import type {
	ControllerInterface,
	LifecycleStatus,
	PhaseContext,
	PhaseDerivation,
	PhaseInterface,
	PhaseSnapshot,
	TaskContext,
	TaskInterface,
	TaskResult,
	TaskSnapshot,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowInterface,
	WorkflowOptions,
	WorkflowRegistry,
	WorkflowSnapshot,
} from './types.js'
import type { Failure, Success } from '@orkestrel/contract'
import { isAbortSignal, linkSignal } from '@orkestrel/abort'
import {
	isArray,
	isBoolean,
	isFiniteNumber,
	isFunction,
	isInteger,
	isJSONValue,
	isNonEmptyString,
	isRecord,
} from '@orkestrel/contract'
import { DEFAULT_BAIL, MAX_TIMER_MS, TASK_TRANSITIONS, TERMINAL_STATUSES } from './constants.js'
import { WorkflowError } from './errors.js'
import { isLifecycleStatus, isTaskFailure } from './validators.js'

/**
 * Captures every top-level {@link WorkflowOptions} value exactly once into an owned plain bag.
 *
 * @remarks
 * Direct property reads preserve inherited and non-enumerable option values while preventing
 * accessor-backed caller bags from shifting policy, handlers, hooks, or nested options between
 * construction stages. Nested bags and the functions registry retain their original identities so
 * entity constructors can snapshot keyed child options and live additions can resolve against the
 * same registry.
 *
 * @param options - The caller-owned workflow construction options
 * @returns An owned top-level options bag containing the captured values
 *
 * @example
 * ```ts
 * const captured = captureWorkflowOptions(options)
 * const workflow = createWorkflow(definition, captured)
 * ```
 */
export function captureWorkflowOptions(options?: WorkflowOptions): WorkflowOptions {
	const on = options?.on
	const bail = options?.bail
	const error = options?.error
	const phases = options?.phases
	const functions = options?.functions
	const silence = options?.silence
	return Object.freeze({
		...(on === undefined ? {} : { on }),
		...(bail === undefined ? {} : { bail }),
		...(error === undefined ? {} : { error }),
		...(phases === undefined ? {} : { phases }),
		...(functions === undefined ? {} : { functions }),
		...(silence === undefined ? {} : { silence }),
	})
}

// Workflow derivation helpers — pure, side-effect-free functions. Every function is
// exported and unit-tested. The status derivations encode
// the lifecycle truth-table logic: a phase status is derived from its tasks'
// statuses, a workflow status from its phases' statuses UNDER the `bail` policy.
// Determinism is fixed by design (tasks concurrent, phases sequential), so these
// derivations are order-insensitive set reductions, never sequencing decisions.

// === Status predicates

/**
 * Tests whether a {@link LifecycleStatus} is TERMINAL — a node in this state will not
 * transition further.
 *
 * @remarks
 * The ONE terminal check across every tier (AGENTS.md § Design laws, "one concept, one term"):
 * a task, a phase, and a workflow share the same {@link LifecycleStatus} vocabulary, so a
 * single predicate covers them — {@link derivePhaseStatus} and {@link deriveWorkflowStatus}
 * both consult it to tell a settled node from an in-flight one. It reads the terminal set from
 * {@link import('./constants.js').TERMINAL_STATUSES} (`completed` / `failed` / `skipped` /
 * `stopped`), so that constant is the one definition; the only non-terminal states are `pending`
 * and `running`.
 *
 * @param status - The lifecycle status to test (a task / phase / workflow status)
 * @returns True if the status is terminal; false otherwise
 */
export function isTerminalStatus(status: LifecycleStatus): boolean {
	return TERMINAL_STATUSES.includes(status)
}

/**
 * Tests whether a driving run must stop giving a workflow more work.
 *
 * @remarks
 * The halt gate a {@link import('./WorkflowRunner.js').WorkflowRunner} consults before starting a
 * phase, before dispatching a task, and after every cooperative gate. A workflow is halted after
 * its derived status is terminal but NOT `completed` — a `bail: true` failure, a caller's own
 * graceful `stop()`, or a forced `skip`. `completed` is excluded deliberately: a workflow that
 * completed vacuously is settled, not halted, and the distinction is what keeps the run from
 * sweeping a finished tree. When a `phase` is supplied, its own forced `skipped` / `stopped` halts
 * that phase's work too; a `failed` phase does not, because the workflow's own `bail` policy
 * decides whether a failed phase ends the run.
 *
 * @param workflow - The live workflow the run is driving
 * @param phase - The phase whose own forced terminal status also halts its tasks
 * @returns True if the run must stop giving this workflow (or phase) more work; false otherwise
 *
 * @example
 * ```ts
 * isHalted(workflow) // false while pending or running
 * workflow.stop()
 * isHalted(workflow) // true
 * ```
 */
export function isHalted(workflow: WorkflowInterface, phase?: PhaseInterface): boolean {
	const status = workflow.status
	// The workflow half is the terminal set minus `completed`, so it reads the one terminal
	// definition. The phase half is NOT that set — only a FORCED skip / stop halts a phase, because a
	// `failed` phase is the workflow policy's decision and a `completed` one is ordinary progress.
	return (
		(isTerminalStatus(status) && status !== 'completed') ||
		phase?.status === 'skipped' ||
		phase?.status === 'stopped'
	)
}

/**
 * Tests whether forcing a workflow `stopped` would still record something.
 *
 * @remarks
 * `stop()` is a no-op after a workflow's status becomes terminal, so a run that must record a
 * cancellation forces it only while this holds. It is NOT the negation of
 * {@link isTerminalStatus}: `completed` and `skipped` both pass, because a run-level cancel that
 * lands on a vacuously-completed or fully-skipped tree still records `stopped` as the outcome the
 * caller asked for. Only an already-`failed` or already-`stopped` workflow has a terminal state
 * worth keeping.
 *
 * @param workflow - The live workflow a run-level cancel would force
 * @returns True if forcing `stopped` would change the recorded outcome; false otherwise
 *
 * @example
 * ```ts
 * isStoppable(workflow) // true while pending, running, completed, or skipped
 * workflow.stop()
 * isStoppable(workflow) // false
 * ```
 */
