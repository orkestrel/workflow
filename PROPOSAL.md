# Native Workflow over MCP

**Status:** proposal; no Tool, MCP, provider, or Harness behavior described here ships from this repository today  
**Evidence date:** 2026-07-31  
**Objective:** make `@orkestrel/workflow` a durable standalone workflow engine that an MCP server can expose through one conceptual `workflow` tool, so Claude Code, Codex, Cursor, and other capable clients can start and control long-running work without owning the execution process.

The primary product is Workflow projected through MCP. Workflow is authoritative for logical execution and its snapshot; the integration record is authoritative for epochs, leases, and provider observations. A future Harness is only a native-aware adapter/supervisor for installed provider harnesses; it is neither a replacement for those harnesses nor a reimplementation of their session, approval, recovery, or process capabilities.

## Failure modes this proposal closes

- A client disconnects after launch and accidentally owns or kills the run.
- A tool call blocks until the whole workflow finishes instead of promptly returning a durable handle.
- Workflow snapshots, MCP task state, notifications, provider sessions, and process state each claim to be authoritative.
- Reconnect relies on a lossy event stream rather than an authoritative state read.
- Cancellation is reported as termination before an external provider process actually exits.
- Provider continuation is confused with `Task.resume()`, which only opens a live cooperative pause gate.
- Two restorers launch the same pending attempt after a crash.
- A required persistence write never settles and strands execution indefinitely.
- An integration invents Tool adapters, Workflow error codes, or client capabilities that do not exist.

## Reconciled position

The supplied architecture (Opus), local source-audit (Sol), and official provider-research (Grok) tracks converge on the following boundary. Opus favored a clean consumer boundary, Sol established what Workflow and sibling packages actually ship, and Grok established which native provider capabilities can be relied on or must be feature-detected:

1. Workflow remains the host-independent logical-execution and snapshot authority; the integration record owns epoch, lease, and provider-observation truth.
2. MCP owns protocol negotiation and projection, using the existing generic Tool primitives rather than adding Tool behavior to Workflow.
3. The MCP server process owns continued execution. The calling client receives a durable handle and may disconnect.
4. Installed provider harnesses retain authority over their own sessions, approvals, turns, and native recovery.
5. A later Harness package may normalize supervision around those native capabilities, but must not dominate or delay Workflow→MCP.

Rejected placements:

| Placement                                          | Decision | Reason                                                                                                                                                                                                 |
| -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow depends on Tool or MCP                    | Reject   | It would break the host-independent core boundary and invert the composition direction.                                                                                                                |
| Tool owns Workflow runtime or provider supervision | Reject   | Tool 0.0.8 supplies generic definitions, a total call-envelope guard, invocation, and registry primitives; it neither validates arguments against schemas nor has a Workflow/provider adapter surface. |
| Agent core owns subprocess supervision             | Reject   | Agent is an inference/conversation runtime; process trees and MCP service lifetime are different responsibilities.                                                                                     |
| Empty package created before a real consumer       | Reject   | The first package boundary must be justified by working MCP/provider composition and tests.                                                                                                            |
| Harness replaces native provider harnesses         | Reject   | It would discard stronger session, approval, recovery, and supervision semantics already owned upstream.                                                                                               |

## Current Workflow guarantees and limits

The proposal is grounded in the current local source, types, guide, and real tests—not in planned API assumptions.

| Current guarantee                                                                         | Consequence                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| JSON `Workflow → Phase → Task` definitions; named functions resolve once into handlers    | MCP can persist and validate definitions without serializing behavior.                                                                |
| Sequential phases, concurrent tasks, optional phase concurrency and bail policy           | The server can expose deterministic structure without inventing a DAG.                                                                |
| Live pause/resume/stop, task activity, events, folded signals, deadlines, retries         | MCP controls can project existing mechanisms rather than duplicating them.                                                            |
| Owned exact-JSON snapshots, restore, explicit recovery, consumed attempts                 | A reconnect can inspect authoritative durable state; recovery never silently replenishes retries.                                     |
| Initial, attempt, settlement, and final persistence checkpoints with one coalesced writer | Handler dispatch follows a required durable attempt checkpoint; distributed fencing still belongs to the external epoch/lease record. |
| Same-object execution claim through a process-local `WeakSet`                             | One object cannot be driven twice locally, but distributed duplicate launch is still possible.                                        |
| Pending and recovered-retryable tasks omit old activity                                   | A recovered attempt cannot present stale activity as current work.                                                                    |

