import type { AbortInterface } from '../aborts/index.js'
import type { ControllerInterface } from './types.js'

/**
 * The per-unit handle a runner handler receives — wraps the unit's identity,
 * input, cancellation, and the run controls (`wait` / `spawn` / `abort`).
 *
 * @remarks
 * - **Built by the Runner per unit.** The runner constructs one `Controller` per
 *   unit it dispatches, handing it the unit's `id`, `input`, the unit's `Abort`
 *   handle, the queue attempt's `signal`, and a `spawn` callback that launches a
 *   sibling through the same queue.
 * - **Signal.** `signal` is the queue attempt's signal, which ANY-combines the
 *   unit's own abort, the runner-level abort (the runner aborts every unit), and
 *   the per-attempt timeout — so it fires on any of the three. `aborted` and
 *   `abort(reason)` delegate to the unit's `Abort` (the cancellation source of
 *   truth); since the attempt signal ANY-includes that abort, `abort()` fires
 *   `signal` too.
 * - **`wait` promise-parks (never a timer).** It resolves the instant the unit's
 *   `signal` fires (immediately if already aborted) via a one-shot listener — no
 *   `setTimeout`, no polling, no busy-yield — so a parked unit costs no CPU.
 * - **`spawn` is fire-and-track.** It delegates to the runner's launch-a-sibling
 *   callback, which routes the sibling through the queue; the runner's `execute`
 *   awaits the spawn closure, so the sibling runs whether or not its promise is
 *   awaited. (Inline-awaiting a spawn from a slot-holding handler on a bounded
 *   runner can deadlock — fan out instead; see {@link ControllerInterface.spawn}.)
 * - **Event-free by design.** The per-unit handle carries no Emitter; observe the
 *   {@link RunnerInterface.emitter} instead (`unit` / `spawn` / `settle` / `fail` carry the id).
 */
export class Controller<TInput, TResult> implements ControllerInterface<TInput, TResult> {
	readonly id: string
	readonly input: TInput
	readonly signal: AbortSignal
	// The unit's cancellation handle — the source of truth for `aborted` / `abort`.
	readonly #abort: AbortInterface
	// The runner's launch-a-sibling callback — routes a spawn through the queue.
	readonly #spawn: (input: TInput) => Promise<TResult>

	constructor(
		id: string,
		input: TInput,
		abort: AbortInterface,
		signal: AbortSignal,
		spawn: (input: TInput) => Promise<TResult>,
	) {
		this.id = id
		this.input = input
		this.#abort = abort
		this.signal = signal
		this.#spawn = spawn
	}

	get aborted(): boolean {
		return this.#abort.aborted
	}

	wait(): Promise<void> {
		// Promise-park on the unit's signal — resolve immediately if already aborted,
		// else on the one-shot 'abort' event. No timer, no poll (the B1 fix).
		if (this.signal.aborted) return Promise.resolve()
		return new Promise<void>((resolve) => {
			this.signal.addEventListener('abort', () => resolve(), { once: true })
		})
	}

	spawn(input: TInput): Promise<TResult> {
		return this.#spawn(input)
	}

	abort(reason?: unknown): void {
		this.#abort.abort(reason)
	}
}
