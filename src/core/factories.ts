import type { RunnerInterface, RunnerOptions, SchedulerInterface } from './types.js'
import { Scheduler } from './Scheduler.js'
import type { ContractInterface } from '@orkestrel/contract'
import type { ToolInterface } from '@orkestrel/agent'
import type { DriverInterface, TableInterface } from '@orkestrel/database'
import type {
	WorkflowDefinition,
	WorkflowDraft,
	WorkflowInterface,
	WorkflowOptions,
	WorkflowRunnerInterface,
	WorkflowRunnerOptions,
	WorkflowSnapshot,
	WorkflowSnapshotRow,
	WorkflowSteps,
	WorkflowStoreInterface,
	WorkflowToolOptions,
} from './types.js'
import { createTool } from '@orkestrel/agent'
import { createContract, rawShape, schemaToParameters, stringShape } from '@orkestrel/contract'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import {
	DEFAULT_BAIL,
	MAX_WORKFLOW_DEPTH,
	PHASE_STATUSES,
	TASK_STATUSES,
	WORKFLOW_STATUSES,
	WORKFLOW_TOOL_DESCRIPTION,
	WORKFLOW_TOOL_NAME,
} from './constants.js'
import { WorkflowError } from './errors.js'
import {
	completeDraft,
	definitionToSnapshot,
	expandSteps,
	workflowTag,
	workflowToolSummary,
} from './helpers.js'
import { workflowDraftShape, workflowShape, workflowStepsShape } from './shapers.js'
import { DatabaseWorkflowStore } from './stores/DatabaseWorkflowStore.js'
import { MemoryWorkflowStore } from './stores/MemoryWorkflowStore.js'
import { Workflow } from './Workflow.js'
import { WorkflowRunner } from './WorkflowRunner.js'
import { Runner } from './Runner.js'

// Workflow contract factory — compiles the workflow shape (shapers.ts) into the
// four lockstep outputs (JSON Schema + guard + parser + generator) and types the
// result as the hand-written `WorkflowDefinition` (the source of truth, AGENTS §14).
//
// The compiled `ContractInterface<Infer<typeof workflowShape>>` is structurally
// identical to `ContractInterface<WorkflowDefinition>` — verified bidirectionally,
// with ZERO TS2589 (the three-level nesting that tripped the databases module's
// `objectShape` generics does NOT strike here, because the shapes are kept
// intersection-free per the shapers' design note). So the hand-written interface
// stays the source of truth AND the contract's `is` / `generate` / `parse` narrow
// to it natively — no `as`. The round-trip parity test (generate → is → parse)
// guards against any future drift between the two.
//
// `parse` is the contract's own parser, used directly: the shared compiler now
// re-applies each leaf's `min` / `max` / `pattern` refinement after coercion
// (compilers.ts `compileParser`, via the shared `stringOf` / `boundsOf`
// combinators), so a parsed
// `WorkflowDefinition` already satisfies `is` — refinements included (AGENTS §14
// parse↔guard soundness). An empty `id` or `concurrency: 0` parses to `undefined`
// at the contract level, so no guard-gate wrapper is needed here.

/**
 * Compile the workflow definition contract — the JSON Schema, guard, parser, and
 * seeded generator for a {@link WorkflowDefinition}, all derived from one shape and
 * kept in lockstep.
 *
 * @remarks
 * The returned {@link ContractInterface}:
 * - `schema` — the emitted JSON Schema for a workflow definition.
 * - `is` — a total guard that narrows `unknown` to a valid {@link WorkflowDefinition}
 *   (malformed input returns `false`, never throws).
 * - `parse` — coerces `unknown` to a {@link WorkflowDefinition}, or `undefined` when
 *   it does not match.
 * - `generate` — produces a deterministic valid {@link WorkflowDefinition} from an
 *   optional seeded random source.
 *
 * @returns The compiled {@link WorkflowDefinition} contract
 *
 * @example
 * ```ts
 * import { createWorkflowContract } from '@src/core'
 *
 * const contract = createWorkflowContract()
 * const definition = contract.generate()       // a valid WorkflowDefinition
 * contract.is(definition)                       // true
 * contract.parse({ id: '', phases: [] })        // undefined (malformed)
 * ```
 */
