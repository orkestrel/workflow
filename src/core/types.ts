import type { BudgetInterface, TokenUsage } from '@orkestrel/budget'
import type { JSONRecord, JSONValue, Result } from '@orkestrel/contract'
import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'
import type { WorkflowError } from './errors.js'

// Workflows — a JSON-serializable Workflow → Phase → Task tree (strict three
// levels, positional, no DAG). Two type families share this file: the DEFINITION
// family (pure serializable JSON DATA a UI/LLM authors — behavior is referenced
// BY NAME through a registry, never as inline functions) and the runtime CONTEXT
// / SNAPSHOT / RESULT surfaces the entity tree (W-b) and durable store (W-d) build
// on. One compiled contract (factories.ts) keeps the JSON Schema + guard + parser
// + generator in lockstep with the hand-written definition interfaces. Types are
// the source of truth (AGENTS.md § Authority and loading).
//
// Determinism is a FIXED design principle, not a configuration: tasks within a
// phase are concurrent; phases are sequential. The only per-phase concurrency
// knob is `concurrency` — an optional resource throttle (max-in-flight), never a
// sequencing control.

// === Definition family (pure serializable JSON DATA)

/**
 * Represents the serializable definition of one task — its identity plus an optional reference to
 * the behavior it runs.
 *
 * @remarks
 * Pure JSON DATA: a UI or an LLM authors it, it round-trips through the contract
 * (factories.ts), and it carries NO functions. `id` is the positional identity within
 * its phase; `name` is the human label; `description` is optional prose. `behavior` is a
 * PLAIN NAME — a key resolved ONCE at construction against a workflow-level
 * {@link WorkflowRegistry} registry into a runtime {@link TaskInterface.handler}
 * carried on the live task. An omitted `behavior` is the deliberate no-op form and completes
 * with JSON `null`; an unresolved present name remains inspectable but is not executable.
 */
export interface TaskDefinition {
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly behavior?: string
	/**
	 * Sets the extra attempts after the first on failure.
	 *
	 * @remarks
	 * Extra attempts after the first on failure (a non-negative integer); the runner threads it
	 * to this task's substrate unit, OVERRIDING the phase Runner's `retries` default. Omitted ⇒
	 * the default (no extra attempts). PERSISTED in a {@link TaskSnapshot} (like `bail` and
	 * `concurrency`), so `createRestoredWorkflow(snapshot, { functions })` resumes with the same
	 * reliability config; only the resolved handler itself is runtime-only.
	 */
	readonly retries?: number
	/**
	 * Sets the per-attempt deadline in milliseconds.
	 *
	 * @remarks
	 * The workflow-owned per-attempt deadline in milliseconds, an integer from `0` through
	 * `MAX_TIMER_MS`. Zero or omission means no deadline. PERSISTED in a {@link TaskSnapshot},
	 * so `createRestoredWorkflow(snapshot, { functions })` resumes with the same reliability config;
	 * only the resolved handler itself is runtime-only.
	 */
	readonly timeout?: number
}

/**
 * Represents the serializable definition of one phase — its identity, its ordered tasks, and
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
	/** Caps the tasks in flight at once (a resource throttle); omitted ⇒ unbounded. */
	readonly concurrency?: number
	/**
	 * Sets the phase's failure policy.
	 *
	 * @remarks
	 * The per-phase failure-policy OVERRIDE. Omitted ⇒ the phase INHERITS the
	 * workflow `bail`; supplied, it wins (`effectiveBail = phase.bail ?? workflow.bail`). A
	 * `bail: true` phase HALTS the run on its first task failure even under a graceful workflow
	 * default; a `bail: false` phase does NOT halt even under a strict workflow default.
	 */
	readonly bail?: boolean
}

/**
 * Represents the serializable definition of a whole workflow — its identity, its ordered
 * phases, and the `bail` failure policy.
 *
 * @remarks
 * Pure JSON DATA — the root a UI/LLM authors and the contract validates. `phases`
 * are the workflow's phases, which run SEQUENTIALLY. `bail` is the failure policy
 * (a boolean behavioral toggle): `false` (the default) is GRACEFUL —
 * a failed leaf task is recorded as data and the workflow still completes; `true`
 * is a database-transaction HALT — a single failed task propagates `failed` to the
 * whole workflow. See {@link import('./helpers.js').deriveWorkflowStatus}.
 */
export interface WorkflowDefinition {
	readonly id: string
	readonly name: string
	readonly description?: string
	readonly phases: readonly PhaseDefinition[]
	/** Sets the failure policy: `false` (default) continues gracefully, `true` halts on the first failure. */
	readonly bail?: boolean
}

// === Context chain (lineage carried back UP the tree)

/**
 * Represents the ambient context of a workflow — the identity every level inherits.
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
 * Represents the ambient context of a phase — its own identity plus a back-reference to the
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
 * Represents the ambient context of a task — its own identity plus a back-reference to the
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

// === Inputs (minimal creation data)

/** Represents the minimal data to create a workflow context — a partial {@link WorkflowContext}. */
export type WorkflowInput = Partial<WorkflowContext>

/** Represents the minimal data to create a phase context — a partial {@link PhaseContext}. */
export type PhaseInput = Partial<PhaseContext>

/**
 * Represents the minimal data to create a task context — a partial {@link TaskContext} plus
 * any creation-only fields.
 *
 * @remarks
 * `metadata` is an open consumer bag the workflow system stores and carries into a
 * {@link TaskSnapshot} but never interprets. All members are optional (the storing
 * layer fills identity / lineage).
 */
export interface TaskInput extends Partial<TaskContext> {
	/** Holds an open consumer bag — stored and snapshotted, never interpreted by the workflow. */
	readonly metadata?: JSONRecord
}

/**
 * Represents one identified thing a running task claims active, with the moment the claim began.
 *
 * @remarks
 * The shape {@link TaskOperation} and {@link TaskConstraint} share: `id` is unique within one
 * complete activity report, `name` is the human-readable label, and `started` is a finite
 * non-negative reporter timestamp. The two claim lists are validated by one guard
 * ({@link import('./validators.js').isTaskClaimList}) and owned by one cloner
 * ({@link import('./cloners.js').cloneTaskClaims}) over this type, while each list keeps its own
 * published member name so a later member can distinguish them.
 */
export interface TaskClaim {
	readonly id: string
	readonly name: string
	readonly started: number
}

/**
 * Represents one operation claimed active when a running task's complete frame was accepted.
 *
 * @remarks
 * A {@link TaskClaim}: `id` is stable within one complete activity report, `name` is the
 * human-readable label, and `started` is a finite non-negative reporter timestamp.
 */
export interface TaskOperation extends TaskClaim {}

/**
 * Represents the aggregate progress most recently reported by a running task.
 *
 * @remarks
 * `progress` and an optional `total` are finite non-negative numbers; when `total` is present
 * it is at least `progress`. `message` is optional observer-facing text describing the reported
 * state.
 */
export interface TaskProgress {
	readonly progress: number
	readonly total?: number
	readonly message?: string
}

/**
 * Represents one constraint claimed active when a running task's complete frame was accepted.
 *
 * @remarks
 * A {@link TaskClaim}. Constraints describe active limits or requirements without embedding
 * provider policy in core. `id` is unique within one complete report and `started` is finite and
 * non-negative.
 */
export interface TaskConstraint extends TaskClaim {}

/**
 * Represents one complete replacement of a running task's observable activity.
 *
 * @remarks
 * `note` describes the frame while `progress.message` describes the progress value.
 * Omitted `operations` or `constraints` mean an empty list. Omitted `progress` clears the
 * previous aggregate progress. Use {@link TaskInterface.report} to commit the replacement.
 */
export interface TaskActivityInput {
	readonly note?: string
	readonly progress?: TaskProgress
	readonly operations?: readonly TaskOperation[]
	readonly constraints?: readonly TaskConstraint[]
}

/**
 * Represents the bounded, JSON-serializable activity most recently accepted from a task reporter.
 */
export interface TaskActivity {
	readonly note?: string
	readonly progress?: TaskProgress
	readonly operations: readonly TaskOperation[]
	readonly constraints: readonly TaskConstraint[]
	readonly updated: number
}

// === Patches (declarative partial updates — the mutation API's `update` payloads)

/**
 * Represents a declarative partial update to a {@link TaskInterface} — the fields a `pending`
 * task's {@link TaskInterface.patch} (and the owning {@link TaskManagerInterface.update})
 * accept, runtime-validated through {@link import('./shapers.js').taskUpdateShape}.
 *
 * @remarks
 * Mirrors the identity fields of {@link TaskDefinition} (`name` / `description`) —
 * never `behavior` / `retries` / `timeout` (a form/reliability change is a structural
 * replace, not a patch) and never `id` (identity is immutable after creation). Every
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
 * Represents a declarative partial update to a {@link PhaseInterface} — the fields a `pending`
 * phase's {@link PhaseInterface.patch} (and the owning {@link PhaseManagerInterface.update})
 * accept, runtime-validated through {@link import('./shapers.js').phaseUpdateShape}.
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

// === Error codes (the machine-readable codes the W-b entities throw)

/**
 * Names the machine-readable code of a {@link import('./errors.js').WorkflowError} — the
 * fault the live W-b state machine raises.
 *
 * @remarks
 * - `TRANSITION` — an illegal state-machine transition (for example, `start`ing a task
 *   that is not `pending`, or `complete`/`fail`ing one that is not `running`); the guard names
 *   the offending current status + requested transition in the error `context`.
 * - `RESTORE` — a {@link import('./factories.js').createRestoredWorkflow} given a structurally
 *   invalid {@link WorkflowSnapshot} (a status outside the lifecycle vocabulary).
 * - `MUTATION` — a GATED structural or patch edit was refused: a duplicate id on
 *   `append`/`add`, a target that does not exist or is not `pending`, an out-of-bounds
 *   `index`, a patch that failed shaper validation, or a live structural edit refused by
 *   the NATIVE bottom-up gate — a terminal container, an edit targeting (or destined for)
 *   a position BEFORE the container's own pending-suffix boundary, or (a running phase)
 *   anything other than a pure append. The manager /
 *   entity structural API returns it as a graceful `Result` `failure` —
 *   it NEVER throws for this code except {@link TaskInterface.patch} /
 *   {@link PhaseInterface.patch}'s defense-in-depth self-check and the build-time
 *   {@link TaskManagerInterface.append} / {@link PhaseManagerInterface.append} duplicate-id
 *   guard (both genuine programmer-error paths). The error `context` names
 *   the offending id / index / status.
 * - `SCHEDULE` — {@link import('./helpers.js').scheduleHost} refused to arm host work
 *   because the caller passed a `signal` that is not a native `AbortSignal`. The refusal
 *   is a REJECTED promise, never a synchronous throw, so every scheduler backend settles
 *   the same way whatever the caller passed. The error `context` names the offending
 *   parameter (`signal`) and the `typeof` the caller supplied.
 * - `INVARIANT` — an internal invariant did not hold: a derived
 *   `failed` node whose failing {@link TaskResult} is missing, or a tracked
 *   {@link RunnerInterface} unit whose cancellation handle is absent. It is a programmer-error
 *   guard on a path no input reaches, raised instead of fabricating a substitute value that
 *   would type-check while masking the true cause. The error `context` names the offending node.
 */
export type WorkflowErrorCode = 'TRANSITION' | 'RESTORE' | 'MUTATION' | 'SCHEDULE' | 'INVARIANT'

// === Status union (the lifecycle vocabulary)

/**
 * Names the shared lifecycle vocabulary every tier draws from — `pending` before it runs,
 * `running` while in flight, then one of the terminal states `completed` / `failed` /
 * `skipped` / `stopped`.
 *
 * @remarks
 * The ONE literal set the workflow, phase, and task tiers all draw from, so the vocabulary
 * lives in one place and a signature reading `LifecycleStatus` means the same thing at
 * every tier. Each member's tier-specific meaning belongs to the member that declares it:
 * `skipped` is "deliberately not run" and `stopped` is "ended early", and the terminal
 * members for which a {@link TaskResult} is meaningful are exactly `completed` and
 * `failed`, which box a {@link Result}, while `skipped` and `stopped` settle without a
 * boxed outcome. It also types the single runtime terminal check
 * {@link import('./helpers.js').isTerminalStatus}, which therefore accepts a value from
 * any tier.
 */
export type LifecycleStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'stopped'

/**
 * Represents one phase's contribution to the workflow-status derivation — its
 * {@link LifecycleStatus} paired with the EFFECTIVE `bail` policy it ran under
 * (`phase.bail ?? workflow.bail`).
 *
 * @remarks
 * The input shape of {@link import('./helpers.js').deriveWorkflowStatus}: because `bail` is a
 * per-phase override, the workflow `failed` derivation is per-phase-bail-aware, so each phase
 * must carry its OWN effective policy rather than the derivation taking one scalar `bail`. A
 * `failed` phase propagates `failed` to the workflow only when ITS `bail` is `true`; a `failed`
 * phase whose `bail` is `false` folds into completion. {@link import('./Workflow.js').Workflow}
 * builds one per live phase (`{ status: phase.status, bail: phase.bail }`).
 */
