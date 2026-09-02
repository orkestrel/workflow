import type { SchedulerInterface, SchedulerOptions } from './types.js'
import { delayHost } from './helpers.js'

/**
 * Implements the safe cross-environment cooperative-yield default — a {@link SchedulerInterface}
 * built on `setTimeout` / `clearTimeout` alone, so it runs unchanged in both the
 * browser and Node.
 *
 * @remarks
 * - **Cross-environment.** Uses ONLY `setTimeout` / `clearTimeout` — universally
 *   available. It deliberately avoids env-specific fast paths (`setImmediate`,
 *   `scheduler.yield`, `requestAnimationFrame`, `node:timers/promises`,
 *   `MessageChannel`); those belong to the environment backends, built with the
 *   agent loop that consumes them.
 * - **`yield` is a macrotask host-turn, not a microtask.** `yield()` waits on a
 *   `setTimeout(0)`, NOT `queueMicrotask`. A microtask drains before the host
 *   regains control, so it would not actually let pending I/O, timers, or
 *   rendering run — it only defers within the current task. A zero-delay timer is
 *   the correct cross-environment "give the host a turn".
 * - **Abort-aware.** A pending `yield` / `delay` rejects with `signal.reason` exactly.
 *   {@link delayHost} links an owned settlement composite to the caller before arming
 *   the timer, so pre-abort schedules nothing, caller signal method mutation is harmless,
 *   cancellation clears the handle, and native first-settlement wins exactly once.
 * - **Priority is accepted but uniform.** `options.priority` is part of the
 *   contract, but a `setTimeout`-based default cannot act on urgency, so it treats
 *   every priority the same. Environment backends honour it.
 * - **Event-free.** A pure functional primitive — no Emitter, no events.
 *
 * @example
 * ```ts
 * const scheduler = new Scheduler()
 * while (!signal.aborted) {
 * 	doSomeWork()
 * 	await scheduler.yield({ signal }) // let the host run between work units
 * }
 * ```
 */
export class Scheduler implements SchedulerInterface {
	/**
	 * Yields control back to the host so other tasks (I/O, timers, rendering) can
	 * run, then resumes — a macrotask turn through `setTimeout(0)` (NOT a microtask,
	 * which would resume before the host regains control).
	 */
	yield(options?: SchedulerOptions): Promise<void> {
		return delayHost(0, options?.signal)
	}

	/**
	 * Resumes after at least `ms` milliseconds; abort rejects with `signal.reason`.
	 *
	 * @remarks
	 * Pass a non-negative finite `ms`. The primitive stays minimal and does no
	 * validation: it passes `ms` straight to the host `setTimeout`, which clamps a
	 * negative value or `NaN` to ~0 — so an out-of-domain `ms` resolves on the next
	 * host turn rather than throwing.
	 */
	delay(ms: number, options?: SchedulerOptions): Promise<void> {
		return delayHost(ms, options?.signal)
	}
}
