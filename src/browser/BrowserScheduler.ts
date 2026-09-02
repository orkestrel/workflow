import type { SchedulerInterface, SchedulerOptions, SchedulerPriority } from '@src/core'
import { delayHost, scheduleHost } from '@src/core'
import { isFunction, isPromise, isRecord } from '@orkestrel/contract'
import { POST_TASK_PRIORITY } from './constants.js'

/**
 * Implements the browser {@link SchedulerInterface} — the browser-native cooperative-yield backend
 * built on the Prioritized Task Scheduling API (`scheduler.postTask`), falling back to a
 * zero-delay macrotask where it is absent.
 *
 * @remarks
 * - **`yield` prefers `scheduler.postTask`, honouring priority.** When `globalThis`
 *   exposes a `scheduler` with a `postTask` method, `yield()` posts a task at the mapped
 *   priority (`user` → `'user-blocking'`, `normal` → `'user-visible'`, `background` →
 *   `'background'`), so the host genuinely regains control and the urgency hint is
 *   honoured. The capability is feature-detected through guards (`isRecord` / `isFunction`),
 *   never an `as` (AGENTS §14). Where the API is absent (Firefox today, older engines),
 *   it **falls back** to a `setTimeout(0)` macrotask — still a real host-turn, without
 *   priority. `delay(ms)` is always a real `setTimeout`.
 * - **Abort fidelity is verbatim.** The shared `scheduleHost` lifecycle links an owned
 *   settlement composite before scheduling, preserving the exact caller reason without
 *   invoking caller-owned signal methods. The caller signal is NOT handed to `postTask`;
 *   an internal controller cancels that native task. An unexpected native promise rejection
 *   is routed back as the exact host failure instead of being discarded.
 * - **Event-free.** A pure functional primitive — no Emitter, no events.
 *
 * @example
 * ```ts
 * import { createAbort } from '@orkestrel/abort'
 * import { BrowserScheduler } from '@orkestrel/workflow/browser'
 *
 * const abort = createAbort()
 * const scheduler = new BrowserScheduler()
 * while (!abort.signal.aborted) {
 * 	doSomeWork()
 * 	await scheduler.yield({ priority: 'background', signal: abort.signal })
 * }
 * ```
 */
export class BrowserScheduler implements SchedulerInterface {
	/**
	 * Yields control to the host through `scheduler.postTask` at the given priority (or a
	 * `setTimeout(0)` macrotask where the API is absent), then resumes; abort rejects with
	 * `signal.reason`.
	 */
	yield(options?: SchedulerOptions): Promise<void> {
		const post = this.#postTask()
		if (post === undefined) return delayHost(0, options?.signal)
		return this.#yieldVia(post, options?.priority ?? 'normal', options?.signal)
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

	// Feature-detect the Prioritized Task Scheduling API through guards (no `as`): the
	// global `scheduler` must be a record carrying a callable `postTask`. Returns the
	// narrowed `postTask` function, or `undefined` when the API is absent (the fallback).
	#postTask(): ((callback: () => void, options: Record<string, unknown>) => unknown) | undefined {
		const candidate: unknown = Reflect.get(globalThis, 'scheduler')
		if (!isRecord(candidate)) return undefined
		const post = candidate.postTask
		if (!isFunction(post)) return undefined
		return (callback, options) => Reflect.apply(post, candidate, [callback, options])
	}

	// A `scheduler.postTask` boundary with an internal cancellation controller; `scheduleHost`
	// owns caller linking and first-settlement arbitration, including native promise failure.
	#yieldVia(
		post: (callback: () => void, options: Record<string, unknown>) => unknown,
		priority: SchedulerPriority,
		signal?: AbortSignal,
	): Promise<void> {
		return scheduleHost((complete, failure) => {
			const internal = new AbortController()
			const task = post(complete, {
				priority: POST_TASK_PRIORITY[priority],
				signal: internal.signal,
			})
			if (isPromise(task)) void task.catch(failure)
			return () => internal.abort()
		}, signal)
	}
}
