# Supervised Workflow over MCP

**Status:** proposal. Nothing described here ships from this repository, or from any sibling package, today. `@orkestrel/supervisor` does not exist; every type, factory, adapter, and behavior below is proposed, not implemented.
**Evidence date:** 2026-07-31
**Binding decisions:** `tmp/verdict.md` — the orchestrator's reconciliation of two independent adversarial rounds. This document implements those rulings; it does not reopen them.
**Objective:** make `@orkestrel/workflow` a durable standalone workflow engine that an MCP server exposes through one conceptual `supervisor` tool, so Claude Code, Codex, Cursor, and other capable clients can start and control long-running work without owning the execution process — and give that server one package, `@orkestrel/supervisor`, that owns the fenced record every external effect is joined to.

The primary product is Workflow projected through MCP. Workflow is authoritative for logical execution and its snapshot. `@orkestrel/supervisor` is authoritative for the fenced record, executors, journals, and process trees. It is a native-aware adapter over installed provider harnesses — never a replacement for them, and never a reimplementation of their session, approval, recovery, or process capabilities.

## Failure modes this proposal closes

- A client disconnects after launch and accidentally owns or kills the run.
- A tool call blocks until the whole workflow finishes instead of promptly returning a durable handle.
- Workflow snapshots, MCP task state, notifications, provider sessions, and process state each claim to be authoritative.
- Reconnect relies on a lossy event stream rather than an authoritative state read.
- Cancellation is reported as termination before an external provider process actually exits.
- Provider continuation is confused with `Task.resume()`, which only opens a live cooperative pause gate.
- Two restorers launch the same pending attempt after a crash.
- A recovery pass spends retry budget on an attempt whose external unit is still alive and re-attachable.
- A timed-out attempt leaves an uncooperative external unit alive while a later attempt starts a second one, and nothing records both.
- A required persistence write never settles and strands execution indefinitely.
- An integration invents Tool adapters, Workflow error codes, or client capabilities that do not exist.

## Reconciled position

Four owners, four authorities, no overlap.

1. **Workflow** remains the host-independent logical-execution and snapshot authority. It is **not amended** by this proposal — no `claim` field, no `stake()` checkpoint, no new `TaskSnapshot` member. The join key it already publishes is sufficient.
2. **`@orkestrel/supervisor`** owns the fenced record: epochs and leases, per-attempt units, native identities, bounded redacted journals, executors, and the process trees it launched.
3. **The application** owns policy: authorization, which executors are enabled, journal retention, tenant binding, and workspace selection.
4. **MCP** owns protocol negotiation and projection, using the existing generic Tool primitives rather than adding Tool behavior to Workflow.

The MCP server process owns continued execution; the calling client receives a durable handle and may disconnect. Installed provider harnesses retain authority over their own sessions, approvals, turns, and native recovery.

### Why workflow is not amended

`TaskSnapshot.attempts` is documented "never reset by recovery" (`src/core/types.ts:443`), and the runner's required `'attempt'` checkpoint resolves before the handler is constructed. At the instant any irreversible effect becomes possible, `(workflow.id, phase.id, task.id, attempts)` is already durable, already unique for that launch, and already derivable inside a handler from `controller.task.phase.workflow.id`, `controller.task.phase.id`, `controller.task.id`, and `controller.attempt` — with zero API growth. The phase is not optional in that key: a task id is only "Unique task id within its phase" (`src/core/shapers.ts:37`), and workflow's own suite builds three phases each holding a task with id `'t'` (`tests/src/core/phases/PhaseManager.test.ts:13-15`), so a three-part key would collide two concurrent tasks onto one row. `TaskContext.phase` already carries the lineage (`src/core/types.ts:145-147`), so the fourth component costs nothing. `WorkflowStoreInterface.set` is a blind whole-snapshot upsert with no revision and no compare-and-set, so nothing inside workflow could fence a claim written there; a claim field would tell a second restorer that a unit is re-attachable while the first restorer still holds it. And one replaceable claim slot is structurally incapable of holding both a timed-out attempt's still-live unit and a later attempt's new one. A per-attempt unit registry can. That registry is `@orkestrel/supervisor`.

If a future consumer ever forces executor-written per-attempt identity into workflow, it ships as `readonly handle?: JSONRecord` on `TaskOperation`, written through the existing `report` path — one field family, one mechanism, no new checkpoint member, no boolean that must lie.

### Rejected placements

| Placement                                                                    | Decision | Reason                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow depends on Tool, MCP, or Supervisor                                 | Reject   | It would break the host-independent core boundary and invert the composition direction.                                                                                         |
| Workflow gains a durable executor-written claim                              | Reject   | Nothing inside workflow can fence a blind whole-snapshot upsert, and one claim slot cannot hold two concurrent attempts.                                                        |
| Tool owns Workflow runtime or provider supervision                           | Reject   | Tool 0.0.8 supplies generic definitions, a total call-envelope guard, invocation, and registry primitives; it neither validates arguments against schemas nor adapts providers. |
| Agent core owns subprocess supervision                                       | Reject   | Agent is an inference/conversation runtime; process trees and MCP service lifetime are different responsibilities.                                                              |
| A package named `harness`                                                    | Reject   | The provider products are harnesses; the name makes every authority sentence ambiguous.                                                                                         |
| A separate lease package before a second consumer                            | Reject   | The lease lives in its own supervisor module behind its own contract, so later extraction is mechanical. It is not a package until something else needs it.                     |
| `@orkestrel/agent` or `@orkestrel/terminal` on supervisor's dependency edges | Reject   | Those executors are composed where those dependencies already live. Supervising a CLI must not install an inference runtime.                                                    |
| Supervisor replaces native provider harnesses                                | Reject   | It would discard stronger session, approval, recovery, and supervision semantics already owned upstream.                                                                        |
| An empty package created before a real consumer                              | Reject   | The first package boundary must be justified by working MCP/provider composition and tests.                                                                                     |

## Current Workflow guarantees and limits

Grounded in current local source, types, guide, and real tests — not in planned API assumptions.

| Current guarantee                                                                          | Consequence                                                                                                           |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| JSON `Workflow → Phase → Task` definitions; named functions resolve once into handlers     | MCP can persist and validate definitions without serializing behavior.                                                |
| Sequential phases, concurrent tasks, optional phase concurrency and bail policy            | The server can expose deterministic structure without inventing a DAG.                                                |
| Live pause/resume/stop, task activity, events, folded signals, deadlines, retries          | MCP controls can project existing mechanisms rather than duplicating them.                                            |
| Owned exact-JSON snapshots, restore, explicit recovery, consumed attempts                  | A reconnect can inspect authoritative durable state; recovery never silently replenishes retries.                     |
| `TaskSnapshot.attempts` never reset by recovery, and a task id is unique within its phase  | `(workflow.id, phase.id, task.id, attempts)` is a durable, unique, already-published join key for one launch.         |
| Initial, attempt, settlement, and final persistence checkpoints with one coalesced writer  | Handler dispatch follows a required durable attempt checkpoint; distributed fencing belongs to the supervisor record. |
| `WorkflowStoreInterface.set` is a blind whole-snapshot upsert with no revision             | Workflow cannot fence itself. A lease must live outside it, over a store that has compare-and-set semantics.          |
| Same-object execution claim through a process-local `WeakSet`                              | One object cannot be driven twice locally, but distributed duplicate launch is still possible.                        |
| Pending and recovered-retryable tasks omit old activity                                    | A recovered attempt cannot present stale activity as current work.                                                    |
| `recoverWorkflowSnapshot` demotes retryable `running` to `pending` and fails the exhausted | Applying recovery before the supervisor reconciles its record spends budget on a possibly re-attachable attempt.      |

