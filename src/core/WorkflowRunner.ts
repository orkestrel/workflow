import type { JSONValue } from '@orkestrel/contract'
import type { TimeoutInterface } from '@orkestrel/timeout'
import type {
	AttemptOutcome,
	ControllerInterface,
	PhaseInterface,
	RunHolder,
	RunnerEntryOptions,
	SchedulerInterface,
	TaskInterface,
	WorkflowDefinition,
	WorkflowInterface,
	WorkflowOptions,
	WorkflowResult,
	WorkflowRunOptions,
	WorkflowRunnerInterface,
} from './types.js'
import { createTimeout } from '@orkestrel/timeout'
import { DEFAULT_BAIL, DEFAULT_PHASE_CONCURRENCY, MAX_TIMER_MS } from './constants.js'
import { WorkflowError } from './errors.js'
import {
	captureWorkflowOptions,
	definitionToSnapshot,
	errorToMessage,
	failure,
	hasWorkflowHandlers,
	isCompletable,
	isHalted,
	isSkipping,
	isStoppable,
	isTerminalStatus,
	ownsAttempt,
} from './helpers.js'
import { isWorkflowInterface } from './validators.js'
import { Runner } from './Runner.js'
import { TaskController } from './tasks/TaskController.js'
import { Workflow } from './Workflow.js'
import { WorkflowPersistence } from './WorkflowPersistence.js'

// A unit of phase work is one live `TaskInterface` — the substrate Runner's `TInput`. Its
// handler's resolved value is irrelevant (the OUTCOME is recorded on the live task through
// `complete` / `fail` / `skip`, NOT in the Runner's ordered results), so the Runner's
// `TResult` is `void`: the runner DRIVES the entity, the substrate only sequences + bounds.
//
// The run-level cancel reads the active phase Runner through a LOCAL per-`#execute` cell (an
// inline `{ runner }` holder threaded into `#runPhase`), NOT a shared `#active` field — so a
// NESTED `execute` through application composition gets its OWN cell and can never clobber the
// outer run's while it is suspended awaiting that handler. Each run cancels exactly its own
// phase Runner.

/**
 * The thin orchestrator that EXECUTES a live W-b workflow tree by COMPOSING the shipped
 * substrate — phases sequential, tasks concurrent — dispatching each task through its OWN
 * resolved handler under the `bail` policy.
 *
 * @remarks
 * - **Composes, never re-implements.** Per-phase bounded concurrency is one
 *   {@link createRunner} per phase (the substrate {@link import('./types.js').RunnerInterface}
 *   over the workers
 *   `Queue`); `bail` maps onto that Runner's fail-fast vs settle-all; the run-level abort /
 *   timeout / budget / entity `signal` fold through the `@orkestrel/abort` signal contract,
 *   {@link createTimeout}, and `AbortSignal.any` (exactly as the agent runtime folds its bounds);
 *   pacing is the shipped
 *   {@link SchedulerInterface}. The runner writes ZERO concurrency / retry / abort logic of
 *   its own — it only sequences phases, dispatches a task's own handler, and drives the live
 *   entity. The workflow layer owns per-task deadlines because timeout settlement must
 *   update the live leaf under the phase's `bail` policy before the substrate unit settles.
 * - **Pure engine — no integration registry.** The runner carries no behavior or provider
 *   registry: each live {@link TaskInterface} already
 *   resolved its own {@link import('./types.js').WorkflowFunction} into
 *   {@link import('./types.js').TaskInterface.handler} ONCE at construction (build, restore,
 *   or a live mint all resolve it identically, from {@link WorkflowOptions.functions}), so
 *   dispatch is "invoke the task's own handler". Provider, protocol, and tool
 *   integrations remain application-owned {@link import('./types.js').WorkflowFunction}s
 *   composed into {@link WorkflowOptions.functions}. This module imports none of them.
 * - **Two `execute` forms, one engine.** `execute(definition, options)` BUILDS the live tree
 *   from a {@link WorkflowDefinition} (single source of truth for the `run` / `concurrency`
 *   metadata); `execute(workflow, options)` DRIVES a caller-owned, ALREADY-BUILT
 *   {@link WorkflowInterface} instead — the entity-native control surface (AGENTS §10:
 *   `pause` / `resume` / `add` / `stop` / `destroy` live on the entity itself). Both forms
 *   converge on the SAME `#execute` engine: neither reads a `WorkflowDefinition` once the tree
 *   exists — `#runTask` reads each task's OWN {@link import('./types.js').TaskInterface.handler}
 *   / `retries` / `timeout`, and `#runPhase` reads each phase's OWN
 *   {@link PhaseInterface.concurrency} / `bail`, so a live `add`-minted phase or task (V5)
 *   runs under EXACTLY the same rules as one built from the original definition.
 * - **Phases sequential, tasks concurrent — LIVE continuity.** `#execute` drives the phases in
 *   order, RE-READING `workflow.phases.phases()` every iteration (a cursor over the live
 *   manager, not a one-time snapshot) so a caller's `workflow.add(phaseDefinition)` mid-run is
 *   picked up. Within a phase, `#runPhase` subscribes to that phase's `add` event BEFORE
 *   capturing its task list, then `spawn`s any task added mid-phase onto the SAME substrate
 *   Runner (so it is actually dispatched, under the same `concurrency`); a task added too late
 *   for `spawn` to accept (the runner already drained) is swept `skip`ped afterward so the
 *   phase always reaches a coherent terminal state.
 * - **Dispatch by handler.** `#runTask` invokes the live task's own
 *   {@link import('./types.js').TaskInterface.handler} directly. An omitted `run` deliberately
 *   auto-completes with JSON `null`; a present unresolved name is rejected by the synchronous
 *   execution claim and never false-completes.
 * - **`bail` → substrate.** Under `bail: true` (halt) a genuine task failure `fail`s the leaf
 *   THEN re-throws, so the substrate Runner fail-fasts — it aborts the in-flight siblings
 *   (their `controller.signal` fires; a mid-flight sibling `skip`s) and rejects the phase run;
 *   `#execute` then `skip`s the remaining tasks / phases (the workflow derives `failed`).
 *   Under `bail: false` (graceful) a failure `fail`s the leaf and RESOLVES (never throws), so
 *   the Runner settles every unit (allSettled) and the run finishes (the workflow derives
 *   `completed`, the failure recorded in the result tree).
 * - **Pause / stop / destroy gates.** Workflow, phase, and task gates are checked before
 *   dispatch, and a running handler can checkpoint their folded state through
 *   {@link import('./types.js').TaskControllerInterface.wait}. Because the substrate acquires
 *   concurrency before this handler gate, a paused task occupies one phase slot until resume;
 *   already-running siblings continue and its per-attempt timeout keeps counting. A GRACEFUL
 *   `workflow.stop()` (no signal involved) is caught at
 *   those same gates: not-yet-started work is `skip`ped, in-flight work finishes naturally. A
 *   HARD `workflow.destroy()` aborts {@link WorkflowInterface.signal}, which `#fold` has folded
 *   into the run's composed signal — so it cancels the active phase Runner (and every
 *   in-flight task) exactly like an external abort / timeout / budget fire. EVERY park on a
 *   `wait()` gate is RACED against that same run signal (`#raceWait`, S2) — so a cancel firing
 *   WHILE parked unparks the engine promptly instead of hanging until `resume`; the existing
 *   halt / abort re-checks after the gate then decide the outcome.
 * - **Abort / Timeout / Budget / entity-signal fold.** `#execute` folds the live workflow's
 *   own {@link WorkflowInterface.signal}, the run's external `signal`, a
 *   {@link TimeoutInterface}, and the `@orkestrel/budget` package's `BudgetInterface`'s
 *   `signal` into one `runSignal` (`AbortSignal.any`); a fire aborts the active phase's Runner
 *   (cancelling every in-flight task) and HALTS the run — the remaining tasks / phases `skip`
 *   and the workflow is force-`stop`ped (settles `stopped`). Each task's
 *   {@link TaskController} signal `AbortSignal.any`-combines the substrate per-unit signal with
 *   `runSignal`, so a handler observes either cause directly.
 * - **Re-entrant-safe.** No shared per-run mutable field: the active-Runner holder is LOCAL to
 *   each `#execute`, so a nested application-level `execute` cannot clobber the outer run's
 *   state.
 */
