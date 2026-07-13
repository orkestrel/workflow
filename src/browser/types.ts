/**
 * The narrowed `requestIdleCallback` / `cancelIdleCallback` pair feature-detected off
 * `globalThis`.
 *
 * @remarks
 * A `request` taking a callback and returning a numeric handle, and a `cancel` taking that
 * handle. {@link IdleSchedule} feature-detects the pair through a guard (`isFunction`,
 * never an `as` — AGENTS §14) and resolves to `undefined` when the API is absent (Safari
 * today), so `yield` falls back to a macrotask.
 */
export interface IdleAPI {
	readonly request: (callback: () => void) => number
	readonly cancel: (handle: number) => void
}
