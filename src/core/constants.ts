import type { PhaseStatus, TaskStatus, WorkflowStatus } from './types.js'

// Workflow constants — the centralized data the contract, the derivation helpers,
// and (later) the entities read. UPPER_SNAKE, `Object.freeze`d, every member
// exported (AGENTS §5). The status-vocabulary arrays are the runtime source of
// truth for the §10 unions: compose them with the shipped contracts primitives
// (`literalOf(...)` for a guard, `literalShape(...)` for a contract) instead of a
// bespoke guard.

/** The default {@link import('./types.js').WorkflowDefinition.bail} — graceful (continue on a leaf failure). */
export const DEFAULT_BAIL = false

/**
 * Every {@link TaskStatus} value, frozen — the lifecycle vocabulary of a task.
 *
 * @remarks
 * Ordered pending → running → terminal (`completed` / `failed` / `skipped` /
 * `stopped`). The source of truth for the union; compose guards / shapes from it.
 */
export const TASK_STATUSES: readonly TaskStatus[] = Object.freeze([
	'pending',
	'running',
	'completed',
	'failed',
	'skipped',
	'stopped',
])

/** Every {@link PhaseStatus} value, frozen — the lifecycle vocabulary of a phase. */
export const PHASE_STATUSES: readonly PhaseStatus[] = Object.freeze([
	'pending',
	'running',
	'completed',
	'failed',
	'skipped',
	'stopped',
])

/** Every {@link WorkflowStatus} value, frozen — the lifecycle vocabulary of a workflow. */
export const WORKFLOW_STATUSES: readonly WorkflowStatus[] = Object.freeze([
	'pending',
	'running',
	'completed',
	'failed',
	'skipped',
	'stopped',
])

/**
 * The {@link TaskStatus} values that are TERMINAL — a task in one of these will
 * not transition further, frozen.
 *
 * @remarks
 * The source of truth behind {@link import('./helpers.js').isTerminalStatus}.
 * `pending` and `running` are the only non-terminal members.
 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = Object.freeze([
	'completed',
	'failed',
	'skipped',
	'stopped',
])

/**
 * The legal {@link TaskStatus} transition graph of the live W-b task state machine —
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
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
	pending: ['running', 'skipped', 'stopped'],
	running: ['completed', 'failed', 'skipped', 'stopped'],
	completed: [],
	failed: [],
	skipped: [],
	stopped: [],
})

/**
 * The default per-phase task concurrency the {@link import('./factories.js').createWorkflowRunner}
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
