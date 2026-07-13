import type { AbortInterface } from '../aborts/index.js'
import type { EmitterInterface } from '../emitters/types.js'
import type { QueueExecution, QueueInterface } from '../workers/index.js'
import type { DeferredInterface } from '../types.js'
import type {
	RunnerEventMap,
	RunnerInterface,
	RunnerOptions,
	RunnerUnit,
	UnitOutcome,
} from './types.js'
import { createAbort } from '../aborts/index.js'
import { createQueue } from '../workers/index.js'
import { createDeferred } from '../helpers.js'
import { Emitter } from '../emitters/Emitter.js'
import { Controller } from './Controller.js'

/**
 * A thin generic orchestrator that drives declared units — and any they `spawn` —
 * through a bounded-concurrency {@link createQueue}, collecting ordered results.
 *
 * @remarks
 * - **Drives the Queue (no reimplemented concurrency).** Every unit (declared or
 *   spawned) is `enqueue`d on one internal `Queue`, so backpressure, FIFO ordering,
 *   bounded concurrency, retries, and the per-attempt timeout are all the Queue's —
 *   the Runner adds only orchestration (launching, ordering, draining, fail-fast).
 * - **Spawns actually run, results stay ordered (the B2 fix).** Declared inputs and
 *   `spawn`ed siblings flow through the SAME `#launch`, which appends the unit's `id`
 *   to an ordered `#order` list and records its settled value into `#values` by `id`.
 *   Results are read back as `#order.map(id => #values.get(id))` — declared first (in
 *   input order), then spawns (in spawn order). There is no one-time task snapshot,
 *   so a unit spawned mid-handler is run and ordered like any other.
 * - **`execute` awaits the full spawn closure via a count gate.** `#launch` increments
 *   an outstanding-unit `#count` BEFORE enqueuing and every settle decrements it,
 *   resolving the `#drained` deferred at zero. Because `spawn` calls `#launch` (so
 *   `#count += 1`) before the parent handler returns, the count never reaches zero
 *   mid-run — `execute` parks on `#drained` and so awaits the entire transitive
 *   closure, not just the declared units.
 * - **`spawn` is fire-and-track.** A spawned unit runs through the queue regardless of
 *   whether its promise is awaited; the Runner never awaits a spawned promise from
 *   within a handler's slot (it awaits the count gate instead), so a slot-holding
 *   handler can fan out without the Runner deadlocking it. (An inline `await` of a
 *   spawn by a bounded handler can still deadlock — that caveat is the caller's.)
 * - **Per-unit Controller + signal.** Each unit gets a `Controller` carrying its `id`,
 *   `input`, the unit's `Abort` (so `aborted` / `abort` delegate to it), and the queue
 *   attempt's `signal` (which ANY-combines the unit abort + runner abort + timeout). A
 *   `spawn` callback is injected so `controller.spawn(input)` delegates to `#launch`.
 * - **One-shot + fail-fast.** `execute` runs once (a second call throws). The first
 *   unit failure (after its retries) records the error and `abort()`s the run, so every
 *   sibling's signal fires; later failures are ignored and `execute` rejects with the
 *   first error. A user `abort(reason)` likewise rejects a running `execute`.
 * - **Observable (§13).** The owned {@link emitter} ({@link RunnerEventMap}) carries the run
 *   lifecycle — `start` / `unit` / `spawn` / `settle` / `fail` / `finish` / `abort` — for
 *   fire-and-forget observers. Every event is emitted directly, strictly AFTER the relevant
 *   launch / settle / drain transition; the emitter isolates a listener throw and routes it
 *   to its `error` handler (the `error` option), so a buggy observer can NEVER reorder, throw
 *   into, or corrupt the one-shot / fail-fast / spawn-tracking engine: the outstanding-unit
 *   count gate stays balanced and fail-fast still fires regardless of what a listener does.
 *   Observation is purely a side-channel.
 */
export class Runner<TInput, TResult> implements RunnerInterface<TInput, TResult> {
	readonly #handler: RunnerOptions<TInput, TResult>['handler']
	// The per-entry reliability resolver — spread into each enqueue so a unit's `retries` /
	// `timeout` OVERRIDE the queue-level defaults (the Queue resolves default→override). Optional:
	// with none supplied, the enqueue is byte-identical to the no-resolver path.
	readonly #entries: RunnerOptions<TInput, TResult>['entries']
	readonly #queue: QueueInterface<RunnerUnit<TInput>, TResult>
	// The PUSH observation surface (§13) — owned, never inherited. The emitter isolates a
	// listener throw (routing it to the `error` handler), so it can never escape into the
	// count gate / fail-fast / spawn tracking.
	readonly #emitter: Emitter<RunnerEventMap<TResult>>
	// Each unit's cancellation handle, by id — aborted en masse on a runner abort.
	readonly #aborts = new Map<string, AbortInterface>()
	// The launch order of every unit (declared, then spawns) — the result ordering.
	readonly #order: string[] = []
	// Each unit's settled value, by id — boxed so presence is tracked by map membership
	// (not by an `undefined` sentinel), correct even when `TResult` includes `undefined`.
	readonly #values = new Map<string, { readonly value: TResult }>()
	// Outstanding (launched-but-unsettled) units; `#drained` resolves when it hits 0.
	#count = 0
	#drained: DeferredInterface<void> | undefined
	#started = false
	#running = false
	#stopped = false
	// The first unit failure (fail-fast) — `execute` rejects with it once drained.
	#failure: { readonly error: unknown } | undefined

