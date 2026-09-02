import type { SchedulerPriority } from '@src/core'

/**
 * Maps each portable {@link SchedulerPriority} to the browser-native `postTask` priority — the
 * Prioritized Task Scheduling API's three levels.
 *
 * @remarks
 * A `user` hint maps to the most urgent `'user-blocking'`, `normal` to the default
 * `'user-visible'`, and `background` to `'background'`. {@link BrowserScheduler} reads this
 * map to translate the caller's portable priority into the value passed to
 * `scheduler.postTask`, so the urgency hint is honoured by the host.
 */
export const POST_TASK_PRIORITY: Readonly<Record<SchedulerPriority, string>> = Object.freeze({
	user: 'user-blocking',
	normal: 'user-visible',
	background: 'background',
})
