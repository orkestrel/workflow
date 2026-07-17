import type {
	PhaseStatus,
	TaskStatus,
	WorkflowDefinition,
	WorkflowStatus,
	WorkflowSteps,
} from './types.js'

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

/**
 * The maximum nesting depth a workflow → agent → workflow chain may reach — the bound
 * the {@link import('./factories.js').createAgentFunction} and
 * {@link import('./factories.js').createWorkflowTool} adapters' depth/cycle guards enforce.
 *
 * @remarks
 * The limit lives in ONE place. An {@link import('./factories.js').createAgentFunction}-wrapped
 * agent running at this depth can no longer author + run a NESTED workflow through its bound
 * workflow tool (that would be depth `MAX_WORKFLOW_DEPTH + 1`), so the over-deep invocation is
 * REJECTED (a typed `DEPTH` {@link import('./errors.js').WorkflowError} throw). The chain
 * therefore nests workflows down to this depth, and the nested run at
 * depth `MAX_WORKFLOW_DEPTH` fails.
 */
export const MAX_WORKFLOW_DEPTH = 8

/**
 * The name under which {@link import('./factories.js').createAgentFunction} BINDS the
 * depth/cycle-aware workflow tool onto a wrapped agent's `context.tools` (`AgentContextInterface`,
 * `@orkestrel/agent`).
 *
 * @remarks
 * The propagation seam's well-known key: when its `runner` option is supplied, the adapter adds a
 * {@link import('./factories.js').createWorkflowTool}-built tool under this name to the
 * agent's `context.tools`, so it can author + run a NESTED workflow (bounded by
 * {@link MAX_WORKFLOW_DEPTH}). An agent that wants to fan out into a workflow calls this tool by
 * this name; the bound handler runs the nested workflow at depth + 1.
 */
export const WORKFLOW_TOOL_NAME = 'workflow'

/**
 * A complete FLAT authoring example — the PRIMARY way a small model authors a workflow
 * through {@link import('./factories.js').createWorkflowTool}: `{ name, steps: [{ name }] }`.
 *
 * @remarks
 * Each step becomes a one-task phase, in order; a step's `name` is a REGISTERED behavior name
 * (not a label) — the registry key its task's `run` resolves against. The tool expands this
 * ({@link import('./helpers.js').expandSteps}) into a valid {@link WorkflowDefinition}. It
 * is embedded VERBATIM in {@link WORKFLOW_TOOL_DESCRIPTION} and guarded by a parity test
 * (it must expand to a tree the STRICT contract accepts), so the doc example can never drift.
 */
export const WORKFLOW_TOOL_FLAT_EXAMPLE: WorkflowSteps = Object.freeze({
	name: 'release',
	steps: Object.freeze([Object.freeze({ name: 'compile' }), Object.freeze({ name: 'publish' })]),
})

/**
 * A minimal NESTED authoring example — the ADVANCED escape-hatch form a model may use
 * instead of the flat shape: a full {@link WorkflowDefinition}.
 *
 * @remarks
 * The full four-level form, documented in {@link WORKFLOW_TOOL_DESCRIPTION} as the advanced
 * alternative. It is embedded VERBATIM and guarded by a parity test (`createWorkflowContract().is`
 * must accept it), so the doc example can never drift from a valid definition.
 */
export const WORKFLOW_TOOL_NESTED_EXAMPLE: WorkflowDefinition = Object.freeze({
	id: 'release',
	name: 'Release',
	phases: Object.freeze([
		Object.freeze({
			id: 'build',
			name: 'Build',
			tasks: Object.freeze([
				Object.freeze({
					id: 'compile',
					name: 'Compile',
					run: 'compile',
				}),
			]),
		}),
	]),
})

/**
 * The DESCRIPTION {@link import('./factories.js').createWorkflowTool} advertises — a
 * multi-line guide that teaches a small model how to author a complete workflow tree.
 *
 * @remarks
 * Presents the SIMPLE flat shape (`{ name, steps: [{ name }] }`) as the PRIMARY way with
 * one complete worked example ({@link WORKFLOW_TOOL_FLAT_EXAMPLE}), names that a step's
 * `name` is a REGISTERED name (not a human label), and documents the full nested
 * {@link WorkflowDefinition} as the ADVANCED form with a minimal example
 * ({@link WORKFLOW_TOOL_NESTED_EXAMPLE}). Both examples are interpolated VERBATIM from the
 * validated constants, so a parity test pins them — the description can never drift from a
 * real, contract-valid example. The `parameters` the tool advertises are the FLAT shape's
 * schema; the nested form is the documented escape-hatch (the tool accepts both). NOTE: a step's
 * "registered behavior name" is authored STRUCTURE only —
 * {@link import('./factories.js').createWorkflowTool} runs the authored tree with no
 * {@link WorkflowFunctions} registry of its own, so every one of its tasks auto-completes under
 * the no-handler rule; the tool validates/synthesizes shape, it does not dispatch behavior.
 */
export const WORKFLOW_TOOL_DESCRIPTION = [
	'Author and run a workflow (phases run sequentially, the tasks within a phase run concurrently) in one call.',
	'',
	'SIMPLEST way — a flat list of steps. Each step runs one registered behavior; steps run one after another:',
	'  { "name": "<workflow name>", "steps": [ { "name": "<registered name>" }, ... ] }',
	'- a step\'s "name" is a REGISTERED behavior name (a registry key), NOT a human label.',
	'- the top-level "name" (the workflow name) is optional. Ids are filled in for you.',
	'Example:',
	JSON.stringify(WORKFLOW_TOOL_FLAT_EXAMPLE),
	'',
	'ADVANCED — the full nested form, for multi-task phases or explicit ids. A workflow has phases; a phase has tasks; a task has a "run" (a registered behavior name):',
	JSON.stringify(WORKFLOW_TOOL_NESTED_EXAMPLE),
	'In the nested form you may omit any "id"/"name" and they are filled in positionally; a provided one is kept.',
].join('\n')