export function isStoppable(workflow: WorkflowInterface): boolean {
	const status = workflow.status
	return status !== 'failed' && status !== 'stopped'
}

/**
 * Tests whether a naturally-finished run may force its workflow `completed`.
 *
 * @remarks
 * A run that walked every phase and still derives `pending` executed nothing — zero phases, or
 * every phase empty — so it is vacuously done and the run settles it `completed`. Gated on
 * EXACTLY `pending` so a real `completed`, a `bail: true` `failed`, a `stopped`, or a derived
 * `skipped` is never overridden. The tree-is-empty half of the rule is
 * {@link WorkflowInterface.complete}'s own guard, which refuses a pending tree that still holds
 * tasks.
 *
 * @param workflow - The live workflow the run has finished walking
 * @returns True if the run may force the vacuous completion; false otherwise
 *
 * @example
 * ```ts
 * isCompletable(createWorkflow({ id: 'w', name: 'W', phases: [] })) // true
 * ```
 */
export function isCompletable(workflow: WorkflowInterface): boolean {
	return workflow.status === 'pending'
}

/**
 * Tests whether a task attempt is being genuinely cancelled rather than merely timed out.
 *
 * @remarks
 * The discriminator that keeps a per-attempt deadline off the skip path. Three causes fire a
 * running task's folded signal, and only two of them mean "skip this task": the task's own
 * `signal` (its `stop` / `skip`), and the unit or run signal (a sibling fail-fast under
 * `bail: true`, or a run-level abort / timeout / budget / `destroy`). A bare per-attempt timeout
 * fires NEITHER — it aborts only the deadline portion of the attempt signal — so it stays a
 * retryable failure of that attempt instead of skipping the leaf and losing the recorded fault.
 * Read fresh at each call so a cancel that lands mid-dispatch is seen.
 *
 * @param task - The live task the attempt is driving
 * @param controller - The substrate unit handle carrying the unit-level abort
 * @param runSignal - The run's folded cancellation signal
 * @returns True if the attempt is being genuinely cancelled; false otherwise
 *
 * @example
 * ```ts
 * isSkipping(task, controller, runSignal) // false until a cancel fires
 * ```
 */
export function isSkipping(
	task: TaskInterface,
	controller: ControllerInterface<TaskInterface, void>,
	runSignal: AbortSignal,
): boolean {
	return task.signal.aborted || controller.aborted || runSignal.aborted
}

/**
 * Tests whether one attempt still owns the task it launched.
 *
 * @remarks
 * A retried task is re-dispatched while an earlier attempt's handler may still be resolving, so
 * every settlement path re-checks ownership before touching the leaf. Ownership needs BOTH
 * halves: the run-local `owners` ledger must still name this attempt, and the live task's own
 * `attempts` tally must still match it. A superseded attempt reads `false` and returns without
 * recording anything, so a late resolution can never overwrite the newer attempt's outcome.
 *
 * @param owners - The run-local ledger of the attempt owning each task id
 * @param task - The live task the attempt launched
 * @param attempt - The one-based attempt number to test
 * @returns True if `attempt` still owns `task`; false otherwise
 *
 * @example
 * ```ts
 * const owners = new Map([[task.id, 1]])
 * ownsAttempt(owners, task, 1) // true while the task's own `attempts` is 1
 * ownsAttempt(owners, task, 2) // false
 * ```
 */
export function ownsAttempt(
	owners: Map<string, number>,
	task: TaskInterface,
	attempt: number,
): boolean {
	return owners.get(task.id) === attempt && task.attempts === attempt
}

// === Status derivation

/**
 * Derives a phase's status from its tasks' statuses (tasks are concurrent, so this
 * is an order-insensitive reduction).
 *
 * @remarks
 * The truth table (most-severe terminal wins; `bail`-agnostic — a phase surfaces a
 * task failure as `failed` so the workflow's `bail` policy can decide):
 * - no tasks ⇒ `pending`.
 * - any task `running`, OR a mix of started-and-unsettled tasks (some non-`pending`
 *   but not all terminal) ⇒ `running`.
 * - every task `pending` ⇒ `pending`.
 * - all terminal: any `failed` ⇒ `failed`; else any `stopped` ⇒ `stopped`; else any
 *   `completed` ⇒ `completed`; else (all `skipped`) ⇒ `skipped`.
 *
 * So an all-`skipped` phase is `skipped`, an all-`stopped` phase is `stopped`, a
 * phase with completed tasks and some skips is `completed`, and a single failed
 * task makes the phase `failed`.
 *
 * @param tasks - The phase's task statuses, in any order
 * @returns The derived phase {@link LifecycleStatus}
 */
export function derivePhaseStatus(tasks: readonly LifecycleStatus[]): LifecycleStatus {
	if (tasks.length === 0) return 'pending'
	if (tasks.every((status) => status === 'pending')) return 'pending'
	if (!tasks.every((status) => isTerminalStatus(status))) return 'running'
	if (tasks.some((status) => status === 'failed')) return 'failed'
	if (tasks.some((status) => status === 'stopped')) return 'stopped'
	if (tasks.some((status) => status === 'completed')) return 'completed'
	return 'skipped'
}