	constructor(options: RunnerOptions<TInput, TResult>) {
		this.#handler = options.handler
		this.#entries = options.entries
		this.#emitter = new Emitter<RunnerEventMap<TResult>>({ on: options?.on, error: options?.error })
		this.#queue = createQueue<RunnerUnit<TInput>, TResult>({
			handler: (unit, execution) => this.#dispatch(unit, execution),
			concurrency: options.concurrency,
			retries: options.retries,
			timeout: options.timeout,
		})
	}

	get emitter(): EmitterInterface<RunnerEventMap<TResult>> {
		return this.#emitter
	}

	get active(): number {
		return this.#count
	}

	get stopped(): boolean {
		return this.#stopped
	}

	async execute(inputs: readonly TInput[]): Promise<readonly TResult[]> {
		if (this.#started) throw new Error('runner has already executed')
		if (this.#stopped) throw new Error('runner is stopped')
		this.#started = true
		this.#running = true
		// Observe the run beginning — AFTER the one-shot / stopped guards passed and the run is
		// marked started + running, so a swallowed listener throw can't perturb the launch.
		this.#emitter.emit('start')
		// An empty run has nothing to drain — resolve to [] without arming the gate.
		if (inputs.length === 0) {
			this.#running = false
			// The (trivially) settled batch — observe `finish` with the empty result.
			this.#emitter.emit('finish', [])
			return []
		}
		const drained = createDeferred<void>()
		this.#drained = drained
		for (const input of inputs) void this.#launch(input)
		await drained.promise
		this.#running = false
		if (this.#failure !== undefined) throw this.#failure.error
		// The batch drained successfully — observe `finish` with the ordered results, AFTER the
		// drained gate resolved and the fail-fast check passed (a failed run throws above and
		// emits no `finish`; its per-unit `fail` + run-level `abort` already fired).
		const results = this.#collect()
		this.#emitter.emit('finish', results)
		return results
	}

	abort(reason?: unknown): void {
		if (this.#stopped) return
		// Record an abort as the run's failure (if none yet) so a parked `execute` rejects
		// rather than returning partial results. Preserve the caller's `reason` verbatim —
		// it is the same value the unit signals carry (the abort flows to each unit's
		// signal), and symmetric with `#settle`, which stores `outcome.error` as-is — only
		// synthesizing an Error when no reason was given. The `#failure === undefined` guard
		// keeps the FIRST failure (a fail-fast handler error recorded in `#settle` before its
		// own `this.abort(...)` call) from being overwritten by the abort's write.
		if (this.#running && this.#failure === undefined) {
			this.#failure = { error: reason === undefined ? new Error('runner aborted') : reason }
		}
		this.#cancel(reason)
		this.#queue.abort(reason)
		this.#stopped = true
		// Observe the abort — AFTER every unit's signal fired, the backing queue was aborted,
		// and the run was marked stopped, so a swallowed listener throw can't perturb the
		// cancel. Idempotent at the top (a second `abort` returns early), so this fires once.
		this.#emitter.emit('abort', reason)
	}

	destroy(): void {
		if (this.#stopped) {
			this.#queue.destroy()
			return
		}
		this.abort()
		this.#queue.destroy()
	}

	// Launch one unit (a declared input or a spawned sibling) through the shared queue.
	// Increments `#count` BEFORE enqueuing — so a spawn keeps the count above zero until
	// the spawned unit itself settles, making `execute` await the full closure (B2). The
	// settle bookkeeping records the value / first failure and drains at zero. A `parent`
	// (present only for a `spawn`) means this is a sub-unit — observe it as a `spawn` AFTER
	// the unit's id is minted, tracked, and the count incremented (so the gate already
	// accounts for it), BEFORE enqueuing; a declared launch (no parent) emits no `spawn`.
	#launch(input: TInput, parent?: string): Promise<TResult> {
		const id = crypto.randomUUID()
		const abort = createAbort()
		this.#aborts.set(id, abort)
		this.#order.push(id)
		this.#count += 1
		if (parent !== undefined) this.#emitter.emit('spawn', id, parent)
		// Resolve the unit's per-entry reliability overrides (`retries` / `timeout`) from its input
		// and spread them into the enqueue AFTER the Runner-managed `id` / `signal` — the Queue
		// resolves default→override, so a resolved value wins over the queue-level default and an
		// absent one (or no resolver at all) falls back to it (byte-identical to the prior behavior).
		const promise = this.#queue.enqueue(
			{ id, input },
			{ id, signal: abort.signal, ...this.#entries?.(input) },
		)
		promise.then(
			(value) => this.#settle(id, { ok: true, value }),
			(error: unknown) => this.#settle(id, { ok: false, error }),
		)
		return promise
	}

	// The queue handler for one unit: build its Controller over the attempt signal and
	// run the user handler against it. The unit's own `Abort` was passed as the entry
	// signal, so `execution.signal` already fires on unit abort, runner abort, or timeout
	// — expose THAT as `controller.signal` (covering all three); `abort` / `aborted`
	// delegate to the unit `Abort` via the Controller.
	#dispatch(unit: RunnerUnit<TInput>, execution: QueueExecution): Promise<TResult> | TResult {
		// `#launch` always stores the unit's `Abort` BEFORE enqueuing, so this lookup is an
		// invariant, never optional. Assert it (§12 programmer-error guard — narrows to a
		// defined `Abort` without `!`) rather than fabricating a fresh, unlinked abort: a
		// fallback `Abort` would be divorced from this entry's `execution.signal`, silently
		// severing the unit's cancellation while the type still type-checked.
		const abort = this.#aborts.get(unit.id)
		if (abort === undefined) throw new Error('unit abort missing')
		const controller = new Controller<TInput, TResult>(
			unit.id,
			unit.input,
			abort,
			execution.signal,
			(input) => this.#spawn(input, unit.id),
		)
		// Observe the unit beginning — the queue has dequeued it and is about to run its
		// handler (mirrors the Queue's own `start`); AFTER the invariant abort lookup, BEFORE
		// the user handler runs, so a swallowed listener throw can't perturb the dispatch.
		this.#emitter.emit('unit', unit.id)
		return this.#handler(controller)
	}

	// `controller.spawn(input)` — only valid DURING a run; routes the sibling through
	// the same `#launch` (and thus the queue), so it actually runs and is ordered. The
	// spawning unit's `parent` id flows through so `#launch` can observe the `spawn`.
	#spawn(input: TInput, parent: string): Promise<TResult> {
		if (!this.#running) throw new Error('spawn is unavailable outside an active run')
		return this.#launch(input, parent)
	}

	// Record one unit's outcome, then decrement the outstanding count and drain at zero.
	// The FIRST failure is fail-fast: store it and `abort()` so every sibling's signal
	// fires; later failures (incl. the abort-induced rejections) are ignored. A success
	// boxes its value by id (presence by membership, so `undefined` is a valid result).
	#settle(id: string, outcome: UnitOutcome<TResult>): void {
		if (outcome.ok) {
			this.#values.set(id, { value: outcome.value })
			// Observe the successful unit — AFTER its value is recorded (the unit is settled);
			// the emit only OBSERVES it and runs before the count decrement, so it cannot
			// perturb the drain that follows.
			this.#emitter.emit('settle', id)
		} else if (this.#failure === undefined) {
			this.#failure = { error: outcome.error }
			// Observe the FIRST (fail-fast) failure — AFTER the error is recorded, BEFORE the
			// cascade `abort()` (so observers see cause `fail` then effect `abort`). Only the
			// first failure emits `fail`; the abort-induced sibling rejections are ignored
			// (they fall through neither branch), matching fail-fast's "later failures ignored".
			this.#emitter.emit('fail', id, outcome.error)
			this.abort(outcome.error)
		}
		this.#count -= 1
		// `#count` is incremented once per launch and decremented once per settle, so it
		// reaches exactly 0 — assert that honestly. `<= 0` would mask an over-decrement
		// regression (a double-settle) as a silent early drain; `=== 0` surfaces it instead.
		if (this.#count === 0) this.#drained?.resolve()
	}

	// Read every settled value back in launch order (declared first, then spawns) — by
	// map membership, so a `TResult` of `undefined` is preserved (not treated as absent).
	#collect(): readonly TResult[] {
		const results: TResult[] = []
		for (const id of this.#order) {
			const box = this.#values.get(id)
			if (box !== undefined) results.push(box.value)
		}
		return results
	}

	// Abort every tracked unit's cancellation handle (fires each Controller's signal).
	#cancel(reason: unknown): void {
		for (const abort of this.#aborts.values()) abort.abort(reason)
	}
}