export function createWorkflowContract(): ContractInterface<WorkflowDefinition> {
	const contract = createContract(workflowShape)
	return {
		schema: contract.schema,
		is: contract.is,
		generate: (random) => contract.generate(random),
		// The contract's own parser already enforces every leaf refinement (it
		// re-applies the shared `stringOf` / `boundsOf` combinators after coercion),
		// so a non-`undefined` result satisfies `is` — no guard-gate wrapper needed.
		parse: (value) => contract.parse(value),
	}
}

/**
 * Compile the LENIENT workflow DRAFT contract — identical to
 * {@link createWorkflowContract} EXCEPT `id` and `name` are OPTIONAL at all three levels
 * (workflow / phase / task), so a small model can omit the six identity strings.
 *
 * @remarks
 * The widened authoring surface {@link createWorkflowTool} parses an authored blob through
 * before {@link import('./helpers.js').completeDraft} fills the missing ids/names. It does
 * NOT relax the canonical contract — {@link createWorkflowContract} stays byte-for-byte
 * unchanged and STRICT, and the completed draft is re-validated against THAT strict gate
 * before running (soundness preserved). A PROVIDED `id` / `name` still carries `minLength: 1`,
 * so an explicitly-empty `id: ''` is REJECTED (parses to `undefined`), never auto-filled —
 * keeping "garbage" distinct from "omitted". `run` stays required.
 *
 * @returns The compiled {@link WorkflowDraft} contract
 *
 * @example
 * ```ts
 * import { createWorkflowDraftContract, completeDraft } from '@src/core'
 *
 * const draft = createWorkflowDraftContract()
 * const parsed = draft.parse({ phases: [{ tasks: [{ run: { via: 'function', name: 'f' } }] }] })
 * const definition = parsed && completeDraft(parsed) // ids/names filled positionally
 * draft.parse({ id: '', phases: [] })                // undefined — an explicit empty id is rejected
 * ```
 */
export function createWorkflowDraftContract(): ContractInterface<WorkflowDraft> {
	const contract = createContract(workflowDraftShape)
	return {
		schema: contract.schema,
		is: contract.is,
		generate: (random) => contract.generate(random),
		parse: (value) => contract.parse(value),
	}
}

/**
 * Build the live W-b entity tree from a {@link WorkflowDefinition} — the whole
 * {@link WorkflowInterface} → {@link import('./types.js').PhaseInterface} →
 * {@link import('./types.js').TaskInterface} tree, each level wired with its lineage
 * context, its emitter, and the cascade.
 *
 * @remarks
 * The definition is the DECLARATIVE blueprint; this seeds an initial all-`pending`
 * {@link WorkflowSnapshot} from it ({@link definitionToSnapshot}) and constructs the live
 * tree over that one path. The `bail` failure policy resolves to `options.bail`, else the
 * definition's `bail`, else the graceful {@link import('./constants.js').DEFAULT_BAIL}; it
 * feeds {@link import('./helpers.js').deriveWorkflowStatus}. Per-phase / per-task initial
 * listeners + metadata travel through `options.phases[id].on` /
 * `options.phases[id].tasks[id]` (the AGENTS §8 nested-by-id bag). The W-b tree is the
 * state machine ONLY — it does not execute tasks (W-c drives the transitions).
 *
 * @param definition - The workflow definition to bring to life
 * @param options - Runtime options (initial listeners, `bail` override, per-node options)
 * @returns The live {@link WorkflowInterface} root
 *
 * @example
 * ```ts
 * import { createWorkflow } from '@src/core'
 *
 * const workflow = createWorkflow(definition, { on: { complete: () => done() } })
 * const phase = workflow.phase('phase-build')
 * phase?.task('task-compile')?.start()    // pending → running (cascades up)
 * ```
 */
export function createWorkflow(
	definition: WorkflowDefinition,
	options?: WorkflowOptions,
): WorkflowInterface {
	const bail = options?.bail ?? definition.bail ?? DEFAULT_BAIL
	// Seed BOTH tiers of the snapshot with the effective bail (`definitionToSnapshot`'s second arg),
	// so an `options.bail` override reaches each INHERITING phase's snapshot while a phase with its own
	// `bail` still wins (`phase.bail ?? bail`) — the per-phase-bail-aware derivation reads each
	// PhaseSnapshot's bail. `options` is forwarded UNCHANGED (NOT `{ ...options, bail }`): the snapshot
	// already carries the resolved bail at both tiers, so `Workflow` reads `#bail` from it; injecting a
	// resolved `bail` here would make `Workflow` treat it as an EXPLICIT uniform override and clobber
	// per-phase overrides. A caller's genuine `options.bail` stays in `options` and cascades (uniform re-run).
	return new Workflow(definitionToSnapshot(definition, bail), options)
}