/**
 * Derives a workflow's status from its phases' {@link PhaseDerivation}s — each phase's status
 * paired with the EFFECTIVE `bail` it ran under (`phase.bail ?? workflow.bail`) — so the
 * failure outcome is PER-PHASE-bail-aware (phases are sequential, but the derivation is an
 * order-insensitive reduction over the settled set).
 *
 * @remarks
 * `bail` is a per-phase override, so it is carried on each
 * {@link PhaseDerivation} rather than passed as one scalar. It is the ONLY axis that changes
 * the failure outcome, decided per phase:
 * - **A `failed` phase whose effective `bail` is `true` (halt)** propagates ⇒ the workflow is
 *   `failed` (the database-transaction halt) — even when the workflow default is graceful.
 * - **A `failed` phase whose effective `bail` is `false` (graceful)** is DATA, not a workflow
 *   failure — it folds into completion like a settled phase. A graceful failed phase NEVER
 *   makes the workflow `failed` — even when the workflow default is strict.
 *
 * The rest of the table is shared:
 * - no phases ⇒ `pending`.
 * - any phase `running`, OR a mix of started-and-unsettled phases (some non-`pending`
 *   but not all terminal) ⇒ `running`.
 * - every phase `pending` ⇒ `pending`.
 * - all terminal (a `failed` phase counts as terminal here): any `stopped` ⇒ `stopped`; else
 *   any `completed` (or any graceful-bail `failed`, folded into completion) ⇒ `completed`;
 *   else (all `skipped`) ⇒ `skipped`.
 *
 * @param phases - The workflow's per-phase {@link PhaseDerivation}s (status + effective bail), in any order
 * @returns The derived workflow {@link LifecycleStatus}
 */
export function deriveWorkflowStatus(phases: readonly PhaseDerivation[]): LifecycleStatus {
	if (phases.length === 0) return 'pending'
	if (phases.some((phase) => phase.status === 'failed' && phase.bail)) return 'failed'
	if (phases.every((phase) => phase.status === 'pending')) return 'pending'
	if (!phases.every((phase) => isTerminalStatus(phase.status))) return 'running'
	if (phases.some((phase) => phase.status === 'stopped')) return 'stopped'
	// A `completed` phase — or a graceful-bail `failed` phase, folded into completion — makes the
	// whole workflow complete.
	if (
		phases.some(
			(phase) => phase.status === 'completed' || (phase.status === 'failed' && !phase.bail),
		)
	) {
		return 'completed'
	}
	return 'skipped'
}

// === Pending-suffix boundary (bottom-up NATIVE mutation gating)

/**
 * Derives the PENDING SUFFIX boundary of a positional list of {@link LifecycleStatus}es —
 * the index of the first entry in the contiguous trailing run of `pending` entries.
 *
 * @remarks
 * The native, hook-free replacement for a runner-installed cursor: a
 * {@link import('./types.js').WorkflowInterface}'s `add` / `remove` / `move` / `update`
 * reads this over its live phases' statuses to decide which positions are safe to edit.
 * Because entries run SEQUENTIALLY (phases sequential, AGENTS determinism), every
 * already-started entry forms a contiguous LEADING prefix and every still-`pending`
 * entry forms the trailing suffix — so the boundary is the count of leading
 * non-`pending` entries: the index of the first `pending` entry, or the full length when
 * none is `pending` (nothing is safely editable). A `pending` container's entries are ALL
 * `pending`, so the boundary is `0` and every position is naturally accepted — callers
 * need no special case for that.
 *
 * @param statuses - The positional list of statuses to derive the boundary from
 * @returns The index of the first `pending` entry, or `statuses.length` when none is `pending`
 *
 * @example
 * ```ts
 * deriveBoundary(['completed', 'running', 'pending', 'pending']) // 2
 * deriveBoundary(['pending', 'pending']) // 0
 * deriveBoundary(['completed', 'completed']) // 2 (nothing pending)
 * ```
 */
export function deriveBoundary(statuses: readonly LifecycleStatus[]): number {
	const index = statuses.findIndex((status) => status === 'pending')
	return index === -1 ? statuses.length : index
}

// === Task state-machine guards (the W-b transition graph + override)

/**
 * Tests whether the live W-b task state machine may move directly from one
 * {@link LifecycleStatus} to another — the legal-transition guard.
 *
 * @remarks
 * Reads the {@link import('./constants.js').TASK_TRANSITIONS} graph: `true` only when
 * `to` is listed under `from`. A settled (terminal) `from` has no legal targets, so any
 * transition off it is `false`. The W-b `Task` consults this before every transition and
 * throws a `TRANSITION` {@link import('./errors.js').WorkflowError} when it returns `false`.
 *
 * @param from - The task's current status
 * @param to - The status the transition would move it to
 * @returns True if the move is legal; false otherwise
 */
export function canTransitionTask(from: LifecycleStatus, to: LifecycleStatus): boolean {
	return TASK_TRANSITIONS[from].includes(to)
}

/**
 * Resolves a task's runtime silence window against its workflow default.
 *
 * @param value - The task-level override; any present non-positive or non-finite value disables
 * @param fallback - The workflow-level default
 * @returns A host-safe effective window (`1..MAX_TIMER_MS`), or `undefined`
 */
export function resolveTaskSilence(
	value: number | undefined,
	fallback: number | undefined,
): number | undefined {
	if (value !== undefined) {
		return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS ? value : undefined
	}
	return fallback !== undefined &&
		Number.isFinite(fallback) &&
		fallback > 0 &&
		fallback <= MAX_TIMER_MS
		? fallback
		: undefined
}

// === Result construction (`@orkestrel/contract` ships the `Result` /
// `Success` / `Failure` TYPES but no `success`/`failure` constructors, so this module
// provides the ones every gated Result-constructing site in this package's W-b entities
// + managers uses instead of a hand-rolled `{ success: true/false, ... }` literal)

/**
 * Boxes a value as a {@link Success} — the graceful outcome half of a {@link Result}.
 *
 * @typeParam T - The boxed value's type
 * @param value - The value to box
 * @returns A {@link Success} wrapping `value`
 *
 * @example
 * ```ts
 * const result = success(task) // { success: true, value: task }
 * ```
 */