Hardening cannot provide distributed exclusivity, provider idempotency, operating-system process termination, remote authorization, or cancellation of an arbitrary never-settling store Promise. Those are explicit integration responsibilities. In particular, adding a Promise timeout would not cancel a late backend write and could permit stale data to arrive out of order.

## Proposed ownership

| Owner                               | Owns                                                                                                                             | Does not own                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Workflow                            | definitions, live entities, runner, activity, snapshots, restore/recovery, store contract                                        | Tool schemas, MCP messages, provider protocols, subprocesses, leases             |
| Supervisor core                     | leases and epochs, per-attempt units, native identities, journal, executor contract, the function executor, the workflow adapter | inference runtimes, terminals, MCP messages, authorization, retention policy     |
| Supervisor server                   | the provider executor, provider adapters, launched process trees, stream framing                                                 | provider session semantics, approval policy, credential handling                 |
| Tool                                | generic definitions, total call-envelope guard, invocation, registry                                                             | schema-based argument validation, Workflow lifecycle policy, provider adapters   |
| MCP composition                     | the conceptual `supervisor` tool, generic MCP tasks/progress, session/transport projection, authorization                        | Workflow engine internals, supervisor record internals, client terminal lifetime |
| Application                         | executor enablement, authorization, tenant/workspace binding, journal retention, the agent and human executors                   | the fenced record, provider protocols, the workflow engine                       |
| Database + SQLite/IndexedDB drivers | atomic durable storage through existing driver and transaction seams                                                             | Workflow recovery policy, supervisor recovery policy                             |
| Provider native harness             | provider session/turn lifecycle, native approvals/input, native reconnect/recovery                                               | Workflow's logical task and durable snapshot authority                           |

Dependency direction:

```text
Workflow ← Supervisor core → Contract
    ↑           ↓
    └── MCP composition → Tool
                ↓
Supervisor server → provider-native protocols + Node process APIs
                ↓
Database → SQLite (server, leases possible) or IndexedDB (browser, leases impossible)

Application → Supervisor + Agent      (the agent executor)
Application → Supervisor + Terminal   (the human executor)
```

Workflow must not import Tool, MCP, Terminal, Agent, or Supervisor. Supervisor must not import Tool, MCP, Agent, or Terminal. Browser and server implementations remain disjoint; provider processes and MCP service lifetime are server/application concerns.

## `@orkestrel/supervisor` — the proposed type surface

One published package with a `core` and a `server` environment. The lease lives in its own core module behind its own contract, so a later extraction is mechanical rather than a rewrite. Every type below is proposed; none exists.

### Identity and the fenced record

```ts
/**
 * The durable join key for one launch — exactly workflow's own
 * `(workflow.id, phase.id, task.id, attempts)`. `phase` is required because a task id is
 * unique only within its phase.
 */
export interface UnitContext {
	readonly workflow: string
	readonly phase: string
	readonly task: string
	readonly attempt: number
}

/** The fence a supervisor process holds over one workflow id. */
export interface Lease {
	readonly id: string
	readonly owner: string
	readonly epoch: number
	readonly expiry: number
}

/** How a reconciled unit is to be resumed — the three outcomes, never two. */
export type RecoveryMode = 'reattach' | 'relaunch' | 'quarantine'

/**
 * What every durable per-attempt row carries whatever its status — one row per launch,
 * never one replaceable slot per task.
 */
export interface UnitRecord {
	/**
	 * The correlation token: a pure derivation of `context`, committed in the intent row
	 * before any effect is possible, and handed to the executor so a provider can echo it.
	 * It is the only address this unit has inside the indeterminate interval.
	 */
	readonly id: string
	readonly context: UnitContext
	readonly executor: string
	readonly epoch: number
	readonly revision: number
	readonly payload: JSONRecord
	/** The provider-minted native identity; absent until the identity commit lands. */
	readonly identity?: string
	readonly created: number
	readonly updated: number
}

/** Launched, with no terminal external outcome yet. Intent-without-launch is an absent `identity`. */
export interface RunningUnit extends UnitRecord {
	readonly status: 'running'
}

/** The external outcome is durable, so it is always present. */
export interface SettledUnit extends UnitRecord {
	readonly status: 'settled'
	/** The terminal external outcome, reusing workflow's JSON-safe failure shape. */
	readonly result: Result<JSONValue, TaskFailure>
}

/** The launch outcome is undeterminable, so a reason is always present. Terminal, never a retry. */
export interface QuarantinedUnit extends UnitRecord {
	readonly status: 'quarantined'
	readonly reason: string
}

/** The durable per-attempt row, discriminated on the status axis. */
export type UnitSnapshot = RunningUnit | SettledUnit | QuarantinedUnit

/** A unit's live mode — derived from the row union, never declared twice. */
export type UnitStatus = UnitSnapshot['status']

/** The whole durable record for one workflow id — the lease plus every attempt it ever authorized. */
export interface RunSnapshot {
	readonly id: string
	readonly lease: Lease
	readonly units: readonly UnitSnapshot[]
}
```

A `UnitSnapshot` is a union on `status`, not a bag of optional fields, because the three statuses carry genuinely different data: only a settled unit has a `result`, only a quarantined unit has a `reason`, and a running unit has neither. A flat shape would admit `settled` with no outcome and `quarantined` with no reason — states the record must be incapable of expressing.

Two units of the same `(workflow, phase, task)` that carry the **same** `identity` are a reattachment; two that carry **different** identities are two external effects. Nothing else needs to be stored to say so. What the record therefore proves is narrower than "no duplicate external unit": it proves that **no duplicate is unrecorded** — every launch the supervisor authorized is countable, every recorded identity is attributable to exactly one authorized launch, and the count of distinct identities can never exceed the count of authorized launches. It cannot prove that no duplicate external effect exists, because an effect accepted inside the indeterminate interval below may never be recorded at all. Detectable and bounded is the guarantee; exactly-once is not.

### Observations and the journal

```ts
/** What was observed. Names its axis; never `kind` or `type`. */
export type ObservationCategory = 'identity' | 'activity' | 'request' | 'settlement' | 'diagnostic'

/** One bounded, redacted, JSON-serializable thing an executor saw. */
export interface Observation {
	readonly id: string
	readonly sequence: number
	readonly timestamp: number
	readonly category: ObservationCategory
	/** Redacted human-facing text, capped in bytes. */
	readonly note?: string
	/** Commands run and files changed — workflow's own milestone type, not a new one. */
	readonly operations?: readonly TaskOperation[]
	/** Awaiting approval, rate limited — workflow's own limit type, not a new one. */
	readonly constraints?: readonly TaskConstraint[]
	readonly progress?: TaskProgress
	/** The native identity, present only on an `identity` observation. */
	readonly identity?: string
}

/** The bounded redacted record of what executors saw, keyed by unit. */
export interface JournalInterface {
	/**
	 * Append one observation under the writer's fence; `FENCED` when the lease epoch or the
	 * unit revision has moved. Writing requires the held `lease` and the current row, so a
	 * stale epoch cannot publish even though `SupervisorInterface.journal` is public.
	 */
	append(
		lease: Lease,
		unit: UnitSnapshot,
		observation: Observation,
	): Promise<Result<void, SupervisorError>>
	/** Reads are unfenced: any observer may tail any unit's bounded history. */
	entries(context: UnitContext, limit?: number): Promise<readonly Observation[]>
	/** Drop entries older than `before`; returns how many were dropped. */
	prune(before: number): Promise<number>
}
```

