import type { ContractInterface } from '@orkestrel/contract'
import type { DriverInterface, TableInterface } from '@orkestrel/database'
import type {
	RunnerInterface,
	RunnerOptions,
	SchedulerInterface,
	WorkflowDefinition,
	WorkflowInterface,
	WorkflowManagerInterface,
	WorkflowManagerOptions,
	WorkflowOptions,
	WorkflowRunnerInterface,
	WorkflowRunnerOptions,
	WorkflowSnapshotRow,
	WorkflowStoreInterface,
} from './types.js'
import { createContract, rawShape, stringShape } from '@orkestrel/contract'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { cloneWorkflowSnapshot } from './cloners.js'
import { WorkflowError } from './errors.js'
import {
	captureWorkflowOptions,
	definitionToSnapshot,
	hasWorkflowHandlers,
	recoverWorkflowSnapshot,
} from './helpers.js'
import { Scheduler } from './Scheduler.js'
import { workflowShape } from './shapers.js'
import { DatabaseWorkflowStore } from './stores/DatabaseWorkflowStore.js'
import { MemoryWorkflowStore } from './stores/MemoryWorkflowStore.js'
import { Workflow } from './Workflow.js'
import { WorkflowManager } from './WorkflowManager.js'
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
// (compilers.ts `compileParser`, through the shared `stringOf` / `boundsOf`
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
 * import { createWorkflowContract } from '@orkestrel/workflow'
 *
 * const contract = createWorkflowContract()
 * const definition = contract.generate()       // a valid WorkflowDefinition
 * contract.is(definition)                       // true
 * contract.parse({ id: '', phases: [] })        // undefined (malformed)
 * ```
 */
export function createWorkflowContract(): ContractInterface<WorkflowDefinition> {
	return createContract(workflowShape)
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
 * `options.functions` is the {@link import('./types.js').WorkflowFunctions} registry each live
 * task's `behavior` name resolves against ONCE at construction into its runtime
 * {@link import('./types.js').TaskInterface.handler}. An omitted name is the deliberate no-op;
 * an unresolved present name remains inspectable but is rejected if execution is attempted.
 *
 * @param definition - The workflow definition to bring to life
 * @param options - Runtime options (initial listeners, `bail` override, per-node options)
 * @returns The live {@link WorkflowInterface} root
 *
 * @example
 * ```ts
 * import { createWorkflow } from '@orkestrel/workflow'
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
	const captured = captureWorkflowOptions(options)
	return createWorkflowTree(definition, captured)
}

/**
 * Builds the live entity tree one definition and one owned options bag describe — the shared
 * construction path behind every definition-driven mint.
 *
 * @remarks
 * Seeds an initial all-`pending` {@link WorkflowSnapshot} from the definition and constructs the
 * live {@link WorkflowInterface} over it. `bail` is the caller's own override, forwarded to
 * {@link definitionToSnapshot} so it reaches BOTH tiers: the workflow snapshot AND the inheritance
 * default of every phase that declares no `bail` of its own, while a phase declaring one still
 * wins. Omitted, the definition's own `bail` governs, defaulting to the graceful
 * {@link import('./constants.js').DEFAULT_BAIL}.
 *
 * `captured` is forwarded to the entity UNCHANGED — its own `bail` is deliberately not replaced
 * with the resolved policy, because the snapshot already carries the resolved value at both tiers
 * and an injected one would make `Workflow` read it as an EXPLICIT uniform override and clobber
 * the per-phase overrides. Each task's `behavior` / `retries` / `timeout` travel onto the snapshot
 * too, so `captured.functions` resolves every handler identically whether the tree is built fresh
 * or restored. Pass a bag {@link captureWorkflowOptions} already owns: this constructs over it
 * without re-capturing.
 *
 * @param definition - The workflow definition to bring to life
 * @param captured - The already-owned {@link WorkflowOptions} bag the entity is constructed with,
 * whose `bail` is the caller's failure-policy override, or `undefined` to take the definition's
 * @returns The live {@link WorkflowInterface} root
 *
 * @example
 * ```ts
 * import { captureWorkflowOptions, createWorkflowTree } from '@orkestrel/workflow'
 *
 * const captured = captureWorkflowOptions({ bail: true })
 * const workflow = createWorkflowTree(definition, captured)
 * workflow.bail // true — the override reached the workflow and every inheriting phase
 * ```
 */