export class WorkflowRunner implements WorkflowRunnerInterface {
	static readonly #executions = new WeakSet<WorkflowInterface>()
	readonly #scheduler: SchedulerInterface

	constructor(scheduler: SchedulerInterface) {
		this.#scheduler = scheduler
	}

	/**
	 * Execute a workflow definition to completion — BUILD its live tree, run the phases
	 * sequentially with each phase's tasks concurrent — resolving its terminal
	 * {@link WorkflowResult} (whose `workflow` is the freshly-built live tree).
	 *
	 * @remarks
	 * One-shot. The runner BUILDS the live tree from `definition` internally (one source of
	 * truth — the per-task `run` and per-phase `concurrency` come from the same definition
	 * the tree is constructed from, so the executed tree can never drift from the metadata).
	 * The {@link WorkflowOptions} part of `options` (initial `on` listeners, a `bail` override,
	 * the per-node `phases` bag, the {@link WorkflowOptions.functions} registry each task's
	 * `run` resolves against) is forwarded to the build. Under `bail: false` (graceful) every
	 * task settles (a failure is recorded on its {@link TaskInterface}) and the workflow
	 * reaches `completed`; under `bail: true` (halt) the first failure aborts the in-flight
	 * sibling tasks AND `skip`s the remaining tasks / phases, settling the workflow `failed`. A
	 * {@link WorkflowRunOptions} abort / timeout / budget fires every in-flight task's signal
	 * and `stop`s the run. `execute` resolves (never rejects) on a cancel — the partial outcome
	 * is read from the returned {@link WorkflowResult} (its `workflow` / `status` / `results`).
	 * An unexpected scheduler or engine-infrastructure failure rejects after remaining work is
	 * stopped, swept, and final persistence is attempted.
	 *
	 * @param definition - The {@link WorkflowDefinition} to build the live tree from and drive
	 * @param options - The construction options ({@link WorkflowOptions}: `on` / `bail` /
	 *   `phases` / `functions`) PLUS the per-run bounds (`signal` / `timeout` / `budget`) and the
	 *   durable `store`
	 * @returns The run's terminal {@link WorkflowResult} (its `workflow` is the built tree)
	 * @example
	 * ```ts
	 * const result = await runner.execute(definition, { timeout: 5_000 })
	 * result.status // 'completed' | 'failed' | 'stopped'
	 * ```
	 */
	execute(definition: WorkflowDefinition, options?: WorkflowRunOptions): Promise<WorkflowResult>
	/**
	 * Drive an ALREADY-BUILT, CALLER-OWNED live {@link WorkflowInterface} — the entity-native
	 * counterpart to the definition-building {@link execute} overload.
	 *
	 * @remarks
	 * `createWorkflow` mints the live tree, this overload drives it, and the caller controls
	 * the SAME entity mid-run through its own `pause` / `resume` / `add` / `stop` / `destroy`
	 * (AGENTS §10). Requires `workflow.status === 'pending'`, `!workflow.destroyed`, and no
	 * prior execution claim. A process-local object-identity claim shared by all runner instances
	 * is acquired synchronously and never released, so a same-object second call throws a `TRANSITION`
	 * {@link WorkflowError} before any asynchronous status change. Once accepted, observable
	 * semantics are byte-identical to the `definition` form —
	 * except the phase loop RE-READS the live tree every iteration, so a caller's live `add`
	 * mid-run is picked up and actually dispatched. `options` carries only the per-run run
	 * controls — the bounds (`signal` / `timeout` / `budget`) and the durable `store` — since the
	 * construction half of {@link WorkflowRunOptions} does not apply to a tree that already exists.
	 *
	 * @param workflow - The live {@link WorkflowInterface} to drive
	 * @param options - The per-run bounds (`signal` / `timeout` / `budget`) and the durable `store`
	 * @returns The run's terminal {@link WorkflowResult} (its `workflow` is the SAME entity passed in)
	 * @example
	 * ```ts
	 * const workflow = createWorkflow(definition)
	 * const run = runner.execute(workflow)
	 * workflow.pause()
	 * workflow.resume()
	 * await run
	 * ```
	 */
	execute(
		workflow: WorkflowInterface,
		options?: Omit<WorkflowRunOptions, keyof WorkflowOptions>,
	): Promise<WorkflowResult>
	execute(
		target: WorkflowDefinition | WorkflowInterface,
		options?: WorkflowRunOptions,
	): Promise<WorkflowResult> {
		if (isWorkflowInterface(target)) {
			const signal = options?.signal
			const timeout = options?.timeout
			const budget = options?.budget
			const store = options?.store
			this.#acquire(target)
			return this.#execute(target, signal, timeout, budget, store)
		}
		const captured = captureWorkflowOptions(options)
		const signal = options?.signal
		const timeout = options?.timeout
		const budget = options?.budget
		const store = options?.store
		// SINGLE SOURCE OF TRUTH: build the live tree from the SAME definition we drive, so the
		// executed entity can never drift from the `run` / `concurrency` metadata. The
		// WorkflowOptions half (initial `on` listeners + a `bail` override + the per-node `phases`
		// bag + the `functions` registry) is applied to the constructed `Workflow` (resolving
		// `bail` as `options.bail ?? definition.bail ?? DEFAULT_BAIL`); the run-control bounds
		// (signal/timeout/budget) feed the fold in `#execute`. The tree is built DIRECTLY (not through
		// `createWorkflow`) so the runner never imports its own module's factory — preserving this
		// codebase's factories→classes direction (no class↔factory cycle).
		const bail = captured.bail ?? target.bail ?? DEFAULT_BAIL
		// Seed BOTH tiers of the snapshot with the effective bail (`definitionToSnapshot`'s 2nd arg) so
		// an `options.bail` override reaches each INHERITING phase's snapshot (a per-phase `bail` still
		// wins). The captured `options.bail` value is preserved (NOT overwritten with the resolved
		// `bail`): the snapshot already carries the resolved bail at both tiers, so `Workflow` reads
		// `#bail` from it; injecting a resolved `bail` would make `Workflow` treat it as an EXPLICIT
		// uniform override and clobber the per-phase overrides. A caller's genuine `options.bail` stays
		// as given and cascades uniformly. The owned top-level `captured` bag is forwarded — `Workflow`
		// resolves each task's `handler` from its retained `functions` registry at construction (V-c),
		// so a definition run and a `createWorkflow` build follow the SAME construction path.
		const workflow = new Workflow(definitionToSnapshot(target, bail), captured)
		this.#acquire(workflow)
		return this.#execute(workflow, signal, timeout, budget, store)
	}