`append` takes the lease and the current row rather than a bare `UnitContext` because C1 requires that observations be accepted "only while epoch and revision match", and a method given neither cannot enforce that. Passing the row carries its `context`, `epoch`, and `revision` together, so the journal fences on exactly the values the unit row was written at, with no second copy to drift. Reads stay unfenced on purpose — a browser that can never hold a lease must still be able to tail the record.

There is no `Monitor` class and no journal entry wrapper. `TaskActivity` already **is** the milestone type: `TaskOperation` is "commands run / files changed" and `TaskConstraint` is "awaiting approval / rate limited". The journal stores `Observation`s directly; a wrapper carrying only `{ context, observation }` would add no boundary, invariant, composition, translation, or lifecycle, so it does not exist. Nor does the one-subscription-per-epoch invariant live here: MCP supplies the mechanism — at most one live stream per subscription key — and the supervisor supplies the key's meaning by binding it to an epoch, which is what makes the invariant true without MCP ever learning the word. Mechanism there, policy in the composition; the journal is neither.

### The executor seam

```ts
/** A live external effect an executor launched or re-attached to. */
export interface ExecutionInterface {
	/** Resolves with the provider-minted native identity the moment the provider reports one. */
	readonly identity: Promise<string>
	/** Bounded observations, ending when the execution settles. */
	readonly events: AsyncIterable<Observation>
	/** The settled external outcome; rejects only on a genuine transport fault. */
	readonly result: Promise<ExecutionResult>
	abort(): void
}

/** The external outcome, in workflow's own JSON-safe boxed shape. */
export type ExecutionResult = Result<JSONValue, TaskFailure>

/** What an executor receives. Deliberately NOT the live `TaskControllerInterface`. */
export interface ExecutionInput {
	readonly unit: UnitContext
	/** The correlation token from the committed intent row; pass it to the provider so it can echo it. */
	readonly token: string
	readonly payload: JSONRecord
	readonly signal: AbortSignal
}

/**
 * How an executor addresses one external unit. `token` is the supervisor's correlation token
 * and always exists, because the intent row committed before any effect was possible;
 * `identity` is the provider-minted native id and exists only after the identity commit.
 * Inside the indeterminate interval the token is the only address there is — which is why
 * these operations take the pair and never a bare native identity.
 */
export interface ExecutionContext {
	readonly token: string
	readonly identity?: string
}

/**
 * One way of causing external work. Equivalence holds ONLY at the workflow lifecycle/result
 * seam: `launch` and `result` are universal, everything else is capability-dependent and
 * feature-detected by presence.
 */
export interface ExecutorInterface {
	readonly name: string
	launch(input: ExecutionInput): Promise<Result<ExecutionInterface, SupervisorError>>
	/** Re-attach to an existing native session; absent ⇒ this executor can never reattach. */
	attach?(
		context: ExecutionContext,
		options?: ExecutionOptions,
	): Promise<Result<ExecutionInterface, SupervisorError>>
	/** Authoritative liveness: `true` alive, `false` PROVEN absent, failure ⇒ undeterminable. */
	probe?(context: ExecutionContext): Promise<Result<boolean, SupervisorError>>
	stop?(context: ExecutionContext): Promise<Result<void, SupervisorError>>
	steer?(context: ExecutionContext, message: string): Promise<Result<void, SupervisorError>>
	reply?(
		context: ExecutionContext,
		request: string,
		message: string,
	): Promise<Result<void, SupervisorError>>
}
```

These operations take `ExecutionContext` rather than a native identity string because the one state the whole design exists to resolve — an intent row whose identity commit never landed — has no native identity to pass. If `probe` demanded a `string`, the crash-and-race matrix's central row would be unreachable and the record could never do better than quarantine there. With the pair, a provider that accepts the supervisor's correlation token as an idempotency key or session tag can be asked _"did the unit I authorized under this token ever start?"_, and the answer is authoritative.

`probe`'s three-valued shape is load-bearing. Success `true` is life, success `false` is **proof** of absence, and a failure is "cannot tell" — which is precisely the distinction C2 demands and precisely what a `boolean` alone would destroy. An executor that omits `probe` can never prove absence, so its interrupted units always quarantine. So does an executor whose `probe` cannot answer from a token alone: asked about a unit with no `identity`, it returns a failure, which is "cannot tell", which is quarantine. That is a feature: it makes fail-closed the default for any adapter that has not earned the right to relaunch, and it keeps token-addressed probing an earned capability rather than an assumption about every provider.

Capability absence is expressed by an absent optional method, not by a `capabilities` bag — a second label that could drift from the methods it describes. The uniform run-facing surface converts absence into a typed failure: `unit.steer(...)` on an executor without `steer` returns `failure(SupervisorError 'UNSUPPORTED')` and never pretends to succeed.

### The unit — the only place effects are fenced

```ts
export interface UnitInterface {
	/** The correlation token — durable since the intent row, and this unit's address before any identity exists. */
	readonly id: string
	readonly context: UnitContext
	readonly executor: string
	readonly epoch: number
	readonly revision: number
	readonly status: UnitStatus
	readonly identity: string | undefined
	/** The decided recovery, set by `reconcile`; `undefined` on a freshly launched unit. */
	readonly recovery: RecoveryMode | undefined
	/** The live external handle, when one is held. */
	readonly execution: ExecutionInterface | undefined
	/** Commit the provider-minted native identity under this unit's epoch; resolves the new revision. */
	identify(identity: string): Promise<Result<number, SupervisorError>>
	/** Append one bounded redacted observation under the fence. */
	observe(observation: Observation): Promise<Result<void, SupervisorError>>
	/** Record the terminal external outcome under the fence. */
	settle(result: ExecutionResult): Promise<Result<void, SupervisorError>>
	/** Terminally mark this unit undeterminable — a first-class state, not a retry. */
	quarantine(reason: string): Promise<Result<void, SupervisorError>>
	stop(): Promise<Result<void, SupervisorError>>
	steer(message: string): Promise<Result<void, SupervisorError>>
	reply(request: string, message: string): Promise<Result<void, SupervisorError>>
	snapshot(): UnitSnapshot
}
```

Recording and control live on the same entity on purpose. Both must be fenced: a stale epoch must no more be able to kill a live provider session than to publish an observation into it. Splitting them would put the fence in two places and let one of them rot.

### Run, supervisor, store, errors

