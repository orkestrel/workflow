import type { BudgetInterface, TokenUsage } from '@orkestrel/budget'
import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'
import type { Result } from '@orkestrel/contract'
import type { WorkflowError } from './errors.js'

// Workflows — a JSON-serializable Workflow → Phase → Task tree (strict three
// levels, positional, no DAG). Two type families share this file: the DEFINITION
// family (pure serializable JSON DATA a UI/LLM authors — behavior is referenced
// BY NAME through a registry, never as inline functions) and the runtime CONTEXT
// / SNAPSHOT / RESULT surfaces the entity tree (W-b) and durable store (W-d) build
// on. One compiled contract (factories.ts) keeps the JSON Schema + guard + parser
// + generator in lockstep with the hand-written definition interfaces. Types are
// the source of truth (AGENTS §2).
//
// Determinism is a FIXED design principle, not a configuration: tasks within a
// phase are concurrent; phases are sequential. The only per-phase concurrency
// knob is `concurrency` — an optional resource throttle (max-in-flight), never a
// sequencing control.

// === Definition family (pure serializable JSON DATA)

/**
 * The serializable definition of one task — its identity plus an optional reference to
 * the behavior it runs.
 *
 * @remarks
 * Pure JSON DATA: a UI or an LLM authors it, it round-trips through the contract
 * (factories.ts), and it carries NO functions. `id` is the positional identity within
 * its phase; `name` is the human label; `description` is optional prose. `run` is a
 * PLAIN NAME — a key resolved ONCE at construction against a workflow-level
 * {@link WorkflowFunctions} registry into a runtime {@link TaskInterface.handler}
 * carried on the live task. A task whose `run` is omitted, or whose name is unregistered,
 * has no handler and AUTO-COMPLETES (the no-handler rule).
 */
export interface TaskDefinition {
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly run?: string
	/**
	 * @remarks
	 * Extra attempts after the first on failure (a non-negative integer); the runner threads it
	 * to this task's substrate unit, OVERRIDING the phase Runner's `retries` default. Omitted ⇒
	 * the default (no extra attempts). PERSISTED in a {@link TaskSnapshot} (like `bail` and
	 * `concurrency`), so `restoreWorkflow(snapshot, { functions })` resumes with the same
	 * reliability config; only the resolved handler itself is runtime-only.
	 */
	readonly retries?: number
	/**
	 * @remarks
	 * The per-attempt deadline in milliseconds (a non-negative integer); the runner threads it to
	 * this task's substrate unit, OVERRIDING the phase Runner's `timeout` default. Omitted (or a
	 * non-positive value) ⇒ no deadline. PERSISTED in a {@link TaskSnapshot} (like `bail` and
	 * `concurrency`), so `restoreWorkflow(snapshot, { functions })` resumes with the same
	 * reliability config; only the resolved handler itself is runtime-only.
	 */
	readonly timeout?: number
}

/**
 * The serializable definition of one phase — its identity, its ordered tasks, and
 * an optional resource throttle.
 *
 * @remarks
 * Pure JSON DATA. `tasks` are the phase's tasks, which run CONCURRENTLY (the fixed
 * determinism principle). `concurrency` is the optional per-phase resource throttle
 * — the maximum number of tasks in flight at once (a positive integer); omitted ⇒
 * unbounded. It is a throttle, NOT a sequencing control: phases are always
 * sequential, tasks within a phase always concurrent.
 */
export interface PhaseDefinition {
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly tasks: readonly TaskDefinition[]
	/** Max tasks in flight at once (a resource throttle); omitted ⇒ unbounded. */
	readonly concurrency?: number
	/**
	 * @remarks
	 * The per-phase failure-policy OVERRIDE (AGENTS §4.4). Omitted ⇒ the phase INHERITS the
	 * workflow `bail`; supplied, it wins (`effectiveBail = phase.bail ?? workflow.bail`). A
	 * `bail: true` phase HALTS the run on its first task failure even under a graceful workflow
	 * default; a `bail: false` phase does NOT halt even under a strict workflow default.
	 */
	readonly bail?: boolean
}

/**
 * The serializable definition of a whole workflow — its identity, its ordered
 * phases, and the `bail` failure policy.
 *
 * @remarks
 * Pure JSON DATA — the root a UI/LLM authors and the contract validates. `phases`
 * are the workflow's phases, which run SEQUENTIALLY. `bail` is the failure policy
 * (a boolean behavioral toggle, AGENTS §4.4): `false` (the default) is GRACEFUL —
 * a failed leaf task is recorded as data and the workflow still completes; `true`
 * is a database-transaction HALT — a single failed task propagates `failed` to the
 * whole workflow. See {@link import('./helpers.js').deriveWorkflowStatus}.
 */
export interface WorkflowDefinition {
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly phases: readonly PhaseDefinition[]
	/** Failure policy: `false` (default) continues gracefully, `true` halts on the first failure. */
	readonly bail?: boolean
}

// === Context chain (lineage carried back UP the tree)

/**
 * The ambient context of a workflow — the identity every level inherits.
 *
 * @remarks
 * The root of the context chain: a {@link PhaseContext} and {@link TaskContext}
 * both extend it, so a task at the leaf still sees the workflow's `id` / `name`.
 * `description` is optional (it mirrors the optional definition field).
 */
export interface WorkflowContext {
	readonly id: string
	readonly name: string
	readonly description?: string
}

/**
 * The ambient context of a phase — its own identity plus a back-reference to the
 * workflow it belongs to.
 *
 * @remarks
 * Extends {@link WorkflowContext} (so the phase carries its own `id` / `name`) and
 * adds `workflow`, the parent's context — the lineage pointer back UP the tree.
 */
export interface PhaseContext extends WorkflowContext {
	readonly workflow: WorkflowContext
}

/**
 * The ambient context of a task — its own identity plus a back-reference to the
 * phase (and, transitively, the workflow) it belongs to.
 *
 * @remarks
 * Extends {@link WorkflowContext} and adds `phase`, the parent {@link PhaseContext}
 * — so a task carries its FULL lineage (workflow → phase → task) for a
 * {@link TaskResult} or a runner.
 */
export interface TaskContext extends WorkflowContext {
	readonly phase: PhaseContext
}

// === Inputs (AGENTS §4.5 — minimal creation data)

/** The minimal data to create a workflow context — a partial {@link WorkflowContext}. */
export type WorkflowInput = Partial<WorkflowContext>

/** The minimal data to create a phase context — a partial {@link PhaseContext}. */
export type PhaseInput = Partial<PhaseContext>

/**
 * The minimal data to create a task context — a partial {@link TaskContext} plus
 * any creation-only fields.
 *
 * @remarks
 * `metadata` is an open consumer bag the workflow system stores and carries into a
 * {@link TaskSnapshot} but never interprets. All members are optional (the storing
 * layer fills identity / lineage).
 */
export interface TaskInput extends Partial<TaskContext> {
	/** An open consumer bag — stored and snapshotted, never interpreted by the workflow. */
	readonly metadata?: Readonly<Record<string, unknown>>
}

// === Patches (declarative partial updates — the mutation API's `update` payloads)

/**
 * A declarative partial update to a {@link TaskInterface} — the fields a `pending`
 * task's {@link TaskInterface.patch} (and the owning {@link TaskManagerInterface.update})
 * accept, runtime-validated via {@link import('./shapers.js').taskUpdateShape}.
 *
 * @remarks
 * Mirrors the identity fields of {@link TaskDefinition} (`name` / `description`) —
 * never `run` / `retries` / `timeout` (a form/reliability change is a structural
 * replace, not a patch) and never `id` (identity is immutable once created). Every
 * field is optional; an omitted field is left unchanged.
 *
 * @example
 * ```ts
 * const result = task.phase.tasks.update(task.id, { name: 'Renamed task' })
 * ```
 */
export interface TaskUpdate {
	readonly name?: string
	readonly description?: string
}

/**
 * A declarative partial update to a {@link PhaseInterface} — the fields a `pending`
 * phase's {@link PhaseInterface.patch} (and the owning {@link PhaseManagerInterface.update})
 * accept, runtime-validated via {@link import('./shapers.js').phaseUpdateShape}.
 *
 * @remarks
 * Mirrors the identity + throttle/policy fields of {@link PhaseDefinition} (`name` /
 * `description` / `concurrency` / `bail`) — never `id` / `tasks` (structural children
 * change through {@link PhaseInterface.add} / `remove` / `move`, not a patch). Every
 * field is optional; an omitted field is left unchanged.
 *
 * @example
 * ```ts
 * const result = workflow.phases.update(phase.id, { concurrency: 4, bail: true })
 * ```
 */
export interface PhaseUpdate {
	readonly name?: string
	readonly description?: string
	readonly concurrency?: number
	readonly bail?: boolean
}

// === Error codes (AGENTS §12 — the machine-readable codes the W-b entities throw)

/**
 * The machine-readable code of a {@link import('./errors.js').WorkflowError} — the
 * fault the live W-b state machine raises (AGENTS §12).
 *
 * @remarks
 * - `TRANSITION` — an illegal state-machine transition (e.g. `start`ing a task that is
 *   not `pending`, or `complete`/`fail`ing one that is not `running`); the guard names
 *   the offending current status + requested transition in the error `context`.
 * - `RESTORE` — a {@link import('./factories.js').restoreWorkflow} given a structurally
 *   invalid {@link WorkflowSnapshot} (a status outside the lifecycle vocabulary).
 * - `DEPTH` — a nested-workflow dispatch (W-c2) that a depth / cycle guard rejected:
 *   running it would push the nested-workflow chain past a bounded max depth, OR its
 *   target agent (or a workflow it would author) is already an ancestor of the current
 *   run (a re-entry cycle). Public type surface consumed by the `@orkestrel/tool`
 *   package's workflow-tool / agent-function adapters, which construct
 *   {@link import('./errors.js').WorkflowError}s with this code (thrown, then ISOLATED
 *   by that package's `ToolManager` into the tool result's `error`). The error `context`
 *   names the offending agent / workflow id + the depth.
 * - `TOOL` — a workflow-authoring tool handler (in `@orkestrel/tool`) was handed a
 *   MALFORMED / over-constraint authored args blob (e.g. an empty `id`, `concurrency: 0`)
 *   that {@link import('./factories.js').createWorkflowContract} rejected, so no workflow
 *   ran. Public type surface: `@orkestrel/tool` constructs this code and THROWS it
 *   (rather than returning a failure result); its `ToolManager` ISOLATES the throw into
 *   the canonical tool result's top-level `error` (AGENTS §14 — the universal
 *   tool-handler contract); the error `context` names the wrapped workflow id.
 * - `MUTATION` — a GATED structural or patch edit was refused: a duplicate id on
 *   `append`/`add`, a target that does not exist or is not `pending`, an out-of-bounds
 *   `index`, a patch that failed shaper validation, or a live structural edit refused by
 *   the NATIVE bottom-up gate — a terminal container, an edit targeting (or destined for)
 *   a position BEFORE the container's own pending-suffix boundary, or (a running phase)
 *   anything other than a pure append. The manager /
 *   entity structural API (AGENTS §12) returns it as a graceful `Result` `failure` —
 *   it NEVER throws for this code except {@link TaskInterface.patch} /
 *   {@link PhaseInterface.patch}'s defense-in-depth self-check and the build-time
 *   {@link TaskManagerInterface.append} / {@link PhaseManagerInterface.append} duplicate-id
 *   guard (both genuine programmer-error paths, AGENTS §12). The error `context` names
 *   the offending id / index / status.
 */
export type WorkflowErrorCode = 'TRANSITION' | 'RESTORE' | 'DEPTH' | 'TOOL' | 'MUTATION'

// === Status unions (AGENTS §10 lifecycle vocabulary)

/**
 * The shared lifecycle vocabulary every tier draws from — `pending` before it runs,
 * `running` while in flight, then one of the terminal states `completed` / `failed` /
 * `skipped` / `stopped`.
 *
 * @remarks
 * The ONE literal set behind the three semantic tiers ({@link TaskStatus} /
 * {@link PhaseStatus} / {@link WorkflowStatus}), which alias it so each keeps its own
 * name + doc while the vocabulary lives in one place (AGENTS §4.4 "one concept = one
 * word"). It also types the single runtime terminal check
 * {@link import('./helpers.js').isTerminalStatus} — every tier's value is a
 * `LifecycleStatus`, so the one predicate accepts them all. The tiers stay distinct
 * types (a phase status is not a task status) even though they currently share a body.
 */