export interface PhaseDerivation {
	/** Holds the phase's derived lifecycle status. */
	readonly status: LifecycleStatus
	readonly bail: boolean
}

// === Task result (lineage + boxed outcome)

/**
 * Names where a task failure arose — the axis a persisted {@link TaskFailure} records.
 *
 * @remarks
 * - `handler` — the task's own {@link WorkflowFunction} threw or rejected, or its `behavior` name had
 *   no registered handler to dispatch.
 * - `timeout` — the task's per-attempt deadline expired on its final attempt.
 * - `recovery` — an interrupted `running` task was rebuilt by
 *   {@link import('./factories.js').createRecoveredWorkflow} with no attempts left in its retry
 *   budget, so the recovery settled it rather than replenishing it.
 */
export type TaskFailureOrigin = 'handler' | 'timeout' | 'recovery'

/** Represents a normalized JSON-safe task failure persisted without a stack or cause. */
export interface TaskFailure {
	readonly origin: TaskFailureOrigin
	readonly message: string
}

/**
 * Represents the structured outcome of a task execution — its full lineage, its terminal
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
	/** Holds the task's lifecycle status at the moment the result was recorded. */
	readonly status: LifecycleStatus
	/** Holds the boxed outcome — present for `completed` (Success) / `failed` (Failure), absent otherwise. */
	readonly result?: Result<JSONValue, TaskFailure>
	readonly timestamp: number
}

// === Snapshots (the durable-store payload, pure JSON)

/**
 * Represents a JSON-serializable snapshot of one task's state — the leaf of the snapshot tree
 * the durable store (W-d) persists.
 *
 * @remarks
 * Pure JSON DATA (no class instances, no functions). `result` is the task's
 * {@link TaskResult} when it has settled with an outcome, else `undefined`.
 * `metadata` is the open consumer bag carried from the task's {@link TaskInput}.
 * `behavior` / `retries` / `timeout` are the DECLARATIVE config the task carries — persisted
 * like a {@link PhaseSnapshot}'s `bail` / `concurrency`, so a restore reinstates the same
 * behavior reference and reliability overrides (`behavior` re-resolves against the
 * {@link WorkflowOptions.functions} registry supplied to
 * {@link import('./factories.js').createRestoredWorkflow}); each omitted ⇒ the corresponding
 * unset default.
 */
export interface TaskSnapshot {
	readonly id: string
	readonly name: string
	readonly description?: string
	/** Holds the task's persisted lifecycle status. */
	readonly status: LifecycleStatus
	readonly result?: TaskResult
	readonly metadata: JSONRecord
	/** Counts total launches already consumed; zero while fresh and never reset by recovery. */
	readonly attempts: number
	/** Names the behavior reference — a registry key resolved against {@link WorkflowRegistry} on restore/build. */
	readonly behavior?: string
	/** Records the extra attempts after the first on failure (a non-negative integer); overrides the phase Runner default. */
	readonly retries?: number
	/** Records the workflow-owned per-attempt deadline (`0..MAX_TIMER_MS`); zero or omission means disabled. */
	readonly timeout?: number
	/** Holds the task's activity: pending omits it; running/completed/failed require it; skipped/stopped may retain it. */
	readonly activity?: TaskActivity
}

/**
 * Represents a JSON-serializable snapshot of one phase's state — its identity, status, its forced
 * override (if any), and its nested task snapshots.
 *
 * @remarks
 * Pure JSON DATA. `status` is the EFFECTIVE status (override-or-derived) at snapshot time.
 * `override` is the forced status of a whole-phase `skip` / `stop` — PRESENT only
 * when one is in force, so a restore reinstates it DIRECTLY (no fragile derivation comparison)
 * and a genuinely-derived phase carries none. A leaf {@link TaskSnapshot} needs no `override`
 * field — a task's terminal status IS its forced marker. `tasks` are the phase's
 * {@link TaskSnapshot}s in order.
 */
export interface PhaseSnapshot {
	readonly id: string
	readonly name: string
	readonly description?: string
	/** Holds the phase's persisted effective lifecycle status (override-or-derived). */
	readonly status: LifecycleStatus
	/** Records the forced status of a whole-phase `skip` / `stop`; present only when an override is in force. */
	readonly override?: LifecycleStatus
	/**
	 * Records the EFFECTIVE failure policy this phase ran under (`phase.bail ?? workflow.bail`)
	 * — persisted (REQUIRED, like {@link WorkflowSnapshot.bail}) so a restore reinstates the same
	 * per-phase policy identically without a silent default.
	 */
	readonly bail: boolean
	/**
	 * Caps the tasks in flight at once (a resource throttle), persisted so a restore reinstates the
	 * same per-phase throttle — mirrors {@link import('./types.js').PhaseDefinition.concurrency}.
	 * Omitted ⇒ unbounded.
	 */
	readonly concurrency?: number
	readonly tasks: readonly TaskSnapshot[]
}

/**
 * Represents a JSON-serializable snapshot of a whole workflow's state — its identity, status, its
 * forced override (if any), the `bail` policy it ran under, its nested phase snapshots,
 * and creation / update timestamps.
 *
 * @remarks
 * Pure JSON DATA — the COMPLETE, SELF-CONTAINED payload the durable store (W-d) persists,
 * designed in full at W-a so its shape is fixed from the start. It can be written to disk,
 * sent to a prompt companion, loaded across conversations, or reviewed by an agent. Because
 * it is self-contained, it carries the policy it ran under: `bail` is the
 * failure policy, so {@link import('./factories.js').createRestoredWorkflow} re-derives status
 * IDENTICALLY without a silent default. `status` is the EFFECTIVE status (override-or-derived)
 * at snapshot time; `override` is the forced status of a whole-workflow `skip` / `stop` or
 * vacuous `completed`. The completed override is valid only for an otherwise-derived pending
 * tree containing no tasks. An override is PRESENT only when one is in force (so a restore
 * reinstates it DIRECTLY rather than guessing from a status divergence). `phases` are the
 * workflow's {@link PhaseSnapshot}s in order; `created` / `updated` are ms since epoch.
 */
export interface WorkflowSnapshot {
	readonly id: string
	readonly name: string
	readonly description?: string
	/** Holds the workflow's persisted effective lifecycle status (override-or-derived). */
	readonly status: LifecycleStatus
	/** Records a whole-workflow `skip` / `stop` or a valid task-free vacuous `completed`; omitted when derived. */
	readonly override?: LifecycleStatus
	/** Records the failure policy the workflow ran under — persisted so a restore re-derives identically. */
	readonly bail: boolean
	readonly phases: readonly PhaseSnapshot[]
	readonly created: number
	readonly updated: number
}

/**
 * Declares the durable persistence seam for a {@link WorkflowSnapshot} — three async primitives
 * (`get` / `set` / `delete`) keyed by a workflow id, the snapshot analogue of
 * the server package's `SessionStoreInterface` (and the `@orkestrel/queue`
 * `QueueStoreInterface` driver-swap pattern).
 *
 * @remarks
 * The store persists the W-a {@link WorkflowSnapshot} — the COMPLETE, self-contained,
 * pure-JSON run state — so a JSON / SQLite / IndexedDB backend swaps in WITHOUT touching the
 * runner or the entity tree: the in-memory default
 * {@link import('./stores/MemoryWorkflowStore.js').MemoryWorkflowStore} and its driver-pluggable
 * twin {@link import('./stores/DatabaseWorkflowStore.js').DatabaseWorkflowStore} (the snapshot as
 * one opaque JSON column) share THIS one interface. Restore is NOT a store concern — a caller reads
 * a snapshot back and rebuilds the live tree with the shipped {@link import('./factories.js').createRestoredWorkflow}.
 *
 * Every primitive is async (a `Promise`), so a durable backend (a database round-trip) fits the
 * same shape as the memory one. The snapshot carries its OWN id, so `set` takes no separate id
 * param (mirroring `QueueStoreInterface.save` from `@orkestrel/queue` / the server package's
 * `SessionStoreInterface.set`, which key off the value's own
 * `id`). UNLIKE a session store there is NO idle-TTL / eviction — a persisted workflow run-state
 * lives until an explicit `delete`, never silently expiring (it is durable orchestration state,
 * not an ephemeral session). It is concrete over {@link WorkflowSnapshot} — no generic parameter
 * (the smallest interface the capability requires), because the snapshot is the ONE payload a
 * workflow store persists.
 */
export interface WorkflowStoreInterface {
	/**
	 * Resolves the persisted snapshot for `id`, or `undefined` if none is stored.
	 * A present payload whose own `id` differs from the requested storage key is corrupt and
	 * rejects with a normalized `RESTORE` error carrying both ids.
	 *
	 * @param id - The workflow id to resolve (a {@link WorkflowSnapshot.id})
	 * @returns The persisted snapshot, or `undefined` if absent
	 */
	get(id: string): Promise<WorkflowSnapshot | undefined>
	/**
	 * Inserts or replaces a snapshot under its own `snapshot.id` (no separate id param —
	 * mirroring `QueueStoreInterface.save` from `@orkestrel/queue`).
	 *
	 * @param snapshot - The snapshot to store (keyed by its `id`)
	 */
	set(snapshot: WorkflowSnapshot): Promise<void>
	/**
	 * Drops a snapshot by id; an absent id is a no-op (no throw).
	 *
	 * @param id - The workflow id to drop
	 */
	delete(id: string): Promise<void>
}

/**
 * Represents one row of the table a {@link import('./stores/DatabaseWorkflowStore.js').DatabaseWorkflowStore}
 * persists — a workflow `id` plus its {@link WorkflowSnapshot} held as ONE OPAQUE JSON column.
 *
 * @remarks
 * The Database twin of {@link WorkflowStoreInterface} stores the snapshot whole (the `snapshot`
 * column is a `rawShape`, an opaque JSON blob — exactly as
 * `@orkestrel/queue`'s `StoredEntry` stores a queue entry's `input`), so the row
 * type stays FLAT and the deeply-nested snapshot shape (workflow → phases → tasks → results) never
 * forces the contract to `Infer` it — sidestepping a TS2589 instantiation-depth blow-up. The column
 * therefore reads back as the broad `unknown`; the store owns and narrows it to a
 * {@link WorkflowSnapshot} on `get` through {@link import('./cloners.js').cloneWorkflowSnapshot},
 * whose semantic pass is {@link import('./validators.js').isOwnedWorkflowSnapshot} — the
 * boundary narrow, which also key-checks the row and refuses a mismatch. The total guard
 * {@link import('./validators.js').isWorkflowSnapshot} is the same boundary narrow for a caller
 * holding an untrusted payload of its own. `id`
 * mirrors {@link WorkflowSnapshot.id} (the primary key), so a `set` writes `{ id: snapshot.id, snapshot }`.
 */
export interface WorkflowSnapshotRow {
	readonly id: string
	/** Holds the whole {@link WorkflowSnapshot} as one opaque JSON blob — read back as `unknown`, narrowed on `get`. */
	readonly snapshot: unknown
}

// === Event maps (defined here, owned by the W-b entities)

/**
 * Declares the push observation surface of the workflow entity (W-b) — the
 * lifecycle moments a fire-and-forget observer subscribes to through
 * `workflow.emitter.on`.
 *
 * @remarks
 * Present-tense events with arg tuples. `start` fires when the workflow begins;
 * `complete` when every phase settled successfully; `fail` when a phase failed
 * under `bail` (carrying the failing {@link TaskResult}); `pause` / `resume` when its
 * runtime gate closes / opens; `skip` when the workflow was intentionally skipped;
 * `stop` when it was permanently ended. `add` / `remove`
 * / `move` / `update` fire on a successful
 * structural or patch edit through {@link WorkflowInterface.add} / `remove` / `move` /
 * `update` — never on a refused/gated one. A throwing listener never
 * reaches the domain surface — the emitter isolates it and routes it to its OWN
 * `error` handler (the `error` option). Declared as a `type` alias (not
 * `interface extends EventMap`) so the type-literal satisfies `EventMap`
 * structurally.
 */
export type WorkflowEventMap = {
	/** Signals that the workflow began — its `id`. */
	readonly start: readonly [id: string]
	/** Signals that every phase settled successfully. */
	readonly complete: readonly []
	/** Signals that a phase failed under `bail` — the failing task's result. */
	readonly fail: readonly [result: TaskResult]
	/** Signals that the workflow's runtime gate closed. */
	readonly pause: readonly []
	/** Signals that the workflow's runtime gate opened. */
	readonly resume: readonly []
	/** Signals that the workflow was intentionally skipped. */
	readonly skip: readonly []
	/** Signals that the workflow was permanently stopped. */
	readonly stop: readonly []
	/** Signals that a phase was inserted — the inserted phase + its final index. */
	readonly add: readonly [phase: PhaseInterface, index: number]
	/** Signals that a phase was removed — the removed phase. */
	readonly remove: readonly [phase: PhaseInterface]
	/** Signals that a phase was repositioned — the moved phase + its new index. */
	readonly move: readonly [phase: PhaseInterface, index: number]
	/** Signals that a phase was patched — the patched phase. */
	readonly update: readonly [phase: PhaseInterface]
}