```ts
export interface UnitManagerInterface {
	readonly count: number
	unit(id: string): UnitInterface | undefined
	units(): readonly UnitInterface[]
}

export interface LaunchInput {
	readonly context: UnitContext
	readonly executor: string
	readonly payload: JSONRecord
	readonly signal: AbortSignal
}

/** One supervised workflow id, under one held lease. */
export interface RunInterface {
	readonly id: string
	readonly lease: Lease
	readonly units: UnitManagerInterface
	/** The whole launch transaction: intent commit, external launch, identity commit. */
	launch(input: LaunchInput): Promise<Result<UnitInterface, SupervisorError>>
	/** The authoritative durable read MCP `inspect` projects. */
	inspect(): Promise<Result<RunSnapshot, SupervisorError>>
	/** Release the lease; idempotent. */
	destroy(): Promise<void>
}

/** The record-reconciled snapshot, produced BEFORE `recoverWorkflow` is applied. */
export interface ReconcileResult {
	readonly snapshot: WorkflowSnapshot
	readonly units: readonly UnitInterface[]
}

export interface SupervisorInterface {
	readonly emitter: EmitterInterface<SupervisorEventMap>
	/** This supervisor process's owner identity — the value written into every lease. */
	readonly id: string
	readonly executors: ExecutorManagerInterface
	readonly runs: RunManagerInterface
	readonly journal: JournalInterface
	/** Acquire a fresh fenced epoch for a workflow id; `CONFLICT` when a live epoch holds it. */
	open(id: string): Promise<Result<RunInterface, SupervisorError>>
	/** Decide reattach / relaunch / quarantine per live unit and project the snapshot. */
	reconcile(snapshot: WorkflowSnapshot): Promise<Result<ReconcileResult, SupervisorError>>
	destroy(): Promise<void>
}

export interface SupervisorStoreInterface {
	/**
	 * Mint a fresh epoch for `id` on behalf of `owner`, in one transaction; `CONFLICT` when an
	 * unexpired lease already holds it. `owner` is the value written into `Lease.owner`.
	 */
	acquire(
		id: string,
		owner: string,
		options?: LeaseOptions,
	): Promise<Result<Lease, SupervisorError>>
	/**
	 * Extend the held lease's expiry at the SAME epoch, in one transaction; `FENCED` when the
	 * epoch has moved. Separate from `acquire` because renewal must never mint a new epoch —
	 * doing so would fence the renewing process's own live units.
	 */
	renew(lease: Lease, options?: LeaseOptions): Promise<Result<Lease, SupervisorError>>
	/** Read the whole durable record for one workflow id. */
	get(id: string): Promise<RunSnapshot | undefined>
	/**
	 * In ONE transaction: re-read the lease row, confirm `lease.epoch` still holds it, then write
	 * the unit row — `insert` at `revision` 1, compare-and-set on `revision` above it. `FENCED`
	 * when the epoch moved, `CONFLICT` when an intent row for that token already exists.
	 */
	set(lease: Lease, unit: UnitSnapshot): Promise<Result<UnitSnapshot, SupervisorError>>
	release(lease: Lease): Promise<void>
	delete(id: string): Promise<void>
}

export type SupervisorErrorCode =
	'CONFLICT' | 'FENCED' | 'LAUNCH' | 'PROTOCOL' | 'QUARANTINE' | 'STORE' | 'UNSUPPORTED'

export class SupervisorError extends Error {
	readonly code: SupervisorErrorCode
	readonly context?: Readonly<Record<string, unknown>>
}

export function isSupervisorError(value: unknown): value is SupervisorError
```

`ExecutorManagerInterface` and `RunManagerInterface` follow the same accessor shape: `count` plus `executor(name)` / `executors()` and `run(id)` / `runs()`, with `add` / `remove` on the executor registry only.

`SupervisorEventMap` carries seven present-tense events: `open(id, epoch)`, `launch(unit)`, `observe(unit, observation)`, `settle(unit)`, `quarantine(unit, reason)`, `fence(unit)`, `close(id)`. `fence` is how an application learns that a stale epoch tried to write — the single most useful operational signal the record produces.

### Factories

```ts
/** The supervisor entity; defaults to a memory store and an unbounded-in-process journal. */
export function createSupervisor(options?: SupervisorOptions): SupervisorInterface

/** The durable record over any `@orkestrel/database` driver that implements `transaction`. */
export function createDatabaseSupervisorStore(
	driver?: DriverInterface,
	options?: SupervisorStoreOptions,
): SupervisorStoreInterface

/** The in-process executor: a plain function, run under the same fenced record. */
export function createFunctionExecutor(
	run: ExecutionFunction,
	options?: ExecutorOptions,
): ExecutorInterface

/** THE adapter — turn any executor into a `WorkflowFunction`. */
export function createWorkflowFunction(
	executor: ExecutorInterface,
	options: WorkflowFunctionOptions,
): WorkflowFunction

export interface WorkflowFunctionOptions {
	readonly supervisor: SupervisorInterface
	/** Derive the durable request from the controller; omitted ⇒ `controller.input` verbatim. */
	readonly payload?: PayloadFunction
}

export type PayloadFunction = (controller: TaskControllerInterface) => JSONRecord
```

Supporting option and input types, each grouped by entity with one-word leaves:

```ts
export interface SupervisorOptions {
	readonly on?: SupervisorHooks
	readonly error?: EmitterErrorHandler
	/** This process's owner identity; generated when omitted. */
	readonly id?: string
	readonly store?: SupervisorStoreInterface
	readonly journal?: JournalInterface
	readonly executors?: Readonly<Record<string, ExecutorInterface>>
	readonly lease?: LeaseOptions
}

export type SupervisorHooks = EmitterHooks<SupervisorEventMap>

/** How long a granted lease stays valid without renewal, in milliseconds. */
export interface LeaseOptions {
	readonly expiry?: number
}

export interface SupervisorStoreOptions {
	readonly lease?: LeaseOptions
}

export interface ExecutorOptions {
	readonly name?: string
}

export interface ExecutionOptions {
	readonly signal?: AbortSignal
}

export interface ProviderInput {
	readonly unit: UnitContext
	/** The correlation token, so an adapter may pass it as the provider's idempotency key or session tag. */
	readonly token: string
	readonly payload: JSONRecord
	readonly workspace: string
}
```

`createWorkflowFunction` is the **only** adapter. It derives `UnitContext` from `controller.task.phase.workflow.id`, `controller.task.phase.id`, `controller.task.id`, and `controller.attempt`; calls `run.launch`; drains `execution.events` into `controller.report` and `unit.observe`; awaits `execution.result`; calls `unit.settle`; then returns the `JSONValue` or throws so workflow records the `TaskFailure`. Everything capability-dependent stays behind the executor. There is no second adapter per executor and no executor-specific `WorkflowFunction`.

## The four executors

| Executor | Owning package                 | Why there                                                                                                            |
| -------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Function | `@orkestrel/supervisor` core   | No dependency beyond workflow and contract; it is the reference implementation the fence is tested against.          |
| Provider | `@orkestrel/supervisor/server` | Needs Node process APIs and stream framing; browsers cannot spawn a harness.                                         |
| Agent    | the application                | Composing it inside supervisor would put `@orkestrel/agent` on every consumer's install, including CLI-only servers. |
| Human    | the application                | Same reason for `@orkestrel/terminal`, plus the prompt broker's lifetime is a product decision.                      |

### Function — supervisor core

```ts
export type ExecutionFunction = (input: ExecutionInput) => Promise<JSONValue> | JSONValue
```

A plain in-process function, run under the fenced record. `ExecutionFunction` is `WorkflowFunction`'s supervisor-side twin, and the difference is deliberate: an executor receives the fenced `UnitContext`, the durable `payload`, and the folded `signal`, but **not** the live `TaskControllerInterface`. Handing executors the controller would let a provider adapter drive workflow state directly, putting two writers on the task and inverting the layering the whole proposal exists to establish. The adapter is the single writer of workflow state; executors only yield observations.

The function executor mints its own identity at launch and commits it immediately, so its indeterminate interval is a single synchronous statement wide. It implements `probe` honestly: an in-process function cannot survive its process, so after a restart absence is proven and recovery is `relaunch`. That makes it the cleanest vehicle for fence and reconciliation tests without a provider anywhere in the picture.