/**
 * Rebuild an equivalent live W-b entity tree from a {@link WorkflowSnapshot} — the
 * inverse of {@link WorkflowInterface.snapshot}, restoring structure + each node's status
 * + recorded results + positional order + the persisted `#override`.
 *
 * @remarks
 * Round-trip fidelity is paramount: a `snapshot()` → `restoreWorkflow()` reproduces the
 * same status at every node (each `#override` restored DIRECTLY from the snapshot's own
 * `override` field, not guessed from a status divergence), the same recorded
 * {@link import('./types.js').TaskResult}s, and the same positional order (an interior
 * `skip` / `remove` survives). The snapshot is SELF-CONTAINED — it persists the `bail`
 * policy it ran under, so the restore re-derives status IDENTICALLY without a silent
 * default; the snapshot's `bail` is the source of truth, while an explicit `options.bail`
 * still wins when supplied (to deliberately re-run under a different policy). A structurally
 * invalid snapshot (a status — or override — outside the lifecycle vocabulary, or a
 * non-boolean `bail`) throws a `RESTORE` {@link WorkflowError}.
 *
 * @param snapshot - The snapshot to restore (carries its own `bail` + `override`)
 * @param options - Runtime options (initial listeners, an optional `bail` override, per-node options)
 * @returns The restored live {@link WorkflowInterface} root
 *
 * @example
 * ```ts
 * import { restoreWorkflow } from '@src/core'
 *
 * const restored = restoreWorkflow(workflow.snapshot()) // bail comes from the snapshot
 * restored.status === workflow.status // true
 * ```
 */
export function restoreWorkflow(
	snapshot: WorkflowSnapshot,
	options?: WorkflowOptions,
): WorkflowInterface {
	assertSnapshot(snapshot)
	return new Workflow(snapshot, options)
}

/**
 * Assert that a {@link WorkflowSnapshot} carries a `boolean` `bail` — at the workflow tier AND
 * on every phase — and that its every node's status (and its `override`, when present) is drawn
 * from the lifecycle vocabulary, throwing a `RESTORE` {@link WorkflowError} otherwise.
 *
 * @remarks
 * The boundary-narrowing guard (AGENTS §14) for {@link restoreWorkflow}: a snapshot is
 * untrusted JSON, so a status (or an override) outside
 * {@link import('./constants.js').WORKFLOW_STATUSES} /
 * {@link import('./constants.js').PHASE_STATUSES} / {@link import('./constants.js').TASK_STATUSES},
 * or a non-boolean `bail` (the workflow's OR any phase's — both are REQUIRED persisted policy),
 * is rejected loudly (naming the offending node) rather than silently producing a broken tree.
 * The `override` is optional, so it is only checked WHEN present. Structural shape beyond these
 * fields is the contract's concern; this guards exactly the fields the live state machine reads back.
 *
 * @param snapshot - The snapshot to validate
 */
export function assertSnapshot(snapshot: WorkflowSnapshot): void {
	if (typeof snapshot.bail !== 'boolean') {
		throw new WorkflowError('RESTORE', `workflow '${snapshot.id}' has a non-boolean bail`, {
			workflow: snapshot.id,
			bail: snapshot.bail,
		})
	}
	if (!WORKFLOW_STATUSES.includes(snapshot.status)) {
		throw new WorkflowError('RESTORE', `workflow '${snapshot.id}' has an invalid status`, {
			workflow: snapshot.id,
			status: snapshot.status,
		})
	}
	if (snapshot.override !== undefined && !WORKFLOW_STATUSES.includes(snapshot.override)) {
		throw new WorkflowError('RESTORE', `workflow '${snapshot.id}' has an invalid override`, {
			workflow: snapshot.id,
			override: snapshot.override,
		})
	}
	for (const phase of snapshot.phases) {
		if (typeof phase.bail !== 'boolean') {
			throw new WorkflowError('RESTORE', `phase '${phase.id}' has a non-boolean bail`, {
				phase: phase.id,
				bail: phase.bail,
			})
		}
		if (!PHASE_STATUSES.includes(phase.status)) {
			throw new WorkflowError('RESTORE', `phase '${phase.id}' has an invalid status`, {
				phase: phase.id,
				status: phase.status,
			})
		}
		if (phase.override !== undefined && !PHASE_STATUSES.includes(phase.override)) {
			throw new WorkflowError('RESTORE', `phase '${phase.id}' has an invalid override`, {
				phase: phase.id,
				override: phase.override,
			})
		}
		for (const task of phase.tasks) {
			if (!TASK_STATUSES.includes(task.status)) {
				throw new WorkflowError('RESTORE', `task '${task.id}' has an invalid status`, {
					task: task.id,
					status: task.status,
				})
			}
		}
	}
}

