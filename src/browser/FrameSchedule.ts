import type { ScheduleInterface, ScheduleOptions } from '@src/core'

/**
 * The frame-aligned {@link ScheduleInterface} — a browser cooperative-yield backend
 * whose `yield` resumes just before the next paint via `requestAnimationFrame`.
 *
 * @remarks
 * - **`yield` resumes before the next paint.** `yield()` waits on `requestAnimationFrame`,
 *   so the resumption is aligned to the browser's render loop — ideal for work that
 *   should batch per frame (animation, incremental DOM updates) and pause while the tab
 *   is hidden (the host throttles rAF). `delay(ms)` is a real `setTimeout`, unaligned to
 *   frames. `options.priority` is accepted for contract compliance but a no-op — a frame
 *   callback has no priority dimension.
 * - **Abort fidelity is verbatim, with cleanup.** A pending `yield` / `delay` rejects with
 *   `signal.reason` exactly. The discipline mirrors the cross-environment default's
 *   `#sleep`: an already-aborted signal rejects immediately WITHOUT scheduling a frame;
 *   otherwise the frame is requested and a `{ once: true }` abort listener attached, and
 *   the two settle paths are mutually exclusive — the frame path removes the listener
 *   before resolving, and the abort path `cancelAnimationFrame`s the pending handle before
 *   rejecting. The promise settles exactly once, with no leaked frame request and no
 *   leaked listener.
 * - **Event-free.** A pure functional primitive — no Emitter, no events.
 *
 * @example
 * ```ts
 * import { createAbort } from '@src/core'
 * import { FrameSchedule } from '@src/browser'
 *
 * const abort = createAbort()
 * const schedule = new FrameSchedule()
 * while (!abort.signal.aborted) {
 * 	renderOneFrameOfWork()
 * 	await schedule.yield({ signal: abort.signal }) // resume before the next paint
 * }
 * ```
 */
export class FrameSchedule implements ScheduleInterface {
	/**
	 * Yield control to the host until just before the next paint via
	 * `requestAnimationFrame`, then resume; abort rejects with `signal.reason`.
	 */
	yield(options?: ScheduleOptions): Promise<void> {
		return this.#frame(options?.signal)
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

	// The `requestAnimationFrame` host-turn for `yield`. Resolves in the next frame
	// callback (before paint); rejects with `signal.reason` if already aborted (no frame
	// requested) or aborted while pending. Settle-once, no leak: the frame path removes the
	// abort listener before resolving; the abort path cancels the frame before rejecting.
	#frame(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted === true) return Promise.reject(signal.reason)
		return new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				cancelAnimationFrame(handle)
				reject(signal?.reason)
			}
			const handle = requestAnimationFrame(() => {
				signal?.removeEventListener('abort', onAbort) // load-bearing: prevents a post-resolve reject
				resolve()
			})
			signal?.addEventListener('abort', onAbort, { once: true })
		})
	}

	// The abort-aware `setTimeout` sleep for `delay`. Same settle-once discipline as the
	// core `#sleep`: already-aborted → reject without arming; the timer path removes the
	// listener before resolving; the abort path clears the timer before rejecting with the
	// verbatim `signal.reason`.
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
