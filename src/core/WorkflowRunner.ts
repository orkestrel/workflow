import type { AbortInterface } from '../aborts/types.js'
import type { AgentInterface, ToolManagerInterface } from '../agents/types.js'
import type { ControllerInterface, RunnerInterface } from '../runners/types.js'
import type { SchedulerInterface } from '../schedulers/types.js'
import type { TimeoutInterface } from '../timeouts/types.js'
import type {
	PhaseDefinition,
	PhaseInterface,
	TaskDefinition,
	TaskInterface,
	WorkflowAgents,
	WorkflowDefinition,
	WorkflowFunctions,
	WorkflowInterface,
	WorkflowResult,
	WorkflowRunOptions,
	WorkflowRunnerInterface,
	WorkflowToolBinder,
} from './types.js'
import { createAbort } from '../aborts/factories.js'
import { createRunner } from '../runners/factories.js'
import { createTimeout } from '../timeouts/factories.js'
import { DEFAULT_BAIL, DEFAULT_PHASE_CONCURRENCY, MAX_WORKFLOW_DEPTH } from './constants.js'
import { WorkflowError } from './errors.js'
import {
	agentTag,
	definitionToSnapshot,
	isAgentTask,
	isFunctionTask,
	isToolTask,
	workflowTag,
} from './helpers.js'
import { TaskController } from './tasks/TaskController.js'
import { Workflow } from './Workflow.js'

// A unit of phase work is one live `TaskInterface` — the substrate Runner's `TInput`. Its
// handler's resolved value is irrelevant (the OUTCOME is recorded on the live task via
// `complete` / `fail` / `skip`, NOT in the Runner's ordered results), so the Runner's
// `TResult` is `void`: the runner DRIVES the entity, the substrate only sequences + bounds.
//
// The run-level cancel reads the active phase Runner through a LOCAL per-`#execute` cell (an
// inline `{ runner }` holder threaded into `#runPhase`), NOT a shared `#active` field — so a
// NESTED `execute` (an `agent` task whose subagent authored + ran a workflow through the bound
// workflow tool, re-entering this same runner instance while the outer run is suspended at
// `await agent.generate()`) gets its OWN cell and can never clobber the outer run's. Each run
// cancels exactly its own phase Runner. The injected `WorkflowToolBinder` (`createWorkflowTool`,
// threaded at construction) lets the runner BIND a depth/cycle-aware workflow tool onto a
// dispatched subagent WITHOUT importing its own `factories.ts` (the factories→classes direction).