/**
 * Create the in-memory durable {@link WorkflowStoreInterface} — a process-lifetime
 * {@link MemoryWorkflowStore} persisting {@link WorkflowSnapshot}s by workflow id, the DEFAULT
 * backend behind the W-d persistence seam.
 *
 * @remarks
 * The snapshot analogue of the server package's `createMemorySessionStore`
 * (and the {@link createMemoryQueueStore} family), but LEANER — there is no idle-TTL, so no
 * options bag (AGENTS §21 minimal): a persisted run-state lives until an explicit `delete`. This is
 * the zero-plumbing DEFAULT (a plain `Map`); its driver-pluggable twin is
 * {@link createDatabaseWorkflowStore} (the snapshot as one opaque JSON column over a `databases`
 * table) — for a DURABLE store (run-state surviving a restart) pass it a JSON / SQLite / IndexedDB
 * driver, and it swaps in WITHOUT touching the runner or the entity tree. Restore stays a caller
 * concern: read a snapshot back and rebuild the live tree with {@link restoreWorkflow}.
 *
 * @returns A memory-backed {@link WorkflowStoreInterface}
 *
 * @example
 * ```ts
 * import { createMemoryWorkflowStore, createWorkflow, restoreWorkflow } from '@src/core'
 *
 * const store = createMemoryWorkflowStore()
 * const workflow = createWorkflow(definition)
 * await store.set(workflow.snapshot())          // persist the run state
 * const snapshot = await store.get(definition.id)
 * const restored = snapshot && restoreWorkflow(snapshot)       // an identical live tree
 * ```
 */
export function createMemoryWorkflowStore(): WorkflowStoreInterface {
	return new MemoryWorkflowStore()
}

/**
 * Create a {@link DatabaseWorkflowStore} over any {@link DriverInterface} — the durable,
 * driver-pluggable backing for the W-d persistence seam, the opt-in twin of
 * {@link createMemoryWorkflowStore}.
 *
 * @remarks
 * Builds a one-table database (`snapshots`, keyed by `id`) over the supplied driver, the snapshot
 * held as ONE OPAQUE JSON COLUMN — the column map is `{ id; snapshot }` where `snapshot` is a
 * `rawShape` (a JSON blob), exactly as {@link createDatabaseQueueStore} stores its `input`. The
 * snapshot is already a COMPLETE, self-contained, pure-JSON payload, so storing it whole is lossless
 * AND keeps the row type FLAT — a structured multi-column snapshot table would force the contract to
 * `Infer` the deeply-nested snapshot shape (workflow → phases → tasks → results) and trip TS2589;
 * the opaque column sidesteps it (the column reads back as `unknown`, narrowed on `get` by
 * {@link import('./helpers.js').isWorkflowSnapshot}). The `driver` DEFAULTS to
 * {@link createMemoryDriver}, so the store ALSO works in memory out of the box; pass a server
 * `createJSONDriver` / `createSQLiteDriver` (or a browser IndexedDB driver) for a persistent one —
 * the durability is the driver's job, the store engine is shared. It swaps in behind
 * {@link WorkflowStoreInterface} WITHOUT touching the runner or the entity tree.
 *
 * @param driver - The storage backend the snapshots persist to (defaults to {@link createMemoryDriver})
 * @returns A {@link WorkflowStoreInterface} over the driver
 *
 * @example
 * ```ts
 * import { createDatabaseWorkflowStore, createMemoryDriver, createWorkflow, restoreWorkflow } from '@src/core'
 *
 * const store = createDatabaseWorkflowStore(createMemoryDriver()) // a durable driver swaps in here
 * const workflow = createWorkflow(definition)
 * await store.set(workflow.snapshot())          // persist the run state (one JSON column)
 * const snapshot = await store.get(definition.id)
 * const restored = snapshot && restoreWorkflow(snapshot)       // an identical live tree
 * ```
 */
