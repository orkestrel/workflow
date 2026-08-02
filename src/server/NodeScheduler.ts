import type { SchedulerInterface, SchedulerOptions } from '@src/core'
import { scheduleHost } from '@src/core'

/**
 * The Node {@link SchedulerInterface} — the server-native cooperative-yield backend.
 *
 * @remarks
 * - **`yield` is a `setImmediate` host-turn.** `yield()` waits on `setImmediate`, the
 *   canonical Node "give the host a turn" — it runs AFTER the current operation and
 *   any pending I/O callbacks, so the event loop genuinely regains control before
 *   resuming (unlike a microtask, which drains within the current task). `delay(ms)`
 *   waits on a real `setTimeout`.
 * - **Abort fidelity is verbatim.** A pending `yield` / `delay` rejects with
 *   `signal.reason` exactly. The shared `scheduleHost` lifecycle links an owned composite
 *   before arming either Node handle, so caller signal method mutation is harmless and the
 *   first completion, abort, or setup failure owns settlement and cleanup. It deliberately
 *   does NOT use `node:timers/promises`, whose `{ signal }` option replaces the caller reason
 *   with a Node `AbortError` (`code: 'ABORT_ERR'`).
 * - **Priority is accepted but a no-op.** Node has no priority primitive (no equivalent
 *   of the browser's `scheduler.postTask` priorities), so `options.priority` is accepted
 *   for contract compliance and ignored — every yield/delay is uniform.
 * - **Event-free.** A pure functional primitive — no Emitter, no events.
 *
 * @example
 * ```ts
 * import { createAbort } from '@orkestrel/abort'
 * import { NodeScheduler } from '@orkestrel/workflow/server'
 *
 * const abort = createAbort()
 * const scheduler = new NodeScheduler()
 * while (!abort.signal.aborted) {
 * 	doSomeWork()
 * 	await scheduler.yield({ signal: abort.signal }) // a setImmediate host-turn
 * }
 * ```
 */
export class NodeScheduler implements SchedulerInterface {
	/**
	 * Yield control back to the event loop via `setImmediate` so pending I/O and timers
	 * can run, then resume; abort rejects with `signal.reason`.
	 */
	yield(options?: SchedulerOptions): Promise<void> {
		return this.#immediate(options?.signal)
	}

	/**
	 * Resume after at least `ms` milliseconds via `setTimeout`; abort rejects with
	 * `signal.reason`.
	 *
	 * @remarks
	 * `ms` should be a non-negative finite number. The primitive does no validation: it
	 * passes `ms` straight to the host `setTimeout`, which clamps a negative value or
	 * `NaN` to ~0 — so an out-of-domain `ms` resolves on the next host turn rather than
	 * throwing.
	 */
	delay(ms: number, options?: SchedulerOptions): Promise<void> {
		return this.#sleep(ms, options?.signal)
	}

	// === Private

	// The Node-native immediate boundary; `scheduleHost` owns cancellation lifecycle.
	#immediate(signal?: AbortSignal): Promise<void> {
		return scheduleHost((complete) => {
			const handle = setImmediate(complete)
			return () => clearImmediate(handle)
		}, signal)
	}

	// The Node timer boundary; `scheduleHost` owns cancellation lifecycle.
	#sleep(ms: number, signal?: AbortSignal): Promise<void> {
		return scheduleHost((complete) => {
			const handle = setTimeout(complete, ms)
			return () => clearTimeout(handle)
		}, signal)
	}
}
