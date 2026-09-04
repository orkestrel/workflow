/**
 * Declares the narrowed `requestIdleCallback` / `cancelIdleCallback` pair feature-detected off
 * `globalThis`.
 *
 * @remarks
 * A `request` taking a callback and returning a numeric handle, and a `cancel` taking that
 * handle. {@link IdleScheduler} feature-detects the pair through a guard (`isFunction`,
 * never an `as`) and resolves to `undefined` when the API is absent (Safari
 * today), so `yield` falls back to a macrotask.
 */
export interface IdleInterface {
	readonly request: (callback: () => void) => number
	readonly cancel: (handle: number) => void
}
