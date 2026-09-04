import type { SchedulerInterface, SchedulerOptions } from '@src/core'
import type { AnyFunction } from '@orkestrel/contract'
import type { IdleInterface } from './types.js'
import { delayHost, scheduleHost } from '@src/core'
import { isFunction } from '@orkestrel/contract'

/**
 * Implements the idle-time {@link SchedulerInterface} — a browser cooperative-yield backend whose
 * `yield` resumes when the host is idle through `requestIdleCallback`, falling back to a
 * zero-delay macrotask where it is absent.
 *
 * @remarks
 * - **`yield` resumes during idle time.** When `globalThis` exposes `requestIdleCallback`,
 *   `yield()` waits on it, so the resumption happens when the browser has spare time after
 *   rendering and input — ideal for low-priority background work that must not contend with
 *   the user. The capability is feature-detected through a guard (`isFunction`), never an
 *   `as`. Where the API is absent (Safari today), it **falls back** to a
 *   `setTimeout(0)` macrotask — still a real host-turn, not idle-gated. `delay(ms)` is
 *   always a real `setTimeout`. `options.priority` is accepted for contract compliance but a
 *   no-op — idle scheduling has no priority dimension.
 * - **Abort fidelity is verbatim, with cleanup.** The shared `scheduleHost` lifecycle links
 *   an owned settlement composite before scheduling, never invokes caller-owned signal
 *   methods, and cancels the idle callback or fallback timer when abort wins.
 * - **Event-free.** A pure functional primitive — no Emitter, no events.
 *
 * @example
 * ```ts
 * import { createAbort } from '@orkestrel/abort'
 * import { IdleScheduler } from '@orkestrel/workflow/browser'
 *
 * const abort = createAbort()
 * const scheduler = new IdleScheduler()
 * while (!abort.signal.aborted) {
 * 	doLowPriorityWork()
 * 	await scheduler.yield({ signal: abort.signal }) // resume when the host is idle
 * }
 * ```
 */
export class IdleScheduler implements SchedulerInterface {
	/**
	 * Yields control to the host until it is idle through `requestIdleCallback` (or a
	 * `setTimeout(0)` macrotask where the API is absent), then resumes; abort rejects with
	 * `signal.reason`.
	 */
	yield(options?: SchedulerOptions): Promise<void> {
		const idle = this.#idleCallback()
		if (idle === undefined) return delayHost(0, options?.signal)
		return this.#idle(idle, options?.signal)
	}

	/**
	 * Resumes after at least `ms` milliseconds through `setTimeout`; abort rejects with
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

	// Feature-detect `requestIdleCallback` / `cancelIdleCallback` off `globalThis` through
	// guards (no `as`): both must be callable. Returns the narrowed pair, or `undefined`
	// when the API is absent (the macrotask fallback).
	#idleCallback(): IdleInterface | undefined {
		const request: unknown = Reflect.get(globalThis, 'requestIdleCallback')
		const cancel: unknown = Reflect.get(globalThis, 'cancelIdleCallback')
		if (!isFunction(request) || !isFunction(cancel)) return undefined
		return {
			request: this.#request.bind(this, request),
			cancel: this.#cancel.bind(this, cancel),
		}
	}

	// The idle yield boundary; `scheduleHost` owns cancellation lifecycle.
	#idle(idle: IdleInterface, signal?: AbortSignal): Promise<void> {
		return scheduleHost((complete) => {
			const handle = idle.request(complete)
			return () => idle.cancel(handle)
		}, signal)
	}

	#request(request: AnyFunction, callback: () => void): number {
		return Number(Reflect.apply(request, globalThis, [callback]))
	}

	#cancel(cancel: AnyFunction, handle: number): void {
		Reflect.apply(cancel, globalThis, [handle])
	}
}