export type LifecycleStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'stopped'

/**
 * The lifecycle status of a task — `pending` before it runs, `running` while in
 * flight, then one of the terminal states: `completed` (a success), `failed` (a
 * genuine error), `skipped` (intentionally not executed, AGENTS §10 `skip`), or
 * `stopped` (permanently ended, AGENTS §10 `stop`).
 *
 * @remarks
 * A semantic tier of the shared {@link LifecycleStatus} vocabulary. Uses `running` /
 * `failed` (the project vocabulary), and keeps `skipped` and `stopped` DISTINCT — a
 * skip is "deliberately not run", a stop is "ended early". The terminal members are
 * exactly those for which a {@link TaskResult} is meaningful: `completed` / `failed`
 * box a {@link Result}, while `skipped` / `stopped` are terminal WITHOUT a boxed
 * outcome. See {@link import('./helpers.js').isTerminalStatus}.
 */
export type TaskStatus = LifecycleStatus

/**
 * The lifecycle status of a phase — the same vocabulary as {@link TaskStatus},
 * derived from its tasks' statuses.
 *
 * @remarks
 * A semantic tier of the shared {@link LifecycleStatus} vocabulary. A phase is
 * `failed` only when a task failed AND the workflow's `bail` policy is in force (a
 * failure under graceful mode is data, not a phase failure). `stopped` propagates
 * when every task was stopped. See {@link import('./helpers.js').derivePhaseStatus}.
 */
export type PhaseStatus = LifecycleStatus

/**
 * The lifecycle status of a workflow — the same vocabulary as {@link TaskStatus},
 * derived from its phases' statuses under the `bail` policy.
 *
 * @remarks
 * A semantic tier of the shared {@link LifecycleStatus} vocabulary. `failed` is
 * reachable ONLY under `bail: true` (a single failed task halts the whole workflow);
 * under `bail: false` a workflow `completed`s even with failed leaf tasks. See
 * {@link import('./helpers.js').deriveWorkflowStatus}.
 */
export type WorkflowStatus = LifecycleStatus

/**
 * One phase's contribution to the workflow-status derivation — its {@link PhaseStatus} paired
 * with the EFFECTIVE `bail` policy it ran under (`phase.bail ?? workflow.bail`, AGENTS §4.4).
 *
 * @remarks
 * The input shape of {@link import('./helpers.js').deriveWorkflowStatus}: since `bail` is now a
 * per-phase override, the workflow `failed` derivation is per-phase-bail-aware, so each phase
 * must carry its OWN effective policy rather than the derivation taking one scalar `bail`. A
 * `failed` phase propagates `failed` to the workflow only when ITS `bail` is `true`; a `failed`
 * phase whose `bail` is `false` folds into completion. {@link import('./Workflow.js').Workflow}
 * builds one per live phase (`{ status: phase.status, bail: phase.bail }`).
 */
export interface PhaseDerivation {
	readonly status: PhaseStatus
	readonly bail: boolean
}

// === Task result (lineage + boxed outcome)

/**
 * The structured outcome of a task execution — its full lineage, its terminal
 * status, the moment it settled, and its boxed produced outcome.
 *
 * @remarks
 * Carries the complete lineage (`task` / `phase` / `workflow` contexts) so a result
 * is self-describing wherever it travels. `status` is the terminal state this
 * result records. `result` BOXES the produced outcome in a {@link Result}: it is
 * PRESENT exactly when `status` is `completed` (a {@link import('@orkestrel/contract').Success})
 * or `failed` (a {@link import('@orkestrel/contract').Failure}), and ABSENT when `status` is
 * `skipped` or `stopped` (terminal, but produced no outcome) — a pending/running
 * task has no result at all (a non-terminal status, per
 * {@link import('./helpers.js').isTerminalStatus}). This boxed `result` REPLACES separate
 * `value?` / `error?` fields: a success's payload is `result.value`, a failure's reason is `result.error`.
 * `timestamp` is when the result was created (ms since epoch).
 */
export interface TaskResult {
	readonly task: TaskContext
	readonly phase: PhaseContext
	readonly workflow: WorkflowContext
	readonly status: TaskStatus
	/** The boxed outcome — present for `completed` (Success) / `failed` (Failure), absent otherwise. */
	readonly result?: Result<unknown>
	readonly timestamp: number
}

// === Snapshots (the durable-store payload, pure JSON)

/**
 * A JSON-serializable snapshot of one task's state — the leaf of the snapshot tree
 * the durable store (W-d) persists.
 *
 * @remarks
 * Pure JSON DATA (no class instances, no functions). `result` is the task's
 * {@link TaskResult} when it has settled with an outcome, else `undefined`.
 * `metadata` is the open consumer bag carried from the task's {@link TaskInput}.
 * `run` / `retries` / `timeout` are the DECLARATIVE config the task carries — persisted
 * like a {@link PhaseSnapshot}'s `bail` / `concurrency`, so a restore reinstates the same
 * behavior reference and reliability overrides (`run` re-resolves against the
 * {@link WorkflowOptions.functions} registry supplied to
 * {@link import('./factories.js').restoreWorkflow}); each omitted ⇒ the corresponding
 * unset default.
 */
export interface TaskSnapshot {
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly status: TaskStatus
	readonly result?: TaskResult
	readonly metadata: Readonly<Record<string, unknown>>
	/** The behavior reference — a registry key resolved against {@link WorkflowFunctions} on restore/build. */
	readonly run?: string
	/** Extra attempts after the first on failure (a non-negative integer); overrides the phase Runner default. */
	readonly retries?: number
	/** The per-attempt deadline in milliseconds (a non-negative integer); overrides the phase Runner default. */
	readonly timeout?: number
}

/**
 * A JSON-serializable snapshot of one phase's state — its identity, status, its forced
 * override (if any), and its nested task snapshots.
 *
 * @remarks
 * Pure JSON DATA. `status` is the EFFECTIVE status (override-or-derived) at snapshot time.
 * `override` is the forced status of a whole-phase `skip` / `stop` (AGENTS §10) — PRESENT only
 * when one is in force, so a restore reinstates it DIRECTLY (no fragile derivation comparison)
 * and a genuinely-derived phase carries none. A leaf {@link TaskSnapshot} needs no `override`
 * field — a task's terminal status IS its forced marker. `tasks` are the phase's
 * {@link TaskSnapshot}s in order.
 */
export interface PhaseSnapshot {
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly status: PhaseStatus
	/** The forced status of a whole-phase `skip` / `stop`; present only when an override is in force. */
	readonly override?: PhaseStatus
	/**
	 * The EFFECTIVE failure policy this phase ran under (`phase.bail ?? workflow.bail`, AGENTS §4.4)
	 * — persisted (REQUIRED, like {@link WorkflowSnapshot.bail}) so a restore reinstates the same
	 * per-phase policy identically without a silent default.
	 */
	readonly bail: boolean
	/**
	 * Max tasks in flight at once (a resource throttle), persisted so a restore reinstates the
	 * same per-phase throttle — mirrors {@link import('./types.js').PhaseDefinition.concurrency}.
	 * Omitted ⇒ unbounded.
	 */
	readonly concurrency?: number
	readonly tasks: readonly TaskSnapshot[]
}

/**
 * A JSON-serializable snapshot of a whole workflow's state — its identity, status, its
 * forced override (if any), the `bail` policy it ran under, its nested phase snapshots,
 * and creation / update timestamps.
 *
 * @remarks
 * Pure JSON DATA — the COMPLETE, SELF-CONTAINED payload the durable store (W-d) persists,
 * designed in full at W-a so its shape is fixed from the start. It can be written to disk,
 * sent to a prompt companion, loaded across conversations, or reviewed by an agent. Because
 * it is self-contained, it carries the policy it ran under: `bail` (AGENTS §4.4) is the
 * failure policy, so {@link import('./factories.js').restoreWorkflow} re-derives status
 * IDENTICALLY without a silent default. `status` is the EFFECTIVE status (override-or-derived)
 * at snapshot time; `override` is the forced status of a whole-workflow `skip` / `stop`,
 * PRESENT only when one is in force (so a restore reinstates it DIRECTLY rather than guessing
 * from a status divergence). `phases` are the workflow's {@link PhaseSnapshot}s in order;
 * `created` / `updated` are ms since epoch.
 */
export interface WorkflowSnapshot {
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly status: WorkflowStatus
	/** The forced status of a whole-workflow `skip` / `stop`; present only when an override is in force. */
	readonly override?: WorkflowStatus
	/** The failure policy the workflow ran under (AGENTS §4.4) — persisted so a restore re-derives identically. */
	readonly bail: boolean
	readonly phases: readonly PhaseSnapshot[]
	readonly created: number
	readonly updated: number
}

/**
 * The durable persistence seam for a {@link WorkflowSnapshot} — three async primitives
 * (`get` / `set` / `delete`) keyed by a workflow id, the snapshot analogue of
 * the server package's `SessionStoreInterface` (and the
 * {@link QueueStoreInterface} driver-swap pattern).
 *
 * @remarks
 * The store persists the W-a {@link WorkflowSnapshot} — the COMPLETE, self-contained,
 * pure-JSON run state — so a JSON / SQLite / IndexedDB backend swaps in WITHOUT touching the
 * runner or the entity tree: the in-memory default
 * {@link import('./stores/MemoryWorkflowStore.js').MemoryWorkflowStore} and its driver-pluggable
 * twin {@link import('./stores/DatabaseWorkflowStore.js').DatabaseWorkflowStore} (the snapshot as
 * one opaque JSON column) share THIS one interface. Restore is NOT a store concern — a caller reads
 * a snapshot back and rebuilds the live tree with the shipped {@link import('./factories.js').restoreWorkflow}.
 *
 * Every primitive is async (a `Promise`), so a durable backend (a database round-trip) fits the
 * same shape as the memory one. The snapshot carries its OWN id, so `set` takes no separate id
 * param (mirroring {@link QueueStoreInterface.save} / the server package's
 * `SessionStoreInterface.set`, which key off the value's own
 * `id`). UNLIKE a session store there is NO idle-TTL / eviction — a persisted workflow run-state
 * lives until an explicit `delete`, never silently expiring (it is durable orchestration state,
 * not an ephemeral session). It is concrete over {@link WorkflowSnapshot} — no generic parameter
 * (AGENTS §21 minimal-interface), since the snapshot is the ONE payload a workflow store persists.
 */
export interface WorkflowStoreInterface {
	/**
	 * Resolve the persisted snapshot for `id`, or `undefined` if none is stored.
	 *
	 * @param id - The workflow id to resolve (a {@link WorkflowSnapshot.id})
	 * @returns The persisted snapshot, or `undefined` if absent
	 */
	get(id: string): Promise<WorkflowSnapshot | undefined>
	/**
	 * Insert or replace a snapshot under its own `snapshot.id` (no separate id param —
	 * mirroring {@link QueueStoreInterface.save}).
	 *
	 * @param snapshot - The snapshot to store (keyed by its `id`)
	 */
	set(snapshot: WorkflowSnapshot): Promise<void>
	/**
	 * Drop a snapshot by id; an absent id is a no-op (no throw).
	 *
	 * @param id - The workflow id to drop
	 */
	delete(id: string): Promise<void>
}

/**
 * One row of the table a {@link import('./stores/DatabaseWorkflowStore.js').DatabaseWorkflowStore}
 * persists — a workflow `id` plus its {@link WorkflowSnapshot} held as ONE OPAQUE JSON column.
 *
 * @remarks
 * The Database twin of {@link WorkflowStoreInterface} stores the snapshot whole (the `snapshot`
 * column is a `rawShape`, an opaque JSON blob — exactly as
 * `@orkestrel/queue`'s `StoredEntry` stores a queue entry's `input`), so the row
 * type stays FLAT and the deeply-nested snapshot shape (workflow → phases → tasks → results) never
 * forces the contract to `Infer` it — sidestepping a TS2589 instantiation-depth blow-up. The column
 * therefore reads back as the broad `unknown`; the store narrows it to a {@link WorkflowSnapshot} on
 * `get` ({@link import('./helpers.js').isWorkflowSnapshot}, the AGENTS §14 boundary narrow). `id`
 * mirrors {@link WorkflowSnapshot.id} (the primary key), so a `set` writes `{ id: snapshot.id, snapshot }`.
 */