export function success<T>(value: T): Success<T> {
	return { success: true, value }
}

/**
 * Boxes an error as a {@link Failure} — the graceful outcome half of a {@link Result}.
 *
 * @typeParam E - The boxed error's type
 * @param error - The error to box
 * @returns A {@link Failure} wrapping `error`
 *
 * @example
 * ```ts
 * const result = failure(new WorkflowError('MUTATION', 'refused')) // { success: false, error }
 * ```
 */
export function failure<E>(error: E): Failure<E> {
	return { success: false, error }
}

/**
 * Normalizes an unknown thrown value to a non-empty persistence-safe message.
 *
 * @param error - The caught value
 * @returns A non-empty message without stack or cause data
 */
export function errorToMessage(error: unknown): string {
	try {
		const message = error instanceof Error ? error.message : String(error)
		return typeof message === 'string' && message.length > 0 ? message : 'unknown failure'
	} catch {
		return 'unknown failure'
	}
}

// === Result-tree collection

/**
 * Finds the first {@link TaskResult} in a positional list whose boxed outcome is a
 * `Failure` — the pure scan shared by a phase's and a workflow's derived-`failed`
 * `fail`-event lookup.
 *
 * @remarks
 * The shared leaf behind {@link import('./phases/Phase.js').Phase} and
 * {@link import('./Workflow.js').Workflow}'s own `#failure` — each gathers ITS tier's
 * results (a phase's own settled tasks, a workflow's flattened `results()`) and feeds
 * them here; the tier-local method keeps the invariant throw (a derived `failed`
 * status means a failing result exists) because throwing on `undefined` is
 * orchestration, not a leaf concern.
 *
 * @param results - The results to scan, in any order
 * @returns The first result whose `result.success` is `false`, or `undefined` if none
 *
 * @example
 * ```ts
 * findFailure([completedResult, failedResult]) // failedResult
 * ```
 */
export function findFailure(results: readonly TaskResult[]): TaskResult | undefined {
	return results.find((result) => result.result?.success === false)
}

// === Lineage context builders (the chain carried back UP the tree)

/**
 * Builds a {@link WorkflowContext} — the identity every level inherits — from a node's
 * `id` / `name` / optional `description`.
 *
 * @remarks
 * The root of the context chain a live {@link import('./Workflow.js').Workflow} exposes;
 * {@link buildPhaseContext} / {@link buildTaskContext} extend it down the tree. Accepts a
 * structural node (a definition or a snapshot node — both carry the three identity fields).
 *
 * @param node - The node's identity (`id` / `name` / optional `description`)
 * @returns The {@link WorkflowContext}
 */
export function buildWorkflowContext(node: WorkflowContext): WorkflowContext {
	return Object.freeze({
		id: node.id,
		name: node.name,
		...(node.description === undefined ? {} : { description: node.description }),
	})
}

/**
 * Builds a {@link PhaseContext} — a phase's own identity plus a back-reference to its
 * workflow — from the parent {@link WorkflowContext} and the phase node's identity.
 *
 * @param workflow - The parent workflow context (the lineage pointer UP the tree)
 * @param node - The phase's identity (`id` / `name` / optional `description`)
 * @returns The {@link PhaseContext}
 */
export function buildPhaseContext(workflow: WorkflowContext, node: WorkflowContext): PhaseContext {
	return Object.freeze({ ...buildWorkflowContext(node), workflow: buildWorkflowContext(workflow) })
}

/**
 * Builds a {@link TaskContext} — a task's own identity plus a back-reference to its phase
 * (and, transitively, its workflow) — from the parent {@link PhaseContext} and the task
 * node's identity.
 *
 * @param phase - The parent phase context (carrying the full lineage UP the tree)
 * @param node - The task's identity (`id` / `name` / optional `description`)
 * @returns The {@link TaskContext}
 */
export function buildTaskContext(phase: PhaseContext, node: WorkflowContext): TaskContext {
	return Object.freeze({
		...buildWorkflowContext(node),
		phase: buildPhaseContext(phase.workflow, phase),
	})
}

// === Definition → initial snapshot (the unified construction input)

/**
 * Converts a {@link WorkflowDefinition} into an INITIAL {@link WorkflowSnapshot} — every
 * node `pending`, no results, empty metadata — so the live W-b tree has ONE construction
 * path (snapshot-driven) for both a fresh build and a restore.
 *
 * @remarks
 * The structural fields (`id` / `name` / `description` + the ordered phases / tasks)
 * carry over verbatim, as does each phase's `concurrency` (persisted on the
 * {@link PhaseSnapshot} so a restore reinstates the same throttle) and each task's `behavior` /
 * `retries` / `timeout` (persisted on the {@link TaskSnapshot}, like `bail` / `concurrency`,
 * so a restore + a {@link import('./types.js').WorkflowOptions.functions} registry resumes
 * real work). The `bail` policy carries over — at the
 * workflow tier AND, per phase, the
 * EFFECTIVE policy (`phase.bail ?? workflowBail`) on each {@link PhaseSnapshot} — so the seeded
 * snapshot is self-contained; a fresh seed has no `override`. `created` / `updated` are stamped at that point.
 * {@link import('./factories.js').createWorkflow} builds from this.
 *
 * The optional `bail` override is the EFFECTIVE workflow policy the tree will run under
 * (`createWorkflow` / the runner resolve `options.bail ?? definition.bail ?? DEFAULT_BAIL` and
 * pass it here), so an `options.bail` override reaches BOTH the workflow tier AND the
 * inheritance default of every phase that declares no `bail` of its own — otherwise the
 * per-phase seeds would silently ignore the override. Omitted ⇒ the definition's own `bail`
 * (defaulting to the graceful {@link import('./constants.js').DEFAULT_BAIL}).
 *
 * @param definition - The workflow definition to seed from
 * @param bail - The EFFECTIVE workflow bail to seed both tiers with (defaults to the definition's)
 * @returns An initial, all-`pending` {@link WorkflowSnapshot}
 */