Hardening cannot provide distributed exclusivity, provider idempotency, operating-system process termination, remote authorization, or cancellation of an arbitrary never-settling store Promise. Those are explicit integration responsibilities. In particular, adding a Promise timeout would not cancel a late backend write and could permit stale data to arrive out of order.

## Proposed ownership

| Owner                               | Owns                                                                                                                      | Does not own                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Workflow                            | definitions, live entities, runner, activity, snapshots, restore/recovery, store contract                                 | Tool schemas, MCP messages, provider protocols, subprocesses                   |
| Tool                                | generic definitions, total call-envelope guard, invocation, registry                                                      | schema-based argument validation, Workflow lifecycle policy, provider adapters |
| MCP composition                     | the conceptual `workflow` tool, generic MCP Tasks/progress/resources, session/transport projection, authorization         | Workflow engine internals or client-terminal lifetime                          |
| Database + SQLite/IndexedDB drivers | atomic durable storage through existing driver and transaction seams                                                      | Workflow recovery policy                                                       |
| Provider native harness             | provider session/turn lifecycle, native approvals/input, native reconnect/recovery                                        | Workflow's logical task and durable snapshot authority                         |
| Future Harness                      | native-aware normalization, bounded redacted journal, epoch fencing, process tree only where native supervision is absent | replacement provider runtime, generic Workflow engine, automatic approval      |

Dependency direction remains:

```text
Workflow ← MCP composition → Tool
    ↓
Database → SQLite or IndexedDB at the application edge

future Harness → Workflow + provider-native protocols
MCP composition → future Harness only when a provider-backed WorkflowFunction needs it
```

Workflow must not import Tool, MCP, Terminal, Agent, or a future Harness. Browser and server implementations remain disjoint; provider processes and MCP service lifetime are server/application concerns.

## The Workflow MCP surface

The integration should publish one conceptual tool named `workflow`. This proposal intentionally does not freeze a speculative public TypeScript interface. Its command axis remains single-word and initially covers:

| Command   | Meaning                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `start`   | Validate a definition, durably accept it, begin server-owned execution, and promptly return a durable workflow/task handle. |
| `inspect` | Return the authoritative current snapshot, activity, persistence outcome, and external-attempt observation.                 |
| `pause`   | Close Workflow's cooperative dispatch gates; it does not suspend arbitrary JavaScript or an OS process.                     |
| `resume`  | Reopen a live Workflow pause gate; it is not provider session continuation or crash recovery.                               |
| `stop`    | Request graceful Workflow stop and, where applicable, provider interruption/termination through the owning adapter.         |
| `steer`   | Send provider-native steering to an active external session when that provider supports it.                                 |
| `reply`   | Supply required provider input or approval through the native channel; never auto-approve.                                  |

When negotiated, MCP elicitation carries required operator input with related-task metadata. Otherwise a Terminal/application adapter may park on real operator input. Neither path polls, fabricates a reply, or bypasses provider permission policy.

The durable workflow id is stable across transports, sessions, and recovery. A provider session id and MCP task id are correlated identifiers, not replacements for it. The server stores those correlations with an epoch/attempt record before treating a launch as owned.

### Capability-negotiated MCP Tasks

MCP Tasks were introduced as **experimental** in protocol version 2025-11-25. They are durable request state machines designed for polling and deferred results, and both peers must declare category-specific support during initialization. Tool-level `execution.taskSupport` further declares required, optional, or forbidden task augmentation. See the official [MCP Tasks specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks).

When both client and server support task-augmented `tools/call`:

1. `workflow` declares optional or required task support only after generic MCP Tasks exist in the MCP package.
2. A task-augmented `start` returns `CreateTaskResult` promptly; the actual Tool result is retrieved through `tasks/result`.
3. Clients use `tasks/get`, optional paginated `tasks/list`, and—when negotiated—`tasks/cancel`.
4. The initial progress token remains valid for the task lifetime and projects accepted Workflow activity through MCP [progress notifications](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress).
5. `notifications/tasks/status` may reduce latency, but clients must not depend on it; `tasks/get` remains the resynchronization path.

