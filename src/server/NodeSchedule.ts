import type { ScheduleInterface, ScheduleOptions } from '@src/core'

/**
 * The Node {@link ScheduleInterface} — the server-native cooperative-yield backend.
 *
 * @remarks
 * - **`yield` is a `setImmediate` host-turn.** `yield()` waits on `setImmediate`, the
 *   canonical Node "give the host a turn" — it runs AFTER the current operation and
 *   any pending I/O callbacks, so the event loop genuinely regains control before
 *   resuming (unlike a microtask, which drains within the current task). `delay(ms)`
 *   waits on a real `setTimeout`.
 * - **Abort fidelity is verbatim.** A pending `yield` / `delay` rejects with
 *   `signal.reason` exactly — the value the caller passed, never wrapped or replaced.
 *   The discipline mirrors the cross-environment default's `#sleep`: an already-aborted
 *   signal rejects immediately WITHOUT arming a timer; otherwise the timer is armed and
 *   a `{ once: true }` abort listener attached, and the two settle paths are mutually
 *   exclusive — the timer path removes the listener before resolving (so a later abort
 *   cannot reach `reject`), and the abort path clears the timer before rejecting (so the
 *   macrotask cannot reach `resolve`). The promise settles exactly once, with no leaked
 *   timer and no leaked listener. It deliberately does NOT use `node:timers/promises`,
 *   whose `{ signal }` option rejects with a Node `AbortError` (`code: 'ABORT_ERR'`)
 *   rather than the caller's `signal.reason` — that would break reason fidelity, so the
 *   timer and listener are hand-rolled to match the contract.
 * - **Priority is accepted but a no-op.** Node has no priority primitive (no equivalent
 *   of the browser's `schedule.postTask` priorities), so `options.priority` is accepted
 *   for contract compliance and ignored — every yield/delay is uniform.
 * - **Event-free.** A pure functional primitive — no Emitter, no events.
 *
 * @example
 * ```ts
 * import { createAbort } from '@src/core'
 * import { NodeSchedule } from '@src/server'
 *
 * const abort = createAbort()
 * const schedule = new NodeSchedule()
 * while (!abort.signal.aborted) {
 * 	doSomeWork()
 * 	await schedule.yield({ signal: abort.signal }) // a setImmediate host-turn
 * }
 * ```
 */
export class NodeSchedule implements ScheduleInterface {
	/**
	 * Yield control back to the event loop via `setImmediate` so pending I/O and timers
	 * can run, then resume; abort rejects with `signal.reason`.
	 */
	yield(options?: ScheduleOptions): Promise<void> {
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
	delay(ms: number, options?: ScheduleOptions): Promise<void> {
		return this.#sleep(ms, options?.signal)
	}

	// === Private

	// The `setImmediate` host-turn for `yield`. Resolves after the immediate callback
	// fires (after the current operation and pending I/O); rejects with `signal.reason`
	// if the signal is already aborted (no immediate armed) or aborts while pending.
	// The two settle paths disarm each other: the immediate path removes the abort
	// listener before resolving; the abort path clears the immediate before rejecting —
	// so it settles exactly once, with no leaked handle and no leaked listener.
	#immediate(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted === true) return Promise.reject(signal.reason)
		return new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				clearImmediate(handle)
				reject(signal?.reason)
			}
			const handle = setImmediate(() => {
				signal?.removeEventListener('abort', onAbort) // load-bearing: prevents a post-resolve reject
				resolve()
			})
			signal?.addEventListener('abort', onAbort, { once: true })
		})
	}

	// The abort-aware `setTimeout` sleep for `delay`. Same settle-once discipline as
	// `#immediate`, with a timer in place of the immediate: an already-aborted signal
	// rejects without arming; otherwise the timer path removes the listener before
	// resolving and the abort path clears the timer before rejecting with `signal.reason`.
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