export function createDatabaseWorkflowStore(
	driver: DriverInterface = createMemoryDriver(),
): WorkflowStoreInterface {
	// The snapshot is stored as ONE OPAQUE JSON column (`rawShape`), so the row infers FLAT —
	// `{ id: string; snapshot: unknown }` = `WorkflowSnapshotRow` — and the deeply-nested snapshot
	// shape never forces a contract `Infer` (the TS2589 trap a structured table would spring).
	const columns = { id: stringShape(), snapshot: rawShape({}) }
	const database = createDatabase({ driver, tables: { snapshots: columns } })
	const table: TableInterface<WorkflowSnapshotRow> = database.table('snapshots')
	return new DatabaseWorkflowStore(table)
}

/**
 * Create a workflow runner — a {@link WorkflowRunnerInterface} that EXECUTES a live W-b
 * workflow tree by COMPOSING the shipped substrate: phases sequential, tasks concurrent,
 * each task dispatched BY NAME under the workflow's `bail` policy.
 *
 * @remarks
 * The runner is THIN — it re-implements no concurrency / retry / abort logic. Per-phase
 * bounded concurrency is one {@link createRunner} per phase;
 * `bail` maps onto that Runner's fail-fast (`true` — the first failure aborts the in-flight
 * siblings + skips the rest) vs settle-all (`false` — failures are recorded, the run
 * finishes); the run-level abort / timeout / budget ({@link import('./types.js').WorkflowRunOptions})
 * fold through `AbortSignal.any` (the agent runtime's pattern); pacing is the shipped
 * scheduler. `execute(definition, options?)` BUILDS the live tree from the definition itself
 * (via {@link createWorkflow} — one source of truth, returned in `WorkflowResult.workflow`),
 * drives the live entity (`start` → `complete` / `fail`), and resolves a
 * {@link import('./types.js').WorkflowResult}.
 *
 * A task is dispatched on its {@link import('./types.js').TaskForm}: `function` → the
 * `functions` registry, `tool` → the `tools` {@link ToolManagerInterface}, `agent` → the
 * `agents` {@link import('./types.js').WorkflowAgents} resolver (W-c2), behind a depth + cycle
 * guard. A task whose handler is NOT found (an unregistered name for ANY form) AUTO-COMPLETES
 * (the ROADMAP no-handler rule).
 *
 * The runner is constructed with a reference to {@link createWorkflowTool} (the workflow-tool
 * binder) so it can BIND a depth/cycle-aware workflow tool onto a dispatched subagent's context
 * — the propagation seam — WITHOUT this module's classes importing its own `factories.ts` (the
 * factories→classes direction; the binder is injected as a value at construction).
 *
 * @param options - The behavior registries (`functions` / `tools` / `agents`) the runner
 *   dispatches a task by name through, plus an optional pacing `scheduler` (default the shipped
 *   cross-environment one). Omitting `functions` / `tools` / `agents` makes those task forms
 *   auto-complete (no handler). See {@link WorkflowRunnerOptions}.
 * @returns A working {@link WorkflowRunnerInterface}
 *
 * @example
 * ```ts
 * import { createWorkflowRunner, createToolManager } from '@src/core'
 *
 * const tools = createToolManager()
 * const runner = createWorkflowRunner({
 * 	functions: { compile: async (controller) => `built ${controller.task.id}` },
 * 	tools,
 * })
 * const definition = { id: 'w', name: 'W', phases: [{ id: 'p', name: 'P', tasks: [
 * 	{ id: 't', name: 'T', run: { via: 'function', name: 'compile' } },
 * ] }] }
 * const result = await runner.execute(definition) // builds + drives the tree
 * result.status // 'completed'
 * result.workflow.phase('p')?.task('t')?.status // 'completed'
 * ```
 */