export function definitionToSnapshot(
	definition: WorkflowDefinition,
	bail?: boolean,
): WorkflowSnapshot {
	const now = Date.now()
	// The effective workflow-level policy each phase inherits when it declares no `bail` of its own
	// — the supplied override (an `options.bail`) when given, else the definition's own default. The
	// source of the per-phase effective policy persisted on every PhaseSnapshot.
	const workflowBail = bail ?? definition.bail ?? DEFAULT_BAIL
	return {
		id: definition.id,
		name: definition.name,
		...(definition.description === undefined ? {} : { description: definition.description }),
		status: 'pending',
		bail: workflowBail,
		phases: definition.phases.map((phase) => phaseDefinitionToSnapshot(phase, workflowBail)),
		created: now,
		updated: now,
	}
}

/**
 * Converts one {@link import('./types.js').PhaseDefinition} into an initial, all-`pending`
 * {@link PhaseSnapshot} — the per-phase step of {@link definitionToSnapshot}.
 *
 * @remarks
 * The snapshot persists the EFFECTIVE failure policy this phase runs under: the phase's own
 * `bail` when it declares one, else the `workflowBail` it inherits — so a restore reinstates
 * the same per-phase policy without a silent default (`effectiveBail = phase.bail ?? workflowBail`).
 * `concurrency` (the resource throttle) carries over verbatim, omitted when undefined.
 *
 * @param phase - The phase definition to seed from
 * @param workflowBail - The workflow-level `bail` default the phase inherits when it declares none
 * @returns An initial {@link PhaseSnapshot}
 */
export function phaseDefinitionToSnapshot(
	phase: WorkflowDefinition['phases'][number],
	workflowBail: boolean,
): PhaseSnapshot {
	return {
		id: phase.id,
		name: phase.name,
		...(phase.description === undefined ? {} : { description: phase.description }),
		status: 'pending',
		bail: phase.bail ?? workflowBail,
		...(phase.concurrency === undefined ? {} : { concurrency: phase.concurrency }),
		tasks: phase.tasks.map((task) => taskDefinitionToSnapshot(task)),
	}
}

/**
 * Converts one {@link import('./types.js').TaskDefinition} into an initial, `pending`
 * {@link TaskSnapshot} — the per-task leaf step of {@link definitionToSnapshot} (no
 * result yet, empty metadata).
 *
 * @remarks
 * `behavior` / `retries` / `timeout` carry over verbatim (persisted declarative config, like a
 * phase's `bail` / `concurrency`) — a restore reinstates the same behavior reference and
 * reliability overrides after pairing with a {@link import('./types.js').WorkflowOptions.functions}
 * registry.
 *
 * @param task - The task definition to seed from
 * @returns An initial {@link TaskSnapshot}
 */
export function taskDefinitionToSnapshot(
	task: WorkflowDefinition['phases'][number]['tasks'][number],
): TaskSnapshot {
	return {
		id: task.id,
		name: task.name,
		...(task.description === undefined ? {} : { description: task.description }),
		status: 'pending',
		metadata: {},
		attempts: 0,
		...(task.behavior === undefined ? {} : { behavior: task.behavior }),
		...(task.retries === undefined ? {} : { retries: task.retries }),
		...(task.timeout === undefined ? {} : { timeout: task.timeout }),
	}
}

/**
 * Converts interrupted running work into a recoverable pending suffix or an
 * exhausted recovery failure without replenishing attempts.
 *
 * @param snapshot - A fully validated owned snapshot with no terminal overrides
 * @returns The recovery projection
 */
export function recoverWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
	const phases: PhaseSnapshot[] = []
	let halted = false
	const now = Math.max(Date.now(), snapshot.updated)
	const workflow = buildWorkflowContext(snapshot)
	for (const phase of snapshot.phases) {
		const exhausted = new Set<string>()
		for (const task of phase.tasks) {
			const budget = (task.retries ?? 0) + 1
			if (task.status === 'running' && task.attempts >= budget) exhausted.add(task.id)
		}
		const strict =
			phase.bail && (exhausted.size > 0 || phase.tasks.some((task) => task.status === 'failed'))
		const tasks: TaskSnapshot[] = []
		for (const task of phase.tasks) {
			const eligible = task.status === 'pending' || task.status === 'running'
			if ((halted || strict) && eligible && !exhausted.has(task.id)) {
				tasks.push({ ...task, status: 'skipped' })
				continue
			}
			if (!exhausted.has(task.id)) {
				if (task.status === 'running') {
					const { activity: _activity, ...pending } = task
					tasks.push({ ...pending, status: 'pending' })
				} else tasks.push(task)
				continue
			}
			const phaseContext = buildPhaseContext(workflow, phase)
			const taskContext = buildTaskContext(phaseContext, task)
			const result: TaskResult = {
				task: taskContext,
				phase: phaseContext,
				workflow,
				status: 'failed',
				result: {
					success: false,
					error: {
						origin: 'recovery',
						message: `task '${task.id}' exhausted its retry budget during recovery`,
					},
				},
				timestamp: now,
			}
			tasks.push({ ...task, status: 'failed', result })
		}
		const status = derivePhaseStatus(tasks.map((task) => task.status))
		phases.push({ ...phase, status, tasks })
		if (strict) halted = true
	}
	return {
		...snapshot,
		status: deriveWorkflowStatus(
			phases.map((phase) => ({ status: phase.status, bail: phase.bail })),
		),
		phases,
		updated: now,
	}
}

