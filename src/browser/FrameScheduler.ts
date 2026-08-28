import type { SchedulerInterface, SchedulerOptions } from '@src/core'
import { delayHost, scheduleHost } from '@src/core'

/**
 * The frame-aligned {@link SchedulerInterface} — a browser cooperative-yield backend
 * whose `yield` resumes just before the next paint through `requestAnimationFrame`.
 *
 * @remarks
 * - **`yield` resumes before the next paint.** `yield()` waits on `requestAnimationFrame`,
 *   so the resumption is aligned to the browser's render loop — ideal for work that
 *   batches per frame (animation, incremental DOM updates) and pauses while the tab is
 *   hidden (the host throttles rAF). `delay(ms)` is a real `setTimeout`, unaligned to
 *   frames. `options.priority` is accepted for contract compliance but a no-op — a frame
 *   callback has no priority dimension.
 * - **Abort fidelity is verbatim, with cleanup.** The shared `scheduleHost` lifecycle links
 *   an owned settlement composite before requesting a frame, never invokes caller-owned
 *   signal methods, and cancels the native handle when abort wins.
 * - **Event-free.** A pure functional primitive — no Emitter, no events.
 *
 * @example
 * ```ts
 * import { createAbort } from '@orkestrel/abort'
 * import { FrameScheduler } from '@orkestrel/workflow/browser'
 *
 * const abort = createAbort()
 * const scheduler = new FrameScheduler()
 * while (!abort.signal.aborted) {
 * 	renderOneFrameOfWork()
 * 	await scheduler.yield({ signal: abort.signal }) // resume before the next paint
 * }
 * ```
 */
export class FrameScheduler implements SchedulerInterface {
	/**
	 * Yield control to the host until just before the next paint through
	 * `requestAnimationFrame`, then resume; abort rejects with `signal.reason`.
	 */
	yield(options?: SchedulerOptions): Promise<void> {
		return this.#frame(options?.signal)
	}

	/**
	 * Resume after at least `ms` milliseconds through `setTimeout`; abort rejects with
	 * `signal.reason`.
	 *
	 * @remarks
	 * Pass a non-negative finite `ms`. The primitive does no validation: it passes `ms`
	 * straight to the host `setTimeout`, which clamps a negative value or `NaN` to ~0 — so an
	 * out-of-domain `ms` resolves on the next host turn rather than throwing.
	 */
	delay(ms: number, options?: SchedulerOptions): Promise<void> {
		return delayHost(ms, options?.signal)
	}

	// === Private

	// The frame request boundary; `scheduleHost` owns cancellation lifecycle.
	#frame(signal?: AbortSignal): Promise<void> {
		return scheduleHost((complete) => {
			const handle = requestAnimationFrame(complete)
			return () => cancelAnimationFrame(handle)
		}, signal)
	}
}