### Provider — supervisor server

`createProviderExecutor(provider, options)` over a provider-adapter contract, with three proposed implementations. The executor owns every process tree, every stream frame, and every kill. The adapter owns only translation:

```ts
export interface ProviderCommand {
	readonly file: string
	readonly arguments: readonly string[]
	readonly environment?: Readonly<Record<string, string>>
}

export interface ProviderMessage {
	/** Names its axis. */
	readonly command: 'steer' | 'reply'
	readonly text: string
	readonly request?: string
}

export interface ProviderInterface {
	readonly name: string
	launch(input: ProviderInput): ProviderCommand
	/** Re-attach to a native session; absent ⇒ no native reattach exists. */
	attach?(context: ExecutionContext): ProviderCommand
	/**
	 * Authoritatively report whether a native session exists; absent ⇒ absence can never be proved.
	 * An adapter whose provider can only be asked about its own `identity` returns no command when
	 * `context.identity` is absent, which is "cannot tell", which is quarantine.
	 */
	probe?(context: ExecutionContext): ProviderCommand | undefined
	/** Narrow one decoded frame; `undefined` ignores a forward-compatible unknown frame. */
	observe(frame: unknown): Observation | undefined
	/** Encode a steer/reply for the provider's live input channel; absent ⇒ `UNSUPPORTED`. */
	encode?(message: ProviderMessage): string
}
```

Three adapters are proposed and none exists today: `createClaudeProvider`, `createCodexProvider`, `createCursorProvider`. Because the adapter never spawns, **only a process the provider executor launched may be killed by that executor**. A native supervisor's own processes are addressed through that supervisor's own commands, never by pid.