/**
 * Compares two optional description values.
 *
 * @remarks
 * The equality rule a lineage check needs: two descriptions match when they are the same value
 * AND that value is either a string or genuine absence. Anything else — a number, an object, a
 * `null` — never matches, even against itself, so a lineage stamped with a non-string description
 * is rejected rather than silently accepted.
 *
 * @param left - The first description value
 * @param right - The second description value
 * @returns True if both are the same string or both absent; false otherwise
 *
 * @example
 * ```ts
 * matchesDescription('build', 'build') // true
 * matchesDescription(undefined, undefined) // true
 * matchesDescription('build', undefined) // false
 * ```
 */
export function matchesDescription(left: unknown, right: unknown): boolean {
	return left === right && (left === undefined || typeof left === 'string')
}

/**
 * Tests a result's lineage against its containing snapshot nodes.
 *
 * @remarks
 * The four arguments are the result and the three snapshot nodes it claims to belong to, read
 * from the OUTSIDE in: a {@link TaskResult} is self-describing, so restoring one is only safe
 * when every identity it carries agrees with the tree it was found in. It checks the exact key
 * set at each level, that `status` equals the owning task's, and that the `task` / `phase` /
 * `workflow` contexts — including the nested `task.phase.workflow` lineage — carry the same `id`,
 * `name`, and `description` as the nodes containing them. It then requires the boxed outcome to
 * match the status: a `Success` holding JSON for `completed`, a `Failure` holding a
 * {@link TaskFailure} for `failed`, and nothing for any other status. Total — a hostile
 * prototype, accessor, or cycle answers `false` rather than throwing.
 *
 * @param value - The candidate {@link TaskResult}
 * @param workflow - The workflow snapshot node containing it
 * @param phase - The phase snapshot node containing it
 * @param task - The task snapshot node the result belongs to
 * @returns True if `value` is a {@link TaskResult} whose lineage and outcome match
 *   those nodes; false otherwise
 *
 * @example
 * ```ts
 * const snapshot = workflow.snapshot()
 * const phase = snapshot.phases[0]
 * const task = phase?.tasks[0]
 * isTaskResult(task?.result, snapshot, phase, task) // true for a settled task
 * ```
 */
export function isTaskResult(
	value: unknown,
	workflow: unknown,
	phase: unknown,
	task: unknown,
): value is TaskResult {
	try {
		if (
			!isRecord(value) ||
			!isRecord(workflow) ||
			!isRecord(phase) ||
			!isRecord(task) ||
			!Object.keys(value).every(
				(key) =>
					key === 'task' ||
					key === 'phase' ||
					key === 'workflow' ||
					key === 'status' ||
					key === 'result' ||
					key === 'timestamp',
			) ||
			!isLifecycleStatus(value.status) ||
			value.status !== task.status ||
			!isFiniteNumber(value.timestamp) ||
			value.timestamp < 0 ||
			!isRecord(value.task) ||
			!isRecord(value.phase) ||
			!isRecord(value.workflow) ||
			!Object.keys(value.workflow).every(
				(key) => key === 'id' || key === 'name' || key === 'description',
			) ||
			!Object.keys(value.phase).every(
				(key) => key === 'id' || key === 'name' || key === 'description' || key === 'workflow',
			) ||
			!Object.keys(value.task).every(
				(key) => key === 'id' || key === 'name' || key === 'description' || key === 'phase',
			)
		) {
			return false
		}
		if (
			value.task.id !== task.id ||
			value.task.name !== task.name ||
			!matchesDescription(value.task.description, task.description) ||
			value.phase.id !== phase.id ||
			value.phase.name !== phase.name ||
			!matchesDescription(value.phase.description, phase.description) ||
			value.workflow.id !== workflow.id ||
			value.workflow.name !== workflow.name ||
			!matchesDescription(value.workflow.description, workflow.description)
		) {
			return false
		}
		if (
			!isRecord(value.task.phase) ||
			!isRecord(value.task.phase.workflow) ||
			!isRecord(value.phase.workflow) ||
			!Object.keys(value.task.phase).every(
				(key) => key === 'id' || key === 'name' || key === 'description' || key === 'workflow',
			) ||
			!Object.keys(value.task.phase.workflow).every(
				(key) => key === 'id' || key === 'name' || key === 'description',
			) ||
			!Object.keys(value.phase.workflow).every(
				(key) => key === 'id' || key === 'name' || key === 'description',
			)
		) {
			return false
		}
		if (
			value.task.phase.id !== phase.id ||
			value.task.phase.name !== phase.name ||
			!matchesDescription(value.task.phase.description, phase.description) ||
			value.phase.workflow.id !== workflow.id ||
			value.phase.workflow.name !== workflow.name ||
			!matchesDescription(value.phase.workflow.description, workflow.description) ||
			value.task.phase.workflow.id !== workflow.id ||
			value.task.phase.workflow.name !== workflow.name ||
			!matchesDescription(value.task.phase.workflow.description, workflow.description)
		) {
			return false
		}
		if (value.status === 'completed') {
			return (
				isRecord(value.result) &&
				value.result.success === true &&
				Object.keys(value.result).every((key) => key === 'success' || key === 'value') &&
				isJSONValue(value.result.value)
			)
		}
		if (value.status === 'failed') {
			return (
				isRecord(value.result) &&
				value.result.success === false &&
				Object.keys(value.result).every((key) => key === 'success' || key === 'error') &&
				isTaskFailure(value.result.error)
			)
		}
		return false
	} catch {
		return false
	}
}

/**
 * Tests that every named task has a callable runtime handler before dispatch.
 *
 * @remarks
 * A snapshot lookup reads each unique `behavior` binding at most once from `functions`. A live workflow
 * validates its tasks' already-resolved handlers without consulting the retained registry again.
 * `functions` belongs to the snapshot overload alone; the live-workflow overload takes no registry
 * and reads each task's already-resolved `handler`.
 *
 * @param workflow - The persisted snapshot or constructed live workflow to validate
 * @param functions - The behavior registry the snapshot overload resolves each unique `behavior`
 * name against; omitted or `undefined` leaves every named task unresolved
 * @returns True if every named task resolves to a callable handler; false otherwise
 */
