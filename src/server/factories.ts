import type { SchedulerInterface } from '@src/core'
import { NodeScheduler } from './NodeScheduler.js'

/**
 * Creates the Node-native cooperative-yield {@link SchedulerInterface} — `yield()` is a
 * `setImmediate` host-turn (the canonical Node "give the event loop a turn"), `delay(ms)`
 * a real `setTimeout`.
 *
 * @remarks
 * Use it on a server instead of the cross-environment `createScheduler` when a yield must
 * hand the event loop a full turn (after pending I/O) through `setImmediate` rather than a
 * zero-delay timer. Both methods are abort-aware: pass `options.signal` and a
 * pending yield/delay rejects with the signal's exact `reason`; the shared owned-signal
 * lifecycle clears the native handle without invoking caller listener methods.
 * `options.priority` is accepted for contract compliance but a
 * no-op — Node has no priority primitive.
 *
 * @returns A {@link SchedulerInterface} backed by Node's `setImmediate` / `setTimeout`
 *
 * @example
 * ```ts
 * import { createAbort } from '@orkestrel/abort'
 * import { createNodeScheduler } from '@orkestrel/workflow/server'
 *
 * const abort = createAbort()
 * const scheduler = createNodeScheduler()
 * while (!abort.signal.aborted) {
 * 	doSomeWork()
 * 	await scheduler.yield({ signal: abort.signal })
 * }
 * ```
 */
export function createNodeScheduler(): SchedulerInterface {
	return new NodeScheduler()
}