export function createWorkflowRunner(options?: WorkflowRunnerOptions): WorkflowRunnerInterface {
	return new WorkflowRunner(
		options?.functions ?? {},
		options?.tools,
		options?.agents,
		options?.scheduler ?? createScheduler(),
		createWorkflowTool,
	)
}

/**
 * Wrap a {@link WorkflowDefinition} as an LLM-callable {@link ToolInterface} — it ADVERTISES
 * the SIMPLE flat authoring shape (`{ name?, steps: [{ name, via? }] }`) as its `parameters` so
 * even a small model can author a complete tree, and its handler EXPANDS / COMPLETES the
 * authored blob, validates it against the STRICT contract, runs it through `runner`, and
 * returns the run SUMMARY (throwing a typed {@link WorkflowError} on failure).
 *
 * @remarks
 * A plain {@link ToolManagerInterface}-compatible tool (so `createMCPServer` / `createMCPRoutes`
 * expose it for free — nothing MCP is wired here). It is ALSO the propagation carrier the
 * {@link WorkflowRunner} binds onto a dispatched subagent (W-c2): because a tool handler receives
 * ONLY the model-supplied `args` (no ambient context, no signal), the run's depth + ancestry are
 * CLOSED OVER at bind time via {@link WorkflowToolOptions}, and the handler runs the nested
 * workflow at `depth + 1` with the extended ancestry.
 *
 * **Widened authoring surface (additive — the canonical contract + runner stay STRICT and
 * unchanged).** A 2B model reliably CALLS the tool but cannot reliably emit the full four-level
 * nested {@link WorkflowDefinition} (six required `id`/`name` strings, a nested tagged union,
 * all-or-nothing). So the tool ACCEPTS three authoring forms and converges them on the SAME
 * strict {@link createWorkflowContract} gate before running (soundness preserved):
 * - the FLAT shape `{ name?, steps: [{ name, via? }] }` — the ADVERTISED `parameters` (the simplest
 *   form, {@link import('./helpers.js').expandSteps}'d into one one-task phase per step);
 * - a nested DRAFT with any `id`/`name` OMITTED — {@link createWorkflowDraftContract}-parsed then
 *   {@link import('./helpers.js').completeDraft}'d (missing ids synthesized positionally);
 * - the full nested {@link WorkflowDefinition} — the advanced escape-hatch (documented in the
 *   description), accepted as the draft super-set.
 *
 * The handler conforms to the universal tool-handler contract (AGENTS §14): it returns the PLAIN
 * run-summary VALUE on success and THROWS a typed {@link WorkflowError} on every failure path. It
 * does NOT build a {@link ToolResult} itself — the `@orkestrel/agent` package's `ToolManager`
 * performs the ONE canonical wrap (`{ id, name, value }` on a return; `{ id, name, error }` on a
 * throw, ISOLATED so nothing escapes the run), so the outcome appears EXACTLY ONCE, identically,
 * over BOTH the agent loop and MCP (a throw → MCP `isError: true`):
 * - **No authored args** (an empty `arguments`) ⇒ runs the WRAPPED `definition`.
 * - **A `steps` array** ⇒ the FLAT form: parse it, {@link import('./helpers.js').expandSteps} it.
 * - **Otherwise** ⇒ the nested form: {@link createWorkflowDraftContract}-parse it,
 *   {@link import('./helpers.js').completeDraft} it.
 * - **Strict gate** ⇒ the expanded / completed result is validated against
 *   {@link createWorkflowContract}.`is`; a blob that can't expand, or whose result fails the strict
 *   gate (e.g. an explicit empty `id`, `concurrency: 0`) ⇒ THROW a `TOOL` {@link WorkflowError} (no run).
 * - **Over-deep / cyclic** ⇒ THROW a `DEPTH` {@link WorkflowError} when the nested run would exceed
 *   {@link MAX_WORKFLOW_DEPTH}, or the target workflow id is already an ancestor (a cycle) — the
 *   same `code` the agent-task guard raises.
 * - **Otherwise** ⇒ `runner.execute(target, { depth: depth + 1, ancestry: … })`, RETURNING the
 *   plain summary of the terminal run (`{ status, count }`, via {@link workflowToolSummary}).
 *
 * @param definition - The workflow the tool runs when called with no authored args
 * @param runner - The {@link WorkflowRunnerInterface} that executes the (nested) workflow
 * @param options - The depth + ancestry to run the nested workflow under (see
 *   {@link WorkflowToolOptions}); omitted ⇒ depth `0` / empty ancestry (a top-level wrap)
 * @returns A {@link ToolInterface} (named {@link import('./constants.js').WORKFLOW_TOOL_NAME})
 *   whose `parameters` advertise the FLAT authoring schema (the nested form stays accepted)
 *
 * @example
 * ```ts
 * import { createWorkflowRunner, createWorkflowTool, createToolManager } from '@src/core'
 *
 * const runner = createWorkflowRunner()
 * const tool = createWorkflowTool(definition, runner)
 * const tools = createToolManager()
 * tools.add(tool) // a model can now author + run a workflow in one call
 * ```
 */
