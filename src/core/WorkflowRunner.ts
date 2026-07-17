import type { TimeoutInterface } from '@orkestrel/timeout'
import type {
	ControllerInterface,
	PhaseInterface,
	RunnerInterface,
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
import { DEFAULT_BAIL, DEFAULT_PHASE_CONCURRENCY } from './constants.js'
import { WorkflowError } from './errors.js'
import { definitionToSnapshot } from './helpers.js'
import { Runner } from './Runner.js'
import { TaskController } from './tasks/TaskController.js'
import { Workflow } from './Workflow.js'

// A unit of phase work is one live `TaskInterface` — the substrate Runner's `TInput`. Its
// handler's resolved value is irrelevant (the OUTCOME is recorded on the live task via
// `complete` / `fail` / `skip`, NOT in the Runner's ordered results), so the Runner's
// `TResult` is `void`: the runner DRIVES the entity, the substrate only sequences + bounds.
//
// The run-level cancel reads the active phase Runner through a LOCAL per-`#execute` cell (an
// inline `{ runner }` holder threaded into `#runPhase`), NOT a shared `#active` field — so a
// NESTED `execute` (an agent's handler that authored + ran a workflow through a bound
// workflow tool, re-entering this same runner instance while the outer run is suspended
// awaiting that handler) gets its OWN cell and can never clobber the outer run's. Each run
// cancels exactly its own phase Runner.

/**
 * The thin orchestrator that EXECUTES a live W-b workflow tree by COMPOSING the shipped
 * substrate — phases sequential, tasks concurrent — dispatching each task through its OWN
 * resolved handler under the `bail` policy.
 *
 * @remarks
 * - **Composes, never re-implements.** Per-phase bounded concurrency is one
 *   {@link createRunner} per phase (the substrate {@link RunnerInterface} over the workers
 *   `Queue`); `bail` maps onto that Runner's fail-fast vs settle-all; the run-level abort /
 *   timeout / budget / entity `signal` fold through {@link createAbort} / {@link createTimeout} +
 *   `AbortSignal.any` (exactly as the agent runtime folds its bounds); pacing is the shipped
 *   {@link SchedulerInterface}. The runner writes ZERO concurrency / retry / abort logic of
 *   its own — it only sequences phases, dispatches a task's own handler, and drives the live
 *   entity.
 * - **Pure engine — no registries, no tool/agent knowledge.** The runner carries no
 *   `functions` / `tools` / `agents` registry: each live {@link TaskInterface} already
 *   resolved its own {@link import('./types.js').WorkflowFunction} into
 *   {@link import('./types.js').TaskInterface.handler} ONCE at construction (build, restore,
 *   or a live mint all resolve it identically, from {@link WorkflowOptions.functions}), so
 *   dispatch is simply "invoke the task's own handler". Static tool / agent calling is an
 *   OPT-IN concern of the `@orkestrel/tool` package's adapter factories — plain
 *   {@link import('./types.js').WorkflowFunction}s a caller wires into
 *   {@link WorkflowOptions.functions} like any other behavior. This module never imports
 *   any tool/agent package.
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
 *   {@link import('./types.js').TaskInterface.handler} directly: `undefined` (an omitted `run`,
 *   or a `run` name absent from the {@link WorkflowOptions.functions} registry it was resolved
 *   against) AUTO-COMPLETES — the ROADMAP no-handler rule; otherwise the handler runs with the
 *   task's {@link import('./types.js').TaskControllerInterface} handle.
 * - **`bail` → substrate.** Under `bail: true` (halt) a genuine task failure `fail`s the leaf
 *   THEN re-throws, so the substrate Runner fail-fasts — it aborts the in-flight siblings
 *   (their `controller.signal` fires; a mid-flight sibling `skip`s) and rejects the phase run;
 *   `#execute` then `skip`s the remaining tasks / phases (the workflow derives `failed`).
 *   Under `bail: false` (graceful) a failure `fail`s the leaf and RESOLVES (never throws), so
 *   the Runner settles every unit (allSettled) and the run finishes (the workflow derives
 *   `completed`, the failure recorded in the result tree).
 * - **Pause / stop / destroy gates.** `workflow.pause()` is honoured at exactly two points —
 *   the next phase boundary (workflow-only) and each task's own pre-dispatch (before
 *   `task.start()`, workflow gate FIRST then this task's own `phase.pause()`) — by parking on
 *   {@link WorkflowInterface.wait} / {@link PhaseInterface.wait}; an in-flight task body is
 *   NEVER suspended mid-flight. A GRACEFUL `workflow.stop()` (no signal involved) is caught at
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
 *   each `#execute`, so a nested `execute` (a bound workflow-tool handler re-entering this
 *   instance while the outer run is suspended awaiting it) cannot clobber the outer run's state.
 */
export class WorkflowRunner implements WorkflowRunnerInterface {
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
	 *
	 * @param definition - The {@link WorkflowDefinition} to build the live tree from and drive
	 * @param options - The construction options ({@link WorkflowOptions}: `on` / `bail` /
	 *   `phases` / `functions`) PLUS the per-run bounds (`signal` / `timeout` / `budget`)
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
	 * the SAME entity mid-run via its own `pause` / `resume` / `add` / `stop` / `destroy`
	 * (AGENTS §10). Requires `workflow.status === 'pending'` and `!workflow.destroyed` —
	 * otherwise this is a programmer-timing error and it THROWS a `TRANSITION`
	 * {@link WorkflowError} (AGENTS §12) rather than silently no-opping or building a second
	 * tree. Once accepted, observable semantics are byte-identical to the `definition` form —
	 * except the phase loop RE-READS the live tree every iteration, so a caller's live `add`
	 * mid-run is picked up and actually dispatched. `options` carries only the per-run bounds
	 * (`signal` / `timeout` / `budget`) — the construction half of {@link WorkflowRunOptions}
	 * does not apply, since the tree already exists.
	 *
	 * @param workflow - The live {@link WorkflowInterface} to drive
	 * @param options - The per-run bounds (`signal` / `timeout` / `budget`)
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
		if (this.#isWorkflow(target)) {
			if (target.status !== 'pending' || target.destroyed) {
				throw new WorkflowError('TRANSITION', `workflow '${target.id}' is not drivable`, {
					id: target.id,
					status: target.status,
					destroyed: target.destroyed,
				})
			}
			return this.#execute(target, options)
		}
		// SINGLE SOURCE OF TRUTH: build the live tree from the SAME definition we drive, so the
		// executed entity can never drift from the `run` / `concurrency` metadata. The
		// WorkflowOptions half (initial `on` listeners + a `bail` override + the per-node `phases`
		// bag + the `functions` registry) is applied to the constructed `Workflow` (resolving
		// `bail` as `options.bail ?? definition.bail ?? DEFAULT_BAIL`); the run-control bounds
		// (signal/timeout/budget) feed the fold in `#execute`. The tree is built DIRECTLY (not via
		// `createWorkflow`) so the runner never imports its own module's factory — preserving this
		// codebase's factories→classes direction (no class↔factory cycle).
		const bail = options?.bail ?? target.bail ?? DEFAULT_BAIL
		// Seed BOTH tiers of the snapshot with the effective bail (`definitionToSnapshot`'s 2nd arg) so
		// an `options.bail` override reaches each INHERITING phase's snapshot (a per-phase `bail` still
		// wins). `options.bail` itself is forwarded UNCHANGED (NOT overwritten with the resolved
		// `bail`): the snapshot already carries the resolved bail at both tiers, so `Workflow` reads
		// `#bail` from it; injecting a resolved `bail` would make `Workflow` treat it as an EXPLICIT
		// uniform override and clobber the per-phase overrides. A caller's genuine `options.bail` stays
		// as given and cascades uniformly. `options` is forwarded UNCHANGED — `Workflow` resolves each
		// task's `handler` from `options.functions` once at construction (V-c), so a definition run and
		// a `createWorkflow` build follow the SAME single construction path.
		const workflow = new Workflow(definitionToSnapshot(target, bail), options)
		return this.#execute(workflow, options)
	}

	// Drive the whole tree: arm the run-level bounds (the folded abort), run the phases
	// SEQUENTIALLY — re-reading the live phase list every iteration (live continuity, V7) — then
	// assemble the terminal result. A run-level cancel (incl. `workflow.destroy()`, folded into
	// `runSignal`) halts the loop and force-`stop`s the workflow; a graceful `workflow.stop()`
	// (no signal) is caught at the same halt check without forcing anything (it is already the
	// terminal status). The active-Runner `holder` is LOCAL (re-entrant-safe).
	async #execute(
		workflow: WorkflowInterface,
		options: WorkflowRunOptions | undefined,
	): Promise<WorkflowResult> {
		// Arm the deadline + budget and fold every present bound — INCLUDING the live workflow's
		// own `signal` (fires on `destroy`) — into ONE run signal the tasks race against, the same
		// fold the agent runtime uses. A fire of any cancels every in-flight task.
		// Arm the deadline ONLY for a strictly-positive `timeout`: a non-positive value (`0` or
		// negative) means NO deadline (honouring the WorkflowRunOptions.timeout contract), so
		// `0` must NOT cancel the run on the next tick.
		const ms = options?.timeout
		const timeout = ms !== undefined && ms > 0 ? createTimeout({ ms }) : undefined
		timeout?.start()
		options?.budget?.start()
		const runSignal = this.#fold(workflow, options, timeout)
		// On a run-level cancel, abort the ACTIVE phase's Runner (cancelling its in-flight tasks).
		// The active Runner is swapped per phase via the LOCAL holder; a closure over it always
		// fires the current one. A one-shot listener (the run halts once); cleared in the `finally`.
		const holder: { runner: RunnerInterface<TaskInterface, void> | undefined } = {
			runner: undefined,
		}
		const onCancel = (): void => holder.runner?.abort(runSignal.reason)
		if (runSignal.aborted) onCancel()
		else runSignal.addEventListener('abort', onCancel, { once: true })
		try {
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
				if (this.#cancelled(runSignal) || this.#halted(workflow)) {
					this.#haltFrom(phases, index, workflow, runSignal)
					break
				}
				// The phase-boundary pause gate (AGENTS §10, workflow-only): park until resumed /
				// stopped / destroyed, RACED against a run-level cancel (an abort/timeout/budget/
				// destroy firing while parked unparks promptly rather than hanging until resume),
				// then re-check the halt state fresh (a `stop` / `destroy` may have landed while
				// parked) before starting the phase.
				if (workflow.paused) await this.#raceWait(() => workflow.wait(), runSignal)
				if (this.#cancelled(runSignal) || this.#halted(workflow)) {
					this.#haltFrom(workflow.phases.phases(), index, workflow, runSignal)
					break
				}
				// Run the phase to settlement. Under bail-true it REJECTS on the first failure
				// (fail-fast) — skip the remaining phases; otherwise it settles all and continues.
				const failed = await this.#runPhase(workflow, phase, runSignal, holder)
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
				if (index < remaining.length && !this.#cancelled(runSignal)) {
					try {
						await this.#scheduler.yield({ signal: runSignal })
					} catch (error) {
						if (!runSignal.aborted) throw error
					}
				}
			}
			// A run-level cancel makes the run STOPPED — `#haltFrom` forces `stop` BEFORE sweeping
			// (F1-CRITICAL) so the override is set before any per-task skip can drive the derived
			// status to `skipped` first. The substrate RACES an in-flight handler out on abort (its
			// result discarded), so a slow-settling task may still read `running` at this point; the
			// detached handler's own later `skip` is then a guarded no-op.
			if (this.#cancelled(runSignal)) {
				this.#haltFrom(workflow.phases.phases(), 0, workflow, runSignal)
			} else if (this.#completable(workflow)) {
				workflow.complete()
			}
			return { workflow, status: workflow.status, results: workflow.results() }
		} finally {
			timeout?.clear()
			runSignal.removeEventListener('abort', onCancel)
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
		holder: { runner: RunnerInterface<TaskInterface, void> | undefined },
	): Promise<boolean> {
		const launched = new Set<string>()
		let runner: RunnerInterface<TaskInterface, void> | undefined
		const onAdd = (task: TaskInterface): void => {
			if (launched.has(task.id)) return
			launched.add(task.id)
			runner?.spawn(task)
		}
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
			const created = new Runner<TaskInterface, void>({
				concurrency,
				// Thread each task's OWN `retries` / `timeout` (seeded at construction, V3/V4) into the
				// substrate unit. The phase Runner's defaults are the (unset) runner-level retries/timeout,
				// so a task with neither behaves exactly as before; one that declares them OVERRIDES the
				// queue default for that unit alone.
				entries: (task) => ({ retries: task.retries, timeout: task.timeout }),
				handler: (controller) =>
					this.#runTask(workflow, controller.input, controller, runSignal, bail, attempts),
			})
			runner = created
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
				return !this.#cancelled(runSignal)
			} finally {
				created.destroy()
				holder.runner = undefined
			}
		} finally {
			phase.emitter.off('add', onAdd)
			// F1-CRITICAL: on a GENUINE run-level cancel, force the workflow `stop` BEFORE this
			// sweep — the sweep below can itself skip every non-terminal task and drive the derived
			// workflow status to `skipped` first, and `stop()` (F1) is a NO-OP once `status` is
			// already terminal. Forcing here (this `finally` runs BEFORE `#execute` regains control)
			// is required — `#execute`'s own halt guard would otherwise find the workflow already
			// terminal by the time it runs. Not a signal cancel (e.g. a normal phase settle, or a
			// bail-true fail-fast the caller already `fail`ed): no forcing, just the coherent sweep.
			if (this.#cancelled(runSignal) && this.#stoppable(workflow)) workflow.stop()
			// Coherent terminal state (V7): a task minted too late for `spawn` to accept (the
			// drain-race window) is left `pending` with nothing driving it — sweep it `skip`ped now.
			// A no-op for every task the substrate already settled (terminal statuses ignore `skip`).
			for (const task of phase.tasks.tasks()) this.#skip(task)
		}
	}

	// Run ONE task: drive the live entity through its transitions around its OWN resolved
	// handler. `start` (once), invoke `task.handler` (or auto-complete when `undefined`), then
	// `complete(value)` on a returned value or `fail(error)` on a FINAL-attempt failure. A
	// genuine CANCEL (`#skipping` — a run-level bound, or a sibling's fail-fast under bail-true)
	// `skip`s the task instead; a GRACEFUL `workflow.stop()` reaching this pre-dispatch gate
	// likewise `skip`s a not-yet-started task (V7) without touching an in-flight one (checked
	// ONLY here, before `task.start()` — never in the post-dispatch checks below, so a task
	// already running when `stop()` lands finishes naturally).
	//
	// THREE abort causes reach this task's signal and MUST be told apart (the substrate folds all
	// three onto the attempt signal `controller.signal`):
	//  • a per-attempt TIMEOUT (the Queue's per-entry deadline) — fires ONLY the attempt signal, never
	//    the unit `Abort` (`controller.aborted`) nor `runSignal`;
	//  • a SIBLING fail-fast under bail (the Runner aborts in-flight siblings on a failure) — aborts
	//    the unit `Abort` ⇒ `controller.aborted`;
	//  • a run-level CANCEL (abort / timeout / budget / `workflow.destroy()`, all folded into
	//    `runSignal`) — fires `runSignal` (and, forwarded through the phase Runner's abort, the unit
	//    `Abort` too).
	// So `#skipping` (`controller.aborted || runSignal.aborted`) is the genuine-cancel discriminator,
	// and a BARE timeout is `signal.aborted && !#skipping` — a RETRYABLE FAILURE of this attempt, NOT
	// a skip: it joins the retry-cooperative path below (non-final ⇒ leaf stays `running` for the
	// Queue's own retry; final ⇒ `task.fail` so the leaf is `failed`, visible to `bail` /
	// `deriveWorkflowStatus`), never `#skip` (which would lose a recovered result and hide the fault).
	//
	// RETRIES: the substrate Queue re-invokes this handler per attempt (threaded `retries`), so the
	// leaf must survive an intermediate failure to recover. `attempts` counts this task's invocations;
	// an attempt that is NOT the last (`attempt <= retries`) re-throws on a thrown failure to DRIVE the
	// Queue's retry WITHOUT failing the leaf (it stays `running`, so a later attempt can still
	// `complete`); a non-final TIMEOUT likewise leaves the leaf `running` (the Queue's race already
	// rejected the attempt and retries it). Only the FINAL attempt records the leaf `fail`. A no-retry
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
	): Promise<void> {
		// The task's folded cancellation handed to the handler: the substrate per-unit ATTEMPT signal
		// (fires on this Runner's abort — a sibling fail-fast or a run-level cancel I forwarded — OR on
		// the per-attempt deadline) ANY-combined with the run signal directly, so a handler observes
		// any cause. `createAbort` does the fold. NOTE this is broader than the genuine-cancel test:
		// `signal.aborted` is true for a bare timeout too, which is why `#skipping` (the unit-abort /
		// run-cancel discriminator) — not `signal.aborted` — gates the skip path.
		const signal = this.#taskSignal(controller.signal, runSignal)
		// This attempt's 1-based number, and whether it is the LAST the Queue will make (the per-task
		// `retries` + 1 total; the substrate floors negative retries at 0). The leaf is failed only on
		// the final attempt, so an earlier failure/timeout leaves the leaf `running` to retry.
		const attempt = (attempts.get(task.id) ?? 0) + 1
		attempts.set(task.id, attempt)
		const retries = Math.max(0, task.retries ?? 0)
		const last = attempt > retries
		// The per-task pause gate (AGENTS §10), BEFORE `start` — an in-flight task body is never
		// suspended, so this is the only place a paused workflow / phase holds a task back. The
		// workflow's own gate is checked FIRST, then this task's phase's gate — either park is
		// RACED against a run-level cancel (S2: an abort/timeout/budget/destroy firing while
		// parked unparks promptly instead of hanging until `resume`).
		if (workflow.paused) await this.#raceWait(() => workflow.wait(), runSignal)
		if (task.phase.paused) await this.#raceWait(() => task.phase.wait(), runSignal)
		// RE-CHECK for a genuine cancel that landed WHILE parked (a run-level abort / timeout /
		// budget / `workflow.destroy()` firing during the pause-gate await) BEFORE `start` — so a
		// task cancelled while parked is skipped WITHOUT ever emitting `start`. Without this check
		// a cancel that fires exactly while parked would otherwise fall through to `start()` below
		// (the raced gate returns once the signal fires, but the original pre-start skip test ran
		// only AFTER `start`).
		if (this.#skipping(controller, runSignal) || this.#halted(workflow)) {
			this.#skipCancelled(task, workflow, runSignal)
			return
		}
		// `start` only the FIRST time (a retry re-invokes this on the still-`running` leaf — a second
		// `start` would be an illegal `running → running` transition).
		if (task.status === 'pending') task.start()
		// A genuine CANCEL that landed BEFORE dispatch (a run-level bound, or a sibling fail-fast), OR
		// a GRACEFUL `workflow.stop()` the caller invoked directly (V7 — no signal involved): skip
		// without running the handler. A bare per-attempt timeout cannot precede dispatch (its
		// deadline is armed as the attempt begins), so it is excluded from this skip.
		if (this.#skipping(controller, runSignal) || this.#halted(workflow)) {
			this.#skipCancelled(task, workflow, runSignal)
			return
		}
		// The task's open `metadata` bag is on its snapshot (the live `TaskContext` carries only
		// lineage), so read it from there — the task's input the handler may inspect.
		const handle = new TaskController(signal, task.snapshot().metadata, task.context, () =>
			workflow.results(),
		)
		try {
			// Invoke the task's OWN resolved handler directly — `undefined` (an omitted `run`, or a
			// `run` name absent from the registry it was resolved against) AUTO-COMPLETES (the
			// no-handler rule); no by-name dispatch, no registry lookup here.
			const value = task.handler === undefined ? undefined : await task.handler(handle)
			// A genuine cancel during the handler, OR the runner already swept this task terminal on a
			// run-level cancel (the substrate raced this slow handler out): do NOT record a misleading
			// `complete` — `#skip` is a guarded no-op on an already-settled task, and skips a
			// still-`running` one.
			if (task.status !== 'running' || this.#skipping(controller, runSignal)) {
				this.#skipCancelled(task, workflow, runSignal)
				return
			}
			// A bare per-attempt TIMEOUT (the attempt signal fired, but it was NOT a cancel): a
			// retryable failure of THIS attempt — retry (non-final) or `fail` the leaf (final), never a
			// misleading `complete` of the (discarded) post-deadline value.
			if (signal.aborted) {
				this.#timedOut(task, last)
				return
			}
			task.complete(value)
		} catch (error) {
			// A handler threw. If the runner already swept this task terminal, or a genuine cancel
			// fired, treat it as a halt — `#skip` (guarded).
			if (task.status !== 'running' || this.#skipping(controller, runSignal)) {
				this.#skipCancelled(task, workflow, runSignal)
				return
			}
			// A bare per-attempt TIMEOUT surfaced as a throw (a signal-aware handler threw on the
			// deadline): the retryable-failure path, same as the resolve branch above.
			if (signal.aborted) {
				this.#timedOut(task, last)
				return
			}
			// A genuine task failure. NOT the final attempt: re-throw to drive the Queue's retry,
			// leaving the leaf `running` so a later attempt can still recover (`complete`) it — the
			// leaf is NOT failed yet.
			if (!last) throw error
			// The FINAL attempt failed: record it on the leaf.
			task.fail(error)
			// bail-true: re-throw so the substrate Runner fail-fasts (aborts the siblings + rejects
			// the phase run). bail-false: swallow — the failure is recorded and the run settles all.
			if (bail) throw error
		}
	}

	// Settle a TIMED-OUT attempt (the per-attempt deadline fired) on the leaf — the retry-cooperative
	// path a per-attempt timeout shares with a thrown failure. NON-final: leave the leaf `running` and
	// return, so the Queue's own race (which already rejected this attempt on the deadline) retries it
	// and a later attempt can still `complete` the leaf. FINAL: `task.fail` a timeout error so the leaf
	// is `failed` (visible to `bail` + `deriveWorkflowStatus`) — never `skip`ped (which would hide the
	// fault and, on a non-final timeout, discard the recovered result). No re-throw is needed for the
	// substrate fail-fast under bail-true: the Queue's race already rejected the FINAL attempt's entry,
	// so the Runner fail-fasts (aborts siblings + rejects the phase run) regardless of this leaf write.
	#timedOut(task: TaskInterface, last: boolean): void {
		if (!last) return
		task.fail(new Error(`task '${task.id}' timed out`))
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
	// listener early when `wait()` wins the race — it self-removes only via its `{ once: true }`
	// firing on `runSignal`'s eventual abort, which for a run with many pause gates (each call site
	// adding its own listener) would accumulate listeners on `runSignal` for the run's whole
	// lifetime instead of one-at-a-time. The hand-rolled promise here keeps the SAME one-shot-abort
	// shape as `parkSignal` but stays REMOVABLE, so it is cleaned up the instant the race settles
	// either way — correctness over reuse.
	async #raceWait(wait: () => Promise<void>, runSignal: AbortSignal): Promise<void> {
		if (runSignal.aborted) return
		let onAbort: (() => void) | undefined
		const cancelled = new Promise<void>((resolve) => {
			onAbort = () => resolve()
			runSignal.addEventListener('abort', onAbort, { once: true })
		})
		try {
			await Promise.race([wait(), cancelled])
		} finally {
			if (onAbort !== undefined) runSignal.removeEventListener('abort', onAbort)
		}
	}

	// The per-task folded signal: ANY-combine the substrate per-unit signal with the run signal via
	// the native `AbortSignal.any`. No hand-rolled listener wiring, no extra wrapping — `AbortSignal.any`
	// already returns a plain `AbortSignal`. `runSignal` is always present (V7 — it always folds in the
	// live workflow's own signal), so there is no longer a bare-`unitSignal` shortcut to take.
	#taskSignal(unitSignal: AbortSignal, runSignal: AbortSignal): AbortSignal {
		return AbortSignal.any([unitSignal, runSignal])
	}

	// Fold the run-level bounds into ONE signal — the LIVE workflow's own `signal` (fires on
	// `destroy`, V7), the run's external `signal`, the deadline, and the budget, combined via
	// `AbortSignal.any` (the agent runtime's `#parents` pattern). The workflow's signal is always
	// present, so this always returns a defined signal (never `undefined`) — a workflow that is
	// never `destroy`ed simply never fires it, so a bounds-free run is unaffected.
	#fold(
		workflow: WorkflowInterface,
		options: WorkflowRunOptions | undefined,
		timeout: TimeoutInterface | undefined,
	): AbortSignal {
		const signals: AbortSignal[] = [workflow.signal]
		if (options?.signal !== undefined) signals.push(options.signal)
		if (timeout !== undefined) signals.push(timeout.signal)
		if (options?.budget !== undefined) signals.push(options.budget.signal)
		return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
	}

	// HALT from `index`: when the halt is a GENUINE run-level CANCEL (F1-CRITICAL), force the
	// workflow `stop` BEFORE sweeping — `stop()` is a NO-OP once `status` is already terminal
	// (F1), so forcing it FIRST (while the derived status is still non-terminal) is the only
	// ordering that survives the sweep driving every remaining task to `skipped`; sweeping first
	// would silently turn the intended `stopped` into a derived `skipped`. When the halt is NOT a
	// signal cancel (a prior bail-true `failed`, or a caller's own direct `workflow.stop()` /
	// `skip()`), the workflow is ALREADY validly terminal — no forcing needed, just sweep.
	#haltFrom(
		phases: readonly PhaseInterface[],
		index: number,
		workflow: WorkflowInterface,
		runSignal: AbortSignal,
	): void {
		if (this.#cancelled(runSignal) && this.#stoppable(workflow)) workflow.stop()
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
	// FIRST (while `#stoppable`) whenever the skip is due to `#cancelled(runSignal)`, then skip.
	// A skip caused ONLY by a sibling fail-fast (`controller.aborted` under bail, no run-level
	// signal fired) does NOT force anything — that path is a genuine phase failure, not a cancel.
	#skipCancelled(task: TaskInterface, workflow: WorkflowInterface, runSignal: AbortSignal): void {
		if (this.#cancelled(runSignal) && this.#stoppable(workflow)) workflow.stop()
		this.#skip(task)
	}

	// Skip one task iff it is not already terminal — a settled leaf has no legal `skip`
	// transition (it would throw a `TRANSITION` WorkflowError), so guard on the live status.
	#skip(task: TaskInterface): void {
		if (task.status === 'pending' || task.status === 'running') task.skip()
	}

	// Whether an in-flight task is being GENUINELY CANCELLED (and so should `skip`), as opposed to
	// merely TIMED OUT (which retries / fails). Two causes fire a task's attempt signal as a genuine
	// cancel: the unit `Abort` — `controller.aborted` — fired by a SIBLING fail-fast under bail OR by
	// a run-level cancel I forwarded through the phase Runner's abort; and the run signal directly
	// (`runSignal.aborted`, which now also covers `workflow.destroy()`, V7). A per-attempt TIMEOUT
	// fires NEITHER (it aborts only the deadline portion of the attempt signal, never the unit `Abort`
	// nor the run signal), so it is excluded — the precise discriminator that keeps a timeout off the
	// skip path. A fresh read each call so it reflects a cancel that landed mid-dispatch.
	#skipping(controller: ControllerInterface<TaskInterface, void>, runSignal: AbortSignal): boolean {
		return controller.aborted || runSignal.aborted
	}

	// Whether the run-level signal has fired (a fresh read, so it reflects an abort — incl. a
	// `workflow.destroy()`, V7 — that landed during a phase).
	#cancelled(runSignal: AbortSignal): boolean {
		return runSignal.aborted
	}

	// Whether the workflow is no longer runnable — its derived status has reached a terminal
	// state (a bail-true failure flipped it to `failed`, a GRACEFUL `workflow.stop()` the caller
	// invoked directly, or a force `skip`), so the remaining / not-yet-started work must not run.
	#halted(workflow: WorkflowInterface): boolean {
		const status = workflow.status
		return status === 'failed' || status === 'skipped' || status === 'stopped'
	}

	// Whether a run-level cancel should force `stop` — yes UNLESS the workflow already settled a
	// genuine `failed` (a bail-true failure: preserve it, never mask it with `stopped`) or is
	// ALREADY `stopped` (idempotent — covers both a prior `workflow.stop()` and a prior
	// `workflow.destroy()`, which itself forces `stop` when not already terminal). A `skipped`
	// derived status is the CONSEQUENCE of the runner's own per-task skips on the cancel path, so
	// `stop` SHOULD supersede it (the override wins) — the workflow settles `stopped`, the true
	// outcome of a cancelled run.
	#stoppable(workflow: WorkflowInterface): boolean {
		const status = workflow.status
		return status !== 'failed' && status !== 'stopped'
	}

	// A NATURALLY-finished run that still derives `pending` executed but recorded NO work (zero phases,
	// or all phases empty / no-op) — vacuously done ⇒ force `completed`. Gated on EXACTLY `pending` so a
	// real `completed`, a bail-true `failed`, a `stopped`, or a derived `skipped` is never overridden.
	#completable(workflow: WorkflowInterface): boolean {
		return workflow.status === 'pending'
	}

	// Discriminate the overloaded `execute` argument: a `WorkflowInterface` is the only one of the
	// two carrying `destroyed` (RUNTIME-ONLY — V2 — never a field on the pure-JSON
	// `WorkflowDefinition`) AND a `snapshot` method (the live entity's serialization method — a
	// `WorkflowDefinition` has no such method). Requiring BOTH is a sturdier structural
	// discriminator than `destroyed` alone (a definition could coincidentally carry a `destroyed`
	// field as arbitrary data; pairing it with a function-typed `snapshot` narrows to the actual
	// entity shape) without resorting to `as`.
	#isWorkflow(target: WorkflowDefinition | WorkflowInterface): target is WorkflowInterface {
		return 'destroyed' in target && 'snapshot' in target && typeof target.snapshot === 'function'
	}
}
