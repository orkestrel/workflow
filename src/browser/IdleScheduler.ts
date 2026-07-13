import type { SchedulerInterface, SchedulerOptions } from '@src/core'
import { isFunction } from '@src/core'
import type { IdleAPI } from './types.js'

/**
 * The idle-time {@link SchedulerInterface} — a browser cooperative-yield backend whose
 * `yield` resumes when the host is idle via `requestIdleCallback`, falling back to a
 * zero-delay macrotask where it is absent.
 *
 * @remarks
 * - **`yield` resumes during idle time.** When `globalThis` exposes `requestIdleCallback`,
 *   `yield()` waits on it, so the resumption happens when the browser has spare time after
 *   rendering and input — ideal for low-priority background work that must not contend with
 *   the user. The capability is feature-detected through a guard (`isFunction`), never an
 *   `as` (AGENTS §14). Where the API is absent (Safari today), it **falls back** to a
 *   `setTimeout(0)` macrotask — still a real host-turn, just not idle-gated. `delay(ms)` is
 *   always a real `setTimeout`. `options.priority` is accepted for contract compliance but a
 *   no-op — idle scheduling has no priority dimension.
 * - **Abort fidelity is verbatim, with cleanup.** A pending `yield` / `delay` rejects with
 *   `signal.reason` exactly. The discipline mirrors the cross-environment default's
 *   `#sleep`: an already-aborted signal rejects immediately WITHOUT scheduling; otherwise
 *   the idle callback (or fallback timer) is requested and a `{ once: true }` abort listener
 *   attached, and the two settle paths are mutually exclusive — the resume path removes the
 *   listener before resolving, and the abort path `cancelIdleCallback`s (or `clearTimeout`s)
 *   the pending handle before rejecting. The promise settles exactly once, with no leaked
 *   callback/timer and no leaked listener.
 * - **Event-free.** A pure functional primitive — no Emitter, no events.
 *
 * @example
 * ```ts
 * import { createAbort } from '@src/core'
 * import { IdleScheduler } from '@src/browser'
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
	 * Yield control to the host until it is idle via `requestIdleCallback` (or a
	 * `setTimeout(0)` macrotask where the API is absent), then resume; abort rejects with
	 * `signal.reason`.
	 */
	yield(options?: SchedulerOptions): Promise<void> {
		const idle = this.#idleAPI()
		if (idle === undefined) return this.#sleep(0, options?.signal)
		return this.#idle(idle, options?.signal)
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

	// Feature-detect `requestIdleCallback` / `cancelIdleCallback` off `globalThis` through
	// guards (no `as`): both must be callable. Returns the narrowed pair, or `undefined`
	// when the API is absent (the macrotask fallback).
	#idleAPI(): IdleAPI | undefined {
		const request: unknown = Reflect.get(globalThis, 'requestIdleCallback')
		const cancel: unknown = Reflect.get(globalThis, 'cancelIdleCallback')
		if (!isFunction(request) || !isFunction(cancel)) return undefined
		return {
			request: (callback) => Number(Reflect.apply(request, globalThis, [callback])),
			cancel: (handle) => {
				Reflect.apply(cancel, globalThis, [handle])
			},
		}
	}

	// The `requestIdleCallback` host-turn for `yield`. Resolves in the idle callback;
	// rejects with `signal.reason` if already aborted (nothing scheduled) or aborted while
	// pending. Settle-once, no leak: the resume path removes the abort listener before
	// resolving; the abort path cancels the idle callback before rejecting.
	#idle(idle: IdleAPI, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted === true) return Promise.reject(signal.reason)
		return new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				idle.cancel(handle)
				reject(signal?.reason)
			}
			const handle = idle.request(() => {
				signal?.removeEventListener('abort', onAbort) // load-bearing: prevents a post-resolve reject
				resolve()
			})
			signal?.addEventListener('abort', onAbort, { once: true })
		})
	}

	// The abort-aware `setTimeout` sleep shared by `delay` and the `yield` macrotask
	// fallback. Same settle-once discipline as the core `#sleep`: already-aborted → reject
	// without arming; the timer path removes the listener before resolving; the abort path
	// clears the timer before rejecting with the verbatim `signal.reason`.
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