export function createWorkflowTool(
	definition: WorkflowDefinition,
	runner: WorkflowRunnerInterface,
	options?: WorkflowToolOptions,
): ToolInterface {
	const strict = createWorkflowContract()
	const draft = createWorkflowDraftContract()
	const steps: ContractInterface<WorkflowSteps> = createContract(workflowStepsShape)
	const depth = options?.depth ?? 0
	const ancestry = options?.ancestry ?? []
	// The tool ADVERTISES the FLAT authoring shape (the simplest surface a small model can
	// fill) — its JSON Schema, narrowed to the open tool-parameters record (§14, never `as`) via
	// the shared `schemaToParameters` contracts helper. The full nested form is STILL accepted (the
	// handler branches on the args' shape) but is documented in the description as the advanced
	// escape-hatch.
	const parameters = schemaToParameters(steps.schema)
	return createTool({
		name: WORKFLOW_TOOL_NAME,
		description: WORKFLOW_TOOL_DESCRIPTION,
		parameters,
		// The universal tool-handler contract (§14): RETURN the plain run summary on success;
		// THROW a typed WorkflowError on every failure path, which the ToolManager ISOLATES into
		// the canonical tool result's top-level `error` (so nothing escapes the run and the
		// outcome appears once, identically, over the agent loop AND MCP). The authoring surface
		// is WIDENED at this boundary ONLY (the canonical contract + runner stay strict): empty
		// args ⇒ the wrapped definition; a `steps` array ⇒ the FLAT form (expandSteps); else the
		// nested DRAFT form (draft-parse + completeDraft). EVERY path then converges on the STRICT
		// `createWorkflowContract().is` gate — a blob that can't expand / complete, or whose result
		// fails the strict gate, ⇒ throw `TOOL` (no run); an over-deep / cyclic nested run ⇒ throw
		// `DEPTH`; otherwise run at depth + 1 and return the terminal run's summary.
		execute: async (args) => {
			// Branch on the authored args' SHAPE (no ambient context — a tool handler gets only
			// `args`): empty ⇒ the wrapped definition; a `steps` array ⇒ the FLAT form, parsed +
			// expanded; otherwise the nested DRAFT form, parsed + completed. A parse failure leaves
			// `target` undefined ⇒ the strict gate below throws `TOOL`.
			let target: WorkflowDefinition | undefined
			if (Object.keys(args).length === 0) {
				target = definition
			} else if (Array.isArray(args.steps)) {
				const flat = steps.parse(args)
				target = flat === undefined ? undefined : expandSteps(flat)
			} else {
				const parsed = draft.parse(args)
				target = parsed === undefined ? undefined : completeDraft(parsed)
			}
			// The SOUNDNESS gate: whatever authoring form produced `target`, it must satisfy the
			// STRICT canonical contract before it runs — the leniency never reaches the runner.
			if (target === undefined || !strict.is(target)) {
				throw new WorkflowError('TOOL', 'malformed workflow definition', {
					workflow: definition.id,
				})
			}
			if (depth + 1 > MAX_WORKFLOW_DEPTH) {
				throw new WorkflowError(
					'DEPTH',
					`nested workflow exceeds max depth ${MAX_WORKFLOW_DEPTH}`,
					{
						workflow: target.id,
						depth,
						max: MAX_WORKFLOW_DEPTH,
					},
				)
			}
			const tag = workflowTag(target.id)
			if (ancestry.includes(tag)) {
				throw new WorkflowError('DEPTH', `workflow '${target.id}' is already an ancestor (cycle)`, {
					workflow: target.id,
					ancestry: [...ancestry],
				})
			}
			const result = await runner.execute(target, {
				depth: depth + 1,
				ancestry: [...ancestry, tag],
			})
			return workflowToolSummary(result)
		},
	})
}