export function createWorkflowTree(
	definition: WorkflowDefinition,
	captured: WorkflowOptions,
): WorkflowInterface {
	return new Workflow(definitionToSnapshot(definition, captured.bail), captured)
}

/**
 * Build an equivalent live W-b entity tree from a {@link WorkflowSnapshot} — the
 * inverse of {@link WorkflowInterface.snapshot}, restoring structure + each node's status
 * + recorded results + positional order + the persisted `#override`.
 *
 * @remarks
 * Round-trip fidelity is paramount: a `snapshot()` → `createRestoredWorkflow()` reproduces the
 * same status at every node (each `#override` restored DIRECTLY from the snapshot's own
 * `override` field, not guessed from a status divergence), the same recorded
 * {@link import('./types.js').TaskResult}s, and the same positional order (an interior
 * `skip` / `remove` survives). The snapshot is SELF-CONTAINED — it persists the `bail`
 * policy it ran under, so the restore re-derives status IDENTICALLY without a silent
 * default; the snapshot's `bail` is the source of truth, while an explicit `options.bail`
 * still wins when supplied (to deliberately re-run under a different policy). A structurally
 * invalid snapshot (a status — or override — outside the lifecycle vocabulary, or a
 * non-boolean `bail`) throws a `RESTORE` {@link WorkflowError}.
 * Runtime handlers are optional: without a matching `functions` entry, a persisted `behavior`
 * remains visible with an undefined `handler` so the exact state is inspectable. The runner
 * rejects that unresolved tree if execution is attempted.
 *
 * @param snapshot - The snapshot to restore (carries its own `bail` + `override`)
 * @param options - Runtime options (initial listeners, an optional `bail` override, per-node options)
 * @returns The restored live {@link WorkflowInterface} root
 *
 * @example
 * ```ts
 * import { createRestoredWorkflow } from '@orkestrel/workflow'
 *
 * const restored = createRestoredWorkflow(workflow.snapshot()) // bail comes from the snapshot
 * restored.status === workflow.status // true
 * ```
 */
export function createRestoredWorkflow(
	snapshot: unknown,
	options?: WorkflowOptions,
): WorkflowInterface {
	const captured = captureWorkflowOptions(options)
	const owned = cloneWorkflowSnapshot(snapshot)
	return new Workflow(owned, captured)
}

/**
 * Build an interrupted workflow back to life at its remaining retry budget.
 *
 * @remarks
 * Each phase captures every unique initial `behavior` binding once before constructing tasks. Recovery
 * validates those live tasks' captured callable handlers without rereading the registry, while the
 * retained registry identity remains available to resolve future live additions at their mint time.
 *
 * @param snapshot - The hostile persisted snapshot
 * @param options - Runtime handlers and entity options
 * @returns A recoverable live {@link WorkflowInterface} root
 *
 * @example
 * ```ts
 * import { createRecoveredWorkflow } from '@orkestrel/workflow'
 *
 * const recovered = createRecoveredWorkflow(snapshot, { functions })
 * recovered.status // 'pending' — interrupted running work returned to its remaining budget
 * ```
 */
export function createRecoveredWorkflow(
	snapshot: unknown,
	options?: WorkflowOptions,
): WorkflowInterface {
	const captured = captureWorkflowOptions(options)
	const owned = cloneWorkflowSnapshot(snapshot)
	if (owned.override !== undefined || owned.phases.some((phase) => phase.override !== undefined)) {
		throw new WorkflowError('RESTORE', `workflow '${owned.id}' has a terminal override`, {
			workflow: owned.id,
		})
	}
	const recovered = cloneWorkflowSnapshot(recoverWorkflowSnapshot(owned))
	const workflow = new Workflow(recovered, captured)
	if (!hasWorkflowHandlers(workflow)) {
		throw new WorkflowError('RESTORE', `workflow '${owned.id}' has an unresolved behavior`, {
			workflow: owned.id,
		})
	}
	return workflow
}