/**
 * Declares the push observation surface of the phase entity (W-b) — analogous
 * to {@link WorkflowEventMap}, scoped to one phase.
 *
 * @remarks
 * `start` fires when the phase begins; `complete` when all its tasks settled
 * successfully; `fail` when a task failed under `bail` (carrying the
 * {@link TaskResult}); `pause` / `resume` when its runtime gate closes / opens;
 * `skip` when the phase was intentionally skipped; `stop` when the phase was ended.
 * `add` / `remove` / `move` / `update` fire on a successful
 * structural or patch edit through
 * {@link PhaseInterface.add} / `remove` / `move` / `update` — never on a
 * refused/gated one. A throwing listener is isolated by the emitter and routed to its
 * `error` handler, not the domain surface. A `type` alias so it satisfies `EventMap`.
 */
export type PhaseEventMap = {
	/** Signals that the phase began — its `id`. */
	readonly start: readonly [id: string]
	/** Signals that every task in the phase settled successfully. */
	readonly complete: readonly []
	/** Signals that a task failed under `bail` — the failing task's result. */
	readonly fail: readonly [result: TaskResult]
	/** Signals that the phase's runtime gate closed. */
	readonly pause: readonly []
	/** Signals that the phase's runtime gate opened. */
	readonly resume: readonly []
	/** Signals that the phase was intentionally skipped. */
	readonly skip: readonly []
	/** Signals that the phase was permanently stopped. */
	readonly stop: readonly []
	/** Signals that a task was inserted — the inserted task + its final index. */
	readonly add: readonly [task: TaskInterface, index: number]
	/** Signals that a task was removed — the removed task. */
	readonly remove: readonly [task: TaskInterface]
	/** Signals that a task was repositioned — the moved task + its new index. */
	readonly move: readonly [task: TaskInterface, index: number]
	/** Signals that a task was patched — the patched task. */
	readonly update: readonly [task: TaskInterface]
}

/**
 * Declares the push observation surface of the task entity (W-b) — the
 * lifecycle moments of one task.
 *
 * @remarks
 * `start` fires when the task begins; `complete` when it finishes successfully
 * (carrying its {@link TaskResult}); `fail` when it errors (carrying the result);
 * `pause` / `resume` when its runtime gate closes / opens; `skip` when it is
 * intentionally not executed; `stop` when it is ended early. A
 * throwing listener is isolated by the emitter and routed to its `error` handler,
 * not the domain surface. A `type` alias so it satisfies
 * `EventMap`.
 */
export type TaskEventMap = {
	/** Signals that the task began — its `id`. */
	readonly start: readonly [id: string]
	/** Signals that the task finished successfully — its result. */
	readonly complete: readonly [result: TaskResult]
	/** Signals that the task failed — its result. */
	readonly fail: readonly [result: TaskResult]
	/** Signals that the task's runtime gate closed. */
	readonly pause: readonly []
	/** Signals that the task's runtime gate opened. */
	readonly resume: readonly []
	/** Signals that the task was intentionally skipped. */
	readonly skip: readonly []
	/** Signals that the task was permanently stopped. */
	readonly stop: readonly []
	/** Signals that a complete activity replacement was committed. */
	readonly report: readonly [activity: TaskActivity]
	/** Signals that the task confirmed liveness without replacing its current activity. */
	readonly pulse: readonly [activity: TaskActivity]
	/** Signals that no report or pulse was accepted during the effective silence window. */
	readonly silence: readonly []
}

// === Runtime options (the construction bags the W-b entity tree carries)

/**
 * Declares the runtime options for a {@link TaskInterface} — the construction bag the live
 * leaf state machine (W-b) carries that the W-a {@link TaskDefinition} did not.
 *
 * @remarks
 * The reserved `on` wires initial {@link TaskEventMap} listeners; a
 * {@link import('./factories.js').createWorkflow}-built tree threads each level's `on`
 * from its parent options, the same way a {@link WorkflowInterface.add} /
 * {@link PhaseInterface.add} mint threads a leaf's `on` from ITS options. `metadata` is
 * the open consumer bag carried verbatim into a {@link TaskSnapshot} (mirrors
 * {@link TaskInput.metadata}), never interpreted by the workflow.
 */
export interface TaskOptions {
	readonly on?: EmitterHooks<TaskEventMap>
	/** Holds the emitter's listener-error handler — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	/** Holds an open consumer bag — stored and snapshotted, never interpreted by the workflow. */
	readonly metadata?: JSONRecord
	/** Sets the runtime-only silence window; non-positive, non-finite, or over-`MAX_TIMER_MS` disables inheritance. */
	readonly silence?: number
}

/**
 * Declares the runtime options for a {@link PhaseInterface} — the construction bag the live
 * derived phase state machine (W-b) carries.
 *
 * @remarks
 * The reserved `on` wires initial {@link PhaseEventMap} listeners.
 * `tasks` keys per-task {@link TaskOptions} by task `id`, so {@link createWorkflow}
 * can thread a leaf's options (its `on` / `metadata`) down through the phase when it
 * builds the whole tree.
 */
export interface PhaseOptions {
	readonly on?: EmitterHooks<PhaseEventMap>
	/** Holds the emitter's listener-error handler — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	/** Holds the per-task {@link TaskOptions}, keyed by the task's `id`. */
	readonly tasks?: Readonly<Record<string, TaskOptions>>
}

/**
 * Declares the runtime options for a {@link WorkflowInterface} — the construction bag the
 * live derived workflow state machine (W-b) carries, the root {@link createWorkflow}
 * accepts.
 *
 * @remarks
 * The reserved `on` wires initial {@link WorkflowEventMap} listeners.
 * `phases` keys per-phase {@link PhaseOptions} by phase `id`, so the whole tree's
 * initial listeners + per-task metadata can be supplied in one nested bag (the
 * "entity is the key" grouping of `.claude/rules/names.md` § Group options by entity), each leaf
 * reachable by its lineage of ids.
 */
export interface WorkflowOptions {
	readonly on?: EmitterHooks<WorkflowEventMap>
	/**
	 * Sets the failure policy the live tree applies — the same boolean toggle as
	 * {@link WorkflowDefinition.bail}, fed to {@link import('./helpers.js').deriveWorkflowStatus}.
	 * {@link import('./factories.js').createWorkflow} defaults it to the definition's `bail`. A
	 * {@link WorkflowSnapshot} PERSISTS the policy, so {@link import('./factories.js').createRestoredWorkflow}
	 * takes it from the snapshot (the source of truth); an explicit `options.bail` on restore still
	 * wins when supplied. Omitted on a fresh build ⇒ the graceful {@link import('./constants.js').DEFAULT_BAIL}.
	 */
	readonly bail?: boolean
	/** Holds the emitter's listener-error handler — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	/** Holds the per-phase {@link PhaseOptions}, keyed by the phase's `id`. */
	readonly phases?: Readonly<Record<string, PhaseOptions>>
	/**
	 * Holds the `function`-task behavior registry ({@link WorkflowRegistry}) each live task's
	 * {@link TaskDefinition.behavior} / {@link TaskSnapshot.behavior} name resolves against ONCE at
	 * construction into its runtime {@link TaskInterface.handler} — the SAME registry a
	 * fresh build ({@link import('./factories.js').createWorkflow}) and a restore
	 * ({@link import('./factories.js').createRestoredWorkflow}) both consume, and the same shape a
	 * live {@link WorkflowInterface.add} / {@link PhaseInterface.add} mint resolves a newly
	 * minted task against. An omitted `behavior` resolves to no handler and is the deliberate
	 * no-op form. A present name absent from `functions` also has no handler so exact restore
	 * remains inspectable, but {@link WorkflowRunnerInterface.execute} rejects that tree.
	 * Omitted ⇒ an empty registry; only tasks that also omit `behavior` are executable no-ops.
	 */
	readonly functions?: WorkflowRegistry
	/** Sets the runtime-only default silence; non-positive, non-finite, or over-`MAX_TIMER_MS` disables it. */
	readonly silence?: number
}

// === Entity interfaces (the live W-b state machines)
//
// Mutation authority is BOTTOM-UP and NATIVE: `add` / `remove` / `move` / `update`
// gate purely from the container's OWN derived status and the list's positions — no
// runner-installed hook inverts that authority. The "pending suffix" of a positional
// list is its contiguous trailing run of `pending` entries; its BOUNDARY (the index
// of the first entry in that suffix) is a live run's de facto cursor, computed fresh
// from statuses rather than tracked by an installed hook — see
// {@link import('./helpers.js').deriveBoundary}.

/**
 * Declares the live leaf state machine (W-b) for one {@link TaskDefinition} — an observable,
 * guarded synchronous task whose explicit {@link LifecycleStatus} advances through the
 * declared transitions.
 *
 * @remarks
 * - **Identity + lineage.** `id` / `name` / `description` mirror the definition;
 *   `context` is the task's full {@link TaskContext} (so `context.phase` /
 *   `context.phase.workflow` navigate UP the tree), and `phase` / `workflow` are the
 *   live parent entities for direct lineage navigation.
 * - **State machine.** `status` is the explicit current state. `start`
 *   moves `pending → running`; the terminal transitions are `complete(value)` (records
 *   a {@link import('@orkestrel/contract').Success}), `fail(error)` (records a
 *   {@link import('@orkestrel/contract').Failure}), `skip` (intentionally not run),
 *   and `stop` (ended early). Each is GUARDED: an illegal transition (for example,
 *   completing a non-`running` task) throws a {@link import('./errors.js').WorkflowError}.
 *   A leaf needs no override: `skipped` / `stopped` are explicit terminal statuses and
 *   restore directly from {@link TaskSnapshot.status}.
 * - **Result.** `result` is the recorded {@link TaskResult} after the task settled with an
 *   outcome (`completed` / `failed`), else `undefined` — the lineage-navigable leaf of the
 *   result tree.
 * - **Observable.** The owned {@link emitter} ({@link TaskEventMap}) fires
 *   `start` / `complete` / `fail` / `pause` / `resume` / `skip` / `stop` strictly AFTER
 *   each state change; the emitter isolates a listener throw and routes it to its `error`
 *   handler (the `error` option).
 */