export interface WorkflowSnapshotRow {
	readonly id: string
	/** The whole {@link WorkflowSnapshot} as one opaque JSON blob — read back as `unknown`, narrowed on `get`. */
	readonly snapshot: unknown
}

// === Event maps (AGENTS §13 — defined here, owned by the W-b entities)

/**
 * The push observation surface (AGENTS §13) of the workflow entity (W-b) — the
 * lifecycle moments a fire-and-forget observer subscribes to via
 * `workflow.emitter.on`.
 *
 * @remarks
 * Present-tense events with arg tuples. `start` fires when the workflow begins;
 * `complete` when every phase settled successfully; `fail` when a phase failed
 * under `bail` (carrying the failing {@link TaskResult}); `stop` when the workflow
 * was permanently ended. `add` / `remove` / `move` / `update` fire on a successful
 * structural or patch edit through {@link WorkflowInterface.add} / `remove` / `move` /
 * `update` (AGENTS §7) — never on a refused/gated one. A throwing listener never
 * reaches the domain surface — the emitter isolates it and routes it to its OWN
 * `error` handler (the `error` option, AGENTS §13). Declared as a `type` alias (not
 * `interface extends EventMap`, AGENTS §4.5) so the type-literal satisfies `EventMap`
 * structurally.
 */
export type WorkflowEventMap = {
	/** The workflow began — its `id`. */
	readonly start: readonly [id: string]
	/** Every phase settled successfully. */
	readonly complete: readonly []
	/** A phase failed under `bail` — the failing task's result. */
	readonly fail: readonly [result: TaskResult]
	/** The workflow was permanently stopped. */
	readonly stop: readonly []
	/** A phase was inserted — the inserted phase + its final index. */
	readonly add: readonly [phase: PhaseInterface, index: number]
	/** A phase was removed — the removed phase. */
	readonly remove: readonly [phase: PhaseInterface]
	/** A phase was repositioned — the moved phase + its new index. */
	readonly move: readonly [phase: PhaseInterface, index: number]
	/** A phase was patched — the patched phase. */
	readonly update: readonly [phase: PhaseInterface]
}

/**
 * The push observation surface (AGENTS §13) of the phase entity (W-b) — analogous
 * to {@link WorkflowEventMap}, scoped to one phase.
 *
 * @remarks
 * `start` fires when the phase begins; `complete` when all its tasks settled
 * successfully; `fail` when a task failed under `bail` (carrying the
 * {@link TaskResult}); `stop` when the phase was ended. `add` / `remove` / `move` /
 * `update` fire on a successful structural or patch edit through
 * {@link PhaseInterface.add} / `remove` / `move` / `update` (AGENTS §7) — never on a
 * refused/gated one. A throwing listener is isolated by the emitter and routed to its
 * `error` handler, not the domain surface (AGENTS §13). A `type` alias (AGENTS §4.5)
 * so it satisfies `EventMap`.
 */
export type PhaseEventMap = {
	/** The phase began — its `id`. */
	readonly start: readonly [id: string]
	/** Every task in the phase settled successfully. */
	readonly complete: readonly []
	/** A task failed under `bail` — the failing task's result. */
	readonly fail: readonly [result: TaskResult]
	/** The phase was permanently stopped. */
	readonly stop: readonly []
	/** A task was inserted — the inserted task + its final index. */
	readonly add: readonly [task: TaskInterface, index: number]
	/** A task was removed — the removed task. */
	readonly remove: readonly [task: TaskInterface]
	/** A task was repositioned — the moved task + its new index. */
	readonly move: readonly [task: TaskInterface, index: number]
	/** A task was patched — the patched task. */
	readonly update: readonly [task: TaskInterface]
}

/**
 * The push observation surface (AGENTS §13) of the task entity (W-b) — the
 * lifecycle moments of one task.
 *
 * @remarks
 * `start` fires when the task begins; `complete` when it finishes successfully
 * (carrying its {@link TaskResult}); `fail` when it errors (carrying the result);
 * `skip` when it is intentionally not executed; `stop` when it is ended early. A
 * throwing listener is isolated by the emitter and routed to its `error` handler,
 * not the domain surface (AGENTS §13). A `type` alias (AGENTS §4.5) so it satisfies
 * `EventMap`.
 */
export type TaskEventMap = {
	/** The task began — its `id`. */
	readonly start: readonly [id: string]
	/** The task finished successfully — its result. */
	readonly complete: readonly [result: TaskResult]
	/** The task failed — its result. */
	readonly fail: readonly [result: TaskResult]
	/** The task was intentionally skipped. */
	readonly skip: readonly []
	/** The task was permanently stopped. */
	readonly stop: readonly []
}

// === Hooks (AGENTS §8 — the reserved `on` option for the W-b entities)

/** Initial {@link WorkflowEventMap} listeners — the reserved `on` option (AGENTS §8). */
export type WorkflowHooks = EmitterHooks<WorkflowEventMap>

/** Initial {@link PhaseEventMap} listeners — the reserved `on` option (AGENTS §8). */
export type PhaseHooks = EmitterHooks<PhaseEventMap>

/** Initial {@link TaskEventMap} listeners — the reserved `on` option (AGENTS §8). */
export type TaskHooks = EmitterHooks<TaskEventMap>

// === Runtime options (AGENTS §8 — the construction bags the W-b entity tree carries)

/**
 * The runtime options for a {@link TaskInterface} — the construction bag the live
 * leaf state machine (W-b) carries that the W-a {@link TaskDefinition} did not.
 *
 * @remarks
 * The reserved `on` (AGENTS §8) wires initial {@link TaskEventMap} listeners; a
 * {@link import('./factories.js').createWorkflow}-built tree threads each level's `on`
 * from its parent options, the same way a {@link WorkflowInterface.add} /
 * {@link PhaseInterface.add} mint threads a leaf's `on` from ITS options. `metadata` is
 * the open consumer bag carried verbatim into a {@link TaskSnapshot} (mirrors
 * {@link TaskInput.metadata}), never interpreted by the workflow.
 */