| Provider/version evidence     | Preferred integration                                                                                                                                                                                                                                                                                                                                                                                                                                               | Fallback/limit                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.220           | Feature-detect Agent Teams/Agent View supervision and native session operations; use `agents --json`, attach/logs/stop/respawn, peek/reply where available. Claude documents Agent View as a research preview with working/input/idle/completed/failed/stopped states and a persistent supervisor. [Agent View](https://code.claude.com/docs/en/agent-view), [sessions](https://code.claude.com/docs/en/sessions), [CLI](https://code.claude.com/docs/en/cli-usage) | Headless stream JSON plus session resume. Permission hooks may route real requests but must never auto-answer or bypass policy. [Hooks](https://code.claude.com/docs/en/hooks)          |
| Codex CLI 0.145.0             | Prefer Codex App Server: a long-lived bidirectional JSONL service with persisted threads/turns/items, streaming events, approval/input requests, resume/read/list, and interrupt. [App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [harness architecture](https://openai.com/index/unlocking-the-codex-harness/)                                                                                                       | `codex exec` is a one-shot fallback and loses App Server's richer native lifecycle.                                                                                                     |
| Cursor CLI 2026.07.23-e383d2b | Headless `-p --output-format stream-json`, preserve `session_id`, ignore forward-compatible unknown fields, and use native resume/list commands. [Using the CLI](https://docs.cursor.com/en/cli/using), [parameters](https://docs.cursor.com/en/cli/reference/parameters), [output format](https://docs.cursor.com/en/cli/reference/output-format), [headless](https://docs.cursor.com/en/cli/headless)                                                             | No equivalent native persistent supervisor was verified, so `probe` is omitted and an interrupted unit quarantines rather than relaunching. A terminal result may be absent on failure. |

### Agent — the application

A live `@orkestrel/agent` turn. `launch` calls `agent.stream({ signal })` and drains `events`; each `AgentChunk` folds into a bounded observation — `token` and `think` deltas into a capped redacted `note`, each `tool` chunk into a `TaskOperation`, `usage` into `TaskProgress` — and `await result` produces the `ExecutionResult`, resolving partial on a cancel exactly as the agent runtime already promises.

It lives in the application because `ExecutorInterface` is a total public contract with no supervisor-internal access: an out-of-package executor is a first-class citizen, not a plugin. Putting `@orkestrel/agent` on supervisor's dependency edges would make every server that supervises a CLI install an inference runtime it never loads. If a second consumer ever appears, the natural home is whichever package already depends on both — never supervisor.

An agent turn holds no durable native session that survives process death, so the agent executor implements `probe` as proven absence after a restart. That makes relaunch _technically_ safe and _semantically_ dangerous: the tokens are already spent and any tool the turn dispatched may have already acted. The application decides; a tool-calling agent should fail closed.

### Human — the application

A durable input request over `@orkestrel/terminal`'s prompt forms. `launch` calls `PromptInterface.park` and commits the returned `Ticket.id` as the native identity; the parked prompt emits a `request` observation carrying a `TaskConstraint` (which is what MCP projects as `input_required`), and the answer emits a `settlement` observation. `probe` consults `PromptInterface.pending`, and can answer from the correlation token alone because the executor parks the prompt tagged with it: a matching parked prompt is life, an authoritative broker holding none is proven absence, and an unreachable broker is undeterminable. That makes the human executor the one adapter that closes the indeterminate interval outright — the broker is ours, so it can be asked about a unit whose ticket id never committed.

It lives in the application for the same dependency reason as the agent executor, plus one of its own: how long a question stays askable, and to whom, is product policy.

The human executor is the sharpest illustration of why a per-attempt registry was required. A task with a `timeout` can have its attempt deadline fire while a human is still looking at the prompt; workflow starts attempt N+1, which parks a second prompt. Two live external units, one task. One replaceable claim slot could hold only one of them and would silently lose the other. Two unit rows hold both, and the fence decides which may publish.

## The launch transaction

Intent before effect. Nothing crosses the external boundary before the intent row commits.

```text
0. S  supervisor.open(id) — acquire ONE epoch for the whole run     [once, not per attempt]
1. W  the required 'attempt' checkpoint resolves true               [workflow, already ships]
      ⇒ (workflow.id, phase.id, task.id, attempts) is durable and unique
      ⇒ the correlation token is derivable from it
2. S  ONE transaction: re-read the lease row, confirm THIS epoch still holds it,
      insert the intent unit row (status 'running', no identity, revision 1)
      ⇒ the token is now durable, and it is durable BEFORE any effect is possible
3. X  executor.launch(input) — the external boundary is crossed HERE and not before,
      carrying the token so the provider can echo it
4. S  unit.identify(id) — the native identity commits under the SAME epoch, revision 2
5. S  observations, settlement, and control are accepted only while
      the lease epoch and the unit revision both still match
```

Steps 0 and 2 are **two commits, not one**, and C1's `S(epoch acquired + intent row) one commit` is satisfied as _epoch confirmation_ plus intent insertion in one commit rather than epoch acquisition plus intent insertion. Acquisition cannot join step 2, and should not: one lease covers a whole run of many attempts, so minting an epoch per launch would fence every unit the same process already had in flight — each attempt would invalidate its predecessor. What actually has to be atomic is the property C1 exists to guarantee, and it is: `SupervisorStoreInterface.set` re-reads the lease row and compares the epoch inside the same transaction that inserts the intent row, so **an intent row can never commit under a lease the process no longer holds**. A lease that expired between step 0 and step 2 yields `FENCED` at step 2, before the boundary is crossed.

The whole sequence lives in `RunInterface.launch`, which is the single place any of it may happen. **Absence of a unit row for attempt N proves no effect occurred**, which is what makes relaunch safe in that state and only in that state.

A reattachment takes the same path with step 3 replaced: when the record already holds a reconciled re-attachable unit for the same `(workflow, phase, task)`, `RunInterface.launch` commits the attempt-N+1 intent row **carrying that unit's existing identity** and adopts its `ExecutionInterface` instead of launching. Two rows, one identity, one external effect — visible in the record, derived rather than flagged.

## Recovery

Three outcomes, never two.

- **reattach** — a native identity is recorded and the provider confirms the unit lives.
- **relaunch** — only on authoritative proof of absence from the provider or prompt store. A transient attach failure is not proof, and a missing `probe` is not proof.
- **quarantine** — an intent row exists but the launch outcome is undeterminable. A first-class terminal state, not a retry. For non-idempotent work it fails closed.

### `recoverWorkflow` is never applied blindly

The shipped `recoverWorkflow` preserves consumed attempts, converts retryable `running` work to `pending`, and turns an exhausted `running` task into a recovery failure (`recoverWorkflowSnapshot`, `src/core/helpers.ts:450`). Applying it before the supervisor reconciles its own record consumes retry budget for an attempt that may still be re-attachable. The order is fixed:

```ts
const snapshot = await store.get(id) // workflow's durable snapshot
const run = await supervisor.open(id) // acquire a FRESH epoch; CONFLICT ⇒ someone else owns it
const reconciled = await supervisor.reconcile(snapshot) // decide per unit, FIRST
const workflow = recoverWorkflow(reconciled.snapshot) // only NOW
await runner.execute(workflow, { signal, timeout })
```

`reconcile` probes each live unit through its recorded `executor` name, sets each unit's `recovery`, holds an `ExecutionInterface` for every `reattach`, and projects the snapshot: a quarantined unit's task is written `failed` with a `TaskFailure` of origin `'recovery'` **before** `recoverWorkflow` sees it, so recovery never demotes work whose outcome is already terminal, and a re-attachable unit's task is left for recovery to demote to `pending` normally — because the reattachment is carried by the record, not by the tree. That is the whole point of a per-attempt registry: the tree does not need to express reattachment, so workflow does not need to change.

## Fencing

`StorageInterface` — the capability a driver passes into one transaction scope — already exposes everything a lease needs, inside that scope: `read`, `write`, an atomic `insert` that rejects `CONFLICT` when the key exists, `delete`, `keys`, `scan`, and `clear`, with the driver committing when the callback fulfills and rolling back when it rejects, and `commit` / `rollback` observable on `DatabaseEventMap`. `insert` is exactly a lease-acquire primitive. `DatabaseInterface.transaction(scope, options?)` hands the scope a `DatabaseStorageInterface`, and `SQLiteDriver` implements `transaction?` as a callback-scoped real `BEGIN` / `COMMIT` / `ROLLBACK`.

**No amendment to `@orkestrel/database` is required.** `createDatabaseSupervisorStore` composes `acquire` as one transaction — `insert` the lease row under the caller's `owner`, or `read` it and take over at a fresh epoch only when its `expiry` has passed — `renew` as one transaction that re-reads the lease, compares the epoch, and writes back a later `expiry` at the same epoch, and `set` as one transaction that re-reads the lease, compares the epoch, and then `insert`s the intent row or writes the unit row at `revision + 1`, failing `FENCED` when the epoch moved.

`IndexedDBDriver` deliberately omits `transaction?`, because an `IDBTransaction` can auto-commit when the microtask queue drains and no callback could truthfully remain inside one native transaction. **So a browser can observe and drive a supervised run and can never hold a lease.** That is a design fact of the storage substrate, not an omission to be worked around, and the browser build of supervisor exposes `inspect` and the read side of the journal without `acquire`.

## Honest limits

There is no exactly-once. Fencing prevents stale publication; it cannot undo an external side effect that already happened. The irreducible indeterminate interval is:

> from the earliest instant `executor.launch` may have been accepted by the provider, to the instant the native identity commit for that unit is durable.

Inside that interval a crash leaves an intent row with no identity. The row is addressable — the correlation token committed before the boundary was crossed — so the interval can be _interrogated_, which is what `ExecutionContext` exists for. But it can only be _answered_ by a provider that accepts that token; one that can be asked only about its own native id has nothing to be asked with, and the record honestly cannot say whether an effect occurred. Production policy chooses one of three answers and states which: provider idempotency keyed on the token, native recovery through a `probe` that can prove absence, or fail-closed quarantine. The supervisor's contribution is that the interval is _named, bounded, addressable, and observable_ — not that it is closed.

`RunInterface.launch` also cannot make a never-settling store Promise settle. A blocked required checkpoint blocks the run, and operators need a backend-specific health and shutdown policy outside both workflow core and supervisor core.

## What must land in `@orkestrel/mcp` first

The supervisor projection is blocked on generic MCP work tracked in that repository's own proposal (`/home/user/mcp/PROPOSAL.md`); it is not restated here.

- **Target 2026-07-28 first.** The durable id returned in an ordinary tool result is the substrate. The Tasks extension is optional augmentation, never the substrate — it has no implementations, and 2026-07-28 removed blocking `tasks/result`.
- **No MCP resources in the first slice.** `inspect` already carries the authoritative read.
- **An independent service host.** A client-spawned stdio process cannot honestly promise to outlive the client that spawned it; `@orkestrel/sea` is the deployment answer.
- **The durable tool is named `supervisor`.** Toolbox keeps `workflow` for its bounded author-and-run-in-one-call operation, which the application must bound so it cannot become a second long-run path. Renaming toolbox's to `execute` remains a good independent improvement.
- **MRTR cannot push a later input request into a completed call.** Detached runs surface `input_required` through a subscription plus an explicit `reply` command.

### The `supervisor` tool's command axis

| Command   | Meaning                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `start`   | Validate a definition, durably accept it, begin server-owned execution, and promptly return a durable workflow handle. |
| `inspect` | Return the authoritative `RunSnapshot`, the workflow snapshot, activity, persistence outcome, and journal tail.        |
| `pause`   | Close Workflow's cooperative dispatch gates; it does not suspend arbitrary JavaScript or an OS process.                |
| `resume`  | Reopen a live Workflow pause gate; it is not provider session continuation or crash recovery.                          |
| `stop`    | Request graceful Workflow stop and, through the owning unit, provider interruption/termination where supported.        |
| `steer`   | Send provider-native steering to an active unit whose executor implements `steer`; otherwise `UNSUPPORTED`.            |
| `reply`   | Supply required input or approval through the native channel; never auto-approve.                                      |

When negotiated, MCP elicitation carries required operator input with related-task metadata. Otherwise the human executor parks on a real operator. Neither path polls, fabricates a reply, or bypasses provider permission policy. The durable workflow id is stable across transports, sessions, and recovery; a provider session id and an MCP task id are correlated identifiers, not replacements for it.

### State mapping

| Supervisor/workflow observation                                                                 | MCP task projection                                                                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Accepted and nonterminal                                                                        | `working`                                                                           |
| A `request` observation from a real provider or prompt broker                                   | `input_required` plus related-task metadata and the real input channel              |
| Workflow execution completes, including graceful mode with failed tasks recorded as result data | `completed`; the Tool result still exposes the Workflow status/results/fault fields |
| `LAUNCH` / `PROTOCOL` / `STORE` failure, or a required persistence fault                        | `failed`                                                                            |
| `QUARANTINE`                                                                                    | `failed`, with the quarantine reason in the result — never a retry                  |
| Valid MCP cancellation or observed Workflow stop                                                | `cancelled`                                                                         |

`input_required` must arise from a real observation, never from an arbitrary Workflow constraint or a stale log line. MCP requires a cancelled task to remain cancelled even if underlying execution later completes, so inspection records both **requested cancellation** and **observed termination**; a cancelled protocol state must not falsely assert that an uncooperative process has exited.

## Authority, persistence, and recovery

```text
durable Workflow snapshot  +  fenced supervisor record (lease, units, journal)
        ↓
live Workflow entity and live ExecutionInterface observations
        ↓
MCP task/tool projection
        ↓
client cache and UI
```

The projection never reconstructs truth by replaying notifications alone. Only the current epoch may publish observations or settle a unit. Raw prompts, credentials, complete transcripts, and unbounded stdout/stderr never enter Workflow activity or the journal; store references or redacted summaries when retention is authorized.

### Crash and race matrix

| Boundary                                                     | Required behavior                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash before initial checkpoint                              | No accepted handle and no launch.                                                                                                                                                                                                                                          |
| Crash after attempt checkpoint, before the intent commit     | No unit row exists for attempt N, which **proves** no effect occurred. Relaunch is safe within the remaining retry budget under a fresh epoch. **(C1)**                                                                                                                    |
| Crash after the intent commit, before the identity commit    | The irreducible interval. The intent row carries the correlation token, so `probe` is called with `{ token }` and no `identity`: proves life ⇒ reattach; proves absence ⇒ relaunch; cannot answer from the token alone, fails, or is absent ⇒ quarantine. **(C1, C2, C5)** |
| Restore applies `recoverWorkflow` before reconciliation      | Forbidden. Reconcile the supervisor record first, then recover; otherwise a re-attachable attempt's retry budget is spent. **(C3)**                                                                                                                                        |
| A timed-out attempt leaves a live external unit              | Attempt N's unit row stays `running` while attempt N+1 commits its own row. Both are addressable; the fence decides which may publish. **(C1)**                                                                                                                            |
| External side effect occurs before the settlement checkpoint | Recovery uses the recorded native identity and the application's idempotency key; neither workflow nor supervisor can prove exactly-once effects. **(C5)**                                                                                                                 |
| Provider waits for approval/input                            | Record a `request` observation; project `input_required`; park on the native input mechanism, not polling.                                                                                                                                                                 |
| Session disappears or cannot resume                          | A new persisted attempt only if retry policy permits and absence was proved; this is not `Task.resume()`.                                                                                                                                                                  |
| Two restorers race                                           | `SupervisorStoreInterface.acquire` grants exactly one epoch through the driver's atomic `insert`; the loser gets `CONFLICT` and stale epochs cannot launch, journal, or settle. **(C4)**                                                                                   |
| A browser tries to hold a lease                              | `IndexedDBDriver` has no `transaction`, so it cannot. Browsers observe and drive; they never fence. **(C4)**                                                                                                                                                               |
| Unknown/malformed stream frame                               | `ProviderInterface.observe` returns `undefined` for a forward-compatible unknown frame; a malformed required frame fails the attempt with `PROTOCOL` and a bounded redacted `diagnostic` observation.                                                                      |
| Activity becomes silent                                      | Surface silence as observation; do not infer failure or kill work without explicit application policy.                                                                                                                                                                     |
| Task is paused until its deadline                            | The deadline continues; the attempt may time out before provider dispatch, matching Workflow semantics.                                                                                                                                                                    |
| Cancel races completion                                      | Serialize the authoritative observation; retain MCP's terminal cancellation rule once cancellation succeeds and separately record late native completion.                                                                                                                  |
| Store Promise never settles                                  | The run remains blocked at the required checkpoint; operators need a backend-specific health/termination policy outside core.                                                                                                                                              |
| MCP reconnect or authorization changes                       | Reauthenticate, authorize the workflow id, read current state, then resume hints; never trust a prior transport session as authority.                                                                                                                                      |

## Security and operational limits

- Authorize every inspect/control/result request against the durable workflow id; task ids, unit ids, and provider session ids are not bearer secrets.
- Bind leases and provider observations to a tenant/workspace boundary.
- Redact secrets before persistence; cap journal entries, bytes, and age; never persist environment dumps.
- Keep stream parsing defensive and forward-compatible while rejecting malformed required frames.
- Never translate `reply` into unconditional approval. Preserve provider permission modes and audit the human or native decision.
- Terminate only process trees the provider executor launched and owns. Native supervisors remain the source of process ownership when present.
- Require application-level idempotency for external side effects; neither Workflow checkpoints, supervisor fencing, nor MCP tasks create exactly-once execution.
- Expose the never-settling-store limitation in service health and shutdown behavior rather than hiding it behind a core timeout.

## Implementation campaign

Serial where a unit depends on another's contract; parallel otherwise. One writer at a time in the main checkout.

| Unit | Work                                                                                                                                                                                                     | Role / engine                     | Depends on | Acceptance                                                                                                                                                                                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| U0   | Close current Workflow parity: snapshot ownership, recovery, pause/activity, persistence faulting, real-clock scheduler coverage.                                                                        | `verifier` / Sonnet               | —          | All five workflow gates green; the shipped guide describes no future behavior.                                                                                                                                                                                                                         |
| U1   | Scaffold `@orkestrel/supervisor` (core + server, configs, test projects, barrels) from `@orkestrel/scaffold` 0.0.13.                                                                                     | `builder` / Sonnet                | —          | `npm run check` and an empty `npm test` pass; no published behavior yet.                                                                                                                                                                                                                               |
| U2   | `src/core/types.ts`: the whole contract above, plus TSDoc and naming conformance.                                                                                                                        | `implementer` / Opus              | U1         | Every member is one word; no `kind`/`type` discriminant; no sentinel; no status-dependent field is optional on `UnitSnapshot`; `check` green on an implementation-free contract.                                                                                                                       |
| U3   | `errors.ts`, `validators.ts`, `helpers.ts`: `SupervisorError`, `isSupervisorError`, wire guards for `UnitSnapshot` / `RunSnapshot` / `Observation`, the correlation-token derivation from `UnitContext`. | `codex` route `implementer` / Sol | U2         | Every guard is total and returns `false` off-shape for cycles, depth, and hostile prototypes, and narrows each `UnitSnapshot` variant by `status`; the token derivation is injective over all four key components; each is unit-tested.                                                                |
| U4   | The lease module: `SupervisorStoreInterface`, a memory store, and `createDatabaseSupervisorStore` over `StorageInterface.insert` inside one `transaction`.                                               | `codex` route `implementer` / Sol | U3         | `acquire` grants one epoch under real concurrency; `renew` extends without minting an epoch; `set` fails `FENCED` after the epoch moves and `CONFLICT` on a second intent row for one token; all proved over a real temporary SQLite file.                                                             |
| U5   | `Supervisor`, `Run`, `Unit` classes and `RunInterface.launch` — the whole C1 transaction, in one place.                                                                                                  | `codex` route `implementer` / Sol | U4         | No code path reaches an executor before the intent row commits; a test asserts the record contains no unit row when launch is interrupted before commit.                                                                                                                                               |
| U6   | `reconcile`: probe dispatch over `ExecutionContext`, the three outcomes, the snapshot projection, and the C3 ordering.                                                                                   | `codex` route `implementer` / Sol | U5         | A missing `probe` yields `quarantine`, never `relaunch`; a transient probe failure yields `quarantine`, never `relaunch`; a unit with no `identity` is still probed by its token and quarantines when the executor cannot answer; the projected snapshot spends no budget for a re-attachable attempt. |
| U7   | `JournalInterface` with a memory implementation, byte/entry/age caps, and redaction.                                                                                                                     | `codex` route `implementer` / Sol | U3         | Caps are enforced at write; a secret-bearing frame is redacted before persistence; `prune` reports what it dropped; `append` under a stale epoch or revision returns `FENCED` while `entries` stays readable.                                                                                          |
| U8   | `createWorkflowFunction` and `createFunctionExecutor`.                                                                                                                                                   | `implementer` / Opus              | U5, U7     | One adapter serves every executor; a supervised function task completes, fails, and cancels identically to an unsupervised one at the workflow lifecycle/result seam.                                                                                                                                  |
| U9   | Server: `createProviderExecutor`, `ProviderInterface`, and the Claude/Codex/Cursor adapters.                                                                                                             | `codex` route `implementer` / Sol | U8         | Only launched process trees are killed; unknown frames are ignored forward-compatibly; malformed required frames fail `PROTOCOL`; each adapter is proved against a protocol-faithful fixture.                                                                                                          |
| U10  | The two falsification tests (below).                                                                                                                                                                     | `codex` route `implementer` / Sol | U9         | Both fail first against a deliberately mis-ordered launch, then pass.                                                                                                                                                                                                                                  |
| U11  | `guides/src/supervisor.md` plus parity coverage and showcase.                                                                                                                                            | `implementer` / Opus              | U9         | Every backticked API resolves to a real export; every public export is documented; parity green.                                                                                                                                                                                                       |
| U12  | Application composition sample: the agent and human executors, authorization, retention, workspace binding.                                                                                              | `application` / Sonnet            | U9         | Neither `@orkestrel/agent` nor `@orkestrel/terminal` appears in supervisor's dependency graph.                                                                                                                                                                                                         |
| U13  | Generic MCP 2026-07-28 primitives, then the `supervisor` tool composition.                                                                                                                               | per `/home/user/mcp/PROPOSAL.md`  | U11        | Protocol-conformance fixtures pass before the supervisor projection uses them.                                                                                                                                                                                                                         |
| U14  | Authoritative tree-wide gates.                                                                                                                                                                           | `verifier` / Sonnet               | U13        | `format → lint → check → build → test` green, output read.                                                                                                                                                                                                                                             |

### The two falsification tests

Both engines named these independently. Neither uses a mock, a fake clock, or module replacement.

1. **`crash after provider commit, before identity commit — two restorers over one real temporary SQLite file`.** Drive a supervised task to the point where the intent row is committed and the executor has accepted, then terminate before `identify`. Start two restorers against the same file. Assert: exactly one `acquire` succeeds and the other returns `CONFLICT`; the winner's `reconcile` returns `quarantine` when the executor omits `probe` or the probe fails transiently, and `reattach` only when a probe proves life; the loser's fenced `set` returns `FENCED`; and `recoverWorkflow` is never called before `reconcile` resolves.
2. **`no unrecorded duplicate external unit`.** Across a full crash-and-restore cycle including a timed-out attempt, assert that the number of **distinct** `identity` values recorded across every unit of one `(workflow, phase, task)` never exceeds the number of launches the record authorized, and that a reattachment adds a unit row without adding an identity. This bounds and attributes duplication; it does not assert exactly-once, which no test could.

Package baseline recorded 2026-07-31: Workflow 0.0.8, MCP 0.0.8, Tool 0.0.8, Agent 0.0.13, Toolbox 0.0.2, Workspace 0.0.2, Scaffold 0.0.13, Contract 0.0.9, Database 0.0.7, Terminal 0.0.5. Versions record the inspected baseline; they do not imply feature support.

## Validation strategy

No mocks, module replacement, fake clocks, or fake provider behavior.

| Layer            | Deterministic coverage                                                                                                                                                                 | Live coverage                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Workflow         | Real entities/functions/stores; crash-boundary and pause/deadline cases; storage recorder/temporary database                                                                           | Existing package gates only                                                           |
| Supervisor core  | Real function executor; intent-before-effect ordering; the three recovery outcomes; fence rejection; journal caps and redaction                                                        | None required                                                                         |
| Persistence      | Temporary SQLite, real transactions, two competing restorers, epoch fencing, restart; IndexedDB proving a browser cannot acquire                                                       | Service restart against the same durable database                                     |
| Provider adapter | Scripted executable/fixture server speaking each provider's documented stream/protocol and owning a real child process; malformed/unknown frames, approval/input, resume, interruption | Opt-in installed CLI/App Server smoke with a disposable workspace and bounded timeout |
| MCP              | Protocol-faithful fixture peer over a real transport; capability permutations; durable-id path and, where negotiated, task augmentation                                                | Each supported native client against a local server                                   |

Live assertions must prove session recovery, approval/input parking, process ownership, requested-cancel versus observed-termination, redaction, and no unrecorded duplicate external unit. A provider that is unavailable or unauthenticated is a reported skipped opt-in gate, never simulated success.

## Acceptance criteria

- Workflow remains independent of Tool, MCP, Agent, Terminal, and Supervisor, and gains no new `TaskSnapshot` member, checkpoint, or claim field.
- Supervisor's dependency graph contains neither `@orkestrel/agent` nor `@orkestrel/terminal`.
- Every proposed public member is one word; every discriminant names its axis; absence is `undefined` everywhere; no optional field stands in for a state a union should carry.
- Every supervisor key, `UnitContext`, store index, and correlation token uses the four-part `(workflow, phase, task, attempt)` key; no three-part key survives anywhere.
- Every write to the record — unit rows and journal appends alike — carries the lease and fences on epoch and revision; reads are unfenced.
- No code path reaches an executor before the intent row commits, and `RunInterface.launch` is the only place the sequence exists.
- `reconcile` runs before `recoverWorkflow` in every documented and tested recovery path.
- `relaunch` is reachable only from proven absence; a missing or failing `probe` yields `quarantine`.
- Two restorers over one real temporary SQLite file produce one epoch, one `CONFLICT`, and no unrecorded duplicate external unit.
- An unsupported executor operation returns a typed `UNSUPPORTED` failure and never reports success.
- Generic MCP primitives pass protocol-conformance fixtures before the supervisor projection uses them.
- `supervisor start` promptly returns a durable handle and server execution survives client disconnect.
- No integration auto-approves, reads secrets into journals, or claims process termination before observation.
- Native provider support is feature-detected and live-tested at the recorded version; unsupported features degrade to the documented fallback.
- Shipped guides describe only implemented behavior; this proposal is the sole home for proposed behavior until implementation lands.

## Open verification questions

- Which of Claude Code, Codex, and Cursor exposes a command that **authoritatively** reports a session's absence, as opposed to failing to attach to it — and which of them will accept and echo a caller-supplied correlation token, so that question can be asked about a unit whose native id never committed? The first answer decides how much work can ever be relaunched rather than quarantined; the second decides whether the indeterminate interval is answerable at all for that provider.
- Does the chosen MCP transport keep the server process alive independently of every supported client, or is `@orkestrel/sea` required from day one?
- What lease expiry policy fits the deployed SQLite/server topology, and what does an operator do with a run whose owner died mid-interval?
- Which provider operations acknowledge steering, reply, interrupt, and termination strongly enough to record as observed rather than requested?
- What tenant/workspace authorization model governs workflow ids, unit ids, MCP task ids, and native provider session identifiers?

These are release gates, not invitations to speculate in a public type.