When a client lacks compatible Tasks support, `start` returns the durable workflow id through an ordinary tool result. Follow-up `workflow` calls operate on that id. After generic MCP resources and subscription/change notifications exist in the MCP package, current snapshots may also be exposed as [MCP resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources). Events are bounded hints; an authoritative snapshot read repairs missed, duplicated, reordered, or post-reconnect delivery.

The current local MCP 0.0.8 surface implements protocol 2025-06-18 initialization, ping, `tools/list`, and `tools/call` over Tool plus its sessions/transports. It does not yet implement Tasks, resources, or Workflow integration. Generic protocol support must land before the Workflow projection. No claim is made that Claude Code, Codex, or Cursor currently negotiates every experimental Tasks feature; capability detection decides the path at runtime.

### State mapping

| Workflow/integration observation                                                                | MCP task projection                                                                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Accepted and nonterminal                                                                        | `working`                                                                           |
| Native provider explicitly needs approval/input to continue                                     | `input_required` plus related-task metadata and the provider's real input channel   |
| Workflow execution completes, including graceful mode with failed tasks recorded as result data | `completed`; the Tool result still exposes the Workflow status/results/fault fields |
| Provider launch/protocol failure or required persistence fault prevents a valid result          | `failed`                                                                            |
| Valid MCP cancellation or observed Workflow stop                                                | `cancelled`                                                                         |

`input_required` must arise from a real provider/MCP elicitation observation, never from an arbitrary Workflow constraint or a stale log line. MCP requires a cancelled task to remain cancelled even if underlying execution later completes. Therefore inspection records both **requested cancellation** and **observed termination**; a cancelled protocol state must not falsely assert that an uncooperative process has exited.

## Authority, persistence, and recovery

The authoritative chain is:

```text
durable Workflow snapshot + epoch/attempt record
        ↓
live Workflow entity and provider observation
        ↓
MCP Task/resource/tool projection
        ↓
client cache and UI
```

The projection never reconstructs truth by replaying notifications alone. A reconnect reads the durable record, acquires a fresh epoch lease transactionally, feature-detects native provider recovery, and then either reconnects, resumes as a new persisted attempt, or records a normalized failure. Only the current epoch may publish provider observations or settle the logical task.

Minimum durable integration data:

- workflow id, definition/snapshot, revision, and persistence fault;
- current epoch and lease owner/expiry;
- logical task plus consumed Workflow attempt;
- provider, native session/thread identifier, launch/continuation command, and observed process/session state;
- requested controls and observed acknowledgements/termination;
- bounded, redacted observation journal with sequence and timestamps.

Raw prompts, credentials, complete transcripts, and unbounded stdout/stderr do not belong in Workflow activity or the journal. Store references or redacted summaries when retention is authorized.

### Crash and race matrix

| Boundary                                                       | Required behavior                                                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash before initial checkpoint                                | No accepted handle and no launch.                                                                                                                                    |
| Crash after attempt checkpoint, before launch                  | `Task.start()` already consumed that attempt before the checkpoint. Recovery may launch again only within the remaining retry budget and under a fresh fenced epoch. |
| Launch succeeds before native id/process observation is stored | Probe native recovery first; never blindly launch a duplicate. If identity cannot be established, fail closed for non-idempotent work.                               |
| External side effect occurs before settlement checkpoint       | Recovery uses the provider/native id and application idempotency key; Workflow alone cannot prove exactly-once effects.                                              |
| Provider waits for approval/input                              | Record the native observation; project `input_required`; park on the native input mechanism, not polling.                                                            |
| Session disappears or cannot resume                            | Start a new persisted provider attempt only if retry policy permits; this is not `Task.resume()`.                                                                    |
| Two restorers race                                             | A storage transaction grants one epoch/lease; stale epochs cannot launch, journal, or settle.                                                                        |
| Unknown/malformed stream frame                                 | Preserve a bounded redacted diagnostic, ignore forward-compatible unknown fields when allowed, and fail the attempt on malformed required structure.                 |
| Activity becomes silent                                        | Surface silence as observation; do not infer failure or kill work without explicit application policy.                                                               |
| Task is paused until its deadline                              | Deadline continues; the attempt may time out before provider dispatch, matching Workflow semantics.                                                                  |
| Cancel races completion                                        | Serialize the authoritative observation; retain MCP's terminal cancellation rule once cancellation succeeds and separately record late native completion.            |
| Store Promise never settles                                    | The run remains blocked at the required checkpoint; operators need a backend-specific health/termination policy outside Workflow core.                               |
| MCP reconnect or authorization changes                         | Reauthenticate, authorize the workflow id, read current state, then resume hints; never trust a prior transport session as authority.                                |

