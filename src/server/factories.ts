import type { ScheduleInterface } from '@src/core'
import { NodeSchedule } from './NodeSchedule.js'

/**
 * Create the Node-native cooperative-yield {@link ScheduleInterface} — `yield()` is a
 * `setImmediate` host-turn (the canonical Node "give the event loop a turn"), `delay(ms)`
 * a real `setTimeout`.
 *
 * @remarks
 * Use it on a server instead of the cross-environment `createSchedule` when a yield
 * should hand the event loop a full turn (after pending I/O) via `setImmediate` rather
 * than a zero-delay timer. Both methods are abort-aware: pass `options.signal` and a
 * pending yield/delay rejects with the signal's `reason` (verbatim, with full
 * timer/listener cleanup). `options.priority` is accepted for contract compliance but a
 * no-op — Node has no priority primitive.
 *
 * @returns A {@link ScheduleInterface} backed by Node's `setImmediate` / `setTimeout`
 *
 * @example
 * ```ts
 * import { createAbort } from '@src/core'
 * import { createNodeSchedule } from '@src/server'
 *
 * const abort = createAbort()
 * const schedule = createNodeSchedule()
 * while (!abort.signal.aborted) {
 * 	doSomeWork()
 * 	await schedule.yield({ signal: abort.signal })
 * }
 * ```
 */
export function createNodeSchedule(): ScheduleInterface {
	return new NodeSchedule()
}
