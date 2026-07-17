import type {
	DeferredInterface,
	LifecycleStatus,
	PhaseContext,
	PhaseDerivation,
	PhaseSnapshot,
	PhaseStatus,
	TaskContext,
	TaskResult,
	TaskSnapshot,
	TaskStatus,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowSnapshot,
	WorkflowStatus,
} from './types.js'
import type { Failure, Success } from '@orkestrel/contract'
import { isArray, isBoolean, isNumber, isRecord, isString } from '@orkestrel/contract'
import { DEFAULT_BAIL, TASK_TRANSITIONS } from './constants.js'

// Workflow derivation helpers — pure, side-effect-free functions (AGENTS §4.3,
// §14). Every function is exported and unit-tested. The status derivations encode
// the §10/§14 truth-table logic: a phase status is derived from its tasks'
// statuses, a workflow status from its phases' statuses UNDER the `bail` policy.
// Determinism is fixed by design (tasks concurrent, phases sequential), so these
// derivations are order-insensitive set reductions, never sequencing decisions.

// === Status predicates

/**
 * Test whether a {@link LifecycleStatus} is TERMINAL — a node in this state will not
 * transition further.
 *
 * @remarks
 * The ONE terminal check across all three tiers (AGENTS §4.4 "one concept = one word"):
 * a task, a phase, and a workflow share the same {@link LifecycleStatus} vocabulary, so a
 * single predicate covers them — {@link derivePhaseStatus} and {@link deriveWorkflowStatus}
 * both consult it to tell a settled node from an in-flight one. Terminal: `completed` /
 * `failed` / `skipped` / `stopped`; the only non-terminal states are `pending` and
 * `running`.
 *
 * @param status - The lifecycle status to test (a task / phase / workflow status)
 * @returns `true` when the status is terminal
 */
export function isTerminalStatus(status: LifecycleStatus): boolean {
	return (
		status === 'completed' || status === 'failed' || status === 'skipped' || status === 'stopped'
	)
}

// === Status derivation

/**
 * Derive a phase's status from its tasks' statuses (tasks are concurrent, so this
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
 * @returns The derived {@link PhaseStatus}
 */
export function derivePhaseStatus(tasks: readonly TaskStatus[]): PhaseStatus {
	if (tasks.length === 0) return 'pending'
	if (tasks.every((status) => status === 'pending')) return 'pending'
	if (!tasks.every((status) => isTerminalStatus(status))) return 'running'
	if (tasks.some((status) => status === 'failed')) return 'failed'
	if (tasks.some((status) => status === 'stopped')) return 'stopped'
	if (tasks.some((status) => status === 'completed')) return 'completed'
	return 'skipped'
}

/**
 * Derive a workflow's status from its phases' {@link PhaseDerivation}s — each phase's status
 * paired with the EFFECTIVE `bail` it ran under (`phase.bail ?? workflow.bail`) — so the
 * failure outcome is PER-PHASE-bail-aware (phases are sequential, but the derivation is an
 * order-insensitive reduction over the settled set).
 *
 * @remarks
 * `bail` is now a per-phase override (AGENTS §4.4), so it is carried on each
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
 * @returns The derived {@link WorkflowStatus}
 */
export function deriveWorkflowStatus(phases: readonly PhaseDerivation[]): WorkflowStatus {
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
 * Derive the PENDING SUFFIX boundary of a positional list of {@link LifecycleStatus}es —
 * the index of the first entry in the contiguous trailing run of `pending` entries.
 *
 * @remarks
 * The native, hook-free replacement for a runner-installed cursor (AGENTS §12): a
 * {@link import('./types.js').WorkflowInterface}'s `add` / `remove` / `move` / `update`
 * reads this over its live phases' statuses to decide which positions are safe to edit.
 * Because entries run SEQUENTIALLY (phases sequential, AGENTS determinism), every
 * already-started entry forms a contiguous LEADING prefix and every still-`pending`
 * entry forms the trailing suffix — so the boundary is simply the count of leading
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
 * Test whether the live W-b task state machine may move directly from one
 * {@link TaskStatus} to another — the legal-transition guard.
 *
 * @remarks
 * Reads the {@link import('./constants.js').TASK_TRANSITIONS} graph: `true` only when
 * `to` is listed under `from`. A settled (terminal) `from` has no legal targets, so any
 * transition off it is `false`. The W-b `Task` consults this before every transition and
 * throws a `TRANSITION` {@link import('./errors.js').WorkflowError} when it returns `false`.
 *
 * @param from - The task's current status
 * @param to - The status the transition would move it to
 * @returns `true` when the move is legal
 */
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
	return TASK_TRANSITIONS[from].includes(to)
}