export interface TaskInterface {
	readonly emitter: EmitterInterface<TaskEventMap>
	readonly id: string
	readonly name: string
	/** Holds this task's prose, or `undefined` when the definition or snapshot declared none. */
	readonly description: string | undefined
	readonly context: TaskContext
	readonly phase: PhaseInterface
	readonly workflow: WorkflowInterface
	/** Holds this task's explicit lifecycle status, set by its own transitions. */
	readonly status: LifecycleStatus
	/** Counts total launches already consumed; zero while fresh and one-based after launch. */
	readonly attempts: number
	/** Holds the recorded outcome after the task settled with one (`completed` / `failed`), else `undefined`. */
	readonly result: TaskResult | undefined
	/**
	 * Names the behavior reference — a plain registry key name, PERSISTED (mirrors
	 * {@link TaskDefinition.behavior} / {@link TaskSnapshot.behavior}), like {@link PhaseInterface.bail}.
	 * `undefined` when this task has no behavior reference.
	 */
	readonly behavior: string | undefined
	/**
	 * Holds the RESOLVED runtime handler — RUNTIME-ONLY, NEVER persisted in a {@link TaskSnapshot}.
	 * Resolved ONCE at construction (build, restore, or a live mint) by looking `behavior` up in the
	 * workflow-level {@link WorkflowOptions.functions} registry: `functions?.[behavior]` when `behavior`
	 * is defined, else `undefined`. An omitted `behavior` is the deliberate no-op form. A present,
	 * unresolved `behavior` remains visible on exact restore, but the runner rejects it before
	 * dispatch instead of falsely completing named work.
	 */
	readonly handler: WorkflowFunction | undefined
	/**
	 * Holds the extra attempts after the first on failure — PERSISTED (mirrors {@link TaskDefinition.retries}
	 * / {@link TaskSnapshot.retries}), like {@link PhaseInterface.concurrency}. `undefined` ⇒ none.
	 */
	readonly retries: number | undefined
	/**
	 * Holds the workflow-owned per-attempt deadline in milliseconds (`0..MAX_TIMER_MS`) — PERSISTED
	 * (mirrors {@link TaskDefinition.timeout} / {@link TaskSnapshot.timeout}). Zero or
	 * `undefined` means no deadline.
	 */
	readonly timeout: number | undefined
	/** Holds the last accepted reporter claim, absent while pending. */
	readonly activity: TaskActivity | undefined
	/** Holds the effective host-safe silence window (`1..MAX_TIMER_MS`), or `undefined` when disabled. */
	readonly silence: number | undefined
	/** Reports whether no report or pulse was accepted during the current silence window. */
	readonly silent: boolean
	/** Reports whether this task's cooperative execution gate is paused. */
	readonly paused: boolean
	/** Holds this task's own cancellation signal; running/pending {@link stop} or {@link skip} fires it. */
	readonly signal: AbortSignal
	start(): void
	complete(value: JSONValue): void
	fail(error: TaskFailure): void
	skip(): void
	stop(): void
	/**
	 * Replaces the complete observable activity of this running task.
	 *
	 * @param input - The complete operations, progress, and constraints replacement
	 * @returns The accepted immutable frame; `MUTATION` for invalid input or `TRANSITION` when not running
	 */
	report(input: TaskActivityInput): Result<TaskActivity, WorkflowError>
	/**
	 * Confirms liveness without replacing the current operations, progress, or constraints.
	 *
	 * @returns True if the pulse was committed while the task is running; false otherwise
	 */
	pulse(): boolean
	/** Suspends this task's cooperative gate while pending or running; idempotent. */
	pause(): void
	/** Continues this task's cooperative gate; idempotent. */
	resume(): void
	/**
	 * Parks until this task is not paused.
	 *
	 * @returns A promise that resolves after the task gate is released
	 */
	wait(): Promise<void>
	/**
	 * Applies a validated declarative patch to SELF (`name` / `description`).
	 *
	 * @remarks
	 * Defense-in-depth: the owning {@link TaskManagerInterface.update} gates
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
 * Declares the live derived state machine (W-b) for one {@link PhaseDefinition} — an
 * observable phase whose {@link LifecycleStatus} is DERIVED from its tasks
 * (never set directly) and recomputed reactively as a task transitions (the cascade).
 *
 * @remarks
 * - **Derived status.** `status` is computed through
 *   {@link import('./helpers.js').derivePhaseStatus} over the live tasks' statuses,
 *   UNLESS an override is in force. It recomputes whenever a child task transitions; a
 *   CHANGE emits.
 * - **Children.** `tasks` is the lean {@link TaskManagerInterface} (an
 *   accessor + `count`, no batch matrix); `task(id)` / `tasks().tasks()` read in positional
 *   order. `results` collects the settled tasks' {@link TaskResult}s (the phase tier of the
 *   result tree); `workflow` navigates UP to the live parent.
 * - **Override.** `skip` / `stop` FORCE the phase's status, overriding the
 *   derived value (for example, skipping a whole phase); the override survives a snapshot.
 * - **Observable.** The owned {@link emitter} ({@link PhaseEventMap}) fires
 *   `start` / `complete` / `fail` / `pause` / `resume` / `stop` after the corresponding
 *   status or runtime-gate change; the emitter isolates a listener throw and routes it to
 *   its `error` handler (the `error` option).
 * - **Runtime lifecycle.** `pause` / `resume` / `wait` mirror
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
	/** Holds this phase's prose, or `undefined` when the definition or snapshot declared none. */
	readonly description: string | undefined
	readonly context: PhaseContext
	readonly workflow: WorkflowInterface
	/** Holds this phase's effective lifecycle status, derived from its tasks unless an override is in force. */
	readonly status: LifecycleStatus
	/** Reports the RESOLVED effective failure policy this phase runs under (`phase.bail ?? workflow.bail`); mirrors {@link WorkflowInterface.bail}. */
	readonly bail: boolean
	/** Caps the tasks in flight at once (a resource throttle); mirrors {@link PhaseSnapshot.concurrency}. `undefined` ⇒ unbounded. */
	readonly concurrency: number | undefined
	/**
	 * Reports whether the phase is paused (resumable); RUNTIME-ONLY — never a
	 * {@link LifecycleStatus}, never persisted in a {@link PhaseSnapshot} (a paused phase's
	 * `status` still reports its ordinary derived value).
	 */
	readonly paused: boolean
	readonly tasks: TaskManagerInterface
	/** Looks up one live task by its `id`. */
	task(id: string): TaskInterface | undefined
	/** Lists the settled tasks' results, in positional order — the phase tier of the result tree. */
	results(): readonly TaskResult[]
	/**
	 * Forces this phase to `skipped`, overriding the derived value; idempotent.
	 *
	 * @remarks
	 * A NO-OP after `status` becomes terminal — a settled phase cannot be re-forced. Always
	 * releases a parked {@link wait} waiter regardless (a terminal phase has nothing left to
	 * pause for).
	 */
	skip(): void
	/**
	 * Forces this phase to `stopped`, overriding the derived value; idempotent.
	 *
	 * @remarks
	 * A NO-OP after `status` becomes terminal (a settled phase cannot be re-forced). Always
	 * releases a parked {@link wait} waiter regardless (a terminal phase has nothing left to
	 * pause for).
	 */
	stop(): void
	/**
	 * Suspends the phase (resumable); idempotent.
	 *
	 * @remarks
	 * A no-op when already `paused` or when `status` is terminal. RUNTIME-ONLY —
	 * never a {@link LifecycleStatus}, never persisted in a {@link PhaseSnapshot}. A driving
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
	 * Continues a paused phase; idempotent — a no-op unless {@link paused}.
	 *
	 * @example
	 * ```ts
	 * phase.resume()
	 * phase.paused // false
	 * ```
	 */
	resume(): void
	/**
	 * Parks until this phase is not paused — **promise-parked**, never a timer or busy-loop
	 * (mirrors {@link WorkflowInterface.wait}).
	 *
	 * @remarks
	 * Resolves IMMEDIATELY when not {@link paused}. While paused, parks until `resume` or
	 * this phase's own `stop` / `skip` forcing a terminal status — all release a parked
	 * waiter. NEVER rejects.
	 *
	 * @returns A promise that resolves after the phase is no longer paused
	 */
	wait(): Promise<void>
	/**
	 * Mints a live {@link TaskInterface} from `definition` and inserts it into this phase
	 * (the entity structural API) — gated BEFORE delegating to {@link tasks}'
	 * manager.
	 *
	 * @remarks
	 * Converts `definition` → {@link TaskSnapshot} and constructs the live task (wired to
	 * THIS phase, its recompute cascade, and its emitter hooks), carrying its `behavior` /
	 * `retries` / `timeout` from `definition` and resolving its {@link TaskInterface.handler}
	 * against the workflow-level {@link WorkflowOptions.functions} registry — the SAME
	 * resolution {@link import('./factories.js').createWorkflow} performs at build time.
	 * Requires `definition.id` to be UNIQUE among this phase's existing
	 * task ids — a duplicate is a `MUTATION` failure (mirrors
	 * {@link TaskManagerInterface.add}'s own duplicate-id gate).
	 *
	 * NATIVE gating, purely from this phase's own derived `status` (no
	 * runner-installed hook), UNCHANGED from the entity-taking predecessor. While
	 * `pending`: any valid `index` is accepted (delegates the minted task to
	 * {@link TaskManagerInterface.add} then emits `add`). While `running`: accepted ONLY as
	 * a pure append (`index` omitted or `=== tasks.count`) — a live runner subscribed to
	 * the `add` event picks the new task up for same-run execution; the derived-status
	 * model keeps this phase from reaching a terminal status while the accepted task is
	 * still `pending` (its status feeds `status` through {@link import('./helpers.js').derivePhaseStatus}).
	 * While terminal: always refused.
	 *
	 * **Abort edge.** An append ACCEPTED while `running` can still settle `skipped` rather
	 * than run — if the driving run is cancelled (abort / timeout / budget / `workflow.destroy()`)
	 * before the substrate actually dispatches the newly-minted task, the runner's halt sweep
	 * `skip`s it like any other not-yet-started task. Acceptance here means only that the task
	 * is WIRED into the live tree, not that it will execute.
	 *
	 * @param definition - The {@link TaskDefinition} to mint a live task from
	 * @param index - The insertion position; omitted inserts at the end
	 * @returns A {@link Result} boxing the minted, inserted task, or a `MUTATION` failure
	 */
	add(definition: TaskDefinition, index?: number): Result<TaskInterface, WorkflowError>
	/**
	 * Removes the `pending` task `id` from this phase.
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
	 * Repositions the `pending` task `id` to `index` within this phase.
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
	 * Applies a validated {@link TaskUpdate} patch to the `pending` task `id` in this phase.
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
	 * Applies a validated declarative patch to SELF (`name` / `description` /
	 * `concurrency` / `bail`).
	 *
	 * @remarks
	 * Defense-in-depth: the owning {@link WorkflowInterface.update} gates
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
 * Declares the live derived state machine (W-b) for a whole {@link WorkflowDefinition} — the
 * observable root whose {@link LifecycleStatus} is DERIVED from its phases
 * under the `bail` policy and recomputed reactively as the cascade propagates up.
 *
 * @remarks
 * - **Derived status.** `status` is computed through
 *   {@link import('./helpers.js').deriveWorkflowStatus} over the live phases' statuses,
 *   feeding the definition's `bail`, UNLESS an override is in force. It recomputes when a
 *   phase's status changes (the top of the cascade); a CHANGE emits — `fail` carries the
 *   failing {@link TaskResult} (under `bail: true`).
 * - **Children.** `phases` is the lean {@link PhaseManagerInterface};
 *   `phase(id)` / `phases().phases()` read in positional order. `results` collects ALL
 *   tasks' results across every phase (the workflow tier of the result tree).
 * - **Override.** `skip` / `stop` FORCE the workflow's status; `complete`
 *   may force only a task-free, otherwise-pending tree. The override survives a snapshot.
 * - **Snapshot.** `snapshot()` serializes the whole live tree to a {@link WorkflowSnapshot}
 *   (pure JSON — structure + each node's status + recorded results + positional order);
 *   {@link createRestoredWorkflow} rebuilds an equivalent live tree.
 * - **Observable.** The owned {@link emitter} ({@link WorkflowEventMap}) fires
 *   `start` / `complete` / `fail` / `pause` / `resume` / `stop` after the corresponding
 *   status or runtime-gate change; the emitter isolates a listener throw and routes it to
 *   its `error` handler (the `error` option).
 */
export interface WorkflowInterface {
	readonly emitter: EmitterInterface<WorkflowEventMap>
	readonly id: string
	readonly name: string
	/** Holds this workflow's prose, or `undefined` when the definition or snapshot declared none. */
	readonly description: string | undefined
	readonly context: WorkflowContext
	readonly bail: boolean
	/** Holds this workflow's effective lifecycle status, derived from its phases unless an override is in force. */
	readonly status: LifecycleStatus
	readonly phases: PhaseManagerInterface
	/**
	 * Reports whether the workflow is paused (resumable); RUNTIME-ONLY —
	 * never a {@link LifecycleStatus}, never persisted in a {@link WorkflowSnapshot} (a
	 * paused workflow's `status` still reports its ordinary `pending` / `running` value).
	 */
	readonly paused: boolean
	/** Reports whether {@link destroy} has torn this workflow down; RUNTIME-ONLY, never persisted. */
	readonly destroyed: boolean
	/**
	 * Holds this workflow's own cancellation signal — fires on {@link destroy}. RUNTIME-ONLY
	 * (implemented over `@orkestrel/abort`, AGENTS core precedent), never persisted.
	 */
	readonly signal: AbortSignal
	/** Looks up one live phase by its `id`. */
	phase(id: string): PhaseInterface | undefined
	/** Lists every settled task's result across all phases, in positional order — the workflow tier of the result tree. */
	results(): readonly TaskResult[]
	/**
	 * Forces this workflow to `skipped`, overriding the derived value; idempotent.
	 *
	 * @remarks
	 * A NO-OP after `status` becomes terminal — a settled workflow cannot be re-forced.
	 * Always releases a parked {@link wait} waiter regardless (a terminal workflow has nothing
	 * left to pause for).
	 */
	skip(): void
	/**
	 * Forces this workflow to `stopped`, overriding the derived value; idempotent.
	 *
	 * @remarks
	 * A NO-OP after `status` becomes terminal — a settled workflow cannot be re-forced. Always
	 * releases a parked {@link wait} waiter regardless (a terminal workflow has nothing left to
	 * pause for).
	 */
	stop(): void
	/**
	 * Forces this workflow to `completed`, overriding the derived value.
	 *
	 * @remarks
	 * A NO-OP unless `status` is `pending` and the tree is genuinely vacuous: zero phases or
	 * every phase contains zero tasks. Its ONLY legitimate use is settling an executed no-op
	 * tree. It never overrides pending work or any started/terminal state.
	 */
	complete(): void
	/**
	 * Suspends the workflow (resumable); idempotent.
	 *
	 * @remarks
	 * A no-op when already `paused`, when `status` is terminal, or after {@link destroyed} becomes true.
	 * RUNTIME-ONLY — never a {@link LifecycleStatus}, never persisted in a
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
	 * Continues a paused workflow; idempotent — a no-op unless {@link paused}.
	 *
	 * @example
	 * ```ts
	 * workflow.resume()
	 * workflow.paused // false
	 * ```
	 */
	resume(): void
	/**
	 * Tears this workflow down — an atomic TERMINAL teardown: mark
	 * {@link destroyed}, pin non-terminal workflow/phase overrides to `stopped`, stop every
	 * non-terminal task, release gates and liveness resources, abort {@link signal}, then
	 * destroy task, phase, and workflow emitters in ownership order; idempotent.
	 *
	 * @remarks
	 * {@link destroyed} is set before final events, so reentrant mutation is refused and a
	 * recursive `destroy` is a no-op. Already-terminal genuine completed/failed state is
	 * preserved, and state/snapshots remain inspectable after emitter resources are destroyed.
	 *
	 * @example
	 * ```ts
	 * workflow.destroy()
	 * workflow.destroyed // true
	 * ```
	 */
	destroy(): void
	/**
	 * Parks until this workflow is not paused — **promise-parked**, never a timer or
	 * busy-loop (mirrors {@link ControllerInterface.wait}'s doc style).
	 *
	 * @remarks
	 * Resolves IMMEDIATELY when not {@link paused}. While paused, parks until `resume` /
	 * `skip` / `stop` / `destroy` — each always releases a parked waiter (a permanently
	 * ended workflow has nothing left to pause for). NEVER rejects.
	 *
	 * @returns A promise that resolves after the workflow is no longer paused
	 */
	wait(): Promise<void>
	/**
	 * Mints a live {@link PhaseInterface} (and its tasks) from `definition` and inserts it
	 * into this workflow (the entity structural API) — gated BEFORE delegating
	 * to {@link phases}' manager.
	 *
	 * @remarks
	 * Converts `definition` → {@link PhaseSnapshot} and constructs the live phase (wired to
	 * THIS workflow, its recompute cascade, and its emitter hooks) plus each of its live
	 * tasks — each task's `behavior` / `retries` / `timeout` carried from its {@link TaskDefinition}
	 * and its {@link TaskInterface.handler} resolved against the workflow-level
	 * {@link WorkflowOptions.functions} registry (mirrors
	 * {@link import('./factories.js').createWorkflow}'s build-time resolution). The
	 * phase's effective `bail` resolves exactly as the build path does
	 * (`definition.bail ?? this.bail`). Requires `definition.id` to be UNIQUE among this
	 * workflow's existing phase ids — a duplicate is a `MUTATION` failure (mirrors
	 * {@link PhaseManagerInterface.add}'s own duplicate-id gate).
	 *
	 * NATIVE gating, purely from this workflow's own derived `status` and the phase list's
	 * positions (no runner-installed hook), UNCHANGED from the entity-taking
	 * predecessor: refused outright while this workflow's own `status` is terminal or after
	 * {@link destroyed} becomes true. Otherwise the effective target position (`index ?? phases.count`)
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
	 * Removes the `pending` phase `id` from this workflow.
	 *
	 * @remarks
	 * NATIVE gating: refused while this workflow's own `status` is terminal. Otherwise the
	 * target must exist at an index within the pending suffix (at or past
	 * {@link import('./helpers.js').deriveBoundary}) — the manager separately gates the
	 * target's own `pending` status.
	 *
	 * @param id - The phase id to remove
	 * @returns A {@link Result} boxing the removed phase, or a `MUTATION` failure
	 */
	remove(id: string): Result<PhaseInterface, WorkflowError>
	/**
	 * Repositions the `pending` phase `id` to `index` within this workflow.
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
	 * Applies a validated {@link PhaseUpdate} patch to the `pending` phase `id` in this workflow.
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

// === Positional collection (the one insertion-ordered gated store both managers hold)

/**
 * Declares what the {@link CollectionInterface} store requires of the entities it holds — a stable `id`, a
 * gating {@link LifecycleStatus}, and a `patch` the store applies after validation.
 *
 * @remarks
 * Both {@link TaskInterface} and {@link PhaseInterface} satisfy it, which is what lets one engine
 * serve {@link TaskManagerInterface} and {@link PhaseManagerInterface}. The store reads `status`
 * only to gate a `remove` / `move` / `update` on the target being `pending`; it never derives,
 * writes, or interprets it further.
 *
 * @typeParam TPatch - The declarative partial update the entity's `patch` accepts
 */
export interface CollectionEntry<TPatch> {
	readonly id: string
	readonly status: LifecycleStatus
	patch(value: TPatch): void
}

/**
 * Declares an insertion-ordered store of {@link CollectionEntry} entities keyed by `id`, with the gated
 * mutation quartet a lean manager delegates to.
 *
 * @remarks
 * The ONE engine behind {@link TaskManagerInterface} and {@link PhaseManagerInterface}: positional
 * order is the backing `Map`'s insertion order, so it survives an interior `skip` (a status
 * change, never a removal) and a snapshot restore reproduces it by re-`append`ing in order.
 * `append` is the build-time wiring path and THROWS a `MUTATION`
 * {@link import('./errors.js').WorkflowError} on a duplicate id (a genuine programmer error);
 * `add` / `remove` / `move` / `update` are its graceful `Result` counterparts, gating ONLY on the
 * target's own existence, `pending` status, id, and bounds. The store is event-free — the entity
 * that owns it emits on success. Each refusal names the entity noun the store was built with, so
 * a task store and a phase store report in their own vocabulary.
 *
 * @typeParam TEntry - The stored entity
 * @typeParam TPatch - The declarative partial update `update` validates and applies
 */
export interface CollectionInterface<TEntry, TPatch> {
	readonly count: number
	/**
	 * Adds `entry` at the end — the build-time wiring path.
	 *
	 * @remarks
	 * THROWS a `MUTATION` {@link import('./errors.js').WorkflowError} on a duplicate `id` instead
	 * of silently overwriting the existing entry.
	 *
	 * @param entry - The entity to append
	 */
	append(entry: TEntry): void
	/**
	 * Inserts `entry` at `index` (default the end) — the gated counterpart to {@link append}.
	 *
	 * @param entry - The entity to insert
	 * @param index - The insertion position (`[0, count]`); omitted inserts at the end
	 * @returns A {@link Result} boxing the inserted entity, or a `MUTATION` failure on a duplicate
	 *   id or an out-of-bounds `index`
	 */
	add(entry: TEntry, index?: number): Result<TEntry, WorkflowError>
	/**
	 * Removes the `pending` entity `id`.
	 *
	 * @param id - The entity id to remove
	 * @returns A {@link Result} boxing the removed entity, or a `MUTATION` failure when `id` is
	 *   absent or not `pending`
	 */
	remove(id: string): Result<TEntry, WorkflowError>
	/**
	 * Repositions the `pending` entity `id` to `index`.
	 *
	 * @param id - The entity id to move
	 * @param index - The destination position (`[0, count)`)
	 * @returns A {@link Result} boxing the moved entity, or a `MUTATION` failure when `id` is
	 *   absent, not `pending`, or `index` is out of bounds
	 */
	move(id: string, index: number): Result<TEntry, WorkflowError>
	/**
	 * Applies a validated patch to the `pending` entity `id`.
	 *
	 * @param id - The entity id to patch
	 * @param patch - The fields to update
	 * @returns A {@link Result} boxing the patched entity, or a `MUTATION` failure when `id` is
	 *   absent, not `pending`, or `patch` fails validation
	 */
	update(id: string, patch: TPatch): Result<TEntry, WorkflowError>
	/**
	 * Looks up one stored entity by its `id`.
	 *
	 * @param id - The entity id to resolve
	 * @returns The stored entity, or `undefined` when none is stored under `id`
	 */
	entry(id: string): TEntry | undefined
	/**
	 * Lists every stored entity in positional order.
	 *
	 * @returns The stored entities, in insertion order
	 */
	entries(): readonly TEntry[]
}

// === Manager interfaces (lean: an accessor + count, no batch matrix)

/**
 * Declares the lean child manager of a {@link PhaseInterface}'s live tasks —
 * positional accessors plus `count`, backed by an insertion-ordered store so order
 * is preserved across an interior `skip` / `remove`.
 *
 * @remarks
 * `append` adds one live {@link TaskInterface} at the end (the build-time wiring path);
 * `task(id)` looks one up; `tasks()` lists them in positional order; `count` is the
 * tally. No batch matrix (`.claude/rules/patterns.md` § Batch operations is deliberately omitted —
 * a phase's tasks are a fixed positional set, not a bulk-mutated collection). `add` / `remove` / `move` /
 * `update` are the GATED mutation counterparts a
 * {@link PhaseInterface.add} / `remove` / `move` / `update` delegates to AFTER its own
 * container-status/hook gating — the manager gates ONLY on the target's OWN
 * existence/status/id/bounds and stays event-free (the entity emits on success).
 */
export interface TaskManagerInterface {
	readonly count: number
	/**
	 * Adds `task` at the end (the build-time wiring path).
	 *
	 * @remarks
	 * THROWS a `MUTATION` {@link import('./errors.js').WorkflowError} on a duplicate
	 * `id` (a genuine programmer error — a build-time wiring bug) instead of
	 * silently overwriting the existing entry.
	 *
	 * @param task - The live task to append
	 */
	append(task: TaskInterface): void
	/**
	 * Inserts `task` at `index` (default the end) — the GATED mutation counterpart to
	 * {@link append}: a duplicate `id` or an out-of-bounds `index` fails gracefully
	 * instead of throwing.
	 *
	 * @param task - The live task to insert
	 * @param index - The insertion position (`[0, count]`); omitted inserts at the end
	 * @returns A {@link Result} boxing the inserted task, or a `MUTATION` failure
	 */
	add(task: TaskInterface, index?: number): Result<TaskInterface, WorkflowError>
	/**
	 * Removes the `pending` task `id`.
	 *
	 * @param id - The task id to remove
	 * @returns A {@link Result} boxing the removed task, or a `MUTATION` failure when
	 *   `id` is absent or not `pending`
	 */
	remove(id: string): Result<TaskInterface, WorkflowError>
	/**
	 * Repositions the `pending` task `id` to `index`.
	 *
	 * @param id - The task id to move
	 * @param index - The destination position (`[0, count)`)
	 * @returns A {@link Result} boxing the moved task, or a `MUTATION` failure when `id`
	 *   is absent, not `pending`, or `index` is out of bounds
	 */
	move(id: string, index: number): Result<TaskInterface, WorkflowError>
	/**
	 * Applies a validated {@link TaskUpdate} patch to the `pending` task `id`.
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
 * Declares the lean child manager of a {@link WorkflowInterface}'s live phases —
 * positional accessors plus `count`, the phase analogue of {@link TaskManagerInterface}.
 *
 * @remarks
 * `append` adds one live {@link PhaseInterface} at the end; `phase(id)` looks one up;
 * `phases()` lists them in positional order; `count` is the tally. No batch matrix.
 * `add` / `remove` / `move` / `update` are the GATED mutation
 * counterparts a {@link WorkflowInterface.add} / `remove` / `move` / `update`
 * delegates to AFTER its own container-status/hook gating — the manager gates ONLY
 * on the target's OWN existence/status/id/bounds and stays event-free (the entity
 * emits on success).
 */
export interface PhaseManagerInterface {
	readonly count: number
	/**
	 * Adds `phase` at the end (the build-time wiring path).
	 *
	 * @remarks
	 * THROWS a `MUTATION` {@link import('./errors.js').WorkflowError} on a duplicate
	 * `id` (a genuine programmer error — a build-time wiring bug) instead of
	 * silently overwriting the existing entry.
	 *
	 * @param phase - The live phase to append
	 */
	append(phase: PhaseInterface): void
	/**
	 * Inserts `phase` at `index` (default the end) — the GATED mutation counterpart to
	 * {@link append}: a duplicate `id` or an out-of-bounds `index` fails gracefully
	 * instead of throwing.
	 *
	 * @param phase - The live phase to insert
	 * @param index - The insertion position (`[0, count]`); omitted inserts at the end
	 * @returns A {@link Result} boxing the inserted phase, or a `MUTATION` failure
	 */
	add(phase: PhaseInterface, index?: number): Result<PhaseInterface, WorkflowError>
	/**
	 * Removes the `pending` phase `id`.
	 *
	 * @param id - The phase id to remove
	 * @returns A {@link Result} boxing the removed phase, or a `MUTATION` failure when
	 *   `id` is absent or not `pending`
	 */
	remove(id: string): Result<PhaseInterface, WorkflowError>
	/**
	 * Repositions the `pending` phase `id` to `index`.
	 *
	 * @param id - The phase id to move
	 * @param index - The destination position (`[0, count)`)
	 * @returns A {@link Result} boxing the moved phase, or a `MUTATION` failure when
	 *   `id` is absent, not `pending`, or `index` is out of bounds
	 */
	move(id: string, index: number): Result<PhaseInterface, WorkflowError>
	/**
	 * Applies a validated {@link PhaseUpdate} patch to the `pending` phase `id`.
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
// is dispatched through its construction-resolved handler; only an omitted-`behavior` task
// auto-completes as a deliberate no-op.
// The `bail` policy maps onto the substrate Runner's fail-fast (`bail: true`) vs settle-all
// (`bail: false`). Abort / Timeout / Budget fold per run through `AbortSignal.any`, exactly as
// the agent runtime folds its bounds. Tool and agent adaptation remains outside core.

/**
 * Declares the registered behavior a `function`-form
 * {@link TaskDefinition} runs, resolved BY NAME through the {@link WorkflowRegistry}
 * registry — a function type the framework invokes.
 *
 * @remarks
 * Receives a {@link TaskControllerInterface} — the running task's folded `signal`, its
 * `input` (the task's `metadata` bag), its lineage {@link TaskContext}, and read-UP access
 * to earlier phases' {@link TaskResult}s. A returned value becomes the task's
 * {@link import('@orkestrel/contract').Success} ({@link TaskInterface.complete}); a throw / rejection
 * becomes its {@link import('@orkestrel/contract').Failure} ({@link TaskInterface.fail}). Long work
 * must honour `controller.signal` (a workflow-level abort / timeout / budget, or — under
 * `bail: true` — a sibling's failure, fires it) so a cancel stops it promptly.
 */
export type WorkflowFunction = (
	controller: TaskControllerInterface,
) => Promise<JSONValue> | JSONValue

/**
 * Declares the `function`-task behavior registry — workflow function names mapped to their
 * {@link WorkflowFunction} handlers.
 *
 * @remarks
 * A live {@link TaskInterface} resolves its `behavior` name against this registry ONCE at
 * construction into its {@link TaskInterface.handler}. An omitted `behavior` is the deliberate
 * no-op case. A present name absent from the registry remains inspectable but makes the tree
 * non-drivable until restored with a matching handler. A plain record (not a manager) — the
 * registry is a lookup, with no lifecycle of its own.
 */
export type WorkflowRegistry = Readonly<Record<string, WorkflowFunction>>

/**
 * Declares the per-task handle a {@link WorkflowFunction} receives — the running task's
 * cancellation, its input, its lineage, and read-UP access to the result tree.
 *
 * @remarks
 * A lean handle (NOT the runner `Controller` — it carries no `spawn`; a workflow task
 * is a leaf of the declarative tree, not a fan-out unit). It exposes:
 * - `signal` — this attempt's folded cancellation: its per-attempt deadline, task
 *   stop/skip, workflow abort/timeout/budget/destroy, or a sibling fail-fast.
 * - `aborted` — whether `signal` has fired.
 * - `input` — the task's `metadata` bag (the open consumer payload from its
 *   {@link TaskInput}); `{}` when none.
 * - `task` — the task's full {@link TaskContext} (so `task.phase` / `task.phase.workflow`
 *   navigate UP the lineage).
 * - `wait()` — a cooperative checkpoint for the workflow, phase, and task pause gates.
 * - `results()` — every settled task's {@link TaskResult} across already-finished phases,
 *   so a `function` task can read an earlier phase's output (the W-b result tree, read-only).
 */
export interface TaskControllerInterface {
	/** Fires on this attempt's deadline, task stop/skip, run cancellation, or sibling fail-fast. */
	readonly signal: AbortSignal
	readonly aborted: boolean
	/** Holds the task's open `metadata` bag (its {@link TaskInput} payload); `{}` when none. */
	readonly input: JSONRecord
	readonly task: TaskContext
	/** Reports the one-based persisted launch represented by this handle. */
	readonly attempt: number
	/** Reports whether the workflow, phase, or task cooperative gate is paused. */
	readonly paused: boolean
	/**
	 * Replaces this running task's complete observable activity.
	 *
	 * @param input - The complete operations, progress, and constraints replacement
	 * @returns The accepted frame, or a `TRANSITION` failure after ownership is lost or this attempt aborts
	 */
	report(input: TaskActivityInput): Result<TaskActivity, WorkflowError>
	/**
	 * Confirms liveness without replacing current activity.
	 *
	 * @returns True if the pulse was committed before ownership is lost or this attempt aborts; false otherwise
	 */
	pulse(): boolean
	/**
	 * Parks cooperatively while any workflow, phase, or task gate is paused, or until cancelled.
	 *
	 * @returns A promise that resolves when every applicable gate is open or the signal aborts
	 */
	wait(): Promise<void>
	/** Lists every settled task's result across already-finished phases — the result tree, read-only. */
	results(): readonly TaskResult[]
}

/**
 * Holds the phase {@link RunnerInterface} one {@link WorkflowRunnerInterface.execute} call is
 * driving, for the lifetime of that run.
 *
 * @remarks
 * Phases run sequentially, so one run drives at most one phase runner at a time: `hold(runner)`
 * takes the runner as a phase starts and `hold()` releases it as that phase settles, leaving
 * `runner` `undefined` between phases and after the last one. `runner` is a readonly projection
 * of the held state, so the swap goes through `hold` alone. A run-level cancel closes over the
 * holder rather than over a runner, so it aborts whichever phase runner is live when the cancel
 * fires rather than the one that was live when the listener was armed, and a fresh holder per
 * `execute` keeps a nested run from clobbering the suspended outer run's.
 */
export interface RunHolderInterface {
	/** Reports the phase runner this cell holds, or `undefined` between phases. */
	readonly runner: RunnerInterface<TaskInterface, void> | undefined
	/**
	 * Takes a phase runner for the phase that is starting, or releases the held one.
	 *
	 * @param runner - The phase runner to hold; omitted releases the held runner
	 */
	hold(runner?: RunnerInterface<TaskInterface, void>): void
}

/**
 * Names how one task attempt left the race between its handler and its cancellation.
 *
 * @remarks
 * The engine races a dispatched {@link WorkflowFunction} against the attempt's folded signal, so
 * the attempt either SETTLED with the handler's JSON value or did not settle at all. A tuple, not
 * a {@link Result}: the unsettled branch is a cancellation rather than an error, so there is no
 * error to carry, and `genuine` records what the cancellation was — `true` for a genuine cancel
 * (a run-level bound, a task `stop` / `skip`, or a sibling fail-fast, all of which skip the leaf),
 * `false` for a bare per-attempt timeout (a retryable failure of this attempt), and `undefined`
 * when the caller must re-read the discriminator itself. The engine reads the tuple positionally
 * at each of its own settlement points; it never crosses the published surface.
 */
export type AttemptOutcome =
	| readonly [settled: true, value: JSONValue]
	| readonly [settled: false, value: undefined, genuine?: boolean]

/**
 * Represents the structured outcome of a {@link WorkflowRunnerInterface.execute} run — the settled
 * live workflow, its final status, and the flattened result tree.
 *
 * @remarks
 * Boxes the settled {@link WorkflowInterface} itself (so a caller can navigate the whole
 * live tree — every phase / task's final `status`, its recorded {@link TaskResult}, its
 * lineage) ALONGSIDE the two read-throughs the run produced: `status` is the workflow's
 * derived {@link LifecycleStatus} at settle (`completed` under graceful mode even with
 * failed leaves; `failed` under `bail: true`; `stopped` on a workflow-level abort /
 * timeout / budget), and `results` is the workflow-tier {@link TaskResult} list (every
 * settled task across all phases, in positional order — the same array `workflow.results()`
 * yields). Returning the live `workflow` (not only a snapshot) keeps the entity tree the
 * source of truth — the runner adds only the convenience `status` / `results` projections.
 * A scheduler or other engine-infrastructure failure rejects after the runner coherently
 * stops remaining work and attempts final persistence.
 */
export interface WorkflowResult {
	readonly workflow: WorkflowInterface
	/** Holds the workflow's derived lifecycle status at settle. */
	readonly status: LifecycleStatus
	readonly results: readonly TaskResult[]
	/** Reports whether the returned final state is stored; omitted when no store was supplied. */
	readonly durable?: boolean
	/** Records the first required persistence failure; omitted when none occurred. */
	readonly fault?: WorkflowFault
}

/** Names a runner-owned durability boundary. */
export type WorkflowCheckpoint = 'initial' | 'attempt' | 'settlement' | 'final'

/** Represents a normalized persistence failure surfaced as workflow result data. */
export interface WorkflowFault {
	readonly checkpoint: WorkflowCheckpoint
	readonly message: string
	readonly task?: string
	readonly attempt?: number
}

/**
 * Declares the advanced run-local durability coordinator normally composed by
 * {@link WorkflowRunnerInterface.execute} when `store` is supplied.
 */
export interface WorkflowPersistenceInterface {
	/** Records the first required checkpoint failure, if one occurred. */
	readonly fault: WorkflowFault | undefined
	/**
	 * Makes the most recent state durable at one required boundary.
	 *
	 * @param checkpoint - The required durability boundary
	 * @param task - The task owning an attempt or settlement
	 * @param attempt - The persisted one-based attempt number
	 * @returns True if the most recent live state reached the store; false otherwise
	 */
	checkpoint(
		checkpoint: WorkflowCheckpoint,
		task?: TaskInterface,
		attempt?: number,
	): Promise<boolean>
	/** Detaches observers and makes the final live state durable. */
	finalize(): Promise<boolean>
	/** Stops observing the live workflow tree; idempotent. */
	detach(): void
}

/**
 * Declares the options for one {@link WorkflowRunnerInterface.execute} call — the live tree's
 * CONSTRUCTION options ({@link WorkflowOptions}) PLUS the per-run RUN CONTROLS: the bounds
 * (an external abort, a deadline, and a cost ceiling), each folded into every task's
 * cancellation, and the optional durable `store`.
 *
 * @remarks
 * `execute` is single-source: it BUILDS the live tree from the definition internally (through
 * {@link import('./factories.js').createWorkflow}), so these options carry BOTH halves of
 * that one call —
 * - the **construction** half is {@link WorkflowOptions} (`on` initial listeners, the `bail`
 *   override, the per-node `phases` bag); `execute` forwards it straight to `createWorkflow`,
 *   so construction-time emitter listeners, a `bail` override, and per-node options all apply
 *   to the tree it builds (`createWorkflow` resolves `bail` as `options.bail ?? definition.bail
 *   ?? DEFAULT_BAIL`); and
 * - the **run-control** half is the bounds and the `store` below; the bounds feed the run-level
 *   fold and the store makes the run durable.
 *
 * The three bounds compose through `AbortSignal.any` (exactly as the agent runtime folds its
 * own): a fire of ANY of them cancels every in-flight task (its
 * {@link TaskControllerInterface.signal} fires) and HALTS the run — the remaining tasks
 * and phases are `skip`ped and the workflow settles `stopped`.
 * - `signal` — an external cancellation (a caller `AbortController`).
 * - `timeout` — a whole-run deadline in milliseconds. A non-positive, non-finite, or
 *   over-`MAX_TIMER_MS` value means no deadline.
 * - `budget` — a whole-run cost ceiling (a {@link BudgetInterface} over {@link TokenUsage}
 *   — its `signal` fires when a task-reported usage crosses `max`); the runner folds its
 *   `signal` and `start`s it. (A `max: 0` budget is exhausted from its first `start`, so it
 *   cancels the run at entry — a DIFFERENT primitive from the `timeout: 0` "no deadline" case.)
 *
 * `store` is not a bound. Supplying a {@link WorkflowStoreInterface} makes the run DURABLE: the
 * runner composes a {@link WorkflowPersistenceInterface} over it and writes the live
 * {@link WorkflowSnapshot} at each required checkpoint — before the first phase, around every
 * attempt and settlement, and once more when the run finishes — so an interrupted run is
 * recoverable from the store through
 * {@link import('./factories.js').createRecoveredWorkflow}. It also adds the two durability
 * read-throughs to the result: {@link WorkflowResult.durable} reports whether the FINAL state
 * reached the store, and {@link WorkflowResult.fault} carries the first required write that
 * failed. Both are OMITTED without a store, because a run that was never asked to persist has
 * nothing to report. A required checkpoint that fails stops the run rather than continuing work
 * whose state is no longer recoverable. This half applies to BOTH `execute` overloads.
 */
export type WorkflowRunOptions = WorkflowOptions & {
	readonly signal?: AbortSignal
	readonly timeout?: number
	readonly budget?: BudgetInterface<TokenUsage>
	readonly store?: WorkflowStoreInterface
}

/**
 * Declares the options for `createWorkflowRunner` — the optional pacing scheduler the runner
 * paces phase boundaries with.
 *
 * @remarks
 * The runner is a PURE engine — it carries no `functions` / `tools` / `agents` registry
 * (each live task already resolved its own handler at construction from
 * {@link WorkflowOptions.functions}).
 * - `scheduler` — the {@link SchedulerInterface} that paces the tree (a cooperative
 *   `yield` between phases). Omitted ⇒ the shipped cross-environment default
 *   ({@link createScheduler}).
 *
 * The reserved `on` key is intentionally ABSENT: the runner is THIN and drives
 * the W-b entities' OWN emitters (subscribe through `workflow.emitter` / `phase.emitter` /
 * `task.emitter`), so it owns no event map of its own — there is nothing for an `on` to
 * wire. A future runner-level emitter would introduce its own `EmitterHooks` here.
 */
export interface WorkflowRunnerOptions {
	readonly scheduler?: SchedulerInterface
}

/**
 * Declares a thin orchestrator that EXECUTES a live {@link WorkflowInterface} tree by composing the
 * shipped substrate — phases sequential, tasks concurrent, each task dispatched through its
 * OWN resolved handler under the `bail` policy.
 *
 * @remarks
 * `execute(definition, options?)` BUILDS the live W-b entity tree from the definition itself
 * (through {@link import('./factories.js').createWorkflow}) and drives it to a terminal
 * {@link WorkflowResult} — phases SEQUENTIALLY and, within each phase, the tasks CONCURRENTLY
 * through ONE substrate {@link RunnerInterface} (concurrency =
 * the phase's {@link PhaseDefinition.concurrency}). The definition is the SINGLE source of
 * truth: the runner owns both the declarative state (the live tree it constructs) and the
 * EXECUTION-ONLY field the snapshot deliberately dropped — each task's `behavior` (resolved into
 * its {@link TaskInterface.handler} once at construction, against
 * {@link WorkflowOptions.functions}) and each phase's `concurrency` (so there is no
 * separately-supplied workflow to drift from the definition). The freshly-built live tree is
 * returned in {@link WorkflowResult.workflow}. The runner carries NO registry of its own — it
 * invokes each task's OWN {@link TaskInterface.handler}; an omitted `behavior` is the only
 * auto-completing no-op. The runner DRIVES the live entity (`start` → `complete` / `fail`), never
 * re-implementing status. The `bail` policy maps onto the substrate's fail-fast (`bail: true`
 * — the first failure aborts in-flight siblings and skips the rest) vs settle-all (`bail:
 * false` — failures are recorded and the run finishes). The {@link WorkflowOptions} half of
 * the options is forwarded to `createWorkflow` (initial listeners, a `bail` override,
 * per-node options, the `functions` registry); the Abort / Timeout / Budget bounds fold per
 * run through `AbortSignal.any`, halting the run and `stop`ping the workflow. A second
 * `execute(workflow, options?)` overload drives a CALLER-BUILT live tree instead — the
 * entity-native control surface (`pause` / `resume` / `add` / `stop` /
 * `destroy` live on {@link WorkflowInterface} itself); see its own doc for details.
 */
export interface WorkflowRunnerInterface {
	/**
	 * Executes a workflow definition to completion — BUILDS its live tree, runs the phases
	 * sequentially with each phase's tasks concurrent — resolving its terminal
	 * {@link WorkflowResult} (whose `workflow` is the freshly-built live tree).
	 *
	 * @remarks
	 * One-shot. The runner BUILDS the live tree from `definition` internally (one source of
	 * truth — the per-task `behavior` (resolved into its {@link TaskInterface.handler}) and per-phase
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
	 * **Programmer-error exception.** A PATHOLOGICAL `definition` (for example, a
	 * duplicate phase or task `id`) THROWS SYNCHRONOUSLY at construction — before any phase
	 * runs, and before the returned `Promise` is even created — rather than resolving a
	 * failed/partial {@link WorkflowResult}. Unexpected scheduler or engine-infrastructure
	 * failures may reject asynchronously after remaining work is stopped, swept, and final
	 * persistence is attempted. Neither case is a domain task outcome to disguise as a result.
	 *
	 * @param definition - The {@link WorkflowDefinition} to build the live tree from and drive
	 * @param options - The construction options ({@link WorkflowOptions}: `on` / `bail` /
	 *   `phases`) PLUS the per-run bounds (`signal` / `timeout` / `budget`) and the durable `store`
	 * @returns The run's terminal {@link WorkflowResult} (its `workflow` is the built tree)
	 */
	execute(definition: WorkflowDefinition, options?: WorkflowRunOptions): Promise<WorkflowResult>
	/**
	 * Drives an ALREADY-BUILT, CALLER-OWNED live {@link WorkflowInterface} — the
	 * ENTITY-NATIVE counterpart to the definition-building {@link execute} overload.
	 *
	 * @remarks
	 * The entity itself is the single control surface (no separate run handle):
	 * `createWorkflow` mints the live tree, this overload drives it, and the caller
	 * controls the SAME entity mid-run through its own `pause` / `resume` / `add` / `stop` /
	 * `destroy`. Requires `workflow.status === 'pending'`,
	 * `!workflow.destroyed`, and no prior execution claim. A process-local object-identity claim
	 * shared by every runner instance is acquired synchronously and never released, so a same-object
	 * call throws a `TRANSITION` {@link import('./errors.js').WorkflowError} even before an
	 * asynchronous status change. After acceptance, phases run
	 * SEQUENTIALLY and, within each phase, tasks CONCURRENTLY — byte-identical observable
	 * semantics to the `definition`-form `execute` — except the phase loop RE-READS the
	 * live `workflow.phases` / each phase's live `tasks` every iteration (a cursor over
	 * the live managers, not a one-time snapshot), so a caller's live `add` mid-run is
	 * picked up and actually dispatched. `workflow.pause()` gates the run at the next
	 * phase boundary AND before each task's dispatch (an in-flight task body is never
	 * suspended); `workflow.stop()` skips not-yet-started work gracefully; `workflow.destroy()`
	 * folds `workflow.signal` into the run's cancellation, aborting in-flight work
	 * immediately. `options` carries only the per-run RUN CONTROLS — the bounds (`signal` /
	 * `timeout` / `budget`) and the durable `store` — because the construction half of
	 * {@link WorkflowRunOptions} does not apply to a tree that already exists.
	 *
	 * **Run round-trips through the snapshot.** Driving a tree rebuilt by
	 * {@link import('./factories.js').createRestoredWorkflow} behaves according to whether a
	 * {@link WorkflowRegistry} registry was supplied at that build: WITH a registry,
	 * each task's `behavior` name is re-resolved against it, so a matched task carries a real
	 * handler and this overload actually DISPATCHES it, resuming real work. Without a registry,
	 * the persisted {@link TaskInterface.behavior} remains visible for inspection while `handler` is
	 * `undefined`, and this overload rejects the tree before dispatch. A quiescent recovered tree may contain
	 * terminal work plus pending work; a tree with any `running` leaf is not drivable.
	 *
	 * @param workflow - The live {@link WorkflowInterface} to drive (its own entity surface —
	 *   `pause` / `resume` / `add` / `stop` / `destroy` — is the caller's control seam)
	 * @param options - The per-run bounds (`signal` / `timeout` / `budget`) and the durable
	 *   `store`; the construction half of {@link WorkflowRunOptions} does not apply (the tree
	 *   already exists)
	 * @returns The run's terminal {@link WorkflowResult} (its `workflow` is the SAME entity passed in)
	 */
	execute(
		workflow: WorkflowInterface,
		options?: Omit<WorkflowRunOptions, keyof WorkflowOptions>,
	): Promise<WorkflowResult>
}

// === Manager (W-e — the store-backed registry seam plus the line's store standard)
//
// `WorkflowManager` is the additive registry tier mirroring the `@orkestrel/agent` line's
// `ConversationManager` / `WorkspaceManager`: an insertion-ordered `Map` keyed by workflow
// `id`, plus an optional durable `store` seam (`open` hydrates on a registry miss, `save`
// persists). UNLIKE the twins there is no `active` / `switch` pointer — nothing in the
// workflow domain renders "the current workflow" the way `AgentContext.build()` renders the
// active conversation/workspace, so carrying it would be a speculative extra.
// The workflow-specific nuance the twins don't have: the manager may carry a `functions`
// registry threaded into every create/restore. Without it, hydrated named work remains an
// inspectable exact state mirror and the runner refuses execution.

/**
 * Declares the options for `createWorkflowManager` — the optional durable {@link WorkflowStoreInterface}
 * seam plus the {@link WorkflowRegistry} registry every workflow the manager mints or
 * hydrates resolves its tasks' handlers against.
 *
 * @remarks
 * `store` is the EXACT analogue of `ConversationManagerOptions.store` /
 * `WorkspaceManagerOptions.store` (the `@orkestrel/agent` line's store standard) — omitted ⇒
 * the manager is registry-only: {@link WorkflowManagerInterface.open} resolves only what is
 * already registered, and {@link WorkflowManagerInterface.save} is a no-op (`false`). `functions`
 * is the workflow-specific addition: the SAME {@link WorkflowRegistry} registry threaded into
 * every {@link import('./factories.js').createWorkflow} ({@link WorkflowManagerInterface.add})
 * and every {@link import('./factories.js').createRestoredWorkflow}
 * ({@link WorkflowManagerInterface.open}'s hydration path) the manager performs — so a
 * hydrated workflow carries real resolved `handler`s and is RUNNABLE. Omitted ⇒ named work
 * remains inspectable but cannot be driven; omitted-`behavior` tasks remain deliberate no-ops.
 */
export interface WorkflowManagerOptions {
	/**
	 * Holds the optional durable {@link WorkflowStoreInterface} backing
	 * {@link WorkflowManagerInterface.open} / {@link WorkflowManagerInterface.save} — a memory
	 * / JSON / SQLite / IndexedDB store a workflow is HYDRATED from (`open` a registry miss)
	 * and PERSISTED to (`save`). Omitted ⇒ the manager is registry-only: `open` resolves only
	 * what is already registered, and `save` is a no-op (`false`).
	 */
	readonly store?: WorkflowStoreInterface
	/**
	 * Holds the {@link WorkflowRegistry} registry threaded into every workflow this manager mints
	 * (`add`, through {@link import('./factories.js').createWorkflow}) or hydrates (`open`'s
	 * registry-miss path, through {@link import('./factories.js').createRestoredWorkflow}) — so a
	 * hydrated workflow is RUNNABLE, its tasks carrying real resolved `handler`s. Omitted ⇒
	 * named tasks remain inspectable but execution rejects them.
	 */
	readonly functions?: WorkflowRegistry
}

/**
 * Declares a store-backed registry of {@link WorkflowInterface}s keyed by their `id`, in insertion
 * order — the additive manager tier mirroring `ConversationManagerInterface` /
 * `WorkspaceManagerInterface` from the `@orkestrel/agent` line, adapted for the workflow
 * domain: `add` mints from a {@link WorkflowDefinition} (not an empty `Input`, because a
 * workflow only exists relative to a definition), and the optional `store` seam's `open`
 * threads the manager's {@link WorkflowRegistry} registry so a HYDRATED workflow is
 * immediately RUNNABLE, not merely a restored state mirror. NO `active` / `switch` pointer
 * — the workflow domain has no consumer that renders "the current workflow" the
 * way an agent context renders the active conversation/workspace.
 *
 * @remarks
 * - **Registry.** `count` is how many are stored. `add(definition)` mints a live
 *   {@link WorkflowInterface} through {@link import('./factories.js').createWorkflow} (flowing
 *   this manager's `functions` registry in) and registers it under `definition.id` — an
 *   already-present id OVERWRITES (last write wins, because `createWorkflow` keys the tree by
 *   the definition's own id). `workflow(id)` looks one up (`undefined` when absent);
 *   `workflows()` lists them in insertion order.
 * - **Durable open / save (the optional `store` seam).** When a {@link WorkflowStoreInterface}
 *   is supplied (the `store` option), `open(id)` resolves an already-registered workflow
 *   directly (no store hit); same-id registry misses share one in-flight hydration. On a MISS
 *   it HYDRATES one from `store.get(id)` through
 *   {@link import('./factories.js').createRestoredWorkflow} — flowing this manager's `functions`
 *   registry in so the rehydrated tree is RUNNABLE — registers it, and returns it. Registry
 *   mutation wins over an earlier pending hydration: `add` supplies the live result, while
 *   `remove` (even for an absent id) and `clear` invalidate the earlier read. Missed and failed
 *   reads leave no stale in-flight entry, and a payload whose own id differs from the requested
 *   key rejects with `RESTORE` instead of registering under either id. `save(id)` captures a
 *   registered workflow's {@link WorkflowInterface.snapshot} at invocation, then PERSISTS it.
 *   Same-id writes run serially in invocation order; different ids remain independent, and an
 *   earlier rejection reaches its caller without preventing a later queued write. Both are
 *   LENIENT without a store — `open` resolves only registered ids, `save` is a no-op
 *   (`false`) — never a throw. The EXACT analogue of
 *   `ConversationManagerInterface.open` / `.save` and `WorkspaceManagerInterface.open` /
 *   `.save` — this is the workflow line's caller-driven persistence gaining the standard
 *   open/save seam, ADDITIVE alongside direct {@link WorkflowStoreInterface} use and
 *   {@link import('./factories.js').createRestoredWorkflow} (both remain valid).
 * - **Removal.** `remove` drops one by id, or a batch (array overload FIRST) — `true` only
 *   when every id was removed. `clear` empties the registry.
 * - **Event-free.** A purely registry store — no `Emitter`, no events (each
 *   {@link WorkflowInterface} owns its own {@link WorkflowEventMap} emitter).
 *
 * @example
 * ```ts
 * import { createWorkflowManager } from '@orkestrel/workflow'
 *
 * const manager = createWorkflowManager({
 * 	functions: { compile: async (controller) => `built ${controller.task.id}` },
 * })
 * const workflow = manager.add(definition) // minted, registered, RUNNABLE (functions flow in)
 * manager.count // 1
 * ```
 */
export interface WorkflowManagerInterface {
	readonly count: number
	workflow(id: string): WorkflowInterface | undefined
	workflows(): readonly WorkflowInterface[]
	/**
	 * Mints a live {@link WorkflowInterface} from `definition` (through
	 * {@link import('./factories.js').createWorkflow}, flowing this manager's `functions`
	 * registry in) and register it under `definition.id`.
	 *
	 * @remarks
	 * An already-registered `definition.id` OVERWRITES (last write wins) — `createWorkflow`
	 * keys the live tree by the definition's own id, so a re-`add` under the same id is
	 * indistinguishable from a fresh mint at the registry level.
	 *
	 * @param definition - The {@link WorkflowDefinition} to build the live tree from
	 * @returns The minted, registered {@link WorkflowInterface}
	 */
	add(definition: WorkflowDefinition): WorkflowInterface
	/**
	 * Resolves a workflow by id — from the registry if present, else HYDRATED from the
	 * optional {@link WorkflowStoreInterface} (`store`), RUNNABLE (this manager's `functions`
	 * registry is threaded into the rehydration).
	 *
	 * @remarks
	 * - If `id` is ALREADY registered, it is returned directly — no store hit.
	 * - Same-id registry misses share one in-flight `store.get(id)` and resolve to the same live
	 *   object. On a HIT the snapshot is
	 *   rehydrated into a fresh {@link WorkflowInterface} through
	 *   {@link import('./factories.js').createRestoredWorkflow}, flowing this manager's `functions`
	 *   registry in (so the rehydrated tree carries real resolved `handler`s and can RESUME
	 *   real work), registers it, and returns it. A payload whose own id differs from `id` rejects
	 *   with a normalized `RESTORE` error carrying the requested and payload ids.
	 * - Registry mutation after the store read starts has precedence: `add(definition)` for the
	 *   same id wins and becomes every pending caller's result; `remove(id)` invalidates that read
	 *   even when the id was absent; `clear()` invalidates every earlier read. A miss or rejection
	 *   clears the in-flight entry so a later call retries.
	 * - Else (no store, or a store MISS) ⇒ `undefined` (lenient — no throw).
	 *
	 * @param id - The workflow id to open
	 * @returns The resolved, RUNNABLE {@link WorkflowInterface}, or `undefined` when neither registered nor stored
	 */
	open(id: string): Promise<WorkflowInterface | undefined>
	/**
	 * Persists a REGISTERED workflow's {@link WorkflowInterface.snapshot} to the optional
	 * {@link WorkflowStoreInterface} (`store`).
	 *
	 * @remarks
	 * When a `store` is set AND `id` is registered, the snapshot is captured synchronously at
	 * invocation. Same-id `store.set` calls are serialized in invocation order; different ids are
	 * independent. A rejected write reaches that caller unchanged but does not poison a later
	 * queued write. Otherwise (no store, OR an unknown id) it is a NO-OP returning `false`.
	 *
	 * @param id - The id of the registered workflow to persist
	 * @returns True if the snapshot was persisted; false otherwise (no store, or an unknown id)
	 */
	save(id: string): Promise<boolean>
	/**
	 * Drops a batch of registered workflows, one per id.
	 *
	 * @remarks
	 * The array overload is declared FIRST, so a list resolves to the batch form. Every id is
	 * invalidated whether or not it was registered, so an absent id changes nothing else. An
	 * empty list returns `true` vacuously — no id failed to be removed.
	 *
	 * @param ids - The workflow ids to drop
	 * @returns True if every id was removed; false if any id was not registered
	 */
	remove(ids: readonly string[]): boolean
	/**
	 * Drops one registered workflow by id.
	 *
	 * @param id - The workflow id to drop
	 * @returns True if the id was registered and removed; false otherwise
	 */
	remove(id: string): boolean
	clear(): void
}

/**
 * Names the relative urgency hint for cooperative scheduling. Honoured by environment
 * backends; the cross-environment default treats all priorities uniformly.
 */
export type SchedulerPriority = 'user' | 'normal' | 'background'

/** Declares the options for a single cooperative yield/delay. */
export interface SchedulerOptions {
	/**
	 * Carries a relative urgency hint. Honoured by environment backends; the
	 * cross-environment default treats all priorities the same.
	 */
	readonly priority?: SchedulerPriority
	/** Carries a signal whose abort rejects a pending yield/delay with its `reason`. */
	readonly signal?: AbortSignal
}

/**
 * Declares a cooperative host-yield primitive: a loop decides WHAT to do; the scheduler
 * decides WHEN the host regains control. Abort-aware — a pending yield/delay
 * rejects with the signal's reason when aborted.
 */
export interface SchedulerInterface {
	/**
	 * Yields control back to the host so other tasks (I/O, timers, rendering) can
	 * run, then resumes.
	 */
	yield(options?: SchedulerOptions): Promise<void>
	/** Resumes after at least `ms` milliseconds. */
	delay(ms: number, options?: SchedulerOptions): Promise<void>
}

/**
 * Declares the push observation surface of a {@link RunnerInterface} — the run
 * lifecycle a fire-and-forget observer (logging, metrics, tracing) subscribes to,
 * ALONGSIDE the eventual `execute` result.
 *
 * @typeParam TResult - The value a unit resolves; the `finish` payload is the run's ordered
 *   `readonly TResult[]`, so the map is `RunnerEventMap<TResult>` — mirroring how the
 *   {@link RunnerInterface} is generic.
 *
 * @remarks
 * Listener isolation is the emitter's: every event is emitted directly and a
 * listener throw is routed to the emitter's OWN `error` handler (the `error` option), never
 * onto this domain map and never into the one-shot / fail-fast / spawn-tracking engine — so a
 * buggy observer can never reorder, throw into, or corrupt the run. Every emit sits AFTER the
 * relevant unit-launch / settle / drain transition, so a throwing observer cannot unbalance
 * the outstanding-unit count gate or break fail-fast. Subscribe through `runner.emitter.on(...)`.
 *
 * Declared as a `type` alias (not `interface extends EventMap` — `EventMap` is a
 * `type` kind): a type-literal satisfies the `EventMap` constraint
 * (`Record<string, readonly unknown[]>`) structurally, whereas an interface lacks the
 * required index signature.
 */
export type RunnerEventMap<TResult> = {
	/** Signals that `execute` began — emitted once at the top of a non-empty run. */
	readonly start: readonly []
	/** Signals that a unit's handler began running — the unit's id (declared or spawned). */
	readonly unit: readonly [id: string]
	/** Signals that a sub-unit was spawned — its id + the spawning parent's id (when known). */
	readonly spawn: readonly [id: string, parent: string | undefined]
	/** Signals that a unit completed successfully — its id (after its outcome was recorded). */
	readonly settle: readonly [id: string]
	/** Signals that a unit failed — its id + the error (always `unknown`). */
	readonly fail: readonly [id: string, error: unknown]
	/** Signals that the batch settled — the run's ordered results (the same array `execute` resolves). */
	readonly finish: readonly [results: readonly TResult[]]
	/** Signals that the run was aborted (fail-fast, a user `abort`, or `destroy`) — the cancel reason. */
	readonly abort: readonly [reason: unknown]
}

/**
 * Declares the per-unit handle a {@link RunnerHandler} receives — the running unit's
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
	 * Parks until this unit's `signal` aborts — **promise-parked**, never a timer.
	 *
	 * @remarks
	 * Resolves the moment the unit's `signal` fires (unit abort, runner abort, or
	 * timeout) and resolves immediately if it has already fired. It registers a
	 * one-shot `'abort'` listener and never polls — no `setTimeout`, no `delay`, no
	 * busy-yield — so a parked unit consumes no CPU until it is actually cancelled.
	 *
	 * @returns A promise that resolves after the unit's `signal` aborts
	 */
	wait(): Promise<void>
	/**
	 * Adds a sibling unit to the run; returns its result promise.
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
	 * Cancels this unit — fires its `signal` with the optional reason.
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
 * Declares the per-entry reliability OVERRIDES for one unit — its extra attempts on failure and its
 * per-attempt deadline, resolved from the unit's input through {@link RunnerOptions.entries}.
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
 * Declares the options for `createRunner`.
 *
 * @remarks
 * - `handler` — runs each unit's work against its {@link ControllerInterface};
 *   rejecting fails the unit (and, after retries are exhausted, fails the run).
 * - `concurrency` — the maximum units in flight at once; defaults to `1` (ordered,
 *   one-at-a-time) and must be a positive safe integer.
 * - `retries` — the default extra attempts per unit on failure (or a per-attempt
 *   timeout); defaults to `0` and must be a nonnegative safe integer.
 * - `timeout` — the per-attempt deadline in milliseconds; defaults to `0`, must be
 *   an integer in `0..2_147_483_647`, and `0` disables the deadline.
 * - `entries` — per-entry `retries` / `timeout` overrides, resolved from each
 *   input; falls back to the runner-level `retries` / `timeout` defaults.
 * - `on` — the reserved {@link EmitterHooks} key: initial listeners for the runner's
 *   {@link RunnerEventMap}, wired at construction (for example, `{ finish: (r) => log(r) }`).
 */
export interface RunnerOptions<TInput, TResult> {
	readonly on?: EmitterHooks<RunnerEventMap<TResult>>
	/** Holds the emitter's listener-error handler — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	readonly handler: RunnerHandler<TInput, TResult>
	readonly concurrency?: number
	readonly retries?: number
	readonly timeout?: number
	/** Resolves per-entry `retries` / `timeout` overrides from each input; falls back to the runner-level defaults. */
	readonly entries?: (input: TInput) => RunnerEntryOptions
}

/**
 * Represents one unit the {@link RunnerInterface} is tracking: the queue payload it was enqueued
 * with — its `id` (a random UUID) keys it in the runner's ordered launch list and value
 * map, and `input` is the unit's work payload handed to the handler's `Controller`.
 *
 * @remarks
 * The runner's internal bookkeeping shape, published through the barrel because
 * `.claude/rules/architecture.md` § Centralized-file pattern centralizes every file-local type —
 * declared or spawned, every unit flows through the
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
 * Declares a thin generic orchestrator that drives declared units — plus any they `spawn` —
 * through a bounded-concurrency queue, collecting their results in order.
 *
 * @remarks
 * One-shot: `execute` runs the unit set once and resolves their results. A `Runner`
 * does not reimplement concurrency or retries — it composes the workers `Queue`
 * (the backpressure + retry + timeout engine), routing every unit (declared and
 * spawned) through it so spawned work actually runs.
 *
 * Exposes a typed {@link emitter} carrying its run lifecycle moments
 * ({@link RunnerEventMap}) for fire-and-forget observers, ALONGSIDE the eventual `execute`
 * result. Emitting is observation-only — every event fires AFTER the relevant unit-launch /
 * settle / drain transition, so a buggy observer can never reorder or corrupt the one-shot /
 * fail-fast / spawn-tracking engine: the emitter isolates a listener throw and routes it to
 * its `error` handler (the `error` option), never the run. Subscribe through
 * `runner.emitter.on(...)`.
 *
 * @typeParam TInput - The unit's work input
 * @typeParam TResult - The value a unit resolves
 */
export interface RunnerInterface<TInput, TResult> {
	readonly emitter: EmitterInterface<RunnerEventMap<TResult>>
	readonly active: number
	readonly stopped: boolean
	/** Reports whether the runner is paused (resumable, no new dispatch); rides the backing queue's own `paused`. */
	readonly paused: boolean
	/**
	 * Runs all `inputs` — and anything they `spawn` — to completion; resolves their
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
	 * Injects one more unit into an IN-FLIGHT `execute` run — a LIVE counterpart to a
	 * `Controller.spawn`, called from OUTSIDE any unit's handler (the seam a live
	 * `running` {@link PhaseInterface}'s `add` event lets a subscribed run offer a newly
	 * added task to the SAME execution substrate).
	 *
	 * @remarks
	 * Returns `undefined` synchronously (graceful, non-throwing) when the
	 * runner is not mid-`execute`, or the run has already fully drained — the
	 * caller reads `undefined` as "not accepted". Otherwise the unit is routed through
	 * the SAME backing queue as a declared/`spawn`ed unit (the runner's
	 * outstanding-unit count gate keeps the in-flight `execute` awaiting it) and emits
	 * the {@link RunnerEventMap.spawn} event; its result promise resolves after the unit
	 * settles.
	 *
	 * @param input - The unit's work payload
	 * @returns The unit's result promise, or `undefined` when no in-flight run can accept it
	 */
	spawn(input: TInput): Promise<TResult> | undefined
	/**
	 * Cancels every in-flight + pending unit (and the backing queue), making a running
	 * `execute` reject.
	 *
	 * @param reason - An optional cancellation reason propagated to every unit's signal
	 * @returns The stable cleanup barrier
	 */
	abort(reason?: unknown): Promise<void>
	/**
	 * Suspends dispatch (resumable): the backing queue holds the NEXT dispatch
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
	 * Continues a paused runner; idempotent.
	 *
	 * @example
	 * ```ts
	 * runner.resume()
	 * runner.paused // false
	 * ```
	 */
	resume(): void
	/**
	 * Ends the runner permanently — a GRACEFUL stop: no further unit is
	 * dispatched, but every already-in-flight unit runs to completion and settles
	 * normally. A never-dispatched (still-pending) unit is rejected by the backing queue
	 * and is NOT recorded as a failure (it never trips fail-fast); a genuine in-flight
	 * failure still is. `execute`'s promise RESOLVES (never rejects) after every unit has
	 * settled, with whatever results actually completed. Idempotent.
	 *
	 * @example
	 * ```ts
	 * const runner = createRunner({ handler: (c) => c.input, concurrency: 1 })
	 * const results = runner.execute([1, 2, 3])
	 * runner.stop() // the in-flight unit finishes; the rest are gracefully dropped
	 * await results // resolves with whatever settled — never rejects
	 * ```
	 * @returns The stable graceful-cleanup barrier
	 */
	stop(): Promise<void>
	/**
	 * Tears the runner down, awaiting backing-queue cleanup before destroying the emitter last.
	 *
	 * @returns The stable teardown barrier
	 */
	destroy(): Promise<void>
}