	#acquire(workflow: WorkflowInterface): void {
		const tasks = workflow.phases.phases().flatMap((phase) => phase.tasks.tasks())
		const runnable =
			(workflow.status === 'pending' || workflow.status === 'running') &&
			tasks.every((task) => task.status !== 'running') &&
			(tasks.length === 0 || tasks.some((task) => task.status === 'pending')) &&
			hasWorkflowHandlers(workflow)
		if (!runnable || workflow.destroyed || WorkflowRunner.#executions.has(workflow)) {
			throw new WorkflowError('TRANSITION', `workflow '${workflow.id}' is not drivable`, {
				id: workflow.id,
				status: workflow.status,
				destroyed: workflow.destroyed,
			})
		}
		WorkflowRunner.#executions.add(workflow)
	}

	// Drive the whole tree: arm the run-level bounds (the folded abort), run the phases
	// SEQUENTIALLY — re-reading the live phase list every iteration (live continuity, V7) — then
	// assemble the terminal result. A run-level cancel (incl. `workflow.destroy()`, folded into
	// `runSignal`) halts the loop and force-`stop`s the workflow; a graceful `workflow.stop()`
	// (no signal) is caught at the same halt check without forcing anything (it is already the
	// terminal status). The active-Runner `holder` is LOCAL (re-entrant-safe).
	async #execute(
		workflow: WorkflowInterface,
		signal: AbortSignal | undefined,
		ms: number | undefined,
		budget: WorkflowRunOptions['budget'],
		store: WorkflowRunOptions['store'],
	): Promise<WorkflowResult> {
		// Arm the deadline + budget and fold every present bound — INCLUDING the live workflow's
		// own `signal` (fires on `destroy`) — into ONE run signal the tasks race against, the same
		// fold the agent runtime uses. A fire of any cancels every in-flight task.
		// Arm only a host-safe deadline. Non-positive, non-finite, and over-max values disable
		// the bound instead of clamping into an immediate host-timer cancellation.
		// On a run-level cancel, abort the ACTIVE phase's Runner (cancelling its in-flight tasks).
		// The active Runner is swapped per phase through the LOCAL holder; a closure over it always
		// fires the current one. A one-shot listener (the run halts once); cleared in the `finally`.
		const holder: RunHolder = { runner: undefined }
		let timeout: TimeoutInterface | undefined
		let persistence: WorkflowPersistence | undefined
		let runSignal: AbortSignal | undefined
		let onCancel: (() => void) | undefined
		try {
			timeout =
				ms !== undefined && Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER_MS
					? createTimeout({ ms })
					: undefined
			timeout?.start()
			budget?.start()
			runSignal = this.#fold(workflow, signal, budget, timeout)
			persistence = store === undefined ? undefined : new WorkflowPersistence(workflow, store)
			onCancel = this.#abortActive.bind(this, holder, runSignal)
			if (runSignal.aborted) onCancel()
			else runSignal.addEventListener('abort', onCancel, { once: true })
			if (persistence !== undefined && !(await persistence.checkpoint('initial'))) {
				if (isStoppable(workflow)) workflow.stop()
				this.#skipFrom(workflow.phases.phases(), 0)
			}
			let index = 0
			for (;;) {
				// Re-read the live phase list every iteration (a cursor, not a one-time snapshot) —
				// a caller's `workflow.add(phaseDefinition)` mid-run extends this and is picked up.
				const phases = workflow.phases.phases()
				if (index >= phases.length) break
				const phase = phases[index]
				if (phase === undefined) {
					index += 1
					continue
				}
				// A run-level cancel, OR the workflow already reached a terminal status (a prior
				// bail-true failure, or a GRACEFUL `workflow.stop()` the caller invoked directly):
				// HALT the loop — skip THIS and every remaining phase's tasks, then break.
				if (runSignal.aborted || isHalted(workflow)) {
					this.#haltFrom(phases, index, workflow, runSignal)
					break
				}
				// The phase-boundary pause gate (AGENTS §10, workflow-only): park until resumed /
				// stopped / destroyed, RACED against a run-level cancel (an abort/timeout/budget/
				// destroy firing while parked unparks promptly rather than hanging until resume),
				// then re-check the halt state fresh (a `stop` / `destroy` may have landed while
				// parked) before starting the phase.
				if (workflow.paused) await this.#raceWait(workflow.wait(), runSignal, undefined, workflow)
				if (runSignal.aborted || isHalted(workflow)) {
					this.#haltFrom(workflow.phases.phases(), index, workflow, runSignal)
					break
				}
				if (phase.status === 'skipped' || phase.status === 'stopped') {
					this.#skipFrom([phase], 0)
					index += 1
					continue
				}
				// Run the phase to settlement. Under bail-true it REJECTS on the first failure
				// (fail-fast) — skip the remaining phases; otherwise it settles all and continues.
				const failed = await this.#runPhase(workflow, phase, runSignal, holder, persistence)
				if (failed) {
					this.#skipFrom(workflow.phases.phases(), index + 1)
					break
				}
				index += 1
				// Pace BETWEEN phases (never after the last, read from the LIVE count) — the
				// cooperative host yield, the shipped scheduler racing the run signal. Only an
				// abort-caused rejection is swallowed (the halt guard handles it next iteration);
				// any other scheduler error is a genuine fault and re-thrown.
				const remaining = workflow.phases.phases()
				if (index < remaining.length && !runSignal.aborted) {
					await this.#pace(runSignal)
				}
			}
			// A run-level cancel makes the run STOPPED — `#haltFrom` forces `stop` BEFORE sweeping
			// (F1-CRITICAL) so the override is set before any per-task skip can drive the derived
			// status to `skipped` first. The substrate RACES an in-flight handler out on abort (its
			// result discarded), so a slow-settling task may still read `running` at this point; the
			// detached handler's own later `skip` is then a guarded no-op.
			if (runSignal.aborted) {
				this.#haltFrom(workflow.phases.phases(), 0, workflow, runSignal)
			} else if (isCompletable(workflow)) {
				workflow.complete()
			}
			const durable = await persistence?.finalize()
			return {
				workflow,
				status: workflow.status,
				results: workflow.results(),
				...(durable === undefined ? {} : { durable }),
				...(persistence?.fault === undefined ? {} : { fault: persistence.fault }),
			}
		} catch (error) {
			if (isStoppable(workflow)) workflow.stop()
			this.#skipFrom(workflow.phases.phases(), 0)
			await persistence?.finalize()
			throw error
		} finally {
			persistence?.detach()
			timeout?.clear()
			if (runSignal !== undefined && onCancel !== undefined) {
				runSignal.removeEventListener('abort', onCancel)
			}
		}
	}

	async #pace(signal: AbortSignal): Promise<void> {
		try {
			await this.#scheduler.yield({ signal })
		} catch (error) {
			if (!signal.aborted) throw error
		}
	}

	// Run ONE phase's tasks CONCURRENTLY through a single substrate Runner. Returns whether the
	// phase failed under bail-true (so `#execute` skips the rest) — `false` for a graceful
	// settle-all AND for a run-level cancel (which is NOT a phase failure; `#execute`'s halt
	// guard handles the skip + the workflow `stop`). The Runner provides bounded concurrency +
	// the fail-fast abort cascade; this handler only drives the live task entity.
	//
	// LIVE continuity (V7): subscribes to the phase's `add` event BEFORE capturing its task
	// list, so a task minted onto this phase mid-run (`phase.add`) is picked up — `spawn`ed onto
	// the SAME substrate Runner the declared tasks run on, under the same `concurrency`. A
	// `spawn` that the Runner can no longer accept (the tight drain-race window its own doc
	// describes) returns `undefined`, tolerated here — the `finally` sweep below `skip`s any
	// task STILL `pending` after the phase settles, so the phase always reaches a coherent
	// terminal state regardless of that race.
	async #runPhase(
		workflow: WorkflowInterface,
		phase: PhaseInterface,
		runSignal: AbortSignal,
		holder: RunHolder,
		persistence: WorkflowPersistence | undefined,
	): Promise<boolean> {
		const launched = new Set<string>()
		const onAdd = this.#spawnAdded.bind(this, launched, holder)
		phase.emitter.on('add', onAdd)
		try {
			const tasks = phase.tasks.tasks()
			for (const task of tasks) launched.add(task.id)
			if (tasks.length === 0) return false
			// The EFFECTIVE per-phase failure policy and resource throttle are read straight off the
			// LIVE phase (V7): `phase.bail` is already the resolved `phase.bail ?? workflow.bail`, and
			// `phase.concurrency` mirrors the definition/mint it was built from — no definition
			// correlation needed. Clamp a non-positive concurrency (unbounded / not validated) to the
			// default — a non-positive throttle means "no throttle declared" ⇒ run them all.
			const bail = phase.bail
			const concurrency =
				phase.concurrency !== undefined && phase.concurrency > 0
					? phase.concurrency
					: DEFAULT_PHASE_CONCURRENCY
			// The substrate Queue retries a failed task by RE-INVOKING its handler (`#runTask`), so the
			// leaf must survive a failed attempt to recover on a later one. This run-local map counts each
			// task's attempts (by id) so `#runTask` can DEFER the leaf `fail` until the FINAL attempt
			// (`attempt > retries`) — an intermediate failure re-throws (driving the Queue's retry) WITHOUT
			// terminating the leaf, so a subsequent success can still `complete` it. A no-retry task's first
			// attempt IS its final one, so this reduces to today's behavior exactly. Fresh per phase run.
			const attempts = new Map<string, number>()
			for (const task of tasks) attempts.set(task.id, task.attempts)
			const owners = new Map<string, number>()
			const created = new Runner<TaskInterface, void>({
				concurrency,
				// Thread retries into the substrate unit. Per-attempt deadlines stay in this workflow
				// layer so timeout settlement follows the phase's bail policy before the unit resolves.
				entries: this.#entry.bind(this),
				handler: this.#runUnit.bind(this, workflow, runSignal, bail, attempts, owners, persistence),
			})
			holder.runner = created
			try {
				// The Runner sequences + bounds the work; its ordered results are unused (the OUTCOME
				// lives on each live task). Under bail-true the FIRST failure rejects this — fail-fast.
				await created.execute(tasks)
				return false
			} catch {
				// The phase Runner rejected. Two causes reject it: a bail-true fail-fast (a task threw,
				// so the Runner aborted the siblings) — a genuine phase failure, report `true` so
				// `#execute` skips the rest (the failing leaf already `fail`ed). OR a run-level cancel I
				// forwarded (`onCancel` → `runner.abort`) — NOT a phase failure: report `false` and let
				// `#execute`'s halt guard skip the remaining phases + force the workflow `stop`.
				return !runSignal.aborted
			} finally {
				try {
					await created.destroy()
				} finally {
					holder.runner = undefined
				}
			}
		} finally {
			phase.emitter.off('add', onAdd)
			// F1-CRITICAL: on a GENUINE run-level cancel, force the workflow `stop` BEFORE this
			// sweep — the sweep below can itself skip every non-terminal task and drive the derived
			// workflow status to `skipped` first, and `stop()` (F1) is a NO-OP once `status` is
			// already terminal. Forcing here (this `finally` runs BEFORE `#execute` regains control)
			// is required — `#execute`'s own halt guard would otherwise find the workflow already
			// terminal by the time it runs. Not a signal cancel (e.g. a normal phase settle, or a
			// bail-true fail-fast the caller already `fail`ed): no forcing, only the coherent sweep.
			if (runSignal.aborted && isStoppable(workflow)) workflow.stop()
			// Coherent terminal state (V7): a task minted too late for `spawn` to accept (the
			// drain-race window) is left `pending` with nothing driving it — sweep it `skip`ped now.
			// A no-op for every task the substrate already settled (terminal statuses ignore `skip`).
			for (const task of phase.tasks.tasks()) this.#skip(task)
		}
	}

	#abortActive(holder: RunHolder, runSignal: AbortSignal): void {
		void holder.runner?.abort(runSignal.reason)
	}

	#spawnAdded(launched: Set<string>, holder: RunHolder, task: TaskInterface): void {
		if (launched.has(task.id)) return
		launched.add(task.id)
		void holder.runner?.spawn(task)
	}

	#entry(task: TaskInterface): RunnerEntryOptions {
		const retries = Math.max(0, (task.retries ?? 0) - task.attempts)
		return retries === 0 ? {} : { retries }
	}

	#runUnit(
		workflow: WorkflowInterface,
		runSignal: AbortSignal,
		bail: boolean,
		attempts: Map<string, number>,
		owners: Map<string, number>,
		persistence: WorkflowPersistence | undefined,
		controller: ControllerInterface<TaskInterface, void>,
	): Promise<void> {
		return this.#runTask(
			workflow,
			controller.input,
			controller,
			runSignal,
			bail,
			attempts,
			owners,
			persistence,
		)
	}

	// Run ONE task: drive the live entity through its transitions around its OWN resolved
	// handler. `start` (once), invoke `task.handler` (or auto-complete an omitted `run`), then
	// `complete(value)` on a returned value or `fail(error)` on a FINAL-attempt failure. A
	// genuine CANCEL (`isSkipping` — a run-level bound, or a sibling's fail-fast under bail-true)
	// `skip`s the task instead; a GRACEFUL `workflow.stop()` reaching this pre-dispatch gate
	// likewise `skip`s a not-yet-started task (V7) without touching an in-flight one (checked
	// ONLY here, before `task.start()` — never in the post-dispatch checks below, so a task
	// already running when `stop()` lands finishes naturally).
	//
	// THREE abort causes reach this task's signal and MUST be told apart:
	//  • a workflow-owned per-attempt TIMEOUT — fires ONLY the folded attempt signal, never
	//    the unit `Abort` (`controller.aborted`) nor `runSignal`;
	//  • a SIBLING fail-fast under bail (the Runner aborts in-flight siblings on a failure) — aborts
	//    the unit `Abort` ⇒ `controller.aborted`;
	//  • a run-level CANCEL (abort / timeout / budget / `workflow.destroy()`, all folded into
	//    `runSignal`) — fires `runSignal` (and, forwarded through the phase Runner's abort, the unit
	//    `Abort` too).
	// So `isSkipping` (`controller.aborted || runSignal.aborted`) is the genuine-cancel discriminator,
	// and a BARE timeout is `signal.aborted` without it — a RETRYABLE FAILURE of this attempt, NOT
	// a skip: it joins the retry-cooperative path below (non-final ⇒ leaf stays `running` for the
	// Queue's own retry; final ⇒ `task.fail` so the leaf is `failed`, visible to `bail` /
	// `deriveWorkflowStatus`), never `#skip` (which would lose a recovered result and hide the fault).
	//
	// RETRIES: the substrate Queue re-invokes this handler per attempt (threaded `retries`), so the
	// leaf must survive an intermediate failure to recover. `attempts` counts this task's invocations;
	// an attempt that is NOT the last (`attempt <= retries`) re-throws on a thrown failure to DRIVE the
	// Queue's retry WITHOUT failing the leaf (it stays `running`, so a later attempt can still
	// `complete`); a non-final TIMEOUT likewise leaves the leaf `running` and rejects to request
	// the substrate retry. Only the FINAL attempt records the leaf `fail`. A no-retry
	// task's first attempt is its final one, so the no-timeout path is byte-identical to before. On the
	// FINAL thrown failure: bail-true re-throws so the substrate Runner fail-fasts (aborts siblings +
	// rejects the phase run); bail-false swallows (the failure is recorded and the run settles all).
	async #runTask(
		workflow: WorkflowInterface,
		task: TaskInterface,
		controller: ControllerInterface<TaskInterface, void>,
		runSignal: AbortSignal,
		bail: boolean,
		attempts: Map<string, number>,
		owners: Map<string, number>,
		persistence: WorkflowPersistence | undefined,
	): Promise<void> {
		// The task's folded cancellation handed to the handler: the substrate per-unit ATTEMPT signal
		// (fires on this Runner's abort — a sibling fail-fast or a run-level cancel I forwarded — OR on
		// the per-attempt deadline) ANY-combined with the run signal directly, so a handler observes
		// any cause. `createAbort` does the fold. NOTE this is broader than the genuine-cancel test:
		// `signal.aborted` is true for a bare timeout too, which is why `isSkipping` (the unit-abort /
		// run-cancel discriminator) — not `signal.aborted` — gates the skip path.
		// This attempt's 1-based number, and whether it is the LAST the Queue will make (the per-task
		// `retries` + 1 total; the substrate floors negative retries at 0). The leaf is failed only on
		// the final attempt, so an earlier failure/timeout leaves the leaf `running` to retry.
		const attempt = (attempts.get(task.id) ?? 0) + 1
		attempts.set(task.id, attempt)
		const retries = Math.max(0, task.retries ?? 0)
		const last = attempt > retries
		if (task.status !== 'pending' && task.status !== 'running') return
		// Pre-existing cancellation wins before this attempt claims a running slot.
		if (isSkipping(task, controller, runSignal) || isHalted(workflow, task.phase)) {
			this.#settleCancelled(task, workflow, runSignal)
			return
		}
		const ms = task.timeout
		const deadline =
			ms !== undefined && Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER_MS
				? createTimeout({ ms })
				: undefined
		const signal = this.#taskSignal(task, controller.signal, runSignal, deadline)
		try {
			// Once the attempt owns its slot, start/reset activity before racing every pause gate
			// against the folded attempt/task/run signal. A deadline can therefore retry/fail a paused
			// attempt without dispatching its external handler.
			task.start()
			if (task.attempts !== attempt) return
			owners.set(task.id, attempt)
			deadline?.start()
			const durable =
				persistence === undefined ? true : await persistence.checkpoint('attempt', task, attempt)
			if (!ownsAttempt(owners, task, attempt)) return
			if (!durable) {
				if (isStoppable(workflow)) workflow.stop()
				return
			}
			if (task.run !== undefined && task.handler === undefined) {
				const error = new WorkflowError(
					'TRANSITION',
					`task '${task.id}' has an unresolved run '${task.run}'`,
					{ task: task.id, run: task.run },
				)
				task.fail({ origin: 'handler', message: error.message })
				if (bail) throw error
				return
			}
			if (
				await this.#gate(
					workflow.paused ? workflow.wait() : undefined,
					task,
					workflow,
					controller,
					runSignal,
					signal,
					attempts,
					owners,
					attempt,
					last,
					bail,
				)
			)
				return
			if (
				await this.#gate(
					task.phase.paused ? task.phase.wait() : undefined,
					task,
					workflow,
					controller,
					runSignal,
					signal,
					attempts,
					owners,
					attempt,
					last,
					bail,
				)
			)
				return
			if (
				await this.#gate(
					task.paused ? task.wait() : undefined,
					task,
					workflow,
					controller,
					runSignal,
					signal,
					attempts,
					owners,
					attempt,
					last,
					bail,
				)
			)
				return
			// A genuine CANCEL that landed BEFORE dispatch (a run-level bound, or a sibling fail-fast), OR
			// a GRACEFUL `workflow.stop()` the caller invoked directly (V7 — no signal involved): skip
			// without running the handler. A bare per-attempt timeout cannot precede dispatch (its
			// deadline is armed as the attempt begins), so it is excluded from this skip.
			if (isSkipping(task, controller, runSignal) || isHalted(workflow, task.phase)) {
				this.#settleCancelled(task, workflow, runSignal)
				return
			}
			if (task.status !== 'running') return
			// The task's open `metadata` bag is on its snapshot (the live `TaskContext` carries only
			// lineage), so read it from there — the task's input the handler may inspect.
			const handle = new TaskController(
				signal,
				task.snapshot().metadata,
				task,
				attempt,
				() => workflow.results(),
				(input) =>
					ownsAttempt(owners, task, attempt) && !signal.aborted
						? task.report(input)
						: failure(
								new WorkflowError(
									'TRANSITION',
									`task '${task.id}' attempt '${attempt}' no longer owns activity`,
									{ task: task.id, attempt },
								),
							),
				() => ownsAttempt(owners, task, attempt) && !signal.aborted && task.pulse(),
			)
			let outcome: AttemptOutcome
			try {
				// Invoke the task's OWN resolved handler directly. `undefined` is reachable here only
				// for an omitted `run`, the deliberate JSON-null no-op form.
				outcome =
					task.handler === undefined
						? [true, null]
						: await this.#raceHandler(Promise.resolve(task.handler(handle)), signal, () =>
								isSkipping(task, controller, runSignal),
							)
			} catch (error) {
				if (!ownsAttempt(owners, task, attempt)) return
				// A handler threw. If the runner already swept this task terminal, or a genuine cancel
				// fired, treat it as a halt — `#skip` (guarded).
				if (task.status !== 'running' || isSkipping(task, controller, runSignal)) {
					this.#settleCancelled(task, workflow, runSignal)
					return
				}
				// A bare per-attempt TIMEOUT surfaced as a throw (a signal-aware handler threw on the
				// deadline): the retryable-failure path, same as the resolve branch above.
				if (signal.aborted) {
					this.#timedOut(owners, task, attempt, last, bail)
					return
				}
				this.#failed(owners, task, attempt, error, last, bail)
				return
			}
			if (!ownsAttempt(owners, task, attempt)) return
			if (!outcome[0]) {
				this.#settleAttempt(
					task,
					workflow,
					controller,
					runSignal,
					signal,
					attempts,
					owners,
					attempt,
					last,
					bail,
					outcome[2],
				)
				return
			}
			if (task.status !== 'running') return
			if (isSkipping(task, controller, runSignal)) {
				this.#settleCancelled(task, workflow, runSignal)
				return
			}
			if (signal.aborted) {
				this.#timedOut(owners, task, attempt, last, bail)
				return
			}
			if (!ownsAttempt(owners, task, attempt)) return
			try {
				task.complete(outcome[1])
			} catch (error) {
				if (!ownsAttempt(owners, task, attempt)) return
				if (task.status !== 'running') throw error
				this.#failed(owners, task, attempt, error, last, bail)
			}
		} finally {
			deadline?.clear()
			if (
				persistence !== undefined &&
				ownsAttempt(owners, task, attempt) &&
				isTerminalStatus(task.status) &&
				!(await persistence.checkpoint('settlement', task, attempt)) &&
				isStoppable(workflow)
			) {
				workflow.stop()
			}
			this.#revoke(owners, task.id, attempt)
		}
	}

	// Check one cooperative gate and settle any cancellation or timeout that won its race.
	async #gate(
		wait: Promise<void> | undefined,
		task: TaskInterface,
		workflow: WorkflowInterface,
		controller: ControllerInterface<TaskInterface, void>,
		runSignal: AbortSignal,
		signal: AbortSignal,
		attempts: Map<string, number>,
		owners: Map<string, number>,
		attempt: number,
		last: boolean,
		bail: boolean,
	): Promise<boolean> {
		const genuine =
			wait === undefined
				? undefined
				: await this.#raceWait(
						wait,
						signal,
						() => isSkipping(task, controller, runSignal),
						workflow,
						task.phase,
					)
		return this.#settleAttempt(
			task,
			workflow,
			controller,
			runSignal,
			signal,
			attempts,
			owners,
			attempt,
			last,
			bail,
			genuine,
		)
	}

	#settleAttempt(
		task: TaskInterface,
		workflow: WorkflowInterface,
		controller: ControllerInterface<TaskInterface, void>,
		runSignal: AbortSignal,
		signal: AbortSignal,
		attempts: Map<string, number>,
		owners: Map<string, number>,
		attempt: number,
		last: boolean,
		bail: boolean,
		genuine?: boolean,
	): boolean {
		if (attempts.get(task.id) !== attempt || !ownsAttempt(owners, task, attempt)) return true
		if (signal.aborted) {
			if (genuine ?? isSkipping(task, controller, runSignal)) {
				this.#settleCancelled(task, workflow, runSignal)
			} else {
				this.#timedOut(owners, task, attempt, last, bail)
			}
			return true
		}
		if (isSkipping(task, controller, runSignal) || isHalted(workflow, task.phase)) {
			this.#settleCancelled(task, workflow, runSignal)
			return true
		}
		return task.status !== 'running'
	}

	async #raceHandler(
		handler: Promise<JSONValue>,
		signal: AbortSignal,
		cancelled: () => boolean,
	): Promise<AttemptOutcome> {
		if (signal.aborted) return [false, undefined, cancelled()]
		const deferred = Promise.withResolvers<AttemptOutcome>()
		const onAbort = this.#resolveHandlerAbort.bind(this, deferred, cancelled)
		signal.addEventListener('abort', onAbort, { once: true })
		try {
			return await Promise.race([
				handler.then((value): readonly [true, JSONValue] => [true, value]),
				deferred.promise,
			])
		} finally {
			signal.removeEventListener('abort', onAbort)
		}
	}

	#resolveHandlerAbort(
		deferred: PromiseWithResolvers<AttemptOutcome>,
		cancelled: () => boolean,
	): void {
		deferred.resolve([false, undefined, cancelled()])
	}

	// Settle a timed-out attempt. A non-final timeout rejects to drive the substrate retry.
	// A final timeout always fails the leaf, then rejects only when the phase is fail-fast.
	#timedOut(
		owners: Map<string, number>,
		task: TaskInterface,
		attempt: number,
		last: boolean,
		bail: boolean,
	): void {
		if (!ownsAttempt(owners, task, attempt)) return
		const error = new Error(`task '${task.id}' timed out`)
		if (last) task.fail({ origin: 'timeout', message: error.message })
		if (!last || bail) throw error
	}

	#failed(
		owners: Map<string, number>,
		task: TaskInterface,
		attempt: number,
		error: unknown,
		last: boolean,
		bail: boolean,
	): void {
		if (!ownsAttempt(owners, task, attempt)) return
		if (!last) throw error
		task.fail({ origin: 'handler', message: errorToMessage(error) })
		if (bail) throw error
	}

	#revoke(owners: Map<string, number>, id: string, attempt: number): void {
		if (owners.get(id) === attempt) owners.delete(id)
	}

	// RACE a parked entity `wait()` against a run-level cancel (S2 — the gate/signal race fix): an
	// external abort / timeout / budget / `workflow.destroy()` firing WHILE the engine is parked on
	// `workflow.wait()` / `phase.wait()` must unpark it PROMPTLY rather than leaving it hung until
	// `resume` — the entity's own `wait()` never rejects and is only ever released by
	// resume/stop/skip/destroy, so the runner (not the entity) is responsible for racing it against
	// the run signal. A one-shot abort listener is wrapped in a promise and ALWAYS removed after the
	// race settles (never leaked) — no polling either way. An already-aborted signal short-circuits.
	//
	// NOT rewritten onto `helpers.parkSignal`: `parkSignal` has no mechanism to detach its own
	// listener early when `wait()` wins the race — it self-removes only through its `{ once: true }`
	// firing on `runSignal`'s eventual abort, which for a run with many pause gates (each call site
	// adding its own listener) would accumulate listeners on `runSignal` for the run's whole
	// lifetime instead of one-at-a-time. The hand-rolled promise here keeps the SAME one-shot-abort
	// shape as `parkSignal` but stays REMOVABLE, so it is cleaned up the instant the race settles
	// either way — correctness over reuse.
	async #raceWait(
		wait: Promise<void>,
		signal: AbortSignal,
		cancelled?: () => boolean,
		workflow?: WorkflowInterface,
		phase?: PhaseInterface,
	): Promise<boolean | undefined> {
		if (signal.aborted) return cancelled?.()
		const deferred = Promise.withResolvers<boolean | undefined>()
		const onAbort = this.#resolveWaitAbort.bind(this, deferred, cancelled)
		const onTerminal = this.#resolveWaitAbort.bind(this, deferred, undefined)
		signal.addEventListener('abort', onAbort, { once: true })
		workflow?.emitter.on('skip', onTerminal)
		workflow?.emitter.on('stop', onTerminal)
		phase?.emitter.on('skip', onTerminal)
		phase?.emitter.on('stop', onTerminal)
		try {
			if (workflow !== undefined && isHalted(workflow, phase)) deferred.resolve(undefined)
			const outcome = await Promise.race([wait, deferred.promise])
			return typeof outcome === 'boolean' ? outcome : undefined
		} finally {
			signal.removeEventListener('abort', onAbort)
			workflow?.emitter.off('skip', onTerminal)
			workflow?.emitter.off('stop', onTerminal)
			phase?.emitter.off('skip', onTerminal)
			phase?.emitter.off('stop', onTerminal)
		}
	}

	#resolveWaitAbort(
		deferred: PromiseWithResolvers<boolean | undefined>,
		cancelled: (() => boolean) | undefined,
	): void {
		deferred.resolve(cancelled?.())
	}

	// The per-task folded signal: ANY-combine the substrate per-unit signal with the run signal through
	// the native `AbortSignal.any`. No hand-rolled listener wiring, no extra wrapping — `AbortSignal.any`
	// already returns a plain `AbortSignal`. `runSignal` is always present (V7 — it always folds in the
	// live workflow's own signal), so there is no longer a bare-`unitSignal` shortcut to take.
	#taskSignal(
		task: TaskInterface,
		unitSignal: AbortSignal,
		runSignal: AbortSignal,
		timeout: TimeoutInterface | undefined,
	): AbortSignal {
		const signals = [task.signal, unitSignal, runSignal]
		if (timeout !== undefined) signals.push(timeout.signal)
		return AbortSignal.any(signals)
	}

	// Fold the run-level bounds into ONE signal — the LIVE workflow's own `signal` (fires on
	// `destroy`, V7), the run's external `signal`, the deadline, and the budget, combined through
	// `AbortSignal.any` (the agent runtime's `#parents` pattern). The workflow's signal is always
	// present, so this always returns a defined signal (never `undefined`) — a workflow that is
	// never `destroy`ed never fires it, so a bounds-free run is unaffected.
	#fold(
		workflow: WorkflowInterface,
		signal: AbortSignal | undefined,
		budget: WorkflowRunOptions['budget'],
		timeout: TimeoutInterface | undefined,
	): AbortSignal {
		const signals: AbortSignal[] = [workflow.signal]
		if (signal !== undefined) signals.push(signal)
		if (timeout !== undefined) signals.push(timeout.signal)
		if (budget !== undefined) signals.push(budget.signal)
		return signals.length === 1 ? workflow.signal : AbortSignal.any(signals)
	}

	// HALT from `index`: when the halt is a GENUINE run-level CANCEL (F1-CRITICAL), force the
	// workflow `stop` BEFORE sweeping — `stop()` is a NO-OP once `status` is already terminal
	// (F1), so forcing it FIRST (while the derived status is still non-terminal) is the only
	// ordering that survives the sweep driving every remaining task to `skipped`; sweeping first
	// would silently turn the intended `stopped` into a derived `skipped`. When the halt is NOT a
	// signal cancel (a prior bail-true `failed`, or a caller's own direct `workflow.stop()` /
	// `skip()`), the workflow is ALREADY validly terminal — no forcing needed, only the sweep.
	#haltFrom(
		phases: readonly PhaseInterface[],
		index: number,
		workflow: WorkflowInterface,
		runSignal: AbortSignal,
	): void {
		if (runSignal.aborted && isStoppable(workflow)) workflow.stop()
		this.#skipFrom(phases, index)
	}

	// Skip every not-yet-settled task across phases `index..end` — the halt path (a run-level
	// cancel, or the remaining phases after a bail-true failure). Only a `pending` / `running`
	// task can `skip` (a settled one ignores it), so this is safe over already-finished phases.
	#skipFrom(phases: readonly PhaseInterface[], index: number): void {
		for (let cursor = index; cursor < phases.length; cursor += 1) {
			const phase = phases[cursor]
			if (phase === undefined) continue
			for (const task of phase.tasks.tasks()) this.#skip(task)
		}
	}

	// F1-CRITICAL: the same stop-before-skip ordering as `#haltFrom`, applied to a SINGLE task
	// skip inside `#runTask`. A per-task skip on a genuine run-level cancel can itself drive the
	// derived workflow status to `skipped` before `#execute` / `#runPhase` ever get control back
	// (this call happens INSIDE the substrate's per-unit handler) — so force the workflow `stop`
	// FIRST (while `isStoppable`) whenever the skip is due to `runSignal.aborted`, then skip.
	// A skip caused ONLY by a sibling fail-fast (`controller.aborted` under bail, no run-level
	// signal fired) does NOT force anything — that path is a genuine phase failure, not a cancel.
	#settleCancelled(task: TaskInterface, workflow: WorkflowInterface, runSignal: AbortSignal): void {
		if (runSignal.aborted && isStoppable(workflow)) workflow.stop()
		this.#skip(task)
	}

	// Skip one task iff it is not already terminal — a settled leaf has no legal `skip`
	// transition (it would throw a `TRANSITION` WorkflowError), so guard on the live status.
	#skip(task: TaskInterface): void {
		if (task.status === 'pending' || task.status === 'running') task.skip()
	}
}