/**
 * Create the safe cross-environment cooperative-yield default — a
 * {@link SchedulerInterface} built on `setTimeout` / `clearTimeout` alone, so it
 * runs unchanged in both the browser and Node.
 *
 * @remarks
 * `yield()` gives the host a turn via a zero-delay macrotask (so pending I/O,
 * timers, and rendering actually run — a microtask would not); `delay(ms)` resumes
 * after at least `ms`. Pass `options.signal` to make a pending yield/delay reject
 * with the signal's `reason` on abort (with full timer/listener cleanup).
 * `options.priority` is accepted for contract compliance but treated uniformly by
 * this default — environment backends honour it.
 *
 * @returns A working {@link SchedulerInterface}
 *
 * @example
 * ```ts
 * import { createAbort, createScheduler } from '@src/core'
 *
 * const abort = createAbort()
 * const scheduler = createScheduler()
 *
 * // A cooperative loop: do a unit of work, then hand the host a turn.
 * while (!abort.signal.aborted) {
 * 	doSomeWork()
 * 	await scheduler.yield({ signal: abort.signal })
 * }
 * ```
 *
 * @example
 * ```ts
 * import { createScheduler } from '@src/core'
 *
 * // A backoff: wait a growing interval between retries.
 * const scheduler = createScheduler()
 * for (let attempt = 0; attempt < 5; attempt += 1) {
 * 	if (await tryOnce()) break
 * 	await scheduler.delay(2 ** attempt * 100)
 * }
 * ```
 */
export function createScheduler(): SchedulerInterface {
	return new Scheduler()
}

/**
 * Create a thin generic orchestrator that drives declared units — and any they
 * `spawn` — through a bounded-concurrency queue, collecting their results in order.
 *
 * @remarks
 * The Runner composes the workers `Queue` for backpressure, FIFO ordering, bounded
 * concurrency, retries, and the per-attempt timeout — it adds only orchestration, not
 * a second concurrency engine. `execute(inputs)` runs the unit set ONCE (a second call
 * throws) and resolves the units' results in order: the declared inputs first, then
 * any `spawn`ed siblings in spawn order. Each unit's handler gets a `Controller` — its
 * `id` / `input`, a `signal` that fires on the unit's `abort`, a runner-level `abort`,
 * or the attempt's timeout, a promise-parked `wait()`, and `spawn(input)` to fan out
 * sibling units. The run is **fail-fast**: the first unit failure (after retries)
 * aborts every other unit and rejects `execute` with that error. **Observable (§13):** a
 * typed `emitter` surfaces `start` / `unit` / `spawn` / `settle` / `fail` / `finish` / `abort`.
 *
 * Because `spawn` is fire-and-track (the runner awaits the whole spawn closure via an
 * outstanding-unit count, not a one-time snapshot), a handler need NOT await its spawns
 * for them to run — and on a bounded runner it should NOT `await` a spawn inline (a
 * slot-holding handler awaiting its own spawn can deadlock); fan out and return instead.
 *
 * @typeParam TInput - The work input each unit carries
 * @typeParam TResult - The value a unit's handler resolves
 * @param options - The `handler` plus optional `concurrency` (default `1`), `retries`
 *   (default `0`), and a default per-attempt `timeout` in milliseconds
 * @returns A working {@link RunnerInterface}
 *
 * @example
 * ```ts
 * import { createRunner } from '@src/core'
 *
 * // A handler that fans out one sibling per declared unit, then returns its own value.
 * const runner = createRunner<number, number>({
 * 	concurrency: 4,
 * 	handler: (controller) => {
 * 		if (controller.input < 10) controller.spawn(controller.input + 100) // fire-and-track
 * 		return controller.input
 * 	},
 * })
 *
 * const results = await runner.execute([1, 2, 3])
 * // [1, 2, 3, 101, 102, 103] — declared inputs first (in order), then spawns (in order)
 * ```
 */
export function createRunner<TInput, TResult>(
	options: RunnerOptions<TInput, TResult>,
): RunnerInterface<TInput, TResult> {
	return new Runner(options)
}
