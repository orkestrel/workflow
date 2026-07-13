# Schedulers

> The cooperative host-yield primitive: a loop decides _what_ to do; the scheduler decides _when_ the host regains control. A `SchedulerInterface` exposes exactly two abort-aware methods — `yield()` (hand the host a turn so pending I/O, timers, and rendering can run, then resume) and `delay(ms)` (resume after at least `ms`). It is the **rhythm** of the substrate, distinct from its two neighbours: the [runner](runners.md) decides _what_ runs, the [workers](workers.md) decide _how much_ runs at once, and the scheduler decides _when_ the host gets control back — the beat a long-running agent loop yields against to stay responsive.
>
> What it deliberately is **not**: a job queue, a cron, a debounce/throttle utility, or an event source. There is no scheduling _table_ — just "give the host a turn now" and "resume after a delay", both cancellable. The cross-environment default `Scheduler` is built on `setTimeout` alone, so the same instance runs unchanged in browser and Node with zero feature detection; when a host has a better native yield, an **environment backend** swaps _only_ the `yield` primitive onto it (Node's `setImmediate`; the browser's `scheduler.postTask` / `requestAnimationFrame` / `requestIdleCallback`) while preserving the abort semantics byte-for-byte. Pure and functional, **event-free for now** — no Emitter, no `on` hook; observability is a separate deferred pass. Source: [`src/core/schedulers`](../../src/core/schedulers) (the primitive) · [`src/browser/schedulers`](../../src/browser/schedulers) · [`src/server/schedulers`](../../src/server/schedulers) (the backends). The core surfaces through `@src/core`; each backend through `@src/browser` / `@src/server`.

## Surface

Create a scheduler, then cooperatively yield to the host between units of work, or delay between attempts:

```ts
import { createAbort, createScheduler } from '@src/core'

const abort = createAbort()
const scheduler = createScheduler()

while (!abort.signal.aborted) {
	doSomeWork()
	await scheduler.yield({ signal: abort.signal }) // give the host a turn, then resume
}
```

The distinction that makes `yield()` useful: it waits on a zero-delay **macrotask**, not a microtask. A microtask (`queueMicrotask`, a bare `await`) drains _before_ the host regains control, so it only defers within the current task — pending I/O, timers, and rendering never get a turn. A macrotask is the correct cross-environment "let the host run", so a microtask queued _after_ a `yield()` call resolves before the yield does. `delay(ms)` resumes after at least `ms`; the primitive stays minimal and does no validation, so a negative `ms` or `NaN` is clamped to ~0 by the host `setTimeout` (resolving on the next turn) rather than throwing. Both are abort-aware: pass `options.signal` and a pending call rejects with the signal's `reason` the moment it aborts — clearing the timer and removing the listener, so there is nothing left to fire. `options.priority` is accepted for contract compliance but treated uniformly here (a `setTimeout`-based default cannot act on urgency); environment backends honour it.

### Factories

| API               | Kind     | Summary                                                                       |
| ----------------- | -------- | ----------------------------------------------------------------------------- |
| `createScheduler` | function | Create the cross-environment `setTimeout`-based default `SchedulerInterface`. |

### Entities

| API         | Kind  | Summary                                                                                      |
| ----------- | ----- | -------------------------------------------------------------------------------------------- |
| `Scheduler` | class | The cross-environment cooperative-yield default — `yield` / `delay` over `setTimeout` alone. |

### Types

| Type                 | Kind      | Shape                                                                                                        |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `SchedulerPriority`  | type      | `'user' \| 'normal' \| 'background'` — a relative urgency hint (uniform in the default; backends honour it). |
| `SchedulerOptions`   | interface | `{ priority?: SchedulerPriority; signal?: AbortSignal }` — options for a single `yield` / `delay`.           |
| `SchedulerInterface` | interface | The `yield` / `delay` cooperative-yield methods.                                                             |

