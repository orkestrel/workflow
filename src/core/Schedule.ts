import type { ScheduleInterface, ScheduleOptions } from './types.js'

/**
 * The safe cross-environment cooperative-yield default — a {@link ScheduleInterface}
 * built on `setTimeout` / `clearTimeout` alone, so it runs unchanged in both the
 * browser and Node.
 *
 * @remarks
 * - **Cross-environment.** Uses ONLY `setTimeout` / `clearTimeout` — universally
 *   available. It deliberately avoids env-specific fast paths (`setImmediate`,
 *   `schedule.yield`, `requestAnimationFrame`, `node:timers/promises`,
 *   `MessageChannel`); those belong to the environment backends, built with the
 *   agent loop that consumes them.
 * - **`yield` is a macrotask host-turn, not a microtask.** `yield()` waits on a
 *   `setTimeout(0)`, NOT `queueMicrotask`. A microtask drains before the host
 *   regains control, so it would not actually let pending I/O, timers, or
 *   rendering run — it only defers within the current task. A zero-delay timer is
 *   the correct cross-environment "give the host a turn".
 * - **Abort-aware.** A pending `yield` / `delay` rejects with `signal.reason` when
 *   the signal aborts (the standard `AbortSignal` convention). An already-aborted
 *   signal rejects immediately without arming a timer. Either settle path clears
 *   the timer and removes the abort listener — no leaked timer, no leaked
 *   listener, and no double-settle.
 * - **Priority is accepted but uniform.** `options.priority` is part of the
 *   contract, but a `setTimeout`-based default cannot act on urgency, so it treats
 *   every priority the same. Environment backends honour it.
 * - **Event-free.** A pure functional primitive — no Emitter, no events.
 *
 * @example
 * ```ts
 * const schedule = new Schedule()
 * while (!signal.aborted) {
 * 	doSomeWork()
 * 	await schedule.yield({ signal }) // let the host run between work units
 * }
 * ```
 */
export class Schedule implements ScheduleInterface {
	/**
	 * Yield control back to the host so other tasks (I/O, timers, rendering) can
	 * run, then resume — a macrotask turn via `setTimeout(0)` (NOT a microtask,
	 * which would resume before the host regains control).
	 */
	yield(options?: ScheduleOptions): Promise<void> {
		return this.#sleep(0, options?.signal)
	}

	/**
	 * Resume after at least `ms` milliseconds; abort rejects with `signal.reason`.
	 *
	 * @remarks
	 * `ms` should be a non-negative finite number. The primitive stays minimal and
	 * does no validation: it passes `ms` straight to the host `setTimeout`, which
	 * clamps a negative value or `NaN` to ~0 — so an out-of-domain `ms` resolves on
	 * the next host turn rather than throwing.
	 */
	delay(ms: number, options?: ScheduleOptions): Promise<void> {
		return this.#sleep(ms, options?.signal)
	}

	// A single abort-aware `setTimeout` sleep shared by `yield` (ms = 0) and
	// `delay`. Resolves after the timer fires; rejects with `signal.reason` if the
	// signal is already aborted (no timer armed) or aborts while pending.
	//
	// The two settle paths are mutually exclusive, and that is load-bearing: each
	// path disarms the other before settling. The timer path REMOVES the abort
	// listener before it resolves, so a later abort can no longer reach `reject`;
	// the abort path CLEARS the timer before it rejects, so the macrotask can no
	// longer reach `resolve`. Whichever fires first disarms the other — so the
	// promise settles exactly once, with no leaked timer and no leaked listener.
	// `{ once: true }` is a backstop against a double-abort, not the guarantee.
	#sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted === true) return Promise.reject(signal.reason)
		return new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(handle)
				reject(signal?.reason)
			}
			const handle = setTimeout(() => {
				signal?.removeEventListener('abort', onAbort) // load-bearing: prevents a post-resolve reject
				resolve()
			}, ms)
			signal?.addEventListener('abort', onAbort, { once: true })
		})
	}
}
