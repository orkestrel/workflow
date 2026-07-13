import type { SchedulePriority } from '@src/core'

/**
 * The browser-native `postTask` priority for each portable {@link SchedulePriority} — the
 * Prioritized Task Scheduling API's three levels.
 *
 * @remarks
 * A `user` hint maps to the most urgent `'user-blocking'`, `normal` to the default
 * `'user-visible'`, and `background` to `'background'`. {@link BrowserSchedule} reads this
 * map to translate the caller's portable priority into the value passed to
 * `schedule.postTask`, so the urgency hint is honoured by the host.
 */
export const POST_TASK_PRIORITY: Readonly<Record<SchedulePriority, string>> = {
	user: 'user-blocking',
	normal: 'user-visible',
	background: 'background',
}