## Future Harness package handoff

This is deliberately short. The future Harness package should be built only when the Workflow MCP path has a real provider-backed consumer. It adapts installed Claude Code, Codex, and Cursor harnesses and is not a drop-in replacement for them. It owns its normalized provider sessions, launched-process trees only where native supervision is absent, bounded redacted journals, epoch fencing, and native recovery.

| Provider/version evidence     | Preferred integration                                                                                                                                                                                                                                                                                                                                                                                                                                               | Fallback/limit                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code 2.1.220           | Feature-detect Agent Teams/Agent View supervision and native session operations; use `agents --json`, attach/logs/stop/respawn, peek/reply where available. Claude documents Agent View as a research preview with working/input/idle/completed/failed/stopped states and a persistent supervisor. [Agent View](https://code.claude.com/docs/en/agent-view), [sessions](https://code.claude.com/docs/en/sessions), [CLI](https://code.claude.com/docs/en/cli-usage) | Headless stream JSON plus session resume. Permission hooks may route real requests but must never auto-answer or bypass policy. [Hooks](https://code.claude.com/docs/en/hooks) |
| Codex CLI 0.145.0             | Prefer Codex App Server: a long-lived bidirectional JSONL service with persisted threads/turns/items, streaming events, approval/input requests, resume/read/list, and interrupt. [App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [harness architecture](https://openai.com/index/unlocking-the-codex-harness/)                                                                                                       | `codex exec` is a one-shot fallback and loses App Server's richer native lifecycle.                                                                                            |
| Cursor CLI 2026.07.23-e383d2b | Headless `-p --output-format stream-json`, preserve `session_id`, ignore forward-compatible unknown fields, and use native resume/list commands. [Using the CLI](https://docs.cursor.com/en/cli/using), [parameters](https://docs.cursor.com/en/cli/reference/parameters), [output format](https://docs.cursor.com/en/cli/reference/output-format), [headless](https://docs.cursor.com/en/cli/headless)                                                             | No equivalent native persistent supervisor was verified; own and terminate only the process tree the adapter launched. A terminal result may be absent on failure.             |

The Harness remains a native-aware adapter/supervisor over those installed harnesses, preserving their own session, approval, recovery, and process capabilities. Terminal supplies operator interaction only where needed; it does not become the execution owner. Approvals and credentials always use the provider's real policy/input channel.

## Security and operational limits

- Authorize every inspect/control/result request against the durable workflow id; task ids and provider session ids are not bearer secrets.
- Bind leases and provider observations to a tenant/workspace boundary.
- Redact secrets before persistence; cap journal entries, bytes, and age; never persist environment dumps.
- Keep stdout/stderr parsing defensive and forward-compatible while rejecting malformed required frames.
- Never translate `reply` into unconditional approval. Preserve provider permission modes and audit the human/native decision.
- Terminate only process trees launched and owned by the adapter. Native supervisors remain the source of process ownership when present.
- Require application-level idempotency for external side effects; neither Workflow checkpoints nor MCP Tasks create exactly-once execution.
- Expose the never-settling-store limitation in service health and shutdown behavior rather than hiding it behind a core timeout.

## Implementation campaign

1. **Close current Workflow parity.** Finish and independently verify the present Workflow hardening: snapshot ownership, recovery, pause/activity semantics, persistence faulting, and real-clock scheduler coverage. Publish no future behavior in the shipped guide.
2. **Add generic MCP 2025-11-25 primitives.** Upgrade protocol negotiation first; implement Tasks, progress association, cancellation, pagination, status notifications, and resources/subscriptions as generic MCP mechanisms with protocol fixtures. Preserve the existing Tool boundary.
3. **Compose the `workflow` tool in MCP/application code.** Use Workflow's existing contract, runner, store, snapshots, activity, controls, recovery, and events. Return a durable handle promptly and keep execution in the server process. Do not add a Workflow dependency on MCP/Tool.
4. **Prove reconnect and authority.** Add transactional epoch/lease storage through existing Database/SQLite capabilities; test server restart, duplicate restorer, notification loss, cancellation races, and authorization changes. No Database/SQLite/IndexedDB republish is justified unless inspection finds a missing required primitive.
5. **Exercise native clients.** Capability-negotiate Claude Code, Codex, and Cursor rather than assuming Tasks support. Verify ordinary durable-id fallback and Tasks paths wherever each client actually supports them.
6. **Create Harness only for a real provider consumer.** Start with the Codex App Server adapter because it exposes the richest documented persistent protocol, then Claude native supervision, then Cursor headless/process ownership. Keep the package native-aware and narrow.
7. **Run live gates explicitly.** Opt-in credentials and installed CLIs only; never make ordinary unit gates depend on live provider availability.

Package baseline inspected on 2026-07-31: Workflow 0.0.7, Contract 0.0.9, Database 0.0.7, IndexedDB 0.0.6, SQLite 0.0.6, Tool 0.0.8, MCP 0.0.8, Agent 0.0.12, Terminal 0.0.5, Scaffold 0.0.13, and Workspace 0.0.2. Exact installed Workflow dependencies resolve to Contract 0.0.9 and Database 0.0.7. Versions record the inspected baseline; they do not imply feature support.

## Validation strategy

No mocks, module replacement, fake clocks, or fake provider behavior.

| Layer            | Deterministic coverage                                                                                                                                                                 | Live coverage                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Workflow         | Real entities/functions/stores; crash-boundary and pause/deadline cases; storage recorder/temporary database                                                                           | Existing package gates only                                                         |
| MCP              | Protocol-faithful fixture peer over real transport; capability permutations; Tasks lifecycle, polling, result, cancel, progress, resources, reconnect                                  | Each supported native client against a local server                                 |
| Provider adapter | Scripted executable/fixture server that speaks the provider's documented stream/protocol and owns a real child process; malformed/unknown frames, approval/input, resume, interruption | Opt-in installed CLI/App Server smoke with disposable workspace and bounded timeout |
| Persistence      | Temporary SQLite/database, real transactions, two competing restorers, epoch fencing, restart                                                                                          | Service restart with the same durable database                                      |

Live assertions must prove session/thread recovery, approval/input parking, process ownership, requested-cancel versus observed termination, redaction, and no duplicate launch. A provider unavailable or unauthenticated is a reported skipped opt-in gate, never simulated success.

## Acceptance criteria

- Workflow remains independent of Tool, MCP, Agent, Terminal, and Harness.
- Generic MCP Tasks/resources/progress pass protocol-conformance fixtures before Workflow uses them.
- `workflow start` promptly returns a durable handle and server execution survives client disconnect.
- Both negotiated Tasks and durable-id fallback paths resynchronize from authoritative state.
- `inspect`, `pause`, `resume`, `stop`, `steer`, and `reply` preserve the semantics and authority described above.
- Crash/race matrix cases have deterministic real-implementation tests, including two-restorer fencing.
- No integration auto-approves, reads secrets into journals, or claims process termination before observation.
- Native provider support is feature-detected and live-tested at the recorded version; unsupported features degrade to the documented fallback.
- Shipped guides describe only implemented behavior; this proposal is the sole home for future behavior until implementation lands.

## Open verification questions

- Which of Claude Code, Codex, and Cursor actually negotiates MCP 2025-11-25 Tasks, task-augmented tool calls, cancellation, resources, subscriptions, and elicitation at implementation time?
- Does the chosen MCP transport keep the server process alive independently of every supported client, or is a separate service host required?
- What transactional lease primitive and expiry policy best fit the deployed SQLite/server topology?
- Which provider operations acknowledge steering, reply, interrupt, and termination strongly enough to record as observed rather than requested?
- What tenant/workspace authorization model governs workflow ids, MCP task ids, resources, and native provider session identifiers?

These questions are release gates, not invitations to speculate in Workflow's public types.