// === Result construction (AGENTS §12 — `@orkestrel/contract` ships the `Result` /
// `Success` / `Failure` TYPES but no `success`/`failure` constructors, so this module
// provides the ones every gated Result-constructing site in this package's W-b entities
// + managers uses instead of a hand-rolled `{ success: true/false, ... }` literal)

/**
 * Box a value as a {@link Success} — the graceful outcome half of a {@link Result}.
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
 * Box an error as a {@link Failure} — the graceful outcome half of a {@link Result}.
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

// === Result-tree collection

/**
 * Find the first {@link TaskResult} in a positional list whose boxed outcome is a
 * `Failure` — the pure scan shared by a phase's and a workflow's derived-`failed`
 * `fail`-event lookup.
 *
 * @remarks
 * The shared leaf behind {@link import('./phases/Phase.js').Phase} and
 * {@link import('./Workflow.js').Workflow}'s own `#failure` — each gathers ITS tier's
 * results (a phase's own settled tasks, a workflow's flattened `results()`) and feeds
 * them here; the tier-local method keeps the §12 invariant throw (a derived `failed`
 * status guarantees a failing result exists) since throwing on `undefined` is
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
 * Build a {@link WorkflowContext} — the identity every level inherits — from a node's
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
	return {
		id: node.id,
		name: node.name,
		...(node.description === undefined ? {} : { description: node.description }),
	}
}

/**
 * Build a {@link PhaseContext} — a phase's own identity plus a back-reference to its
 * workflow — from the parent {@link WorkflowContext} and the phase node's identity.
 *
 * @param workflow - The parent workflow context (the lineage pointer UP the tree)
 * @param node - The phase's identity (`id` / `name` / optional `description`)
 * @returns The {@link PhaseContext}
 */
export function buildPhaseContext(workflow: WorkflowContext, node: WorkflowContext): PhaseContext {
	return { ...buildWorkflowContext(node), workflow }
}

/**
 * Build a {@link TaskContext} — a task's own identity plus a back-reference to its phase
 * (and, transitively, its workflow) — from the parent {@link PhaseContext} and the task
 * node's identity.
 *
 * @param phase - The parent phase context (carrying the full lineage UP the tree)
 * @param node - The task's identity (`id` / `name` / optional `description`)
 * @returns The {@link TaskContext}
 */
export function buildTaskContext(phase: PhaseContext, node: WorkflowContext): TaskContext {
	return { ...buildWorkflowContext(node), phase }
}

// === Snapshot boundary guard (AGENTS §14 — narrow an opaque storage read)

/**
 * Narrow an `unknown` to a {@link WorkflowSnapshot} — the AGENTS §14 boundary guard for an
 * UNTRUSTED snapshot read (a storage row a {@link import('./stores/DatabaseWorkflowStore.js').DatabaseWorkflowStore}
 * reads back from its opaque JSON column, a snapshot loaded from disk).
 *
 * @remarks
 * A total guard (it NEVER throws — adversarial input returns `false`, AGENTS §14). It checks the
 * snapshot's SHAPE — `id` / `name` / `status` strings, a `boolean` `bail`, an array of `phases`,
 * `created` / `updated` numbers — enough to safely impose the {@link WorkflowSnapshot} type at a
 * storage boundary WITHOUT a cast. It is complementary to
 * {@link import('./factories.js').assertSnapshot}, which validates the DEEPER invariant (every
 * node's status / override drawn from the lifecycle vocabulary) and THROWS a `RESTORE`
 * {@link import('./errors.js').WorkflowError} — the deep gate a {@link import('./factories.js').restoreWorkflow}
 * applies. A boundary read narrows shape with this guard; a restore validates vocabulary with `assertSnapshot`.
 *
 * @param value - The value to test (an opaque storage read)
 * @returns `true` when `value` has the structural shape of a {@link WorkflowSnapshot}
 */
export function isWorkflowSnapshot(value: unknown): value is WorkflowSnapshot {
	return (
		isRecord(value) &&
		isString(value.id) &&
		isString(value.name) &&
		isString(value.status) &&
		isBoolean(value.bail) &&
		isArray(value.phases) &&
		isNumber(value.created) &&
		isNumber(value.updated)
	)
}

// === Definition → initial snapshot (the unified construction input)