export interface TaskOptions {
	readonly on?: TaskHooks
	/** The emitter's listener-error handler (AGENTS §13) — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	/** An open consumer bag — stored and snapshotted, never interpreted by the workflow. */
	readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * The runtime options for a {@link PhaseInterface} — the construction bag the live
 * derived phase state machine (W-b) carries.
 *
 * @remarks
 * The reserved `on` (AGENTS §8) wires initial {@link PhaseEventMap} listeners.
 * `tasks` keys per-task {@link TaskOptions} by task `id`, so {@link createWorkflow}
 * can thread a leaf's options (its `on` / `metadata`) down through the phase when it
 * builds the whole tree.
 */
export interface PhaseOptions {
	readonly on?: PhaseHooks
	/** The emitter's listener-error handler (AGENTS §13) — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	/** Per-task {@link TaskOptions}, keyed by the task's `id`. */
	readonly tasks?: Readonly<Record<string, TaskOptions>>
}

/**
 * The runtime options for a {@link WorkflowInterface} — the construction bag the
 * live derived workflow state machine (W-b) carries, the root {@link createWorkflow}
 * accepts.
 *
 * @remarks
 * The reserved `on` (AGENTS §8) wires initial {@link WorkflowEventMap} listeners.
 * `phases` keys per-phase {@link PhaseOptions} by phase `id`, so the whole tree's
 * initial listeners + per-task metadata can be supplied in one nested bag (the
 * AGENTS §8 "entity is the key" grouping), each leaf reachable by its lineage of ids.
 */
export interface WorkflowOptions {
	readonly on?: WorkflowHooks
	/**
	 * The failure policy (AGENTS §4.4) the live tree applies — the same boolean toggle as
	 * {@link WorkflowDefinition.bail}, fed to {@link import('./helpers.js').deriveWorkflowStatus}.
	 * {@link import('./factories.js').createWorkflow} defaults it to the definition's `bail`. A
	 * {@link WorkflowSnapshot} PERSISTS the policy, so {@link import('./factories.js').restoreWorkflow}
	 * takes it from the snapshot (the source of truth); an explicit `options.bail` on restore still
	 * wins when supplied. Omitted on a fresh build ⇒ the graceful {@link import('./constants.js').DEFAULT_BAIL}.
	 */
	readonly bail?: boolean
	/** The emitter's listener-error handler (AGENTS §13) — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	/** Per-phase {@link PhaseOptions}, keyed by the phase's `id`. */
	readonly phases?: Readonly<Record<string, PhaseOptions>>
	/**
	 * The `function`-task behavior registry ({@link WorkflowFunctions}) each live task's
	 * {@link TaskDefinition.run} / {@link TaskSnapshot.run} name resolves against ONCE at
	 * construction into its runtime {@link TaskInterface.handler} — the SAME registry a
	 * fresh build ({@link import('./factories.js').createWorkflow}) and a restore
	 * ({@link import('./factories.js').restoreWorkflow}) both consume, and the same shape a
	 * live {@link WorkflowInterface.add} / {@link PhaseInterface.add} mint resolves a newly
	 * minted task against. A `run` name absent from `functions` (or omitted entirely)
	 * resolves to no handler — that task AUTO-COMPLETES (the no-handler rule): its
	 * phase/workflow still reaches a terminal status, just with no dispatched behavior.
	 * Omitted ⇒ an empty registry (every task auto-completes).
	 */
	readonly functions?: WorkflowFunctions
}

// === Entity interfaces (AGENTS §7/§13 — the live W-b state machines)
//
// Mutation authority is BOTTOM-UP and NATIVE: `add` / `remove` / `move` / `update`
// gate purely from the container's OWN derived status and the list's positions — no
// runner-installed hook inverts that authority. The "pending suffix" of a positional
// list is its contiguous trailing run of `pending` entries; its BOUNDARY (the index
// of the first entry in that suffix) is a live run's de facto cursor, computed fresh
// from statuses rather than tracked by an installed hook — see
// {@link import('./helpers.js').deriveBoundary}.

/**
 * The live leaf state machine (W-b) for one {@link TaskDefinition} — an observable
 * (AGENTS §13), guarded synchronous task whose explicit {@link TaskStatus} advances
 * through the AGENTS §10 transitions.
 *
 * @remarks
 * - **Identity + lineage.** `id` / `name` / `description` mirror the definition;
 *   `context` is the task's full {@link TaskContext} (so `context.phase` /
 *   `context.phase.workflow` navigate UP the tree), and `phase` / `workflow` are the
 *   live parent entities for direct lineage navigation.
 * - **State machine (AGENTS §10).** `status` is the explicit current state. `start`
 *   moves `pending → running`; the terminal transitions are `complete(value)` (records
 *   a {@link import('@orkestrel/contract').Success}), `fail(error)` (records a
 *   {@link import('@orkestrel/contract').Failure}), `skip` (AGENTS §10 — intentionally not run),
 *   and `stop` (AGENTS §10 — ended early). Each is GUARDED: an illegal transition (e.g.
 *   completing a non-`running` task) throws a {@link import('./errors.js').WorkflowError}.
 *   `skip` / `stop` set the override so the leaf's terminal state survives a snapshot.
 * - **Result.** `result` is the recorded {@link TaskResult} once the task settled with an
 *   outcome (`completed` / `failed`), else `undefined` — the lineage-navigable leaf of the
 *   result tree.
 * - **Observable (AGENTS §13).** The owned {@link emitter} ({@link TaskEventMap}) fires
 *   `start` / `complete` / `fail` / `skip` / `stop` strictly AFTER each transition; the
 *   emitter isolates a listener throw and routes it to its `error` handler (the `error` option).
 */
export interface TaskInterface {
	readonly emitter: EmitterInterface<TaskEventMap>
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly context: TaskContext
	readonly phase: PhaseInterface
	readonly workflow: WorkflowInterface
	readonly status: TaskStatus
	/** The recorded outcome once the task settled with one (`completed` / `failed`), else `undefined`. */
	readonly result: TaskResult | undefined
	/**
	 * The behavior reference — a plain registry key name, PERSISTED (mirrors
	 * {@link TaskDefinition.run} / {@link TaskSnapshot.run}), like {@link PhaseInterface.bail}.
	 * `undefined` when this task has no behavior reference.
	 */
	readonly run: string | undefined
	/**
	 * The RESOLVED runtime handler — RUNTIME-ONLY, NEVER persisted in a {@link TaskSnapshot}.
	 * Resolved ONCE at construction (build, restore, or a live mint) by looking `run` up in the
	 * workflow-level {@link WorkflowOptions.functions} registry: `functions?.[run]` when `run`
	 * is defined, else `undefined`. A task with no `handler` (an omitted `run`, or a `run` name
	 * absent from the registry) AUTO-COMPLETES (the no-handler rule) — its phase/workflow still
	 * reaches a terminal status, just with no dispatched behavior.
	 */
	readonly handler: WorkflowFunction | undefined
	/**
	 * Extra attempts after the first on failure — PERSISTED (mirrors {@link TaskDefinition.retries}
	 * / {@link TaskSnapshot.retries}), like {@link PhaseInterface.concurrency}. `undefined` ⇒ none.
	 */
	readonly retries: number | undefined
	/**
	 * The per-attempt deadline in milliseconds — PERSISTED (mirrors {@link TaskDefinition.timeout}
	 * / {@link TaskSnapshot.timeout}). `undefined` ⇒ no deadline.
	 */
	readonly timeout: number | undefined
	start(): void
	complete(value: unknown): void
	fail(error: unknown): void
	skip(): void
	stop(): void
	/**
	 * Apply a validated declarative patch to SELF (`name` / `description`).
	 *
	 * @remarks
	 * Defense-in-depth (AGENTS §12): the owning {@link TaskManagerInterface.update} gates
	 * FIRST (target exists + `pending`), so a direct call here is the second, redundant
	 * check — it THROWS a `MUTATION` {@link import('./errors.js').WorkflowError} unless
	 * this task's own `status` is `pending`.
	 *
	 * @param value - The {@link TaskUpdate} fields to apply
	 * @example
	 * ```ts
	 * task.patch({ name: 'Renamed task' })
	 * ```
	 */
	patch(value: TaskUpdate): void
	snapshot(): TaskSnapshot
}

/**
 * The live derived state machine (W-b) for one {@link PhaseDefinition} — an
 * observable (AGENTS §13) phase whose {@link PhaseStatus} is DERIVED from its tasks
 * (never set directly) and recomputed reactively as a task transitions (the cascade).
 *
 * @remarks
 * - **Derived status.** `status` is computed via
 *   {@link import('./helpers.js').derivePhaseStatus} over the live tasks' statuses,
 *   UNLESS an override is in force. It recomputes whenever a child task transitions; a
 *   CHANGE emits.
 * - **Children.** `tasks` is the lean {@link TaskManagerInterface} (AGENTS §9 — an
 *   accessor + `count`, no batch matrix); `task(id)` / `tasks().tasks()` read in positional
 *   order. `results` collects the settled tasks' {@link TaskResult}s (the phase tier of the
 *   result tree); `workflow` navigates UP to the live parent.
 * - **Override.** `skip` / `stop` (AGENTS §10) FORCE the phase's status, overriding the
 *   derived value (e.g. skipping a whole phase); the override survives a snapshot.
 * - **Observable (AGENTS §13).** The owned {@link emitter} ({@link PhaseEventMap}) fires
 *   `start` / `complete` / `fail` / `stop` on a derived-status change; the emitter isolates a
 *   listener throw and routes it to its `error` handler (the `error` option).
 * - **Runtime lifecycle (AGENTS §10).** `pause` / `resume` / `wait` mirror
 *   {@link WorkflowInterface.pause} / `resume` / `wait`, scoped to this phase — a driving
 *   {@link WorkflowRunnerInterface.execute} gates a task's own pre-dispatch on BOTH the
 *   workflow's and its phase's gate. `paused` is RUNTIME-ONLY, never persisted; idempotent;
 *   released by `resume` and by this phase's own `stop` / `skip` forcing a terminal status
 *   (a permanently-ended phase has nothing left to pause for).
 */
export interface PhaseInterface {
	readonly emitter: EmitterInterface<PhaseEventMap>
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly context: PhaseContext
	readonly workflow: WorkflowInterface
	readonly status: PhaseStatus
	/** The RESOLVED effective failure policy this phase runs under (`phase.bail ?? workflow.bail`); mirrors {@link WorkflowInterface.bail}. */
	readonly bail: boolean
	/** Max tasks in flight at once (a resource throttle); mirrors {@link PhaseSnapshot.concurrency}. `undefined` ⇒ unbounded. */
	readonly concurrency: number | undefined
	/**
	 * Whether the phase is currently paused (AGENTS §10 — resumable); RUNTIME-ONLY — never a
	 * {@link PhaseStatus}, never persisted in a {@link PhaseSnapshot} (a paused phase's
	 * `status` still reports its ordinary derived value).
	 */
	readonly paused: boolean
	readonly tasks: TaskManagerInterface
	/** Look up one live task by its `id`. */
	task(id: string): TaskInterface | undefined
	/** The settled tasks' results, in positional order — the phase tier of the result tree. */
	results(): readonly TaskResult[]
	/**
	 * FORCE this phase to `skipped` (AGENTS §10), overriding the derived value; idempotent.
	 *
	 * @remarks
	 * A NO-OP once `status` is already terminal — a settled phase cannot be re-forced. Always
	 * releases a parked {@link wait} waiter regardless (a terminal phase has nothing left to
	 * pause for).
	 */
	skip(): void
	/**
	 * FORCE this phase to `stopped` (AGENTS §10), overriding the derived value; idempotent.
	 *
	 * @remarks
	 * A NO-OP once `status` is already terminal (a settled phase cannot be re-forced). Always
	 * releases a parked {@link wait} waiter regardless (a terminal phase has nothing left to
	 * pause for).
	 */
	stop(): void
	/**
	 * Suspend the phase (AGENTS §10 — resumable); idempotent.
	 *
	 * @remarks
	 * A no-op when already `paused` or when `status` is terminal. RUNTIME-ONLY (AGENTS §10) —
	 * never a {@link PhaseStatus}, never persisted in a {@link PhaseSnapshot}. A driving
	 * {@link WorkflowRunnerInterface.execute} gates a task's own pre-dispatch on this phase's
	 * gate (after the workflow's own gate). **Pausing does NOT suspend a driving run's
	 * timeout / budget / abort clocks** — those bounds keep ticking while paused, so a long
	 * pause can still fire a run-level cancel and stop the workflow while parked.
	 *
	 * @example
	 * ```ts
	 * phase.pause()
	 * phase.paused // true
	 * ```
	 */
	pause(): void
	/**
	 * Continue a paused phase (AGENTS §10); idempotent — a no-op unless {@link paused}.
	 *
	 * @example
	 * ```ts
	 * phase.resume()
	 * phase.paused // false
	 * ```
	 */
	resume(): void
	/**
	 * Park until this phase is not paused — **promise-parked**, never a timer or busy-loop
	 * (AGENTS §21; mirrors {@link WorkflowInterface.wait}).
	 *
	 * @remarks
	 * Resolves IMMEDIATELY when not {@link paused}. While paused, parks until `resume` or
	 * this phase's own `stop` / `skip` forcing a terminal status — all release a parked
	 * waiter. NEVER rejects.
	 *
	 * @returns A promise that resolves once the phase is no longer paused
	 */
	wait(): Promise<void>
	/**
	 * MINT a live {@link TaskInterface} from `definition` and insert it into this phase
	 * (AGENTS §7 the entity structural API) — gated BEFORE delegating to {@link tasks}'
	 * manager.
	 *
	 * @remarks
	 * Converts `definition` → {@link TaskSnapshot} and constructs the live task (wired to
	 * THIS phase, its recompute cascade, and its emitter hooks), carrying its `run` /
	 * `retries` / `timeout` from `definition` and resolving its {@link TaskInterface.handler}
	 * against the workflow-level {@link WorkflowOptions.functions} registry — the SAME
	 * resolution {@link import('./factories.js').createWorkflow} performs at build time.
	 * Requires `definition.id` to be UNIQUE among this phase's existing
	 * task ids — a duplicate is a `MUTATION` failure (mirrors
	 * {@link TaskManagerInterface.add}'s own duplicate-id gate).
	 *
	 * NATIVE gating, purely from this phase's own derived `status` (AGENTS §12 — no
	 * runner-installed hook), UNCHANGED from the entity-taking predecessor. While
	 * `pending`: any valid `index` is accepted (delegates the minted task to
	 * {@link TaskManagerInterface.add} then emits `add`). While `running`: accepted ONLY as
	 * a pure append (`index` omitted or `=== tasks.count`) — a live runner subscribed to
	 * the `add` event picks the new task up for same-run execution; the derived-status
	 * model guarantees this phase cannot reach a terminal status while the accepted task is
	 * still `pending` (its status feeds `status` via {@link import('./helpers.js').derivePhaseStatus}).
	 * While terminal: always refused.
	 *
	 * **Abort edge.** An append ACCEPTED while `running` can still settle `skipped` rather
	 * than run — if the driving run is cancelled (abort / timeout / budget / `workflow.destroy()`)
	 * before the substrate actually dispatches the newly-minted task, the runner's halt sweep
	 * `skip`s it like any other not-yet-started task. Acceptance here only guarantees the task
	 * is WIRED into the live tree, not that it will execute.
	 *
	 * @param definition - The {@link TaskDefinition} to mint a live task from
	 * @param index - The insertion position; omitted inserts at the end
	 * @returns A {@link Result} boxing the minted, inserted task, or a `MUTATION` failure
	 */
	add(definition: TaskDefinition, index?: number): Result<TaskInterface, WorkflowError>
	/**
	 * Remove the `pending` task `id` from this phase.
	 *
	 * @remarks
	 * NATIVE gating: allowed only while this phase's own `status` is `pending`. While
	 * `running` or terminal, always a `MUTATION` failure — a running phase's tasks are
	 * already handed to the execution substrate and only a pure {@link add} append remains
	 * possible.
	 *
	 * @param id - The task id to remove
	 * @returns A {@link Result} boxing the removed task, or a `MUTATION` failure
	 */
	remove(id: string): Result<TaskInterface, WorkflowError>
	/**
	 * Reposition the `pending` task `id` to `index` within this phase.
	 *
	 * @remarks
	 * NATIVE gating: allowed only while this phase's own `status` is `pending`; `running` /
	 * terminal always fail (see {@link remove}).
	 *
	 * @param id - The task id to move
	 * @param index - The destination position
	 * @returns A {@link Result} boxing the moved task, or a `MUTATION` failure
	 */
	move(id: string, index: number): Result<TaskInterface, WorkflowError>
	/**
	 * Apply a validated {@link TaskUpdate} patch to the `pending` task `id` in this phase.
	 *
	 * @remarks
	 * NATIVE gating: allowed only while this phase's own `status` is `pending`; `running` /
	 * terminal always fail (see {@link remove}).
	 *
	 * @param id - The task id to patch
	 * @param patch - The fields to update
	 * @returns A {@link Result} boxing the patched task, or a `MUTATION` failure
	 */
	update(id: string, patch: TaskUpdate): Result<TaskInterface, WorkflowError>
	/**
	 * Apply a validated declarative patch to SELF (`name` / `description` /
	 * `concurrency` / `bail`).
	 *
	 * @remarks
	 * Defense-in-depth (AGENTS §12): the owning {@link WorkflowInterface.update} gates
	 * FIRST, so a direct call here THROWS a `MUTATION`
	 * {@link import('./errors.js').WorkflowError} unless this phase's own `status` is
	 * `pending`.
	 *
	 * @param value - The {@link PhaseUpdate} fields to apply
	 * @example
	 * ```ts
	 * phase.patch({ concurrency: 4 })
	 * ```
	 */
	patch(value: PhaseUpdate): void
	snapshot(): PhaseSnapshot
}

/**
 * The live derived state machine (W-b) for a whole {@link WorkflowDefinition} — the
 * observable (AGENTS §13) root whose {@link WorkflowStatus} is DERIVED from its phases
 * under the `bail` policy and recomputed reactively as the cascade propagates up.
 *
 * @remarks
 * - **Derived status.** `status` is computed via
 *   {@link import('./helpers.js').deriveWorkflowStatus} over the live phases' statuses,
 *   feeding the definition's `bail`, UNLESS an override is in force. It recomputes when a
 *   phase's status changes (the top of the cascade); a CHANGE emits — `fail` carries the
 *   failing {@link TaskResult} (under `bail: true`).
 * - **Children.** `phases` is the lean {@link PhaseManagerInterface} (AGENTS §9);
 *   `phase(id)` / `phases().phases()` read in positional order. `results` collects ALL
 *   tasks' results across every phase (the workflow tier of the result tree).
 * - **Override.** `skip` / `stop` (AGENTS §10) FORCE the workflow's status; the override
 *   survives a snapshot.
 * - **Snapshot.** `snapshot()` serializes the whole live tree to a {@link WorkflowSnapshot}
 *   (pure JSON — structure + each node's status + recorded results + positional order);
 *   {@link restoreWorkflow} rebuilds an equivalent live tree.
 * - **Observable (AGENTS §13).** The owned {@link emitter} ({@link WorkflowEventMap}) fires
 *   `start` / `complete` / `fail` / `stop` on a derived-status change; the emitter isolates a
 *   listener throw and routes it to its `error` handler (the `error` option).
 */
export interface WorkflowInterface {
	readonly emitter: EmitterInterface<WorkflowEventMap>
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly context: WorkflowContext
	readonly bail: boolean
	readonly status: WorkflowStatus
	readonly phases: PhaseManagerInterface
	/**
	 * Whether the workflow is currently paused (AGENTS §10 — resumable); RUNTIME-ONLY —
	 * never a {@link WorkflowStatus}, never persisted in a {@link WorkflowSnapshot} (a
	 * paused workflow's `status` still reports its ordinary `pending` / `running` value).
	 */
	readonly paused: boolean
	/** Whether {@link destroy} has torn this workflow down; RUNTIME-ONLY, never persisted. */
	readonly destroyed: boolean
	/**
	 * This workflow's own cancellation signal — fires on {@link destroy}. RUNTIME-ONLY
	 * (implemented over `@orkestrel/abort`, AGENTS core precedent), never persisted.
	 */
	readonly signal: AbortSignal
	/** Look up one live phase by its `id`. */
	phase(id: string): PhaseInterface | undefined
	/** Every settled task's result across all phases, in positional order — the workflow tier of the result tree. */
	results(): readonly TaskResult[]
	/**
	 * FORCE this workflow to `skipped` (AGENTS §10), overriding the derived value; idempotent.
	 *
	 * @remarks
	 * A NO-OP once `status` is already terminal — a settled workflow cannot be re-forced.
	 * Always releases a parked {@link wait} waiter regardless (a terminal workflow has nothing
	 * left to pause for).
	 */
	skip(): void
	/**
	 * FORCE this workflow to `stopped` (AGENTS §10), overriding the derived value; idempotent.
	 *
	 * @remarks
	 * A NO-OP once `status` is already terminal — a settled workflow cannot be re-forced. Always
	 * releases a parked {@link wait} waiter regardless (a terminal workflow has nothing left to
	 * pause for).
	 */
	stop(): void
	/**
	 * FORCE this workflow to `completed` (AGENTS §10), overriding the derived value.
	 *
	 * @remarks
	 * A NO-OP unless `status` is `pending` — its ONLY legitimate use is settling a vacuously
	 * DONE tree (no work happened), mirroring the runner's own gate. Never overrides a real
	 * `completed` / a bail-true `failed` / a `stopped` / a derived `skipped`.
	 */
	complete(): void
	/**
	 * Suspend the workflow (AGENTS §10 — resumable); idempotent.
	 *
	 * @remarks
	 * A no-op when already `paused`, when `status` is terminal, or once {@link destroyed}.
	 * RUNTIME-ONLY (AGENTS §10) — never a {@link WorkflowStatus}, never persisted in a
	 * {@link WorkflowSnapshot}. A driving {@link WorkflowRunnerInterface.execute} gates at the
	 * next phase boundary and before each task's own dispatch; an in-flight task body is
	 * never suspended mid-flight. **Pausing does NOT suspend the run's timeout / budget /
	 * abort clocks** — those bounds keep ticking while paused, so a run parked on
	 * `pause()` can still be cancelled (and settle `stopped`) by its own deadline / budget /
	 * abort while parked.
	 *
	 * @example
	 * ```ts
	 * workflow.pause()
	 * workflow.paused // true
	 * ```
	 */
	pause(): void
	/**
	 * Continue a paused workflow (AGENTS §10); idempotent — a no-op unless {@link paused}.
	 *
	 * @example
	 * ```ts
	 * workflow.resume()
	 * workflow.paused // false
	 * ```
	 */
	resume(): void
	/**
	 * Tear this workflow down (AGENTS §10) — a TERMINAL teardown: aborts {@link signal},
	 * `stop`s every non-terminal live phase (so any engine parked on a phase's own gate
	 * unparks and the tree lands coherent), forces the `stop` override on THIS workflow if
	 * it is not already terminal, resolves any parked {@link wait} waiter, and marks
	 * {@link destroyed}; idempotent.
	 *
	 * @remarks
	 * After `destroy`, every structural mutator (`add` / `remove` / `move` / `update` /
	 * `patch`) and `pause` / `resume` reject (a `Result` failure) or no-op — never throws
	 * for calling `destroy` itself twice.
	 *
	 * @example
	 * ```ts
	 * workflow.destroy()
	 * workflow.destroyed // true
	 * ```
	 */
	destroy(): void
	/**
	 * Park until this workflow is not paused — **promise-parked**, never a timer or
	 * busy-loop (AGENTS §21; mirrors {@link ControllerInterface.wait}'s doc style).
	 *
	 * @remarks
	 * Resolves IMMEDIATELY when not {@link paused}. While paused, parks until `resume` /
	 * `skip` / `stop` / `destroy` — each always releases a parked waiter (a permanently
	 * ended workflow has nothing left to pause for). NEVER rejects.
	 *
	 * @returns A promise that resolves once the workflow is no longer paused
	 */
	wait(): Promise<void>
	/**
	 * MINT a live {@link PhaseInterface} (and its tasks) from `definition` and insert it
	 * into this workflow (AGENTS §7 the entity structural API) — gated BEFORE delegating
	 * to {@link phases}' manager.
	 *
	 * @remarks
	 * Converts `definition` → {@link PhaseSnapshot} and constructs the live phase (wired to
	 * THIS workflow, its recompute cascade, and its emitter hooks) plus each of its live
	 * tasks — each task's `run` / `retries` / `timeout` carried from its {@link TaskDefinition}
	 * and its {@link TaskInterface.handler} resolved against the workflow-level
	 * {@link WorkflowOptions.functions} registry (mirrors
	 * {@link import('./factories.js').createWorkflow}'s build-time resolution). The
	 * phase's effective `bail` resolves exactly as the build path does
	 * (`definition.bail ?? this.bail`). Requires `definition.id` to be UNIQUE among this
	 * workflow's existing phase ids — a duplicate is a `MUTATION` failure (mirrors
	 * {@link PhaseManagerInterface.add}'s own duplicate-id gate).
	 *
	 * NATIVE gating, purely from this workflow's own derived `status` and the phase list's
	 * positions (AGENTS §12 — no runner-installed hook), UNCHANGED from the entity-taking
	 * predecessor: refused outright while this workflow's own `status` is terminal or once
	 * {@link destroyed}. Otherwise the effective target position (`index ?? phases.count`)
	 * must fall within the PENDING SUFFIX — the contiguous trailing run of `pending` phases
	 * (phases run sequentially, so every already-started phase forms a contiguous leading
	 * prefix); its boundary is {@link import('./helpers.js').deriveBoundary}. A `pending`
	 * workflow's phases are ALL `pending`, so the boundary is `0` and every index is
	 * naturally accepted — no special case needed. Delegates the minted phase to
	 * {@link PhaseManagerInterface.add} then emits `add` on success.
	 *
	 * @param definition - The {@link PhaseDefinition} to mint a live phase (and tasks) from
	 * @param index - The insertion position; omitted inserts at the end
	 * @returns A {@link Result} boxing the minted, inserted phase, or a `MUTATION` failure
	 */
	add(definition: PhaseDefinition, index?: number): Result<PhaseInterface, WorkflowError>
	/**
	 * Remove the `pending` phase `id` from this workflow.
	 *
	 * @remarks
	 * NATIVE gating: refused while this workflow's own `status` is terminal. Otherwise the
	 * target must exist at an index within the pending suffix (at or past
	 * {@link import('./helpers.js').deriveBoundary}) — the manager separately gates the
	 * target's own `pending` status (AGENTS §9).
	 *
	 * @param id - The phase id to remove
	 * @returns A {@link Result} boxing the removed phase, or a `MUTATION` failure
	 */
	remove(id: string): Result<PhaseInterface, WorkflowError>
	/**
	 * Reposition the `pending` phase `id` to `index` within this workflow.
	 *
	 * @remarks
	 * NATIVE gating: refused while this workflow's own `status` is terminal. Otherwise BOTH
	 * the target's current index and the destination `index` must fall within the pending
	 * suffix (see {@link remove}).
	 *
	 * @param id - The phase id to move
	 * @param index - The destination position
	 * @returns A {@link Result} boxing the moved phase, or a `MUTATION` failure
	 */
	move(id: string, index: number): Result<PhaseInterface, WorkflowError>
	/**
	 * Apply a validated {@link PhaseUpdate} patch to the `pending` phase `id` in this workflow.
	 *
	 * @remarks
	 * NATIVE gating: refused while this workflow's own `status` is terminal. Otherwise the
	 * target must exist at an index within the pending suffix (see {@link remove}).
	 *
	 * @param id - The phase id to patch
	 * @param patch - The fields to update
	 * @returns A {@link Result} boxing the patched phase, or a `MUTATION` failure
	 */
	update(id: string, patch: PhaseUpdate): Result<PhaseInterface, WorkflowError>
	snapshot(): WorkflowSnapshot
}

// === Manager interfaces (AGENTS §9 — lean: an accessor + count, no batch matrix)

/**
 * The lean child manager (AGENTS §9) of a {@link PhaseInterface}'s live tasks —
 * positional accessors plus `count`, backed by an insertion-ordered store so order
 * is preserved across an interior `skip` / `remove`.
 *
 * @remarks
 * `append` adds one live {@link TaskInterface} at the end (the build-time wiring path);
 * `task(id)` looks one up; `tasks()` lists them in positional order; `count` is the
 * tally. No batch matrix (AGENTS §9.2 is deliberately omitted — a phase's tasks are a
 * fixed positional set, not a bulk-mutated collection). `add` / `remove` / `move` /
 * `update` (AGENTS §12) are the GATED mutation counterparts a
 * {@link PhaseInterface.add} / `remove` / `move` / `update` delegates to AFTER its own
 * container-status/hook gating — the manager gates ONLY on the target's OWN
 * existence/status/id/bounds and stays event-free (the entity emits on success).
 */
export interface TaskManagerInterface {
	readonly count: number
	/**
	 * Add `task` at the end (the build-time wiring path).
	 *
	 * @remarks
	 * THROWS a `MUTATION` {@link import('./errors.js').WorkflowError} on a duplicate
	 * `id` (a genuine programmer error — a build-time wiring bug, AGENTS §12) instead of
	 * silently overwriting the existing entry.
	 *
	 * @param task - The live task to append
	 */
	append(task: TaskInterface): void
	/**
	 * Insert `task` at `index` (default the end) — the GATED mutation counterpart to
	 * {@link append}: a duplicate `id` or an out-of-bounds `index` fails gracefully
	 * instead of throwing.
	 *
	 * @param task - The live task to insert
	 * @param index - The insertion position (`[0, count]`); omitted inserts at the end
	 * @returns A {@link Result} boxing the inserted task, or a `MUTATION` failure
	 */
	add(task: TaskInterface, index?: number): Result<TaskInterface, WorkflowError>
	/**
	 * Remove the `pending` task `id`.
	 *
	 * @param id - The task id to remove
	 * @returns A {@link Result} boxing the removed task, or a `MUTATION` failure when
	 *   `id` is absent or not `pending`
	 */
	remove(id: string): Result<TaskInterface, WorkflowError>
	/**
	 * Reposition the `pending` task `id` to `index`.
	 *
	 * @param id - The task id to move
	 * @param index - The destination position (`[0, count)`)
	 * @returns A {@link Result} boxing the moved task, or a `MUTATION` failure when `id`
	 *   is absent, not `pending`, or `index` is out of bounds
	 */
	move(id: string, index: number): Result<TaskInterface, WorkflowError>
	/**
	 * Apply a validated {@link TaskUpdate} patch to the `pending` task `id`.
	 *
	 * @param id - The task id to patch
	 * @param patch - The fields to update
	 * @returns A {@link Result} boxing the patched task, or a `MUTATION` failure when
	 *   `id` is absent, not `pending`, or `patch` fails validation
	 */
	update(id: string, patch: TaskUpdate): Result<TaskInterface, WorkflowError>
	task(id: string): TaskInterface | undefined
	tasks(): readonly TaskInterface[]
}

/**
 * The lean child manager (AGENTS §9) of a {@link WorkflowInterface}'s live phases —
 * positional accessors plus `count`, the phase analogue of {@link TaskManagerInterface}.
 *
 * @remarks
 * `append` adds one live {@link PhaseInterface} at the end; `phase(id)` looks one up;
 * `phases()` lists them in positional order; `count` is the tally. No batch matrix.
 * `add` / `remove` / `move` / `update` (AGENTS §12) are the GATED mutation
 * counterparts a {@link WorkflowInterface.add} / `remove` / `move` / `update`
 * delegates to AFTER its own container-status/hook gating — the manager gates ONLY
 * on the target's OWN existence/status/id/bounds and stays event-free (the entity
 * emits on success).
 */
export interface PhaseManagerInterface {
	readonly count: number
	/**
	 * Add `phase` at the end (the build-time wiring path).
	 *
	 * @remarks
	 * THROWS a `MUTATION` {@link import('./errors.js').WorkflowError} on a duplicate
	 * `id` (a genuine programmer error — a build-time wiring bug, AGENTS §12) instead of
	 * silently overwriting the existing entry.
	 *
	 * @param phase - The live phase to append
	 */
	append(phase: PhaseInterface): void
	/**
	 * Insert `phase` at `index` (default the end) — the GATED mutation counterpart to
	 * {@link append}: a duplicate `id` or an out-of-bounds `index` fails gracefully
	 * instead of throwing.
	 *
	 * @param phase - The live phase to insert
	 * @param index - The insertion position (`[0, count]`); omitted inserts at the end
	 * @returns A {@link Result} boxing the inserted phase, or a `MUTATION` failure
	 */
	add(phase: PhaseInterface, index?: number): Result<PhaseInterface, WorkflowError>
	/**
	 * Remove the `pending` phase `id`.
	 *
	 * @param id - The phase id to remove
	 * @returns A {@link Result} boxing the removed phase, or a `MUTATION` failure when
	 *   `id` is absent or not `pending`
	 */
	remove(id: string): Result<PhaseInterface, WorkflowError>
	/**
	 * Reposition the `pending` phase `id` to `index`.
	 *
	 * @param id - The phase id to move
	 * @param index - The destination position (`[0, count)`)
	 * @returns A {@link Result} boxing the moved phase, or a `MUTATION` failure when
	 *   `id` is absent, not `pending`, or `index` is out of bounds
	 */
	move(id: string, index: number): Result<PhaseInterface, WorkflowError>
	/**
	 * Apply a validated {@link PhaseUpdate} patch to the `pending` phase `id`.
	 *
	 * @param id - The phase id to patch
	 * @param patch - The fields to update
	 * @returns A {@link Result} boxing the patched phase, or a `MUTATION` failure when
	 *   `id` is absent, not `pending`, or `patch` fails validation
	 */
	update(id: string, patch: PhaseUpdate): Result<PhaseInterface, WorkflowError>
	phase(id: string): PhaseInterface | undefined
	phases(): readonly PhaseInterface[]
}

// === Runner (W-c) — the thin orchestrator that EXECUTES the live W-b entity tree
//
// The runner DRIVES the W-b state machine by COMPOSING the shipped substrate; it does
// not re-implement status, concurrency, retries, or abort. Phases run SEQUENTIALLY (a
// plain await loop); a phase's tasks run CONCURRENTLY through ONE substrate
// `createRunner`/`Queue` per phase (concurrency = `PhaseDefinition.concurrency`). A task
// is dispatched BY NAME through the behavior registries; a no-handler task auto-completes.
// The `bail` policy maps onto the substrate Runner's fail-fast (`bail: true`) vs settle-all
// (`bail: false`). Abort / Timeout / Budget fold per run via `AbortSignal.any`, exactly as
// the agent runtime folds its bounds. The `agent` task form is W-c2 — until then it routes
// to the same no-handler auto-complete path, so adding it is a clean third branch.

/**
 * A registered workflow function — the behavior a `function`-form
 * {@link TaskDefinition} runs, resolved BY NAME through the {@link WorkflowFunctions}
 * registry (AGENTS §4.5 — a `Handler` function type the framework invokes).
 *
 * @remarks
 * Receives a {@link TaskControllerInterface} — the running task's folded `signal`, its
 * `input` (the task's `metadata` bag), its lineage {@link TaskContext}, and read-UP access
 * to earlier phases' {@link TaskResult}s. A returned value becomes the task's
 * {@link import('@orkestrel/contract').Success} ({@link TaskInterface.complete}); a throw / rejection
 * becomes its {@link import('@orkestrel/contract').Failure} ({@link TaskInterface.fail}). Long work
 * should honour `controller.signal` (a workflow-level abort / timeout / budget, or — under
 * `bail: true` — a sibling's failure, fires it) so a cancel stops it promptly.
 */
export type WorkflowFunction = (controller: TaskControllerInterface) => Promise<unknown> | unknown

/**
 * The `function`-task behavior registry — workflow function names mapped to their
 * {@link WorkflowFunction} handlers.
 *
 * @remarks
 * A live {@link TaskInterface} resolves its `run` name against this registry ONCE at
 * construction into its {@link TaskInterface.handler}. A name absent from the registry (or
 * an omitted `run`) is the no-handler case — the task AUTO-COMPLETES (the ROADMAP rule). A
 * plain record (not a manager) — the registry is a lookup, with no lifecycle of its own.
 */
export type WorkflowFunctions = Readonly<Record<string, WorkflowFunction>>

/**
 * The per-task handle a {@link WorkflowFunction} receives — the running task's
 * cancellation, its input, its lineage, and read-UP access to the result tree.
 *
 * @remarks
 * A NEW, lean handle (NOT the runner `Controller` — it carries no `spawn` / `wait`; a
 * workflow task is a leaf of the declarative tree, not a fan-out unit). It exposes:
 * - `signal` — the task's folded cancellation: fires on a workflow-level `abort` /
 *   `timeout` / `budget` ceiling, or — under `bail: true` — when a sibling task fails (the
 *   runner aborts the in-flight siblings). A handler races its work against it.
 * - `aborted` — whether `signal` has fired.
 * - `input` — the task's `metadata` bag (the open consumer payload from its
 *   {@link TaskInput}); `{}` when none.
 * - `task` — the task's full {@link TaskContext} (so `task.phase` / `task.phase.workflow`
 *   navigate UP the lineage).
 * - `results()` — every settled task's {@link TaskResult} across already-finished phases,
 *   so a `function` task can read an earlier phase's output (the W-b result tree, read-only).
 */
export interface TaskControllerInterface {
	/** Fires on a workflow-level abort / timeout / budget, or a sibling failure under `bail: true`. */
	readonly signal: AbortSignal
	readonly aborted: boolean
	/** The task's open `metadata` bag (its {@link TaskInput} payload); `{}` when none. */
	readonly input: Readonly<Record<string, unknown>>
	readonly task: TaskContext
	/** Every settled task's result across already-finished phases — the result tree, read-only. */
	results(): readonly TaskResult[]
}

/**
 * The structured outcome of a {@link WorkflowRunnerInterface.execute} run — the settled
 * live workflow, its final status, and the flattened result tree.
 *
 * @remarks
 * Boxes the settled {@link WorkflowInterface} itself (so a caller can navigate the whole
 * live tree — every phase / task's final `status`, its recorded {@link TaskResult}, its
 * lineage) ALONGSIDE the two read-throughs the run produced: `status` is the workflow's
 * derived {@link WorkflowStatus} at settle (`completed` under graceful mode even with
 * failed leaves; `failed` under `bail: true`; `stopped` on a workflow-level abort /
 * timeout / budget), and `results` is the workflow-tier {@link TaskResult} list (every
 * settled task across all phases, in positional order — the same array `workflow.results()`
 * yields). Returning the live `workflow` (not just a snapshot) keeps the entity tree the
 * source of truth — the runner adds only the convenience `status` / `results` projections.
 */
export interface WorkflowResult {
	readonly workflow: WorkflowInterface
	readonly status: WorkflowStatus
	readonly results: readonly TaskResult[]
}

/**
 * The options for one {@link WorkflowRunnerInterface.execute} call — the live tree's
 * CONSTRUCTION options ({@link WorkflowOptions}) PLUS the per-run BOUNDS (an external abort,
 * a deadline, and a cost ceiling), each bound folded into every task's cancellation.
 *
 * @remarks
 * `execute` is single-source: it BUILDS the live tree from the definition internally (via
 * {@link import('./factories.js').createWorkflow}), so these options carry BOTH halves of
 * that one call —
 * - the **construction** half is {@link WorkflowOptions} (`on` initial listeners, the `bail`
 *   override, the per-node `phases` bag); `execute` forwards it straight to `createWorkflow`,
 *   so construction-time emitter listeners, a `bail` override, and per-node options all apply
 *   to the tree it builds (`createWorkflow` resolves `bail` as `options.bail ?? definition.bail
 *   ?? DEFAULT_BAIL`); and
 * - the **run-control** half is the three bounds below, used only for the run-level fold.
 *
 * The three bounds compose via `AbortSignal.any` (exactly as the agent runtime folds its
 * own): a fire of ANY of them cancels every in-flight task (its
 * {@link TaskControllerInterface.signal} fires) and HALTS the run — the remaining tasks
 * and phases are `skip`ped and the workflow settles `stopped`.
 * - `signal` — an external cancellation (a caller `AbortController`).
 * - `timeout` — a whole-run deadline in milliseconds. A non-positive value (`0` or negative)
 *   ⇒ NO deadline (the runner arms an `@orkestrel/timeout` `TimeoutInterface`
 *   only when `timeout > 0`).
 * - `budget` — a whole-run cost ceiling (a {@link BudgetInterface} over {@link TokenUsage}
 *   — its `signal` fires when a task-reported usage crosses `max`); the runner folds its
 *   `signal` and `start`s it. (A `max: 0` budget is exhausted from its first `start`, so it
 *   cancels the run at entry — a DIFFERENT primitive from the `timeout: 0` "no deadline" case.)
 *
 * The engine itself carries NO nesting bookkeeping — the depth / cycle guard for a nested
 * `agent` → workflow-tool → workflow chain lives entirely in the OPT-IN adapter factories
 * shipped by `@orkestrel/tool`, closed over their own `depth` / `ancestry`, never threaded
 * through `execute`'s options.
 */
export type WorkflowRunOptions = WorkflowOptions & {
	readonly signal?: AbortSignal
	readonly timeout?: number
	readonly budget?: BudgetInterface<TokenUsage>
}

/**
 * The options for `createWorkflowRunner` — the optional pacing scheduler the runner
 * paces phase boundaries with.
 *
 * @remarks
 * The runner is a PURE engine — it carries no `functions` / `tools` / `agents` registry
 * (each live task already resolved its own handler at construction from
 * {@link WorkflowOptions.functions}); wiring a `function`-form task to a tool or an agent is
 * an OPT-IN concern of the `@orkestrel/tool` package's adapter factories, which a caller
 * composes into its OWN `functions` registry.
 * - `scheduler` — the {@link SchedulerInterface} that paces the tree (a cooperative
 *   `yield` between phases). Omitted ⇒ the shipped cross-environment default
 *   ({@link createScheduler}).
 *
 * The reserved `on` key (AGENTS §8) is intentionally ABSENT: the runner is THIN and drives
 * the W-b entities' OWN emitters (subscribe via `workflow.emitter` / `phase.emitter` /
 * `task.emitter`), so it owns no event map of its own — there is nothing for an `on` to
 * wire. A future runner-level emitter would introduce its own `EmitterHooks` here.
 */
export interface WorkflowRunnerOptions {
	readonly scheduler?: SchedulerInterface
}

/**
 * A thin orchestrator that EXECUTES a live {@link WorkflowInterface} tree by composing the
 * shipped substrate — phases sequential, tasks concurrent, each task dispatched through its
 * OWN resolved handler under the `bail` policy.
 *
 * @remarks
 * `execute(definition, options?)` BUILDS the live W-b entity tree from the definition itself
 * (via {@link import('./factories.js').createWorkflow}) and drives it to a terminal
 * {@link WorkflowResult} — phases SEQUENTIALLY and, within each phase, the tasks CONCURRENTLY
 * through ONE substrate {@link RunnerInterface} (concurrency =
 * the phase's {@link PhaseDefinition.concurrency}). The definition is the SINGLE source of
 * truth: the runner owns both the declarative state (the live tree it constructs) and the
 * EXECUTION-ONLY field the snapshot deliberately dropped — each task's `run` (resolved into
 * its {@link TaskInterface.handler} once at construction, against
 * {@link WorkflowOptions.functions}) and each phase's `concurrency` (so there is no
 * separately-supplied workflow to drift from the definition). The freshly-built live tree is
 * returned in {@link WorkflowResult.workflow}. The runner carries NO registry of its own — it
 * simply invokes each task's OWN {@link TaskInterface.handler}; a task with no handler
 * AUTO-COMPLETES. The runner DRIVES the live entity (`start` → `complete` / `fail`), never
 * re-implementing status. The `bail` policy maps onto the substrate's fail-fast (`bail: true`
 * — the first failure aborts in-flight siblings and skips the rest) vs settle-all (`bail:
 * false` — failures are recorded and the run finishes). The {@link WorkflowOptions} half of
 * the options is forwarded to `createWorkflow` (initial listeners, a `bail` override,
 * per-node options, the `functions` registry); the Abort / Timeout / Budget bounds fold per
 * run via `AbortSignal.any`, halting the run and `stop`ping the workflow. A second
 * `execute(workflow, options?)` overload drives a CALLER-BUILT live tree instead — the
 * entity-native control surface (AGENTS §10: `pause` / `resume` / `add` / `stop` /
 * `destroy` live on {@link WorkflowInterface} itself); see its own doc for details.
 */
export interface WorkflowRunnerInterface {
	/**
	 * Execute a workflow definition to completion — BUILD its live tree, run the phases
	 * sequentially with each phase's tasks concurrent — resolving its terminal
	 * {@link WorkflowResult} (whose `workflow` is the freshly-built live tree).
	 *
	 * @remarks
	 * One-shot. The runner BUILDS the live tree from `definition` internally (one source of
	 * truth — the per-task `run` (resolved into its {@link TaskInterface.handler}) and per-phase
	 * `concurrency` come from the same definition the tree is constructed from, so the executed
	 * tree can never drift from the metadata). The {@link WorkflowOptions} part of `options`
	 * (initial `on` listeners, a `bail` override, the per-node `phases` bag, the `functions`
	 * registry) is forwarded to the build.
	 * Under `bail: false` (graceful) every task settles (a failure is recorded on its
	 * {@link TaskInterface}) and the workflow reaches `completed`; under `bail: true` (halt)
	 * the first failure aborts the in-flight sibling tasks AND `skip`s the remaining tasks /
	 * phases, settling the workflow `failed`. A {@link WorkflowRunOptions} abort / timeout /
	 * budget fires every in-flight task's signal and `stop`s the run. `execute` resolves
	 * (never rejects) on a cancel — the partial outcome is read from the returned
	 * {@link WorkflowResult} (its `workflow` / `status` / `results`). A run-level cancel
	 * (abort / timeout / budget) that fires on the SAME tick as a genuine task failure resolves
	 * the run as `stopped` — the cancel supersedes the same-tick failure, and that task's error
	 * is not recorded.
	 *
	 * **Programmer-error exception (AGENTS §12).** A PATHOLOGICAL `definition` (e.g. a
	 * duplicate phase or task `id`) THROWS SYNCHRONOUSLY at construction — before any phase
	 * runs, and before the returned `Promise` is even created — rather than resolving a
	 * failed/partial {@link WorkflowResult}. This is the one exception to the "resolves,
	 * never rejects" contract above: a malformed definition is a programmer-timing error, not
	 * a runtime outcome to report through the result tree.
	 *
	 * @param definition - The {@link WorkflowDefinition} to build the live tree from and drive
	 * @param options - The construction options ({@link WorkflowOptions}: `on` / `bail` /
	 *   `phases`) PLUS the per-run bounds (`signal` / `timeout` / `budget`)
	 * @returns The run's terminal {@link WorkflowResult} (its `workflow` is the built tree)
	 */
	execute(definition: WorkflowDefinition, options?: WorkflowRunOptions): Promise<WorkflowResult>
	/**
	 * Drive an ALREADY-BUILT, CALLER-OWNED live {@link WorkflowInterface} — the
	 * ENTITY-NATIVE counterpart to the definition-building {@link execute} overload.
	 *
	 * @remarks
	 * The entity itself is now the single control surface (no separate run handle):
	 * `createWorkflow` mints the live tree, this overload drives it, and the caller
	 * controls the SAME entity mid-run via its own `pause` / `resume` / `add` / `stop` /
	 * `destroy` (AGENTS §10). Requires `workflow.status === 'pending'` and
	 * `!workflow.destroyed` — otherwise this is a programmer-timing error and it THROWS a
	 * `TRANSITION` {@link import('./errors.js').WorkflowError} (AGENTS §12) rather than
	 * silently no-opping or building a second tree. Once accepted, phases run
	 * SEQUENTIALLY and, within each phase, tasks CONCURRENTLY — byte-identical observable
	 * semantics to the `definition`-form `execute` — except the phase loop RE-READS the
	 * live `workflow.phases` / each phase's live `tasks` every iteration (a cursor over
	 * the live managers, not a one-time snapshot), so a caller's live `add` mid-run is
	 * picked up and actually dispatched. `workflow.pause()` gates the run at the next
	 * phase boundary AND before each task's dispatch (an in-flight task body is never
	 * suspended); `workflow.stop()` skips not-yet-started work gracefully; `workflow.destroy()`
	 * folds `workflow.signal` into the run's cancellation, aborting in-flight work
	 * immediately. `options` carries only the per-run BOUNDS (`signal` / `timeout` /
	 * `budget`) — the construction half of {@link WorkflowRunOptions}
	 * does not apply, since the tree already exists.
	 *
	 * **Run round-trips through the snapshot.** Driving a tree rebuilt by
	 * {@link import('./factories.js').restoreWorkflow} behaves according to whether a
	 * {@link WorkflowFunctions} registry was supplied at that build: WITH a registry,
	 * each task's `run` name is re-resolved against it, so a matched task carries a real
	 * handler and this overload actually DISPATCHES it, resuming real work. WITHOUT a
	 * registry (or when a task's `run` name has no match in it), the task's
	 * {@link TaskInterface.run} is `undefined` — the no-handler rule then AUTO-COMPLETES
	 * that task (no dispatch occurs). A PARTIALLY-run restored tree (any live phase/task
	 * not `pending`) is rejected outright by the `workflow.status === 'pending'` guard
	 * above — only a wholly `pending` restored tree is drivable.
	 *
	 * @param workflow - The live {@link WorkflowInterface} to drive (its own entity surface —
	 *   `pause` / `resume` / `add` / `stop` / `destroy` — is the caller's control seam)
	 * @param options - The per-run bounds (`signal` / `timeout` / `budget`); the construction
	 *   half of {@link WorkflowRunOptions} does not apply (the tree already exists)
	 * @returns The run's terminal {@link WorkflowResult} (its `workflow` is the SAME entity passed in)
	 */
	execute(
		workflow: WorkflowInterface,
		options?: Omit<WorkflowRunOptions, keyof WorkflowOptions>,
	): Promise<WorkflowResult>
}

/**
 * Relative urgency hint for cooperative scheduling. Honoured by environment
 * backends; the cross-environment default treats all priorities uniformly.
 */
export type SchedulerPriority = 'user' | 'normal' | 'background'

/** Options for a single cooperative yield/delay. */
export interface SchedulerOptions {
	/**
	 * A relative urgency hint. Honoured by environment backends; the
	 * cross-environment default treats all priorities the same.
	 */
	readonly priority?: SchedulerPriority
	/** A signal whose abort rejects a pending yield/delay with its `reason`. */
	readonly signal?: AbortSignal
}

/**
 * A cooperative host-yield primitive: a loop decides WHAT to do; the scheduler
 * decides WHEN the host regains control. Abort-aware — a pending yield/delay
 * rejects with the signal's reason when aborted.
 */
export interface SchedulerInterface {
	/**
	 * Yield control back to the host so other tasks (I/O, timers, rendering) can
	 * run, then resume.
	 */
	yield(options?: SchedulerOptions): Promise<void>
	/** Resume after at least `ms` milliseconds. */
	delay(ms: number, options?: SchedulerOptions): Promise<void>
}

/**
 * The push observation surface of a {@link RunnerInterface} (AGENTS §13) — the run
 * lifecycle a fire-and-forget observer (logging, metrics, tracing) subscribes to,
 * ALONGSIDE the eventual `execute` result.
 *
 * @typeParam TResult - The value a unit resolves; the `finish` payload is the run's ordered
 *   `readonly TResult[]`, so the map is `RunnerEventMap<TResult>` — mirroring how the
 *   {@link RunnerInterface} is generic.
 *
 * @remarks
 * Listener isolation is the emitter's (AGENTS §13): every event is emitted directly and a
 * listener throw is routed to the emitter's OWN `error` handler (the `error` option), never
 * onto this domain map and never into the one-shot / fail-fast / spawn-tracking engine — so a
 * buggy observer can never reorder, throw into, or corrupt the run. Every emit sits AFTER the
 * relevant unit-launch / settle / drain transition, so a throwing observer cannot unbalance
 * the outstanding-unit count gate or break fail-fast. Subscribe via `runner.emitter.on(...)`.
 *
 * Declared as a `type` alias (not `interface extends EventMap`, §4.5 — `EventMap` is a
 * `type` kind): a type-literal satisfies the `EventMap` constraint
 * (`Record<string, readonly unknown[]>`) structurally, whereas an interface lacks the
 * required index signature.
 */
export type RunnerEventMap<TResult> = {
	/** `execute` began — emitted once at the top of a non-empty run. */
	readonly start: readonly []
	/** A unit's handler began running — the unit's id (declared or spawned). */
	readonly unit: readonly [id: string]
	/** A sub-unit was spawned — its id + the spawning parent's id (when known). */
	readonly spawn: readonly [id: string, parent: string | undefined]
	/** A unit completed successfully — its id (after its outcome was recorded). */
	readonly settle: readonly [id: string]
	/** A unit failed — its id + the error (always `unknown`). */
	readonly fail: readonly [id: string, error: unknown]
	/** The batch settled — the run's ordered results (the same array `execute` resolves). */
	readonly finish: readonly [results: readonly TResult[]]
	/** The run was aborted (fail-fast, a user `abort`, or `destroy`) — the cancel reason. */
	readonly abort: readonly [reason: unknown]
}

/**
 * The per-unit handle a {@link RunnerHandler} receives — the running unit's
 * identity, input, cancellation, and the controls to cooperate with the run.
 *
 * @remarks
 * One `Controller` is built per unit the {@link RunnerInterface} runs (a declared
 * input or a `spawn`ed sibling). It exposes:
 * - `id` — the unit's identifier (a random UUID).
 * - `input` — the unit's work payload.
 * - `signal` — the unit's cancellation: fires on the unit's own `abort()`, a
 *   runner-level `abort` (the runner aborts every unit), or this attempt's timeout
 *   expiring (it reflects the underlying queue attempt's signal, which ANY-combines
 *   all three).
 * - `aborted` — whether the unit's cancellation has fired.
 *
 * @typeParam TInput - The unit's work input
 * @typeParam TResult - The value a unit resolves
 */
export interface ControllerInterface<TInput, TResult> {
	readonly id: string
	readonly input: TInput
	/** Fires on the unit's own `abort()`, a runner-level abort, or this attempt's timeout. */
	readonly signal: AbortSignal
	readonly aborted: boolean
	/**
	 * Park until this unit's `signal` aborts — **promise-parked**, never a timer.
	 *
	 * @remarks
	 * Resolves the moment the unit's `signal` fires (unit abort, runner abort, or
	 * timeout) and resolves immediately if it has already fired. It registers a
	 * one-shot `'abort'` listener and never polls — no `setTimeout`, no `delay`, no
	 * busy-yield — so a parked unit consumes no CPU until it is actually cancelled.
	 *
	 * @returns A promise that resolves once the unit's `signal` aborts
	 */
	wait(): Promise<void>
	/**
	 * Add a sibling unit to the run; returns its result promise.
	 *
	 * @remarks
	 * **Fire-and-track.** The spawned unit is routed through the same backing queue
	 * as every declared unit, so it actually runs (in FIFO wake order) and its result
	 * joins the run's ordered output after the declared units, in spawn order. The
	 * runner's `execute` awaits the full transitive spawn closure (it tracks an
	 * outstanding-unit count, not a one-time snapshot), so a caller does NOT need to
	 * await the returned promise to make the sibling run.
	 *
	 * **Deadlock caveat.** On a bounded-`concurrency` runner, do NOT `await` a
	 * `spawn`ed promise *inline* from within a handler — the handler holds a queue
	 * slot while it awaits, and if every slot is held by a handler awaiting its own
	 * spawn, no slot is free to run the spawns and the run deadlocks. The intended
	 * pattern is fan-out: `spawn` siblings and return, letting the runner drain them.
	 *
	 * @param input - The sibling unit's work payload
	 * @returns The sibling's result promise (it runs regardless of whether it's awaited)
	 */
	spawn(input: TInput): Promise<TResult>
	/**
	 * Cancel this unit — fires its `signal` with the optional reason.
	 *
	 * @param reason - An optional cancellation reason carried on the signal
	 */
	abort(reason?: unknown): void
}

/**
 * Runs one unit's work, given its {@link ControllerInterface}.
 *
 * @typeParam TInput - The unit's work input
 * @typeParam TResult - The value the handler resolves for a unit
 */
export type RunnerHandler<TInput, TResult> = (
	controller: ControllerInterface<TInput, TResult>,
) => Promise<TResult> | TResult

/**
 * The per-entry reliability OVERRIDES for one unit — its extra attempts on failure and its
 * per-attempt deadline, resolved from the unit's input via {@link RunnerOptions.entries}.
 *
 * @remarks
 * The unit's `id` and `signal` stay Runner-managed (it mints the id and owns the per-unit
 * abort), so only the two reliability knobs are exposed here. Each field OVERRIDES the
 * runner-level `retries` / `timeout` default for that one unit; an omitted field falls back
 * to the default. This is the per-unit slice of the backing Queue's
 * `@orkestrel/queue` `QueueEntryOptions` surfaced cleanly — the Queue already
 * resolves default→override.
 */
export interface RunnerEntryOptions {
	readonly retries?: number
	readonly timeout?: number
}

/**
 * Options for `createRunner`.
 *
 * @remarks
 * - `handler` — runs each unit's work against its {@link ControllerInterface};
 *   rejecting fails the unit (and, after retries are exhausted, fails the run).
 * - `concurrency` — the maximum units in flight at once; defaults to `1` (ordered,
 *   one-at-a-time). Floored at `1`.
 * - `retries` — the default extra attempts per unit on failure (or a per-attempt
 *   timeout); defaults to `0`.
 * - `timeout` — the per-attempt deadline in milliseconds; defaults to none (a
 *   non-positive value means no deadline).
 * - `entries` — per-entry `retries` / `timeout` overrides, resolved from each
 *   input; falls back to the runner-level `retries` / `timeout` defaults.
 * - `on` — the reserved {@link EmitterHooks} key (§8): initial listeners for the runner's
 *   {@link RunnerEventMap}, wired at construction (e.g. `{ finish: (r) => log(r) }`).
 */
export interface RunnerOptions<TInput, TResult> {
	readonly on?: EmitterHooks<RunnerEventMap<TResult>>
	/** The emitter's listener-error handler (AGENTS §13) — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	readonly handler: RunnerHandler<TInput, TResult>
	readonly concurrency?: number
	readonly retries?: number
	readonly timeout?: number
	/** Per-entry `retries` / `timeout` overrides, resolved from each input; falls back to the runner-level defaults. */
	readonly entries?: (input: TInput) => RunnerEntryOptions
}

/**
 * One unit the {@link RunnerInterface} is tracking: the queue payload it was enqueued
 * with — its `id` (a random UUID) keys it in the runner's ordered launch list and value
 * map, and `input` is the unit's work payload handed to the handler's `Controller`.
 *
 * @remarks
 * The runner's internal bookkeeping shape, published through the barrel because §5
 * centralizes every file-local type — declared or spawned, every unit flows through the
 * one queue as a `RunnerUnit`, so backpressure / ordering / retries / timeout stay the
 * Queue's behavior and the runner adds only orchestration.
 *
 * @typeParam TInput - The unit's work input
 */
export interface RunnerUnit<TInput> {
	readonly id: string
	readonly input: TInput
}

/**
 * One unit's settled outcome — a discriminated union so a value of `undefined` is still
 * a success (`{ ok: true, value: undefined }`), never mistaken for a failure or an
 * absent result.
 *
 * @remarks
 * The runner records each settled unit's outcome through this shape: a success boxes the
 * resolved `value` (presence tracked by the union tag, so `undefined` is a valid result),
 * a failure carries the `error` (always `unknown`). The FIRST failure is fail-fast.
 *
 * @typeParam TResult - The value a unit resolves
 */
export type UnitOutcome<TResult> =
	| { readonly ok: true; readonly value: TResult }
	| { readonly ok: false; readonly error: unknown }

/**
 * A thin generic orchestrator that drives declared units — plus any they `spawn` —
 * through a bounded-concurrency queue, collecting their results in order.
 *
 * @remarks
 * One-shot: `execute` runs the unit set once and resolves their results. A `Runner`
 * does not reimplement concurrency or retries — it composes the workers `Queue`
 * (the backpressure + retry + timeout engine), routing every unit (declared and
 * spawned) through it so spawned work actually runs.
 *
 * Exposes a typed {@link emitter} (AGENTS §13) carrying its run lifecycle moments
 * ({@link RunnerEventMap}) for fire-and-forget observers, ALONGSIDE the eventual `execute`
 * result. Emitting is observation-only — every event fires AFTER the relevant unit-launch /
 * settle / drain transition, so a buggy observer can never reorder or corrupt the one-shot /
 * fail-fast / spawn-tracking engine: the emitter isolates a listener throw and routes it to
 * its `error` handler (the `error` option), never the run. Subscribe via
 * `runner.emitter.on(...)`.
 *
 * @typeParam TInput - The unit's work input
 * @typeParam TResult - The value a unit resolves
 */
export interface RunnerInterface<TInput, TResult> {
	readonly emitter: EmitterInterface<RunnerEventMap<TResult>>
	readonly active: number
	readonly stopped: boolean
	/** Whether the runner is currently paused (AGENTS §10 — resumable, no new dispatch); rides the backing queue's own `paused`. */
	readonly paused: boolean
	/**
	 * Run all `inputs` — and anything they `spawn` — to completion; resolve their
	 * results in order: the declared inputs first (in input order), then the spawned
	 * units (in spawn order).
	 *
	 * @remarks
	 * One-shot — a second call throws. **Fail-fast** — the first unit failure (after
	 * its retries) aborts every other in-flight + pending unit and rejects the run
	 * with that error; later failures are ignored. An empty `inputs` resolves to `[]`.
	 *
	 * @param inputs - The declared units to run
	 * @returns The units' results, in order (declared first, then spawns)
	 */
	execute(inputs: readonly TInput[]): Promise<readonly TResult[]>
	/**
	 * Inject one more unit into an IN-FLIGHT `execute` run — a LIVE counterpart to a
	 * `Controller.spawn`, called from OUTSIDE any unit's handler (the seam a live
	 * `running` {@link PhaseInterface}'s `add` event lets a subscribed run offer a newly
	 * added task to the SAME execution substrate).
	 *
	 * @remarks
	 * Returns `undefined` synchronously (graceful, non-throwing — AGENTS §12) when the
	 * runner is not currently mid-`execute`, or the run has already fully drained — the
	 * caller reads `undefined` as "not accepted". Otherwise the unit is routed through
	 * the SAME backing queue as a declared/`spawn`ed unit (the runner's
	 * outstanding-unit count gate keeps the in-flight `execute` awaiting it) and emits
	 * the {@link RunnerEventMap.spawn} event; its result promise resolves once the unit
	 * settles.
	 *
	 * @param input - The unit's work payload
	 * @returns The unit's result promise, or `undefined` when no in-flight run can accept it
	 */
	spawn(input: TInput): Promise<TResult> | undefined
	/**
	 * Cancel every in-flight + pending unit (and the backing queue), making a running
	 * `execute` reject.
	 *
	 * @param reason - An optional cancellation reason propagated to every unit's signal
	 */
	abort(reason?: unknown): void
	/**
	 * Suspend dispatch (AGENTS §10 — resumable): the backing queue holds the NEXT dispatch
	 * while any in-flight unit finishes; idempotent.
	 *
	 * @example
	 * ```ts
	 * runner.pause()
	 * runner.paused // true
	 * ```
	 */
	pause(): void
	/**
	 * Continue a paused runner (AGENTS §10); idempotent.
	 *
	 * @example
	 * ```ts
	 * runner.resume()
	 * runner.paused // false
	 * ```
	 */
	resume(): void
	/**
	 * Permanently end the runner (AGENTS §10) — a GRACEFUL stop: no further unit is
	 * dispatched, but every already-in-flight unit runs to completion and settles
	 * normally. A never-dispatched (still-pending) unit is rejected by the backing queue
	 * and is NOT recorded as a failure (it never trips fail-fast); a genuine in-flight
	 * failure still is. `execute`'s promise RESOLVES (never rejects) once every unit has
	 * settled, with whatever results actually completed. Idempotent.
	 *
	 * @example
	 * ```ts
	 * const runner = createRunner({ handler: (c) => c.input, concurrency: 1 })
	 * const results = runner.execute([1, 2, 3])
	 * runner.stop() // the in-flight unit finishes; the rest are gracefully dropped
	 * await results // resolves with whatever settled — never rejects
	 * ```
	 */
	stop(): void
	/** Tear the runner down — `abort` plus stop the backing queue; idempotent. */
	destroy(): void
}

/**
 * A promise paired with its externally-callable `resolve`/`reject` — the settle path
 * is exposed to the caller instead of being buried in an executor closure.
 *
 * @typeParam T - The value the deferred's `promise` resolves
 */
export interface DeferredInterface<T> {
	readonly promise: Promise<T>
	resolve(value: T): void
	reject(reason: unknown): void
}
