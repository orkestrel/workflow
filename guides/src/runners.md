# Runner

> The orchestration-over-execution link: a `Runner` turns a set of declared work units into handler calls and **drives the workers [`Queue`](workers.md)** so they genuinely run. It owns no concurrency engine of its own — backpressure, bounded `concurrency`, `retries`, and the per-attempt `timeout` are all the Queue's; the Runner adds only orchestration (launching, ordering, draining, fail-fast). `execute(inputs)` runs the unit set ONCE and resolves their results **in declared order**, regardless of completion order. Each handler receives a `Controller` — the unit's `id` / `input`, a `signal` that fires on the unit's `abort`, a runner-level `abort`, or the attempt's timeout, a promise-parked `wait()`, and `spawn(input)` to fan out sibling units mid-run. Spawned units flow through the SAME queue (so they actually run, in FIFO wake order) and join the output after the declared units; `execute` awaits the **full transitive spawn closure** via a live outstanding-unit count, never a one-time task snapshot. The run is **fail-fast** — the first unit failure (after its retries) aborts every sibling and rejects. And it is **observable** — a typed `emitter` (AGENTS §13) carries the run lifecycle for fire-and-forget observers (see [Observing](#observing)); emitting is purely a side-channel, so a buggy observer can never reorder, corrupt the count gate, or break fail-fast.
>
> Deliberately small. It is the runtime link from work to workers — NOT a scheduler (no priority, no progress channels), and NOT the declarative `Workflow → Phase → Task` tracking tree (that is separate, deferred). This is the piece scsr never wired — its `WorkflowRunner` ran handlers directly via `Promise.all` and never delegated to its `Queue` — recreated lean over the Queue substrate with scsr's two bugs fixed: its busy-yield `wait` is now promise-parked, and its stale spawn snapshot is now a live id-list + result map. Source: [`src/core/runners`](../../src/core/runners). Surfaced through the `@src/core` barrel.

## Surface

Create a runner over a handler, then `execute` a set of inputs and await their ordered results:

```ts
import { createRunner } from '@src/core'

const runner = createRunner<number, number>({
	concurrency: 4, // up to four units in flight at once (default 1 = ordered)
	retries: 1, // one extra attempt per unit on failure
	timeout: 5_000, // each attempt is bounded to 5s
	handler: (controller) => controller.input * 10,
})

const results = await runner.execute([1, 2, 3]) // [10, 20, 30]
```

`execute` runs every declared input (and anything they `spawn`) to completion and returns their results **in declared order** — even when units finish out of order. It is **one-shot** (a second call throws) and **fail-fast** (the first failure aborts the rest and rejects). The `emitter` (the push observation surface, see [Observing](#observing)), `active` (outstanding units), and `stopped` members report live state; `abort` cancels the run and `destroy` tears it down.

The interesting power is `spawn`: a handler that discovers more work fans it out as sibling units mid-run. Spawns join the output after the declared inputs, in spawn order, and `execute` does not resolve until the whole closure drains:

```ts
import { createRunner } from '@src/core'

const runner = createRunner<number, number>({
	concurrency: 4,
	handler: (controller) => {
		// Fan out a sibling per declared unit — fire-and-track (do NOT await it inline).
		if (controller.input < 10) controller.spawn(controller.input + 100)
		return controller.input
	},
})

const results = await runner.execute([1, 2, 3]) // [1, 2, 3, 101, 102, 103]
```

### Factories

| API            | Kind     | Summary                                                                                      |
| -------------- | -------- | -------------------------------------------------------------------------------------------- |
| `createRunner` | function | Create a `RunnerInterface` over a handler — drives a `Queue`, ordered + fail-fast `execute`. |

### Entities

| API          | Kind  | Summary                                                                                |
| ------------ | ----- | -------------------------------------------------------------------------------------- |
| `Runner`     | class | The orchestrator — drives a `Queue`, ordered result aggregation, fail-fast, one-shot.  |
| `Controller` | class | The per-unit handle a handler receives — `id` / `input` / `signal` + `wait` / `spawn`. |

### Types

| Type                  | Kind      | Shape                                                                                                               |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| `ControllerInterface` | interface | The per-unit handle — `id` / `input` / `signal` / `aborted` data members + `wait` / `spawn` / `abort` methods.      |
| `RunnerHandler`       | type      | `(controller) => Promise<TResult> \| TResult` — runs one unit's work against its `Controller`.                      |
| `RunnerOptions`       | interface | `createRunner` options — `handler` + `concurrency?` / `retries?` / `timeout?` / `entries?` / `on?` / `error?`.      |
| `RunnerEntryOptions`  | interface | The per-entry reliability overrides for one unit — `{ retries?, timeout? }`, resolved from its input via `entries`. |
| `RunnerInterface`     | interface | `emitter` / `active` / `stopped` data members + `execute` / `abort` / `destroy` methods.                            |
| `RunnerEventMap`      | type      | The `Runner`'s observable events — `start` / `unit` / `spawn` / `settle` / `fail` / `finish` / `abort`.             |
| `RunnerUnit`          | interface | One tracked unit's queue payload — `id` (keys its order + value) + `input` (the handler's work).                    |
| `UnitOutcome`         | type      | One unit's settled outcome — `{ ok: true; value }` \| `{ ok: false; error }`, so `undefined` is still a success.    |

Those two interfaces split across this section and the next: their `readonly` data members are the Surface rows above — `ControllerInterface`'s `id` / `input` / `signal` / `aborted`, and `RunnerInterface`'s `emitter` (the typed push observation surface, see [Observing](#observing)) / `active` / `stopped` — while their call-signature methods are documented under [Methods](#methods).

## Methods

The public methods of `RunnerInterface` and `ControllerInterface` — every call-signature member listed (their `readonly` data members stay Surface rows). Each class (`Runner` / `Controller`) implements its interface exactly, so this doubles as each class's instance-method surface (AGENTS §22).

#### `RunnerInterface`

`execute` runs the declared units (and their spawns) once and resolves ordered results; `abort` / `destroy` are the §10 lifecycle verbs. The `active` / `stopped` counts are Surface rows.

| Method    | Returns                       | Behavior                                                                                                                      |
| --------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `execute` | `Promise<readonly TResult[]>` | Run all `inputs` and their spawns to completion; resolve results in order (declared first, then spawns). One-shot; fail-fast. |
| `abort`   | `void`                        | Cancel every in-flight + pending unit (and the backing queue); a running `execute` rejects.                                   |
| `destroy` | `void`                        | Tear the runner down — `abort` then stop the backing queue; idempotent.                                                       |

#### `ControllerInterface`

`wait` parks until the unit's signal aborts; `spawn` fans out a sibling unit; `abort` cancels this unit. The `id` / `input` / `signal` / `aborted` members are Surface rows.

| Method  | Returns            | Behavior                                                                                                                   |
| ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `wait`  | `Promise<void>`    | Park until the unit's `signal` aborts — promise-parked, never a timer; resolves immediately if already aborted.            |
| `spawn` | `Promise<TResult>` | Add a sibling unit to the run through the same queue; returns its result promise. Fire-and-track — do NOT await it inline. |
| `abort` | `void`             | Cancel this unit — fires its `signal` with the optional reason.                                                            |

## Contract

These invariants hold across `src/core/runners` ↔ `runners.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` / `type` row in the `## Surface` tables is a real export of the runner module, and every export appears as a Surface row — exhaustive, both directions (AGENTS §22).
2. **Drives the Queue — no reimplemented concurrency.** The `Runner` owns one internal [`Queue`](workers.md) and `enqueue`s every unit on it, so backpressure, FIFO ordering, bounded `concurrency`, `retries`, and the per-attempt `timeout` are all the Queue's behavior — the Runner never re-implements a concurrency loop, it only orchestrates (launching, ordering, draining, fail-fast). The runner-level `retries` / `timeout` become the Queue's queue-level defaults. An optional `entries(input)` resolver yields a `RunnerEntryOptions` (`{ retries?, timeout? }`) per unit, spread into the `enqueue` AFTER the Runner-managed `id` / `signal`: a resolved field OVERRIDES the queue default, an omitted one (or no resolver) falls back to it. This completes the Queue's existing per-entry primitive rather than bypassing it — with no `entries`, the enqueue is byte-identical to the no-override path.
3. **Every unit — declared AND spawned — runs through the one queue.** Declared inputs and `spawn`ed siblings flow through the SAME launch path and the SAME queue, so a unit spawned mid-handler is dequeued and run exactly like a declared one (in FIFO wake order). There is no separate execution path for spawns. (The B2 fix: scsr snapshotted the task list once, so spawned tasks never ran and results came from a stale array — the Runner routes everything through the live queue instead.)
4. **Ordered result aggregation via an id-list + result map.** Each launched unit appends its `id` to an ordered list and records its settled value into a map keyed by `id`; `execute` reads results back by mapping the ordered id-list through the value map. So results are deterministic regardless of completion order — declared inputs first (in input order), then spawned units (in spawn order) — never a one-time task snapshot. A `TResult` of `undefined` is preserved (presence is tracked by map membership, not an `undefined` sentinel).
5. **`execute` awaits the full transitive spawn closure (count gate).** The Runner tracks an outstanding-unit count: every launch increments it BEFORE enqueuing and every settle decrements it, resolving a `drained` deferred at zero. Because `spawn` launches its sibling (incrementing the count) BEFORE the parent handler returns, the count never reaches zero mid-run — so `execute` (parked on `drained`) awaits the entire transitive closure, declared units and every descendant spawn, not just the declared inputs. An empty `execute([])` resolves to `[]` immediately.
6. **`wait` promise-parks — never a timer.** `controller.wait()` resolves the instant the unit's `signal` fires (immediately if already aborted) via a one-shot `'abort'` listener — no `setTimeout`, no `delay`, no busy-yield, no poll. A parked unit consumes no CPU until it is actually cancelled. (The B1 fix: scsr's `wait` busy-yielded via `setTimeout(0)`; the Runner's parks on the signal.)
7. **`spawn` is fire-and-track + the inline-await deadlock caveat.** A spawned unit runs through the queue regardless of whether its promise is awaited (clause 5), and the Runner never awaits a spawned promise from within a handler's queue slot — it awaits the count gate instead. So a handler can fan out siblings and return without the Runner deadlocking it. The caller, however, must NOT `await` a `spawn`ed promise INLINE from within a handler on a bounded-`concurrency` runner: the handler holds its queue slot while awaiting, and if every slot is held by a handler awaiting its own spawn, no slot is free to run the spawns and the run deadlocks. The intended pattern is fan-out — `spawn` and return.
8. **`spawn` is valid only during an active run.** `controller.spawn(input)` throws `'spawn is unavailable outside an active run'` if called before `execute` or after the run has settled — a captured `controller` cannot leak spawns into a finished or unstarted run.
9. **One-shot `execute`.** `execute` runs the unit set once; a second call throws `'runner has already executed'`. Calling `execute` on a stopped (aborted / destroyed) runner throws `'runner is stopped'`. To run another set, create a new runner.
10. **Fail-fast aborts the siblings.** The FIRST unit failure (a handler rejection after its `retries` are exhausted, or a per-attempt timeout that exhausts them) records the error and `abort()`s the run, firing every other unit's `signal` so in-flight siblings observe cancellation; subsequent failures (including the abort-induced rejections) are ignored. `execute` rejects with that first error once the run drains. A user `abort(reason)` during a run likewise records a failure so `execute` rejects rather than returning partial results.
11. **Per-unit `Controller` + signal wiring.** Each unit gets a `Controller` carrying its `id`, `input`, the unit's [`Abort`](aborts.md) handle (so `aborted` / `abort` delegate to it), and the queue attempt's `signal`. Because the unit's `Abort.signal` is passed to the queue as the entry signal, the attempt's `signal` ANY-combines the unit abort, the runner-level abort, and the per-attempt [`Timeout`](timeouts.md) — so `controller.signal` fires on any of the three, and `controller.abort()` (firing the unit abort) fires `controller.signal` too.
12. **DOC ↔ SOURCE method bijection.** The `## Methods` tables list exactly the public methods of `RunnerInterface` / `ControllerInterface` — exhaustive, both directions — and `Runner` / `Controller` each expose the same public methods as their interface, no more (AGENTS §22).
13. **Observable + scoped.** The `Runner` owns a typed `Emitter` (AGENTS §13) exposed as `readonly emitter` (`RunnerEventMap<TResult>` — `start` / `unit` / `spawn` / `settle` / `fail` / `finish` / `abort`) and accepts the reserved `on?` initial-listeners hook plus the `error?` listener-error handler. **Emitting is observation-only** — the emitter isolates a listener throw (routing it to the `error` handler, never a domain event) and every event sits strictly AFTER the relevant unit-launch / settle / drain transition, so a buggy observer can NEVER reorder, throw into, or corrupt the one-shot / fail-fast / spawn-tracking engine: the outstanding-unit count gate stays balanced and fail-fast still fires regardless of what a listener does. It is the runtime orchestration link only; the declarative `Workflow → Phase → Task` tracking tree is deliberately NOT here (separate, deferred).

## Observing

The `Runner` exposes a typed `emitter` (AGENTS §13) carrying its run lifecycle for fire-and-forget observers — logging, metrics, tracing. Subscribe via `runner.emitter.on(...)`, or wire initial listeners through the reserved `on?` option; supply an `error?` handler to receive a listener's throw. **Emitting is observation-only**: every event fires strictly AFTER the relevant unit-launch / settle / drain transition, so a listener can never change what the run does — and a throwing listener can never corrupt it (see the safety guarantee below).

```ts
import { createRunner } from '@src/core'

const runner = createRunner<Job, Output>({
	handler: (controller) => run(controller.input),
	on: { finish: (results) => console.log(`done: ${results.length}`) }, // initial listener
})

runner.emitter.on('unit', (id) => trace.begin(id))
runner.emitter.on('fail', (id, error) => log.warn(`unit ${id} failed`, error))
```

The `RunnerEventMap<TResult>` vocabulary:

| Event    | Payload         | Fires when                                                                      |
| -------- | --------------- | ------------------------------------------------------------------------------- |
| `start`  | `[]`            | `execute` begins (once per run).                                                |
| `unit`   | `[id]`          | A unit's handler begins running (declared or spawned).                          |
| `spawn`  | `[id, parent?]` | A sub-unit is spawned — its id + the spawning parent's id.                      |
| `settle` | `[id]`          | A unit completed successfully (its value recorded).                             |
| `fail`   | `[id, error]`   | The FIRST unit failure (fail-fast) — its id + the error.                        |
| `finish` | `[results]`     | The batch settled OK — the ordered results (the same array `execute` resolves). |
| `abort`  | `[reason]`      | The run was aborted — fail-fast cascade, a user `abort`, or `destroy`.          |

A successful run fires `start` → `unit`/`settle` per unit → `finish`. A failure fires `fail` (the first failure only — later failures are ignored) then the run-level `abort`, and `execute` rejects WITHOUT a `finish`. A user `abort` fires `abort` (the units are cancelled, not failed, so no `fail`).

**The listener-isolation safety guarantee.** A listener throw is NEVER allowed to escape into the engine: the emitter isolates it and routes it to its OWN `error` handler (the `error` option, surfaced as `(error, event)`), NOT to a domain event — so a buggy observer is isolated yet not silently lost. The `error` handler runs in its own try/catch, so even a throwing handler can't recurse or escape; with no handler, the throw is swallowed silently. Every throwing listener surfaces (not just the first). Because every emit sits after the unit-launch / settle / drain transition AND is isolated, a buggy observer **cannot corrupt the one-shot / fail-fast / spawn-tracking engine**: the outstanding-unit count gate stays balanced (the run still drains, never truncates or hangs) and fail-fast still rejects with the first error — proven by the emit-safety tests.

## Patterns

### Run a set of units

```ts
import { createRunner } from '@src/core'

// Ordered (concurrency defaults to 1): each unit runs to completion before the next.
const runner = createRunner<Job, Output>({ handler: (controller) => run(controller.input) })

const outputs = await runner.execute(jobs) // results in input order
```

### Bounded concurrency

```ts
// Up to 5 units in flight at once; the rest wait for a slot (the Queue's backpressure).
const runner = createRunner<string, Response>({
	concurrency: 5,
	handler: (controller) => fetch(controller.input, { signal: controller.signal }),
})

const responses = await runner.execute(urls)
```

### Per-entry retries / timeout

```ts
// The runner-level retries / timeout are the defaults; `entries` overrides them per unit
// (its result is a RunnerEntryOptions — { retries?, timeout? }). An omitted field falls back.
const runner = createRunner<Job, Output>({
	retries: 0, // the default for every unit…
	handler: (controller) => run(controller.input, controller.signal),
	entries: (job) => (job.flaky ? { retries: 3 } : {}), // …overridden per input
})
```

### Fan out with `spawn`

```ts
// A handler discovers more work and fans it out as sibling units — they run through the
// same queue and their results join the output after the declared units, in spawn order.
const runner = createRunner<Task, Result>({
	concurrency: 8,
	handler: (controller) => {
		for (const child of discover(controller.input)) {
			controller.spawn(child) // fire-and-track — do NOT await inline (deadlock caveat)
		}
		return process(controller.input)
	},
})

const results = await runner.execute(roots) // declared roots first, then every spawn
```

`spawn` returns the sibling's result promise, but the run drains it whether or not you await it — so fan out and return. On a bounded runner, awaiting a spawn _inline_ from a slot-holding handler can deadlock; let the runner drain the closure instead.

### React to cancellation

```ts
const runner = createRunner<Job, Output>({
	concurrency: 4,
	handler: async (controller) => {
		const work = run(controller.input, controller.signal) // honour the signal
		await Promise.race([work, controller.wait()]) // wait() parks until cancelled
		return work
	},
})
```

A handler should observe its `controller.signal` (pass it to `fetch` / child aborts) and may `await controller.wait()` to park until the unit is cancelled — the wait is promise-parked, so it costs nothing until the signal fires.

### Fail-fast + abort

```ts
const runner = createRunner<Job, Output>({
	concurrency: 4,
	handler: (controller) => run(controller.input, controller.signal),
})
const run = runner.execute(jobs)

// The first unit to throw (after its retries) aborts the rest and rejects the run; an
// external abort does the same.
runner.abort(new Error('shutting down'))
await run.catch((error) => report(error))
```

### Practices

- **Honour `controller.signal`** — pass it to `fetch` / child aborts and bail when it fires, so a fail-fast or an `abort` actually stops in-flight units instead of just abandoning their results.
- **Fan out, don't await inline** — `spawn` siblings and return; the run drains the whole closure. Awaiting a spawn inline from a bounded handler risks a slot-starvation deadlock.
- **`concurrency: 1` for ordering** — there is no separate sequential flag; a concurrency of one runs units one-at-a-time.
- **One-shot** — a `Runner` runs one `execute`; create a new one to run another set.
- **Observe, don't drive** — subscribe to `runner.emitter` for run lifecycle moments (see [Observing](#observing)); emitting is a pure side-channel, so a listener never changes what the run does (and a throwing one can't corrupt it).

## Tests

- [`tests/guides/parity.test.ts`](../../tests/guides/src/parity.test.ts) — the `## Surface` ↔ `src/core/runners` bijection (value + type exports) and the `RunnerInterface` / `ControllerInterface` ↔ `Runner` / `Controller` method bijection.
- [`tests/src/core/runners/Runner.test.ts`](../../tests/src/core/runners/Runner.test.ts) — `execute` runs every input and returns results in declared order (even with out-of-order completion); spawned siblings actually run and order after the declared units (the B2 regression); nested spawns drain transitively; bounded concurrency caps handlers in flight; `retries` re-run a flaky unit; fail-fast (one unit throwing rejects `execute` AND fires the siblings' signals); `abort()` mid-run rejects `execute` and aborts every unit; one-shot (a second `execute` throws); `spawn` outside a run throws; empty `execute([])` resolves to `[]`; `active` / `stopped` reporting; idempotent `destroy`.
- [`tests/src/core/runners/Controller.test.ts`](../../tests/src/core/runners/Controller.test.ts) — `wait()` resolves when the unit's signal aborts and stays pending across real delays until it does (the B1 regression — promise-parked, not timer-polled), resolving immediately if already aborted; `id` / `input` / `signal` / `aborted` reflect the unit; `abort(reason)` fires the signal with the reason; `spawn` delegates to the injected callback.
- [`tests/src/core/runners/factories.test.ts`](../../tests/src/core/runners/factories.test.ts) — `createRunner` round-trip: fan-out via `spawn` with ordered results, and concurrency / retries options honoured end to end.

## See also

- [`workers.md`](workers.md) — the `Queue` the Runner drives (bounded concurrency, retries, per-attempt timeout) and the `Worker` / `Pool` it builds on.
- [`aborts.md`](aborts.md) — the cancellation primitive each unit's `Controller` carries (the unit abort the runner fires en masse).
- [`timeouts.md`](timeouts.md) — the deadline primitive behind the per-attempt timeout the unit's `signal` reflects.
- [`AGENTS.md`](../../AGENTS.md) — the rules; §10 lifecycle, §4.1 single-word members, §21 minimal-interface, §22 documentation-as-contracts.
- [`README.md`](README.md) — the guides index.