/**
 * Convert a {@link WorkflowDefinition} into an INITIAL {@link WorkflowSnapshot} — every
 * node `pending`, no results, empty metadata — so the live W-b tree has ONE construction
 * path (snapshot-driven) for both a fresh build and a restore.
 *
 * @remarks
 * The structural fields (`id` / `name` / `description` + the ordered phases / tasks)
 * carry over verbatim, as does each phase's `concurrency` (persisted on the
 * {@link PhaseSnapshot} so a restore reinstates the same throttle) and each task's `run` /
 * `retries` / `timeout` (persisted on the {@link TaskSnapshot}, like `bail` / `concurrency`,
 * so a restore + a {@link import('./types.js').WorkflowOptions.functions} registry resumes
 * real work). The `bail` policy carries over — at the
 * workflow tier AND, per phase, the
 * EFFECTIVE policy (`phase.bail ?? workflowBail`) on each {@link PhaseSnapshot} — so the seeded
 * snapshot is self-contained; a fresh seed has no `override`. `created` / `updated` are stamped now.
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
 * Convert one {@link import('./types.js').PhaseDefinition} into an initial, all-`pending`
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
 * Convert one {@link import('./types.js').TaskDefinition} into an initial, `pending`
 * {@link TaskSnapshot} — the per-task leaf step of {@link definitionToSnapshot} (no
 * result yet, empty metadata).
 *
 * @remarks
 * `run` / `retries` / `timeout` carry over verbatim (persisted declarative config, like a
 * phase's `bail` / `concurrency`) — a restore reinstates the same behavior reference and
 * reliability overrides once paired with a {@link import('./types.js').WorkflowOptions.functions}
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
		...(task.run === undefined ? {} : { run: task.run }),
		...(task.retries === undefined ? {} : { retries: task.retries }),
		...(task.timeout === undefined ? {} : { timeout: task.timeout }),
	}
}

/**
 * Flatten a nested list of per-phase {@link TaskResult} lists into one positional list
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
export function collectResults(phases: readonly (readonly TaskResult[])[]): readonly TaskResult[] {
	return phases.flat()
}

// === Positional-entry array manipulation (the TaskManager/PhaseManager `add`/`move` core)

/**
 * Insert one `[key, value]` entry at a positional index into a readonly entries array —
 * the pure splice-in step behind an insertion-ordered registry's `add`.
 *
 * @remarks
 * Shared by {@link import('./tasks/TaskManager.js').TaskManager} and
 * {@link import('./phases/PhaseManager.js').PhaseManager}: both convert their
 * insertion-ordered `Map` to `[...map.entries()]`, call this to splice the new entry
 * in at the target index, then rebuild the `Map` from the result (a stateful step that
 * stays a `#` private method — this helper does no `Map` construction). Does not
 * mutate `entries`; returns a new array.
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
	entries: readonly (readonly [string, T])[],
	index: number,
	key: string,
	value: T,
): readonly (readonly [string, T])[] {
	const next = [...entries]
	next.splice(index, 0, [key, value])
	return next
}

/**
 * Reposition the entry keyed `key` to a new positional index in a readonly entries
 * array — the pure remove-then-reinsert step behind an insertion-ordered registry's
 * `move`.
 *
 * @remarks
 * The move counterpart of {@link insertEntry}: finds the entry by `key`, splices it
 * out, then splices it back in at `index`. An absent `key` is a no-op (returns a copy
 * of `entries` unchanged) — the caller (`TaskManager.move` / `PhaseManager.move`)
 * already gates on the target's existence before calling this, so the no-op branch is
 * defensive, never reached in practice. Does not mutate `entries`; returns a new array.
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
	entries: readonly (readonly [string, T])[],
	key: string,
	index: number,
): readonly (readonly [string, T])[] {
	const next = [...entries]
	const at = next.findIndex(([entryKey]) => entryKey === key)
	if (at === -1) return next
	const [entry] = next.splice(at, 1)
	if (entry !== undefined) next.splice(index, 0, entry)
	return next
}

/**
 * Create a {@link DeferredInterface} — a promise whose settlement is driven
 * externally, so a caller can resolve/reject it from outside the executor.
 *
 * @typeParam T - The value the deferred promise resolves
 * @returns A deferred `promise` plus its `resolve` / `reject`
 */
export function createDeferred<T>(): DeferredInterface<T> {
	let resolve: (value: T) => void = () => {}
	let reject: (reason: unknown) => void = () => {}
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

/**
 * Park until `signal` aborts — a promise-parked wait (AGENTS §21), never a timer or
 * busy-loop, that NEVER rejects.
 *
 * @remarks
 * Resolves IMMEDIATELY when `signal` is already aborted; otherwise attaches a one-shot
 * `abort` listener and resolves when it fires, removing the listener either way. The
 * shared leaf behind the duplicate abort-wiring an execution engine otherwise hand-rolls
 * at every fold point.
 *
 * @param signal - The signal to park on
 * @returns A promise that resolves once `signal` has aborted
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