/**
 * Create the in-memory durable {@link WorkflowStoreInterface} — a process-lifetime
 * {@link MemoryWorkflowStore} persisting {@link WorkflowSnapshot}s by workflow id, the DEFAULT
 * backend behind the W-d persistence seam.
 *
 * @remarks
 * The snapshot analogue of the server package's `createMemorySessionStore`
 * (and the `createMemoryQueueStore` family), but LEANER — there is no idle-TTL, so no
 * options bag (AGENTS §21 minimal): a persisted run-state lives until an explicit `delete`. This is
 * the zero-plumbing DEFAULT (a plain `Map`); its driver-pluggable twin is
 * {@link createDatabaseWorkflowStore} (the snapshot as one opaque JSON column over a `databases`
 * table) — for a DURABLE store (run-state surviving a restart) pass it a JSON / SQLite / IndexedDB
 * driver, and it swaps in WITHOUT touching the runner or the entity tree. Restore stays a caller
 * concern: read a snapshot back and rebuild the live tree with {@link createRestoredWorkflow}.
 *
 * @returns A memory-backed {@link WorkflowStoreInterface}
 *
 * @example
 * ```ts
 * import { createMemoryWorkflowStore, createWorkflow, createRestoredWorkflow } from '@orkestrel/workflow'
 *
 * const store = createMemoryWorkflowStore()
 * const workflow = createWorkflow(definition)
 * await store.set(workflow.snapshot())          // persist the run state
 * const snapshot = await store.get(definition.id)
 * const restored = snapshot && createRestoredWorkflow(snapshot)       // an identical live tree
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
 * `rawShape` (a JSON blob), exactly as `createDatabaseQueueStore` stores its `input`. The
 * snapshot is already a COMPLETE, self-contained, pure-JSON payload, so storing it whole is lossless
 * AND keeps the row type FLAT — a structured multi-column snapshot table would force the contract to
 * `Infer` the deeply-nested snapshot shape (workflow → phases → tasks → results) and trip TS2589;
 * the opaque column sidesteps it (the column reads back as `unknown`, owned and narrowed on `get` by
 * {@link cloneWorkflowSnapshot}, whose semantic pass is
 * {@link import('./validators.js').isOwnedWorkflowSnapshot}). The `driver` DEFAULTS to
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
 * import { createMemoryDriver } from '@orkestrel/database'
 * import { createDatabaseWorkflowStore, createWorkflow, createRestoredWorkflow } from '@orkestrel/workflow'
 *
 * const store = createDatabaseWorkflowStore(createMemoryDriver()) // a durable driver swaps in here
 * const workflow = createWorkflow(definition)
 * await store.set(workflow.snapshot())          // persist the run state (one JSON column)
 * const snapshot = await store.get(definition.id)
 * const restored = snapshot && createRestoredWorkflow(snapshot)       // an identical live tree
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
 * each task dispatched through its OWN resolved handler under the workflow's `bail` policy.
 *
 * @remarks
 * The runner is a PURE engine — it re-implements no concurrency / retry / abort logic, AND it
 * carries no behavior or provider registry of its own: each live task already
 * resolved its own {@link import('./types.js').WorkflowFunction} into
 * {@link import('./types.js').TaskInterface.handler} ONCE at construction, from the
 * {@link WorkflowOptions.functions} registry supplied to `execute` / {@link createWorkflow}.
 * Per-phase bounded concurrency is one {@link createRunner} per phase; `bail` maps onto that
 * Runner's fail-fast (`true` — the first failure aborts the in-flight siblings + skips the
 * rest) vs settle-all (`false` — failures are recorded, the run finishes); the run-level abort
 * / timeout / budget ({@link import('./types.js').WorkflowRunOptions}) fold through
 * `AbortSignal.any` (the agent runtime's pattern); pacing is the shipped scheduler.
 * `execute(definition, options?)` BUILDS the live tree from the definition itself (through
 * {@link createWorkflow} — one source of truth, returned in `WorkflowResult.workflow`), drives
 * the live entity (`start` → `complete` / `fail`), and resolves a
 * {@link import('./types.js').WorkflowResult}.
 *
 * External integrations remain application-owned: a caller wires an ordinary
 * {@link import('./types.js').WorkflowFunction} into its own {@link WorkflowOptions.functions}
 * registry. Only a task that omits `behavior` auto-completes; unresolved named work is rejected
 * before dispatch.
 *
 * @param options - An optional pacing `scheduler` (default the shipped cross-environment one).
 *   See {@link WorkflowRunnerOptions}.
 * @returns A working {@link WorkflowRunnerInterface}
 *
 * @example
 * ```ts
 * import { createWorkflowRunner } from '@orkestrel/workflow'
 *
 * const runner = createWorkflowRunner()
 * const definition = { id: 'w', name: 'W', phases: [{ id: 'p', name: 'P', tasks: [
 * 	{ id: 't', name: 'T', behavior: 'compile' },
 * ] }] }
 * const result = await runner.execute(definition, {
 * 	functions: { compile: async (controller) => `built ${controller.task.id}` },
 * })
 * result.status // 'completed'
 * result.workflow.phase('p')?.task('t')?.status // 'completed'
 * ```
 */