export function hasWorkflowHandlers(workflow: WorkflowInterface): boolean
export function hasWorkflowHandlers(
	workflow: WorkflowSnapshot,
	functions: WorkflowRegistry | undefined,
): boolean
export function hasWorkflowHandlers(
	workflow: WorkflowInterface | WorkflowSnapshot,
	functions?: WorkflowRegistry,
): boolean {
	if ('destroyed' in workflow) {
		for (const phase of workflow.phases.phases()) {
			for (const task of phase.tasks.tasks()) {
				if (task.behavior !== undefined && !isFunction(task.handler)) return false
			}
		}
		return true
	}
	const behaviors = new Set<string>()
	for (const phase of workflow.phases) {
		for (const task of phase.tasks) {
			if (task.behavior === undefined || behaviors.has(task.behavior)) continue
			behaviors.add(task.behavior)
			if (!isFunction(functions?.[task.behavior])) return false
		}
	}
	return true
}

/**
 * Locates the nearest identifiable node for an inconsistent owned snapshot.
 *
 * @remarks
 * The walk stops at the first phase or task whose persisted fields are inconsistent and returns
 * the identifiers it could read there, so a diagnostic can name the offending node even when part
 * of its identity is unreadable.
 *
 * @param value - The candidate snapshot, which may be any unknown value
 * @returns The nearest identifying record naming the offending `phase` and `task`, or `undefined`
 * when no inconsistent node is identifiable
 */
export function scanSnapshotContext(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (!isRecord(value) || !isArray(value.phases)) return undefined
	for (const phase of value.phases) {
		if (!isRecord(phase)) continue
		const phaseContext = isNonEmptyString(phase.id) ? { phase: phase.id } : undefined
		if (
			!isBoolean(phase.bail) ||
			(phase.concurrency !== undefined &&
				(!isInteger(phase.concurrency) || phase.concurrency < 1)) ||
			!isArray(phase.tasks)
		) {
			return phaseContext
		}
		for (const task of phase.tasks) {
			if (!isRecord(task)) continue
			if (
				(task.behavior !== undefined && !isNonEmptyString(task.behavior)) ||
				(task.retries !== undefined && (!isInteger(task.retries) || task.retries < 0)) ||
				(task.timeout !== undefined &&
					(!isInteger(task.timeout) || task.timeout < 0 || task.timeout > MAX_TIMER_MS)) ||
				!isInteger(task.attempts) ||
				task.attempts < 0
			) {
				return {
					...(phaseContext ?? {}),
					...(isNonEmptyString(task.id) ? { task: task.id } : {}),
				}
			}
		}
	}
	return undefined
}

/**
 * Flattens a nested list of per-phase {@link TaskResult} lists into one positional list
 * — the workflow tier of the result tree, built from each phase's `results()`.
 *
 * @remarks
 * Pure and order-preserving: phases in order, each phase's task results in order. The
 * W-b `Workflow.results()` calls this over its phases' `results()`; a phase's own
 * `results()` is the per-phase list this consumes.
 *
 * @param phases - The per-phase result lists, in phase order
 * @returns One flattened {@link TaskResult} list, in positional order
 */
export function collectResults(
	phases: ReadonlyArray<readonly TaskResult[]>,
): readonly TaskResult[] {
	return phases.flat()
}

// === Positional-entry array manipulation (the TaskManager/PhaseManager `add`/`move` core)

/**
 * Inserts one `[key, value]` entry at a positional index into a readonly entries array —
 * the pure splice-in step behind an insertion-ordered registry's `add`.
 *
 * @remarks
 * Used by the shared {@link import('./Collection.js').Collection} store both managers hold: it
 * converts its insertion-ordered `Map` to `[...map.entries()]`, calls this to splice the new entry
 * in at the target index, then rebuilds the `Map` from the result (a stateful step that stays a
 * `#` private method — this helper does no `Map` construction). Does not mutate `entries`;
 * returns a new array.
 *
 * @typeParam T - The entry's value type
 * @param entries - The current positional entries, in order
 * @param index - The index to insert at (`0` prepends, `entries.length` appends)
 * @param key - The new entry's key
 * @param value - The new entry's value
 * @returns A new entries array with `[key, value]` inserted at `index`
 *
 * @example
 * ```ts
 * insertEntry([['a', 1], ['b', 2]], 1, 'c', 3) // [['a', 1], ['c', 3], ['b', 2]]
 * ```
 */
export function insertEntry<T>(
	entries: ReadonlyArray<readonly [string, T]>,
	index: number,
	key: string,
	value: T,
): ReadonlyArray<readonly [string, T]> {
	const next = [...entries]
	next.splice(index, 0, [key, value])
	return next
}

/**
 * Repositions the entry keyed `key` to a new positional index in a readonly entries
 * array — the pure remove-then-reinsert step behind an insertion-ordered registry's
 * `move`.
 *
 * @remarks
 * The move counterpart of {@link insertEntry}: finds the entry by `key`, splices it
 * out, then splices it back in at `index`. An absent `key` is a no-op (returns a copy
 * of `entries` unchanged) — the caller, the shared
 * {@link import('./Collection.js').Collection} store's `move`, already gates on the target's
 * existence before calling this, so the no-op branch is defensive, never reached in practice.
 * Does not mutate `entries`; returns a new array.
 *
 * @typeParam T - The entry's value type
 * @param entries - The current positional entries, in order
 * @param key - The key of the entry to reposition
 * @param index - The new index for the entry
 * @returns A new entries array with the `key` entry repositioned to `index`
 *
 * @example
 * ```ts
 * moveEntry([['a', 1], ['b', 2], ['c', 3]], 'a', 2) // [['b', 2], ['c', 3], ['a', 1]]
 * ```
 */