`SchedulerInterface` is all call-signature methods — documented under [Methods](#methods); it has no `readonly` data members.

### Environment backends

Beyond the cross-environment default, each host has a native cooperative-yield primitive a `yield()` should reach for; the backends are standalone `SchedulerInterface` implementations (no shared engine — unlike the [databases](databases.md) query engine, there are only two methods to write per environment) that swap the `yield` primitive while keeping the **exact** abort semantics: a pending `yield` / `delay` rejects with `signal.reason` _verbatim_, an already-aborted signal rejects without arming, and either settle path clears the underlying handle and removes the abort listener (no leak, no double-settle). Each backend's `delay(ms)` is a real `setTimeout`; only the `yield` primitive differs.

The **Node** backend ships in [`src/server/schedulers`](../../src/server/schedulers), surfaced through `@src/server`. `NodeScheduler.yield()` waits on `setImmediate` — the canonical Node "give the event loop a turn", running after the current operation and pending I/O. It deliberately does **not** use `node:timers/promises` (whose `{ signal }` option rejects with a Node `AbortError`, `code: 'ABORT_ERR'`, _not_ the caller's `reason`); the timer and abort listener are hand-rolled to forward `signal.reason` verbatim. `priority` is accepted but a no-op — Node has no priority primitive.

The **browser** backends ship in [`src/browser/schedulers`](../../src/browser/schedulers), surfaced through `@src/browser`, one per host-turn strategy. All three feature-detect their native API through guards (`isRecord` / `isFunction` from `@src/core`), never an `as` (AGENTS §14), and fall back to a real macrotask where it is absent:

- `BrowserScheduler.yield()` posts to the **Prioritized Task Scheduling API** (`scheduler.postTask`) at the mapped priority (`user` → `'user-blocking'`, `normal` → `'user-visible'`, `background` → `'background'`) — so the urgency hint is honoured — falling back to a `setTimeout(0)` macrotask where `scheduler.postTask` is absent (Firefox today). The caller's `signal` is **not** handed to `postTask` (whose own abort rejects with a platform `AbortError`, not the caller's `reason`); an internal controller cancels the posted task while the scheduler rejects with the verbatim `signal.reason`.
- `FrameScheduler.yield()` resumes just before the next paint via `requestAnimationFrame` (and `cancelAnimationFrame` on abort) — for work that should batch per render frame and naturally pause while the tab is hidden. `priority` is a no-op.
- `IdleScheduler.yield()` resumes when the host is idle via `requestIdleCallback` (and `cancelIdleCallback` on abort), falling back to a `setTimeout(0)` macrotask where it is absent (Safari today) — for low-priority background work that must not contend with rendering or input. `priority` is a no-op.

| API                | Kind  | Summary                                                                                                                               |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `NodeScheduler`    | class | The Node backend — `yield` over `setImmediate`, verbatim abort fidelity (hand-rolled, not `node:timers/promises`); priority a no-op.  |
| `BrowserScheduler` | class | The browser backend — `yield` over `scheduler.postTask` at the mapped priority, falling back to a macrotask; verbatim abort fidelity. |
| `FrameScheduler`   | class | The frame-aligned browser backend — `yield` over `requestAnimationFrame` (resume before paint); priority a no-op; verbatim abort.     |
| `IdleScheduler`    | class | The idle-time browser backend — `yield` over `requestIdleCallback`, falling back to a macrotask; priority a no-op; verbatim abort.    |

| API                      | Kind     | Summary                                                                                                 |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `createNodeScheduler`    | function | Create the Node-native `SchedulerInterface` (`yield` over `setImmediate`).                              |
| `createBrowserScheduler` | function | Create the browser-native `SchedulerInterface` (`yield` over `scheduler.postTask`, macrotask fallback). |
| `createFrameScheduler`   | function | Create the frame-aligned `SchedulerInterface` (`yield` over `requestAnimationFrame`).                   |
| `createIdleScheduler`    | function | Create the idle-time `SchedulerInterface` (`yield` over `requestIdleCallback`, macrotask fallback).     |

The browser backends also publish two supporting members through `@src/browser`: the `POST_TASK_PRIORITY` map `BrowserScheduler` reads to translate a portable `SchedulerPriority` into a `scheduler.postTask` priority level, and the `IdleAPI` shape of the feature-detected `requestIdleCallback` / `cancelIdleCallback` pair `IdleScheduler` narrows to (or resolves to `undefined`, falling back to a macrotask).

| Type      | Kind      | Shape                                                                                                            |
| --------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `IdleAPI` | interface | `{ request: (callback) => number; cancel: (handle) => void }` — the feature-detected `requestIdleCallback` pair. |

| API                  | Kind  | Summary                                                                                                                                               |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST_TASK_PRIORITY` | const | The `SchedulerPriority` → `scheduler.postTask` priority map (`user` → `'user-blocking'`, `normal` → `'user-visible'`, `background` → `'background'`). |

Each backend is a standalone `implements SchedulerInterface`, so its public methods are exactly `yield` / `delay` — the same [Methods](#methods) table below governs every one (AGENTS §22).

## Methods

The public methods of `SchedulerInterface` — every call-signature member listed. `Scheduler` and every environment backend (`NodeScheduler` / `BrowserScheduler` / `FrameScheduler` / `IdleScheduler`) implement the interface exactly, so this doubles as each class's instance-method surface (AGENTS §22).

#### `SchedulerInterface`

`yield` hands the host a turn (a macrotask, so the host actually runs) and resumes; `delay` resumes after a minimum interval. Both reject with `signal.reason` when an optional `options.signal` aborts.

| Method  | Returns         | Behavior                                                                                                            |
| ------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `yield` | `Promise<void>` | Yield control to the host (a `setTimeout(0)` macrotask, NOT a microtask), then resume. Abort rejects with `reason`. |
| `delay` | `Promise<void>` | Resume after at least `ms` milliseconds. Abort before the deadline rejects with `reason` and clears the timer.      |

## Contract

These invariants hold across the schedulers source tree ↔ `schedulers.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` / `type` row in the `## Surface` tables is a real export of the schedulers source tree (`src/core/schedulers` plus the `src/server/schedulers` and `src/browser/schedulers` backends), and every export appears as a Surface row — exhaustive, both directions (AGENTS §22).
2. **Cross-environment `setTimeout` default.** `Scheduler` uses ONLY `setTimeout` / `clearTimeout` — universally available in browser and Node — so the default runs unchanged in either. It deliberately avoids env-specific fast paths (`setImmediate`, `scheduler.yield`, `requestAnimationFrame`, `node:timers/promises`, `MessageChannel`); those belong to the environment backends.
3. **`yield` is a macrotask host-turn, not a microtask.** `yield()` waits on a zero-delay `setTimeout`, not `queueMicrotask`. A microtask drains before the host regains control, so it would only defer within the current task — it would NOT let pending I/O, timers, or rendering run. A macrotask is the correct cross-environment "give the host a turn", so a microtask queued after a `yield()` call resolves before the yield does.
4. **Abort-aware, with full cleanup.** A pending `yield` / `delay` rejects with `signal.reason` (the standard `AbortSignal` convention) when its `options.signal` aborts. An already-aborted signal rejects immediately WITHOUT arming a timer. Either settle path — the timer firing or the signal aborting — clears the timer and removes the abort listener: no leaked timer, no leaked listener, and no double-settle.
5. **Priority accepted but uniform.** `options.priority` is part of the contract, but a `setTimeout`-based default cannot act on urgency, so it treats every priority the same. It is accepted without error and does not change behavior; environment backends honour it.
6. **Event-free (for now).** A pure functional primitive: no Emitter, no `EventMap`, no `on` hook. Observability is a separate deferred pass (the ROADMAP), so the surface above stays minimal.
7. **Environment backends honour priority and the native primitive; abort semantics are identical.** Each backend (`NodeScheduler` over `setImmediate`; `BrowserScheduler` over `scheduler.postTask`, `FrameScheduler` over `requestAnimationFrame`, `IdleScheduler` over `requestIdleCallback`) is a standalone `SchedulerInterface` that changes only the `yield` primitive — `delay(ms)` stays a real `setTimeout` — and preserves the contract's abort discipline byte-for-byte: reject with `signal.reason` verbatim, no arming when pre-aborted, full handle + listener cleanup on either settle path, settle-once. Native APIs are feature-detected through guards (`isRecord` / `isFunction`), never an `as` (AGENTS §14), with a real-macrotask fallback where absent. `NodeScheduler` does **not** delegate to `node:timers/promises` (it would replace `signal.reason` with a Node `AbortError`); the timer is hand-rolled. `BrowserScheduler` honours `priority` via `postTask`'s priority levels; the others accept `priority` as a documented no-op.
8. **The Worker/Runner hook stays deferred.** The optional `scheduler?` hook threaded into Worker / Runner is built **with the agent loop** (its real consumer), not here — no current consumer needs it, and the Agent already yields directly. This chunk ships the backends, not that wiring.
9. **DOC ↔ SOURCE method bijection.** The `## Methods` table lists exactly `SchedulerInterface`'s public methods — exhaustive, both directions — and `Scheduler` plus every backend (`NodeScheduler` / `BrowserScheduler` / `FrameScheduler` / `IdleScheduler`) exposes the same public methods, no more (AGENTS §22).

## Patterns

### Cooperative loop — yield the host a turn between work units

The dominant use: a long-running loop that periodically hands the host control so it stays responsive, checking an abort signal each pass.

```ts
import { createAbort, createScheduler } from '@src/core'

const abort = createAbort()
const scheduler = createScheduler()

async function pump(): Promise<void> {
	while (!abort.signal.aborted) {
		processOneItem()
		// Give the host a turn (I/O, timers, rendering); abort rejects out of the loop.
		await scheduler.yield({ signal: abort.signal })
	}
}
```

### Backoff — delay a growing interval between attempts

`delay(ms)` waits at least `ms`; pair it with an exponential interval for a retry backoff, and pass a `signal` to bail early.

```ts
import { createScheduler } from '@src/core'

const scheduler = createScheduler()

async function withBackoff(attempt: () => Promise<boolean>, signal?: AbortSignal): Promise<void> {
	for (let n = 0; n < 5; n += 1) {
		if (await attempt()) return
		await scheduler.delay(2 ** n * 100, { signal }) // 100ms, 200ms, 400ms, …
	}
}
```

### Swap the backend — depend on the interface, choose the native primitive at the edge

Every scheduler is the same `SchedulerInterface`, so consumers type against the interface and never name a concrete class. Pick the host-native backend once at the composition root; the loop is identical regardless of which `yield` primitive runs underneath.

```ts
import type { SchedulerInterface } from '@src/core'
import { createNodeScheduler } from '@src/server' // setImmediate yield
import { createIdleScheduler } from '@src/browser' // requestIdleCallback yield

// Choose per environment at the edge…
const scheduler: SchedulerInterface = isServer ? createNodeScheduler() : createIdleScheduler()

// …then write the loop once against the portable interface.
async function pump(work: () => void, signal: AbortSignal): Promise<void> {
	while (!signal.aborted) {
		work()
		await scheduler.yield({ signal })
	}
}
```

### Practices

- **`yield` to stay cooperative** — between units of long-running work, `await scheduler.yield()` so the host can flush I/O, fire timers, and paint; never busy-loop a tight synchronous loop that starves the host.
- **Always thread a `signal`** — pass `options.signal` through `yield` / `delay` so cancellation rejects the pending wait at once (with the signal's `reason`) instead of stalling until the interval elapses; an aborted loop should fall out via that rejection, not a polled flag alone.
- **`delay` for spacing, `yield` for a turn** — reach for `delay(ms)` to space retries or paced work; reach for `yield()` (a zero-delay turn) when you only need to let the host run before continuing.
- **Type against the interface** — depend on `SchedulerInterface`, not a concrete class, and pick the backend at the composition root, so the same loop runs on any host.
- **No events yet** — this is a functional primitive; do not reach for an Emitter here (observability is a separate deferred pass).

## Tests

- [`tests/guides/parity.test.ts`](../../tests/guides/src/parity.test.ts) — the `## Surface` ↔ source bijection across `src/core/schedulers` and the `src/server/schedulers` + `src/browser/schedulers` backends (value + type exports), and the `SchedulerInterface` ↔ method bijection for `Scheduler` and every backend class.
- [`tests/src/core/schedulers/Scheduler.test.ts`](../../tests/src/core/schedulers/Scheduler.test.ts) — `yield()` resolves asynchronously and as a macrotask (a microtask queued after it runs first), `yield` / `delay` reject with `signal.reason` when pre-aborted and when aborted while pending, `delay(ms)` resolves after `ms` (fake timers), an abort before the deadline clears the timer so it never later fires (no double-settle), a completed call leaves no pending timer or listener, and `priority` is accepted (across `yield` / `delay`, combined with `signal`) without changing behavior. Production-hardening: thousands of resolved AND aborted `yield` / `delay` calls never accumulate host timers (`vi.getTimerCount()` → 0) and the abort listener nets to zero across churn (the real signal's add/remove directly counted); one shared `AbortSignal` rejects ALL its pending operations with the reason and clears every timer/listener with no double-settle; many concurrent `delay`s at distinct deadlines each resolve at exactly their own time; abort-timing edges (pre-aborted arms no timer, abort at the exact deadline tick settles once, abort after resolution is inert); the `ms` clamp for `0` / `1` / negative / `NaN` / very large; and the reason is forwarded verbatim (a bare `abort()` yields the platform `AbortError` `DOMException`, never `undefined`; strings and objects pass by identity).
- [`tests/src/core/schedulers/factories.test.ts`](../../tests/src/core/schedulers/factories.test.ts) — `createScheduler` returns a working `SchedulerInterface` whose `yield` and `delay` round-trip and whose `delay` is abort-aware, and returns independent stateless instances (aborting a signal bound to one does not affect another).
- [`tests/src/server/schedulers/NodeScheduler.test.ts`](../../tests/src/server/schedulers/NodeScheduler.test.ts) — the Node backend over REAL `setImmediate` / `setTimeout`: `yield()` resolves as a `setImmediate` macrotask (a microtask queued after it runs first — real timers, since fake timers don't reorder the two), `delay(ms)` resolves after `ms` with a `vi.getTimerCount()` leak proof (fake timers), already-aborted `yield` / `delay` rejects with the EXACT `signal.reason` (a bare `abort()` → the platform `AbortError` `DOMException`, never a Node `AbortError`; a custom `Error` / string / object reason → that value by identity) WITHOUT arming, an abort during a pending `delay` clears the timer (no leak), a completed call removes its abort listener (counted on a real `AbortController` signal), priority is an accepted no-op, and churn leaves zero pending timers / a balanced listener net.
- [`tests/src/server/schedulers/factories.test.ts`](../../tests/src/server/schedulers/factories.test.ts) — `createNodeScheduler` returns a working `SchedulerInterface` (shape + a real yield/delay round-trip), abort-aware, independent stateless instances.
- [`tests/src/browser/schedulers/BrowserScheduler.test.ts`](../../tests/src/browser/schedulers/BrowserScheduler.test.ts) — the browser backend in REAL headless Chromium (where `scheduler.postTask` exists, so the native path is under test): `yield()` resolves via the real `postTask` callback, every priority is accepted, abort rejects with the verbatim `signal.reason` (custom object by identity, a bare `abort()` → `DOMException`) and the posted task is cancelled (no double-settle), `delay` timing, and a completed call leaves no abort listener. The macrotask fallback is covered by the guard logic + a note (the native API is never faked away).
- [`tests/src/browser/schedulers/FrameScheduler.test.ts`](../../tests/src/browser/schedulers/FrameScheduler.test.ts) — the frame backend in REAL Chromium over `requestAnimationFrame` (fake timers are the wrong tool for rAF): `yield()` resolves in a real frame callback, abort cancels the rAF handle and rejects with the verbatim reason, `delay` timing, and no leaked listener.
- [`tests/src/browser/schedulers/IdleScheduler.test.ts`](../../tests/src/browser/schedulers/IdleScheduler.test.ts) — the idle backend in REAL Chromium over `requestIdleCallback` (the native path is under test): `yield()` resolves in a real idle callback, abort cancels the idle handle and rejects with the verbatim reason, `delay` timing, and no leaked listener; the `setTimeout(0)` fallback (for engines without rIC) is covered by the guard logic + a note.
- [`tests/src/browser/schedulers/factories.test.ts`](../../tests/src/browser/schedulers/factories.test.ts) — `createBrowserScheduler` / `createFrameScheduler` / `createIdleScheduler` each return a working `SchedulerInterface` (shape + a real yield/delay round-trip), abort-aware, independent instances, in real Chromium.

## See also

- [`runners.md`](runners.md) — the orchestrator (_what_ runs); the scheduler is the rhythm (_when_ the host resumes), distinct from orchestration.
- [`workers.md`](workers.md) — the concurrency engine (_how much_ runs at once).
- [`aborts.md`](aborts.md) / [`timeouts.md`](timeouts.md) — the cancellation + deadline primitives a scheduled loop bounds itself with.
- [`AGENTS.md`](../../AGENTS.md) — the rules; §4.1 single-word members, §21 minimal interface, §22 documentation-as-contracts.
- [`README.md`](README.md) — the guides index.