export function createWorkflowRunner(options?: WorkflowRunnerOptions): WorkflowRunnerInterface {
	return new WorkflowRunner(options?.scheduler ?? createScheduler())
}

/**
 * Create a {@link WorkflowManagerInterface} — the store-backed registry of
 * {@link WorkflowInterface}s, the additive manager tier mirroring the `@orkestrel/agent`
 * line's `createConversationManager` / `createWorkspaceManager`.
 *
 * @remarks
 * `options.functions` flows into every workflow the manager mints (`add`, through
 * {@link createWorkflow}) or hydrates (`open`'s registry-miss path, through
 * {@link createRestoredWorkflow}), so a hydrated workflow is RUNNABLE rather than a dead snapshot
 * mirror. `options.store` is the EXACT analogue of the twins' `store` seam — omitted ⇒ the
 * manager is registry-only (`open` resolves only what is registered, `save` is a no-op). This
 * is PURELY ADDITIVE: direct {@link WorkflowStoreInterface} use and
 * {@link createRestoredWorkflow} remain valid — the manager is one more caller-driven persistence
 * seam, not a replacement.
 *
 * @param options - The optional `store` seam and the `functions` registry threaded into every mint/hydrate
 * @returns A working {@link WorkflowManagerInterface}
 *
 * @example
 * ```ts
 * import { createMemoryWorkflowStore, createWorkflowManager } from '@orkestrel/workflow'
 *
 * const manager = createWorkflowManager({
 * 	store: createMemoryWorkflowStore(),
 * 	functions: { compile: async (controller) => `built ${controller.task.id}` },
 * })
 * const workflow = manager.add(definition) // minted, registered, RUNNABLE
 * await manager.save(workflow.id)          // persisted to the store
 * const reopened = await manager.open(workflow.id) // already registered — no store hit
 * ```
 */
export function createWorkflowManager(options?: WorkflowManagerOptions): WorkflowManagerInterface {
	return new WorkflowManager(options)
}

/**
 * Create the safe cross-environment cooperative-yield default — a
 * {@link SchedulerInterface} built on `setTimeout` / `clearTimeout` alone, so it
 * runs unchanged in both the browser and Node.
 *
 * @remarks
 * `yield()` gives the host a turn through a zero-delay macrotask (so pending I/O,
 * timers, and rendering actually run — a microtask would not); `delay(ms)` resumes
 * after at least `ms`. Pass `options.signal` to make a pending yield/delay reject
 * with the signal's exact `reason`; the shared owned-signal lifecycle clears the timer
 * without invoking caller-owned listener methods.
 * `options.priority` is accepted for contract compliance but treated uniformly by
 * this default — environment backends honour it.
 *
 * @returns A working {@link SchedulerInterface}
 *
 * @example
 * ```ts
 * import { createAbort } from '@orkestrel/abort'
 * import { createScheduler } from '@orkestrel/workflow'
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
 * import { createScheduler } from '@orkestrel/workflow'
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
 * Because `spawn` is fire-and-track (the runner awaits the whole spawn closure through an
 * outstanding-unit count, not a one-time snapshot), a handler need NOT await its spawns
 * for them to run — and on a bounded runner do NOT `await` a spawn inline (a slot-holding
 * handler awaiting its own spawn can deadlock); fan out and return instead.
 *
 * @typeParam TInput - The work input each unit carries
 * @typeParam TResult - The value a unit's handler resolves
 * @param options - The `handler` plus optional `concurrency` (default `1`), `retries`
 *   (default `0`), and a default per-attempt `timeout` in milliseconds
 * @returns A working {@link RunnerInterface}
 *
 * @example
 * ```ts
 * import { createRunner } from '@orkestrel/workflow'
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