/**
 * The thin orchestrator that EXECUTES a live W-b workflow tree by COMPOSING the shipped
 * substrate — phases sequential, tasks concurrent — dispatching each task BY NAME under the
 * `bail` policy, including the W-c2 `agent` form behind a depth + cycle guard.
 *
 * @remarks
 * - **Composes, never re-implements.** Per-phase bounded concurrency is one
 *   {@link createRunner} per phase (the substrate {@link RunnerInterface} over the workers
 *   `Queue`); `bail` maps onto that Runner's fail-fast vs settle-all; the run-level abort /
 *   timeout / budget fold through {@link createAbort} / {@link createTimeout} +
 *   `AbortSignal.any` (exactly as the agent runtime folds its bounds); pacing is the shipped
 *   {@link SchedulerInterface}. The runner writes ZERO concurrency / retry / abort logic of
 *   its own — it only sequences phases, dispatches a task, and drives the live entity.
 * - **Phases sequential, tasks concurrent.** `#execute` awaits the phases in order (phase
 *   N+1 starts only once phase N has fully settled). Within a phase, ALL its tasks are the
 *   one Runner's `inputs`, run at `concurrency` = the phase's
 *   {@link PhaseDefinition.concurrency} (default {@link DEFAULT_PHASE_CONCURRENCY}).
 * - **Dispatch by name.** `#dispatch` branches on the task's
 *   {@link import('./types.js').TaskForm} (read from the `definition`, correlated by `id`):
 *   `function` → the {@link WorkflowFunctions} registry, `tool` → the
 *   {@link ToolManagerInterface}, `agent` → the {@link WorkflowAgents} resolver (W-c2). A
 *   handler that is NOT found (an unregistered name for ANY form) AUTO-COMPLETES — the
 *   ROADMAP no-handler rule.
 * - **`agent` form + depth/cycle guard (W-c2).** An `agent` task resolves its subagent via
 *   `agents`, BINDS a depth/cycle-aware workflow tool onto the subagent's `context.tools`
 *   (the propagation seam), folds the task's cancellation into the agent run (a workflow
 *   cancel `abort`s the subagent), and drives it: success → `complete(result)`, throw →
 *   `fail(error)`. Before running, the guard REJECTS the task into a typed `DEPTH`
 *   {@link WorkflowError} (`fail`) when running it would push the nested chain past
 *   {@link MAX_WORKFLOW_DEPTH}, OR when its target agent is already an ancestor (a cycle).
 *   The rejected task never runs the agent.
 * - **`bail` → substrate.** Under `bail: true` (halt) a genuine task failure `fail`s the leaf
 *   THEN re-throws, so the substrate Runner fail-fasts — it aborts the in-flight siblings
 *   (their `controller.signal` fires; a mid-flight sibling `skip`s) and rejects the phase run;
 *   `#execute` then `skip`s the remaining tasks / phases (the workflow derives `failed`).
 *   Under `bail: false` (graceful) a failure `fail`s the leaf and RESOLVES (never throws), so
 *   the Runner settles every unit (allSettled) and the run finishes (the workflow derives
 *   `completed`, the failure recorded in the result tree).
 * - **Abort / Timeout / Budget fold.** `#execute` folds the run's external `signal`, a
 *   {@link TimeoutInterface}, and the {@link import('../budgets/types.js').BudgetInterface}'s
 *   `signal` into one `runSignal` (`AbortSignal.any`); a fire aborts the active phase's Runner
 *   (cancelling every in-flight task) and HALTS the run — the remaining tasks / phases `skip`
 *   and the workflow is force-`stop`ped (settles `stopped`). Each task's
 *   {@link TaskController} signal `AbortSignal.any`-combines the substrate per-unit signal with
 *   `runSignal`, so a handler observes either cause directly.
 * - **Re-entrant-safe.** No shared per-run mutable field: the active-Runner holder is LOCAL to
 *   each `#execute`, so a nested `execute` (the bound workflow tool re-entering this instance
 *   while the outer run is suspended on an `agent` task) cannot clobber the outer run's state.
 */
export class WorkflowRunner implements WorkflowRunnerInterface {
	readonly #functions: WorkflowFunctions
	readonly #tools: ToolManagerInterface | undefined
	readonly #agents: WorkflowAgents | undefined
	readonly #scheduler: SchedulerInterface
	// The injected `createWorkflowTool` (see `WorkflowToolBinder`) — `undefined` only when the
	// runner was constructed WITHOUT the binder (no agent can then author a nested workflow; an
	// agent task still runs, just with no workflow tool bound). `createWorkflowRunner` always
	// threads it.
	readonly #workflowTool: WorkflowToolBinder | undefined

	constructor(
		functions: WorkflowFunctions,
		tools: ToolManagerInterface | undefined,
		agents: WorkflowAgents | undefined,
		scheduler: SchedulerInterface,
		workflowTool: WorkflowToolBinder | undefined,
	) {
		this.#functions = functions
		this.#tools = tools
		this.#agents = agents
		this.#scheduler = scheduler
		this.#workflowTool = workflowTool
	}

