import type { LifecycleStatus, PhaseEventMap, TaskEventMap, WorkflowEventMap } from './types.js'

// Workflow constants — the centralized data the contract, the derivation helpers,
// and the entities read. UPPER_SNAKE, `Object.freeze`d, every member exported. The
// status-vocabulary arrays are the runtime source of truth for the lifecycle union,
// and the guards read them: `isLifecycleStatus` scans `LIFECYCLE_STATUSES` and
// `isTerminalStatus` scans `TERMINAL_STATUSES`, so the vocabulary has one definition
// rather than a hard-coded copy per predicate.

/** Names the default {@link import('./types.js').WorkflowDefinition.bail} — graceful (continue on a leaf failure). */
export const DEFAULT_BAIL = false

/**
 * Lists every {@link LifecycleStatus} value, frozen — the vocabulary every tier draws from.
 *
 * @remarks
 * Ordered pending → running → terminal (`completed` / `failed` / `skipped` /
 * `stopped`). The runtime source of truth for the union:
 * {@link import('./validators.js').isLifecycleStatus} reads this array.
 */
export const LIFECYCLE_STATUSES: readonly LifecycleStatus[] = Object.freeze([
	'pending',
	'running',
	'completed',
	'failed',
	'skipped',
	'stopped',
])

/**
 * Lists the {@link LifecycleStatus} values that are TERMINAL — a node in one of these will
 * not transition further, frozen.
 *
 * @remarks
 * The source of truth behind {@link import('./helpers.js').isTerminalStatus}.
 * `pending` and `running` are the only non-terminal members.
 */
export const TERMINAL_STATUSES: readonly LifecycleStatus[] = Object.freeze([
	'completed',
	'failed',
	'skipped',
	'stopped',
])

/**
 * Declares the legal {@link LifecycleStatus} transition graph of the live W-b task state machine —
 * each current status mapped to the statuses it may move to directly, frozen.
 *
 * @remarks
 * The source of truth behind {@link import('./helpers.js').canTransitionTask} and the
 * `TRANSITION` guard ({@link import('./errors.js').WorkflowError}). A `pending` task may
 * `start` (→ `running`), `skip` (→ `skipped`), or `stop` (→ `stopped`); a `running` task
 * may `complete` (→ `completed`), `fail` (→ `failed`), `skip` (→ `skipped`), or `stop`
 * (→ `stopped`). Every terminal status maps to an empty list — a settled task never
 * transitions again. So completing a non-`running` task, or starting a settled one, is
 * rejected.
 */
export const TASK_TRANSITIONS: Readonly<Record<LifecycleStatus, readonly LifecycleStatus[]>> =
	Object.freeze({
		pending: ['running', 'skipped', 'stopped'],
		running: ['completed', 'failed', 'skipped', 'stopped'],
		completed: [],
		failed: [],
		skipped: [],
		stopped: [],
	})

/**
 * Names the default per-phase task concurrency the {@link import('./factories.js').createWorkflowRunner}
 * runner applies when a {@link import('./types.js').PhaseDefinition} omits its `concurrency`
 * throttle — a cap that is effectively unbounded for any realistic phase.
 *
 * @remarks
 * The determinism principle fixes that a phase's tasks run CONCURRENTLY; `concurrency` is
 * only an optional resource throttle (max-in-flight). With none declared, the runner runs
 * all of a phase's tasks at once — modelled as this finite cap so the value flows straight
 * into the substrate {@link import('./types.js').RunnerInterface}'s `concurrency` (which
 * expects a positive integer) without a special unbounded branch. No realistic phase
 * declares enough tasks to reach it, so it behaves as "run them all".
 *
 * WHY `1024` and not a huge sentinel like `1_000_000`: the backing `@orkestrel/queue` Runner
 * EAGERLY spawns one parked worker loop per concurrency unit AT CONSTRUCTION, so this default
 * must be a value whose eager allocation cost is negligible for every default-concurrency
 * phase — a million-unit default meant ~1e6 promise/closure allocations per such phase. A
 * phase may still DECLARE a larger explicit `concurrency` and pays that allocation knowingly.
 */
export const DEFAULT_PHASE_CONCURRENCY = 1024

/**
 * Names the largest delay representable by the host timer APIs without overflow or clamping.
 */
export const MAX_TIMER_MS = 2_147_483_647

/**
 * Lists the {@link WorkflowEventMap} / {@link PhaseEventMap} events that make a durable observer
 * re-persist the live tree, frozen.
 *
 * @remarks
 * The two maps carry the same event names, so one list serves both tiers. It is the source of
 * truth behind {@link import('./WorkflowPersistence.js').WorkflowPersistence}'s attach and detach
 * passes: subscribing and unsubscribing loop over these names, so an added event reaches both
 * passes from one edit. `add` and `remove` are deliberately absent — they carry the new or dropped
 * child, so the persistence layer binds its own attaching handler to them instead.
 */
export const PERSISTED_NODE_EVENTS: ReadonlyArray<keyof WorkflowEventMap & keyof PhaseEventMap> =
	Object.freeze(['start', 'complete', 'fail', 'skip', 'stop', 'move', 'update'])

/**
 * Lists the {@link TaskEventMap} events that make a durable observer re-persist the live tree, frozen.
 *
 * @remarks
 * The leaf counterpart of {@link PERSISTED_NODE_EVENTS}, and the source of truth behind the task
 * attach and detach passes of
 * {@link import('./WorkflowPersistence.js').WorkflowPersistence}. `report` and `pulse` join the
 * lifecycle events because an accepted activity frame changes the persisted snapshot; a leaf has
 * no children, so there is no structural event to bind separately.
 */
export const PERSISTED_TASK_EVENTS: ReadonlyArray<keyof TaskEventMap> = Object.freeze([
	'start',
	'complete',
	'fail',
	'skip',
	'stop',
	'report',
	'pulse',
])
