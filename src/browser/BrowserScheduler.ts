import type { SchedulerInterface, SchedulerOptions, SchedulerPriority } from '@src/core'
import { isFunction, isRecord } from '@src/core'
import { POST_TASK_PRIORITY } from './constants.js'

/**
 * The browser {@link SchedulerInterface} — the browser-native cooperative-yield backend
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
 *   it **falls back** to a `setTimeout(0)` macrotask — still a real host-turn, just
 *   without priority. `delay(ms)` is always a real `setTimeout`.
 * - **Abort fidelity is verbatim.** A pending `yield` / `delay` rejects with `signal.reason`
 *   exactly — the value the caller passed, never wrapped or replaced. The discipline
 *   mirrors the cross-environment default's `#sleep`: an already-aborted signal rejects
 *   immediately WITHOUT scheduling; otherwise the host-turn is scheduled and a
 *   `{ once: true }` abort listener attached, and the two settle paths are mutually
 *   exclusive — the turn path removes the listener before resolving, and the abort path
 *   cancels the scheduled turn before rejecting. The promise settles exactly once, with no
 *   leaked task/timer and no leaked listener. The caller's `signal` is NOT handed to
 *   `postTask` (whose own abort would reject with a platform `AbortError`, not the
 *   caller's `reason`); instead an internal controller cancels the posted task while this
 *   scheduler rejects with the verbatim `signal.reason`.
 * - **Event-free.** A pure functional primitive — no Emitter, no events.
 *
 * @example
 * ```ts
 * import { createAbort } from '@src/core'
 * import { BrowserScheduler } from '@src/browser'
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
	 * Yield control to the host via `scheduler.postTask` at the given priority (or a
	 * `setTimeout(0)` macrotask where the API is absent), then resume; abort rejects with
	 * `signal.reason`.
	 */
	yield(options?: SchedulerOptions): Promise<void> {
		const post = this.#postTask()
		if (post === undefined) return this.#macrotask(options?.signal)
		return this.#yieldVia(post, options?.priority ?? 'normal', options?.signal)
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
		return this.#timer(ms, options?.signal)
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

	// A `scheduler.postTask` host-turn at the mapped priority. The caller's signal is NOT
	// passed to `postTask` (its abort rejects with a platform `AbortError`, not the
	// caller's `reason`); instead an internal controller cancels the posted task on abort
	// while this rejects with the verbatim `signal.reason`. Settle-once, no leak: the task
	// path removes the abort listener before resolving; the abort path aborts the internal
	// controller (cancelling the task) before rejecting.
	#yieldVia(
		post: (callback: () => void, options: Record<string, unknown>) => unknown,
		priority: SchedulerPriority,
		signal?: AbortSignal,
	): Promise<void> {
		if (signal?.aborted === true) return Promise.reject(signal.reason)
		return new Promise<void>((resolve, reject) => {
			const internal = new AbortController()
			const onAbort = () => {
				internal.abort()
				reject(signal?.reason)
			}
			const task = post(
				() => {
					signal?.removeEventListener('abort', onAbort)
					resolve()
				},
				{ priority: POST_TASK_PRIORITY[priority], signal: internal.signal },
			)
			// `postTask` returns a promise that rejects when the internal controller aborts;
			// swallow that rejection (the abort path already rejected with the real reason).
			if (task instanceof Promise) task.catch(() => {})
			signal?.addEventListener('abort', onAbort, { once: true })
		})
	}

	// The `setTimeout(0)` macrotask fallback for `yield` when `postTask` is absent. Same
	// settle-once discipline as the core `#sleep`: an already-aborted signal rejects
	// without arming; otherwise the timer path removes the listener before resolving and
	// the abort path clears the timer before rejecting with `signal.reason`.
	#macrotask(signal?: AbortSignal): Promise<void> {
		return this.#timer(0, signal)
	}

	// The abort-aware `setTimeout` sleep shared by `delay` and the `yield` macrotask
	// fallback. Settle-once, no leak (the core `#sleep` discipline): already-aborted →
	// reject without arming; the timer path removes the listener before resolving; the
	// abort path clears the timer before rejecting with the verbatim `signal.reason`.
	#timer(ms: number, signal?: AbortSignal): Promise<void> {
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