	execute(definition: WorkflowDefinition, options?: WorkflowRunOptions): Promise<WorkflowResult> {
		// SINGLE SOURCE OF TRUTH: build the live tree from the SAME definition we drive, so the
		// executed entity can never drift from the `run` form / `concurrency` metadata. The
		// WorkflowOptions half (initial `on` listeners + a `bail` override + the per-node `phases`
		// bag) is applied to the constructed `Workflow` (resolving `bail` as `options.bail ??
		// definition.bail ?? DEFAULT_BAIL`); the run-control bounds (signal/timeout/budget) feed
		// the fold in `#execute`, and the W-c2 depth/ancestry bookkeeping bounds nested recursion.
		// The tree is built DIRECTLY (not via `createWorkflow`) so the runner never imports its own
		// module's factory — preserving this codebase's factories→classes direction (no
		// class↔factory cycle).
		const bail = options?.bail ?? definition.bail ?? DEFAULT_BAIL
		// Seed BOTH tiers of the snapshot with the effective bail (`definitionToSnapshot`'s 2nd arg) so
		// an `options.bail` override reaches each INHERITING phase's snapshot (a per-phase `bail` still
		// wins). `options` is forwarded UNCHANGED (NOT `{ ...options, bail }`): the snapshot already
		// carries the resolved bail at both tiers, so `Workflow` reads `#bail` from it; injecting a
		// resolved `bail` would make `Workflow` treat it as an EXPLICIT uniform override and clobber the
		// per-phase overrides. A caller's genuine `options.bail` stays in `options` and cascades uniformly.
		const workflow = new Workflow(definitionToSnapshot(definition, bail), options)
		// This run's depth (default 0) and the ancestry every task inherits — the run's own
		// `workflow:<id>` added so a nested workflow that re-enters this same id is a detectable
		// cycle. A top-level caller omits both; the bound workflow tool supplies them, incremented.
		const depth = options?.depth ?? 0
		const ancestry = [...(options?.ancestry ?? []), workflowTag(definition.id)]
		return this.#execute(workflow, definition, options, depth, ancestry)
	}