export function moveEntry<T>(
	entries: ReadonlyArray<readonly [string, T]>,
	key: string,
	index: number,
): ReadonlyArray<readonly [string, T]> {
	const next = [...entries]
	const at = next.findIndex(([entryKey]) => entryKey === key)
	if (at === -1) return next
	const [entry] = next.splice(at, 1)
	if (entry !== undefined) next.splice(index, 0, entry)
	return next
}

/**
 * Schedules one cancellable host operation behind an owned settlement signal.
 *
 * @remarks
 * A defined `signal` that is not a native `AbortSignal` is refused before anything is armed, as a
 * rejected promise carrying a {@link import('./errors.js').WorkflowError} with the `SCHEDULE` code.
 * Rejecting rather than throwing keeps every caller on one settlement path, so a backend never has
 * to guard the call itself.
 *
 * The guard is necessary but not sufficient, so linking stays contained. A `Proxy` over a native
 * signal passes the guard and can still make linking throw from a trap, and that escape would be
 * synchronous — the one shape every caller here is built not to expect. Containment turns it into
 * the same `SCHEDULE` rejection, so setup has exactly one failure shape however hostile the input.
 *
 * The completion and failure paths each own an {@link AbortController}; their native composite is
 * linked to the optional caller signal before `start` can arm host work. Scheduler backends attach
 * only to that safe composite, so caller mutation of `addEventListener` or `removeEventListener`
 * cannot strand the operation. The first completion resolves, the first host failure rejects with
 * its exact value, and caller abort rejects with its exact linked reason. Caller abort and host
 * failure cancel an armed handle; synchronous settlement also cancels the handle immediately after
 * `start` returns it. Cancellation is secondary cleanup: if its closure throws, the already-winning
 * completion, exact host failure, or exact caller reason still settles without escape or replacement.
 *
 * @param start - Arm host work and return its cancellation closure
 * @param signal - Optional caller cancellation signal
 * @returns A promise settled exactly once by an invalid-signal refusal, completion, host failure,
 *   or caller abort
 */
export function scheduleHost(
	start: (complete: () => void, failure: (error: unknown) => void) => () => void,
	signal?: AbortSignal,
): Promise<void> {
	if (signal !== undefined && !isAbortSignal(signal)) {
		return Promise.reject(
			new WorkflowError('SCHEDULE', 'scheduleHost signal must be an AbortSignal', {
				signal: typeof signal,
			}),
		)
	}
	const completion = new AbortController()
	const failed = new AbortController()
	let settled: AbortSignal
	try {
		settled = linkSignal(AbortSignal.any([completion.signal, failed.signal]), signal)
	} catch {
		return Promise.reject(
			new WorkflowError('SCHEDULE', 'scheduleHost could not link the caller signal', {
				signal: typeof signal,
			}),
		)
	}
	if (settled.aborted) return Promise.reject(settled.reason)
	return new Promise<void>((resolve, reject) => {
		let cancel: (() => void) | undefined
		let hostFailure: unknown
		settled.addEventListener(
			'abort',
			() => {
				if (completion.signal.aborted) {
					resolve()
					return
				}
				const reason = failed.signal.aborted ? hostFailure : settled.reason
				try {
					cancel?.()
				} catch {}
				reject(reason)
			},
			{ once: true },
		)
		try {
			cancel = start(
				() => completion.abort(),
				(error) => {
					hostFailure = error
					failed.abort()
				},
			)
		} catch (error) {
			hostFailure = error
			failed.abort()
		}
		if (settled.aborted) {
			try {
				cancel?.()
			} catch {}
		}
	})
}

/**
 * Schedules the shared host timer boundary every scheduler backend resumes from.
 *
 * @remarks
 * The one `setTimeout` / `clearTimeout` boundary in the package: the cross-environment
 * {@link import('./Scheduler.js').Scheduler}, both Node primitives, and every browser backend's
 * `delay` and macrotask fallback route here, so the timer is armed and cleared in one place. It
 * composes {@link scheduleHost}, which owns listener safety, the cancellation race, the exact
 * caller reason, and once-only settlement. It does NOT validate `ms`: the value passes straight to
 * the host `setTimeout`, which clamps a negative value or `NaN` to about zero, so an
 * out-of-domain `ms` resumes on the next host turn rather than throwing. Pass a non-negative
 * finite `ms`.
 *
 * @param ms - The milliseconds to wait before resuming
 * @param signal - Optional caller cancellation signal
 * @returns A promise that resolves after `ms`, or rejects with the caller's exact abort reason
 *
 * @example
 * ```ts
 * const controller = new AbortController()
 * await delayHost(0, controller.signal) // a real macrotask host turn
 * ```
 */
export function delayHost(ms: number, signal?: AbortSignal): Promise<void> {
	return scheduleHost((complete) => {
		const handle = setTimeout(complete, ms)
		return () => clearTimeout(handle)
	}, signal)
}

/**
 * Parks until `signal` aborts — a promise-parked wait, never a timer or
 * busy-loop, that NEVER rejects.
 *
 * @remarks
 * Resolves IMMEDIATELY when `signal` is already aborted; otherwise attaches a one-shot
 * `abort` listener and resolves when it fires, removing the listener either way. The
 * shared leaf behind the duplicate abort-wiring an execution engine otherwise hand-rolls
 * at every fold point.
 *
 * @param signal - The signal to park on
 * @returns A promise that resolves after `signal` has aborted
 *
 * @example
 * ```ts
 * const controller = new AbortController()
 * const parked = parkSignal(controller.signal)
 * controller.abort()
 * await parked // resolves
 * ```
 */
export function parkSignal(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve()
	return new Promise((resolve) => {
		signal.addEventListener('abort', () => resolve(), { once: true })
	})
}