	// Drive the whole tree: arm the run-level bounds (the folded abort), run the phases
	// SEQUENTIALLY, then assemble the terminal result. A run-level cancel halts the loop and
	// force-`stop`s the workflow; otherwise the workflow's derived status is the outcome. The
	// active-Runner `holder` is LOCAL (re-entrant-safe — a nested execute gets its own).
	async #execute(
		workflow: WorkflowInterface,
		definition: WorkflowDefinition,
		options: WorkflowRunOptions | undefined,
		depth: number,
		ancestry: readonly string[],
	): Promise<WorkflowResult> {
		// Arm the deadline + budget and fold every present bound into ONE run signal the tasks
		// race against — the same fold the agent runtime uses (`AbortSignal.any` of external
		// signal + deadline + budget), so a fire of any cancels every in-flight task.
		// Arm the deadline ONLY for a strictly-positive `timeout`: a non-positive value (`0` or
		// negative) means NO deadline (honouring the WorkflowRunOptions.timeout contract), so
		// `0` must NOT cancel the run on the next tick.
		const ms = options?.timeout
		const timeout = ms !== undefined && ms > 0 ? createTimeout({ ms }) : undefined
		timeout?.start()
		options?.budget?.start()
		const runSignal = this.#fold(options, timeout)
		// On a run-level cancel, abort the ACTIVE phase's Runner (cancelling its in-flight tasks).
		// The active Runner is swapped per phase via the LOCAL holder; a closure over it always
		// fires the current one. A one-shot listener (the run halts once); cleared in the `finally`.
		const holder: { runner: RunnerInterface<TaskInterface, void> | undefined } = {
			runner: undefined,
		}
		const onCancel = (): void => holder.runner?.abort(runSignal?.reason)
		if (runSignal !== undefined) {
			if (runSignal.aborted) onCancel()
			else runSignal.addEventListener('abort', onCancel, { once: true })
		}
		try {
			const phases = workflow.phases.phases()
			for (let index = 0; index < phases.length; index += 1) {
				const phase = phases[index]
				if (phase === undefined) continue
				// A run-level cancel (or a prior bail-true failure that left the workflow non-running)
				// HALTS the loop: skip THIS and every remaining phase's tasks, then break. Read the
				// cancel state fresh (the signal may have fired during the previous phase).
				if (this.#cancelled(runSignal) || this.#halted(workflow)) {
					this.#skipFrom(phases, index)
					break
				}
				// Run the phase to settlement. Under bail-true it REJECTS on the first failure
				// (fail-fast) — skip the remaining phases; otherwise it settles all and continues.
				const failed = await this.#runPhase(
					workflow,
					phase,
					this.#phaseOf(definition, phase.id),
					runSignal,
					holder,
					depth,
					ancestry,
				)
				if (failed) {
					this.#skipFrom(phases, index + 1)
					break
				}
				// Pace BETWEEN phases (never after the last) — the cooperative host yield, the
				// shipped scheduler honouring the run signal (an aborted yield rejects, handled). A
				// cancel during the phase skips pacing (the next iteration's halt guard handles it).
				if (index < phases.length - 1 && !this.#cancelled(runSignal)) {
					try {
						await this.#scheduler.yield(runSignal === undefined ? undefined : { signal: runSignal })
					} catch {
						// An aborted yield rejects with the run signal's reason — a cancel, not an error;
						// the next loop iteration's halt guard skips the rest.
					}
				}
			}
			// A run-level cancel makes the run STOPPED. The substrate RACES an in-flight handler out
			// on abort (its result discarded), so a slow-settling task (notably an `agent` task whose
			// subagent takes several ticks to unwind) may still read `running` at this point — sweep
			// EVERY phase to `skip` any task the cancel left non-terminal, so the returned tree is
			// deterministic regardless of handler-settle speed (the detached handler's own later
			// `skip` is then a guarded no-op). THEN force the workflow `stop` so it settles `stopped`
			// (its derived status would otherwise read the per-task skips). A `skip`ped /
			// already-stopped workflow ignores a further `stop`; a natural finish skips none of this.
			if (this.#cancelled(runSignal)) {
				this.#skipFrom(workflow.phases.phases(), 0)
				if (this.#stoppable(workflow)) workflow.stop()
			} else if (this.#completable(workflow)) {
				workflow.complete()
			}
			return { workflow, status: workflow.status, results: workflow.results() }
		} finally {
			timeout?.clear()
			runSignal?.removeEventListener('abort', onCancel)
		}
	}

	// Run ONE phase's tasks CONCURRENTLY through a single substrate Runner. Returns whether the
	// phase failed under bail-true (so `#execute` skips the rest) — `false` for a graceful
	// settle-all AND for a run-level cancel (which is NOT a phase failure; `#execute`'s halt
	// guard handles the skip + the workflow `stop`). The Runner provides bounded concurrency +
	// the fail-fast abort cascade; this handler only drives the live task entity.
	async #runPhase(
		workflow: WorkflowInterface,
		phase: PhaseInterface,
		definition: PhaseDefinition | undefined,
		runSignal: AbortSignal | undefined,
		holder: { runner: RunnerInterface<TaskInterface, void> | undefined },
		depth: number,
		ancestry: readonly string[],
	): Promise<boolean> {
		const tasks = phase.tasks.tasks()
		if (tasks.length === 0) return false
		// The EFFECTIVE per-phase failure policy: the phase definition's own `bail` when it declares
		// one, else the workflow default (`effectiveBail = phase.bail ?? workflow.bail`). This single
		// line drives the halt — `bail` is threaded into every `#runTask`, so a strict phase fail-fasts
		// even under a graceful workflow, and a graceful phase settles-all even under a strict one.
		const bail = definition?.bail ?? workflow.bail
		// Clamp a non-positive `concurrency` (a hand-built definition not validated by the contract,
		// which enforces `>= 1`, could carry `0` / negative) to the default — a non-positive throttle
		// means "no throttle declared" ⇒ run them all, never a broken Runner (createRunner requires a
		// positive integer, flooring at 1; passing 0 here would silently serialize, not "run all").
		const concurrency =
			definition?.concurrency !== undefined && definition.concurrency > 0
				? definition.concurrency
				: DEFAULT_PHASE_CONCURRENCY
		// The substrate Queue retries a failed task by RE-INVOKING its handler (`#runTask`), so the
		// leaf must survive a failed attempt to recover on a later one. This run-local map counts each
		// task's attempts (by id) so `#runTask` can DEFER the leaf `fail` until the FINAL attempt
		// (`attempt > retries`) — an intermediate failure re-throws (driving the Queue's retry) WITHOUT
		// terminating the leaf, so a subsequent success can still `complete` it. A no-retry task's first
		// attempt IS its final one, so this reduces to today's behavior exactly. Fresh per phase run.
		const attempts = new Map<string, number>()
		const runner = createRunner<TaskInterface, void>({
			concurrency,
			// Thread each task's per-entry `retries` / `timeout` overrides (Seam A) from its definition
			// into the substrate unit — the Part-0 resolver. The phase Runner's defaults are the
			// (unset) runner-level retries/timeout, so a task that declares neither behaves exactly as
			// before; one that declares them OVERRIDES the queue default for that unit alone.
			entries: (task) => {
				const def = this.#taskOf(definition, task.id)
				return { retries: def?.retries, timeout: def?.timeout }
			},
			handler: (controller) =>
				this.#runTask(
					workflow,
					controller.input,
					this.#taskOf(definition, controller.input.id),
					controller,
					runSignal,
					bail,
					attempts,
					depth,
					ancestry,
				),
		})
		holder.runner = runner
		try {
			// The Runner sequences + bounds the work; its ordered results are unused (the OUTCOME
			// lives on each live task). Under bail-true the FIRST failure rejects this — fail-fast.
			await runner.execute(tasks)
			return false
		} catch {
			// The phase Runner rejected. Two causes reject it: a bail-true fail-fast (a task threw,
			// so the Runner aborted the siblings) — a genuine phase failure, report `true` so
			// `#execute` skips the rest (the failing leaf already `fail`ed). OR a run-level cancel I
			// forwarded (`onCancel` → `runner.abort`) — NOT a phase failure: report `false` and let
			// `#execute`'s halt guard skip the remaining phases + force the workflow `stop`.
			return !this.#cancelled(runSignal)
		} finally {
			runner.destroy()
			holder.runner = undefined
		}
	}

	// Run ONE task: drive the live entity through its transitions around a dispatch by name.
	// `start` (once), dispatch, then `complete(value)` on a returned value or `fail(error)` on a
	// FINAL-attempt failure. A genuine CANCEL (`#skipping` — a run-level bound, or a sibling's
	// fail-fast under bail-true) `skip`s the task instead.
	//
	// THREE abort causes reach this task's signal and MUST be told apart (the substrate folds all
	// three onto the attempt signal `controller.signal`):
	//  • a per-attempt TIMEOUT (the Queue's per-entry deadline) — fires ONLY the attempt signal, never
	//    the unit `Abort` (`controller.aborted`) nor `runSignal`;
	//  • a SIBLING fail-fast under bail (the Runner aborts in-flight siblings on a failure) — aborts
	//    the unit `Abort` ⇒ `controller.aborted`;
	//  • a run-level CANCEL (abort / run-timeout / budget) — fires `runSignal` (and, forwarded through
	//    the phase Runner's abort, the unit `Abort` too).
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
		definition: TaskDefinition | undefined,
		controller: ControllerInterface<TaskInterface, void>,
		runSignal: AbortSignal | undefined,
		bail: boolean,
		attempts: Map<string, number>,
		depth: number,
		ancestry: readonly string[],
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
		const retries = Math.max(0, definition?.retries ?? 0)
		const last = attempt > retries
		// `start` only the FIRST time (a retry re-invokes this on the still-`running` leaf — a second
		// `start` would be an illegal `running → running` transition).
		if (task.status === 'pending') task.start()
		// A genuine CANCEL that landed BEFORE dispatch (a run-level bound, or a sibling fail-fast): skip
		// without running the handler — the run is halting. A bare per-attempt timeout cannot precede
		// dispatch (its deadline is armed as the attempt begins), so it is excluded from this skip.
		if (this.#skipping(controller, runSignal)) {
			this.#skip(task)
			return
		}
		// The task's open `metadata` bag is on its snapshot (the live `TaskContext` carries only
		// lineage), so read it from there — the task's input the handler may inspect.
		const handle = new TaskController(signal, task.snapshot().metadata, task.context, () =>
			workflow.results(),
		)
		try {
			const value = await this.#dispatch(definition, handle, depth, ancestry)
			// A genuine cancel during the handler, OR the runner already swept this task terminal on a
			// run-level cancel (the substrate raced this slow handler out): do NOT record a misleading
			// `complete` — `#skip` is a guarded no-op on an already-settled task, and skips a
			// still-`running` one.
			if (task.status !== 'running' || this.#skipping(controller, runSignal)) {
				this.#skip(task)
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
				this.#skip(task)
				return
			}
			// A bare per-attempt TIMEOUT surfaced as a throw (a signal-aware handler threw on the
			// deadline): the retryable-failure path, same as the resolve branch above.
			if (signal.aborted) {
				this.#timedOut(task, last)
				return
			}
			// A genuine task failure (incl. a typed `DEPTH` guard rejection of an over-deep / cyclic
			// agent task). NOT the final attempt: re-throw to drive the Queue's retry, leaving the leaf
			// `running` so a later attempt can still recover (`complete`) it — the leaf is NOT failed yet.
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

	// Dispatch a task BY NAME on its `run.via` form:
	//  • `function` → the WorkflowFunctions registry, invoked with the TaskController.
	//  • `tool`     → the ToolManager, invoked with the task's input; a tool result's `error`
	//                 (the manager isolates a throw into one) is re-thrown so the leaf `fail`s.
	//  • `agent`    → the WorkflowAgents resolver (W-c2), behind the depth + cycle guard; the
	//                 resolved subagent runs to its result (folding the task's cancellation),
	//                 returned as the task's completed value. An over-deep / cyclic agent task
	//                 THROWS a typed `DEPTH` WorkflowError (→ the leaf `fail`s).
	//  • not found  → AUTO-COMPLETE (resolve `undefined`): the ROADMAP no-handler rule.
	async #dispatch(
		definition: TaskDefinition | undefined,
		controller: TaskController,
		depth: number,
		ancestry: readonly string[],
	): Promise<unknown> {
		const form = definition?.run
		if (form !== undefined && isFunctionTask(form)) {
			const handler = this.#functions[form.name]
			if (handler !== undefined) return handler(controller)
			return undefined
		}
		if (form !== undefined && isToolTask(form)) {
			// Bind the manager to a local so it narrows to a definite `ToolManagerInterface` — then
			// `tool` lookup AND `execute` are called DIRECTLY (no `?.`), so `result` is the
			// non-optional `ToolResult` rather than being widened by an optional chain's `undefined`.
			const tools = this.#tools
			if (tools === undefined) return undefined
			const tool = tools.tool(form.name)
			if (tool === undefined) return undefined
			const result = await tools.execute({
				id: controller.task.id,
				name: form.name,
				arguments: controller.input,
			})
			// A `tool` result NEVER throws — the manager isolates a handler throw into `result.error`.
			// Surface that as a task failure (so a failing tool `fail`s the leaf, honouring `bail`),
			// else return the value as the task's completed outcome.
			if (result.error !== undefined) throw new Error(result.error)
			return result.value
		}
		if (form !== undefined && isAgentTask(form)) {
			return this.#dispatchAgent(form.name, controller, depth, ancestry)
		}
		// An unregistered name — auto-complete.
		return undefined
	}

	// Dispatch an `agent` task (W-c2): resolve the subagent, apply the depth + cycle guard, BIND
	// the depth/cycle-aware workflow tool onto its context (the propagation seam), fold the task's
	// cancellation into the run, and drive it — returning its `AgentResult` as the task's outcome.
	// An UNREGISTERED agent name auto-completes (no-handler rule, consistent with function/tool).
	async #dispatchAgent(
		name: string,
		controller: TaskController,
		depth: number,
		ancestry: readonly string[],
	): Promise<unknown> {
		const resolve = this.#agents
		if (resolve === undefined) return undefined
		const agent = resolve(name)
		if (agent === undefined) return undefined
		// GUARD (before running the agent): running it would let it author + run a NESTED workflow
		// at `depth + 1`, so reject when that would exceed the bound, OR when this agent is already
		// an ancestor (a re-entry cycle). The throw becomes the leaf's typed `DEPTH` failure.
		if (depth + 1 > MAX_WORKFLOW_DEPTH) {
			throw new WorkflowError('DEPTH', `agent '${name}' exceeds max workflow depth`, {
				agent: name,
				depth,
				max: MAX_WORKFLOW_DEPTH,
			})
		}
		const tag = agentTag(name)
		if (ancestry.includes(tag)) {
			throw new WorkflowError('DEPTH', `agent '${name}' is already an ancestor (cycle)`, {
				agent: name,
				ancestry: [...ancestry],
			})
		}
		// BIND the workflow tool so the subagent can fan out into a nested workflow at `depth + 1`
		// with THIS agent added to the ancestry — the propagation across the agent/tool boundary
		// (closed over the tool at bind time, since a tool handler receives no ambient context). The
		// current workflow's id (the task's lineage) is the tool's WRAPPED default, used only on a
		// no-args call — re-running it is a cycle the guard catches, a safe default.
		this.#bindWorkflowTool(agent, depth, [...ancestry, tag], controller.task.phase.workflow.id)
		return this.#runAgent(agent, controller.signal)
	}

	// BIND the depth/cycle-aware workflow tool onto a subagent's context (under
	// WORKFLOW_TOOL_NAME) so it can author + run a NESTED workflow. The tool is built via the
	// injected `createWorkflowTool` (closing over `depth` / `ancestry`), so when the subagent
	// invokes it the handler runs the nested workflow at `depth + 1` with the extended ancestry —
	// the depth/ancestry travel through the closure, not the (context-free) tool-call boundary.
	// `workflowId` is the wrapped default (the agent's own current workflow), used only on a no-args
	// call. No-op when no binder was injected (an agent with no workflow tool still runs its turn).
	#bindWorkflowTool(
		agent: AgentInterface,
		depth: number,
		ancestry: readonly string[],
		workflowId: string,
	): void {
		const bind = this.#workflowTool
		if (bind === undefined) return
		const wrapped: WorkflowDefinition = { id: workflowId, name: workflowId, phases: [] }
		agent.context.tools.add(bind(wrapped, this, { depth, ancestry }))
	}

	// Run a resolved subagent to its settled `AgentResult`, folding the task's cancellation: an
	// already-aborted signal cancels the agent up front; otherwise a one-shot listener fires
	// `agent.abort(reason)` when the workflow cancels (so a run-level / sibling cancel stops the
	// subagent). `generate()` RESOLVES a partial on a cancel (never rejects), so a cancelled
	// subagent settles — the caller's post-dispatch `signal.aborted` check then `skip`s the task.
	async #runAgent(agent: AgentInterface, signal: AbortSignal): Promise<unknown> {
		const onAbort = (): void => agent.abort(signal.reason)
		if (signal.aborted) {
			agent.abort(signal.reason)
		} else {
			signal.addEventListener('abort', onAbort, { once: true })
		}
		try {
			return await agent.generate()
		} finally {
			signal.removeEventListener('abort', onAbort)
		}
	}

	// The per-task folded signal: ANY-combine the substrate per-unit signal with the run signal
	// (when present), via the shipped `createAbort` parent-linking (`AbortSignal.any`). No
	// hand-rolled listener wiring — the abort primitive owns the fold.
	#taskSignal(unitSignal: AbortSignal, runSignal: AbortSignal | undefined): AbortSignal {
		if (runSignal === undefined) return unitSignal
		const abort: AbortInterface = createAbort({ signal: AbortSignal.any([unitSignal, runSignal]) })
		return abort.signal
	}

	// Fold the run-level bounds into ONE signal — the external `signal`, the deadline, and the
	// budget combined via `AbortSignal.any` (the agent runtime's `#parents` pattern). A lone
	// present bound is returned directly; none ⇒ `undefined` (no run-level cancellation).
	#fold(
		options: WorkflowRunOptions | undefined,
		timeout: TimeoutInterface | undefined,
	): AbortSignal | undefined {
		const signals: AbortSignal[] = []
		if (options?.signal !== undefined) signals.push(options.signal)
		if (timeout !== undefined) signals.push(timeout.signal)
		if (options?.budget !== undefined) signals.push(options.budget.signal)
		if (signals.length === 0) return undefined
		if (signals.length === 1) return signals[0]
		return AbortSignal.any(signals)
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

	// Skip one task iff it is not already terminal — a settled leaf has no legal `skip`
	// transition (it would throw a `TRANSITION` WorkflowError), so guard on the live status.
	#skip(task: TaskInterface): void {
		if (task.status === 'pending' || task.status === 'running') task.skip()
	}

	// Whether an in-flight task is being GENUINELY CANCELLED (and so should `skip`), as opposed to
	// merely TIMED OUT (which retries / fails). Three causes can fire a task's attempt signal; only
	// two are cancels: the unit `Abort` — `controller.aborted` — fired by a SIBLING fail-fast under
	// bail OR by a run-level cancel I forwarded through the phase Runner's abort; and the run signal
	// directly (`runSignal.aborted`). A per-attempt TIMEOUT fires NEITHER (it aborts only the deadline
	// portion of the attempt signal, never the unit `Abort` nor the run signal), so it is excluded —
	// the precise discriminator that keeps a timeout off the skip path. A fresh read each call so it
	// reflects a cancel that landed mid-dispatch.
	#skipping(
		controller: ControllerInterface<TaskInterface, void>,
		runSignal: AbortSignal | undefined,
	): boolean {
		return controller.aborted || runSignal?.aborted === true
	}

	// Whether the run-level signal has fired (a fresh read, so it reflects an abort that landed
	// during a phase) — `false` when there is no run signal at all.
	#cancelled(runSignal: AbortSignal | undefined): boolean {
		return runSignal?.aborted === true
	}

	// Whether the workflow is no longer runnable — its derived status has reached a terminal
	// state (a bail-true failure flipped it to `failed`, or a force `skip` / `stop`), so the
	// remaining phases must not start.
	#halted(workflow: WorkflowInterface): boolean {
		const status = workflow.status
		return status === 'failed' || status === 'skipped' || status === 'stopped'
	}

	// Whether a run-level cancel should force `stop` — yes UNLESS the workflow already settled a
	// genuine `failed` (a bail-true failure: preserve it, never mask it with `stopped`) or is
	// ALREADY `stopped` (idempotent). A `skipped` derived status is the CONSEQUENCE of the
	// runner's own per-task skips on the cancel path, so `stop` SHOULD supersede it (the
	// override wins) — the workflow settles `stopped`, the true outcome of a cancelled run.
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

	// Correlate a live phase to its definition by positional `id` — the source of its
	// `concurrency`. `undefined` when the definition has no matching phase (defensive — the
	// caller passes the SAME definition the tree was built from).
	#phaseOf(definition: WorkflowDefinition, id: string): PhaseDefinition | undefined {
		return definition.phases.find((phase) => phase.id === id)
	}

	// Correlate a live task to its definition by positional `id` within its phase — the source
	// of its `run` form. `undefined` ⇒ the no-handler auto-complete path in `#dispatch`.
	#taskOf(phase: PhaseDefinition | undefined, id: string): TaskDefinition | undefined {
		return phase?.tasks.find((task) => task.id === id)
	}
}
