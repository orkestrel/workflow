import type { ScheduleInterface } from '@src/core'
import { BrowserSchedule } from './BrowserSchedule.js'
import { FrameSchedule } from './FrameSchedule.js'
import { IdleSchedule } from './IdleSchedule.js'

/**
 * Create the browser-native cooperative-yield {@link ScheduleInterface} — `yield()` uses
 * the Prioritized Task Scheduling API (`schedule.postTask`) at the requested priority
 * when present, falling back to a `setTimeout(0)` macrotask; `delay(ms)` is a real
 * `setTimeout`.
 *
 * @remarks
 * The default browser schedule: it honours `options.priority` (`user` /
 * `normal` / `background`) when `schedule.postTask` is available and degrades to a plain
 * macrotask elsewhere. Both methods are abort-aware: pass `options.signal` and a pending
 * yield/delay rejects with the signal's `reason` verbatim, with full task/timer/listener
 * cleanup. Prefer {@link createFrameSchedule} for paint-aligned work or
 * {@link createIdleSchedule} for idle-time background work.
 *
 * @returns A {@link ScheduleInterface} backed by `schedule.postTask` (or a macrotask)
 *
 * @example
 * ```ts
 * import { createBrowserSchedule } from '@src/browser'
 *
 * const schedule = createBrowserSchedule()
 * await schedule.yield({ priority: 'background' })
 * ```
 */
export function createBrowserSchedule(): ScheduleInterface {
	return new BrowserSchedule()
}

/**
 * Create the frame-aligned cooperative-yield {@link ScheduleInterface} — `yield()` resumes
 * just before the next paint via `requestAnimationFrame`; `delay(ms)` is a real
 * `setTimeout`.
 *
 * @remarks
 * Use it for work that should batch per render frame (animation, incremental DOM updates)
 * and naturally pause while the tab is hidden. `yield` is abort-aware: pass `options.signal`
 * and a pending yield rejects with the signal's `reason` verbatim, cancelling the pending
 * frame request. `options.priority` is accepted but a no-op — a frame callback has no
 * priority dimension.
 *
 * @returns A {@link ScheduleInterface} backed by `requestAnimationFrame`
 *
 * @example
 * ```ts
 * import { createFrameSchedule } from '@src/browser'
 *
 * const schedule = createFrameSchedule()
 * await schedule.yield() // resumes before the next paint
 * ```
 */
export function createFrameSchedule(): ScheduleInterface {
	return new FrameSchedule()
}

/**
 * Create the idle-time cooperative-yield {@link ScheduleInterface} — `yield()` resumes when
 * the host is idle via `requestIdleCallback` when present, falling back to a `setTimeout(0)`
 * macrotask; `delay(ms)` is a real `setTimeout`.
 *
 * @remarks
 * Use it for low-priority background work that must not contend with rendering or input.
 * Where `requestIdleCallback` is absent (Safari today) it degrades to a plain macrotask.
 * `yield` is abort-aware: pass `options.signal` and a pending yield rejects with the
 * signal's `reason` verbatim, cancelling the pending idle callback. `options.priority` is
 * accepted but a no-op — idle scheduling has no priority dimension.
 *
 * @returns A {@link ScheduleInterface} backed by `requestIdleCallback` (or a macrotask)
 *
 * @example
 * ```ts
 * import { createIdleSchedule } from '@src/browser'
 *
 * const schedule = createIdleSchedule()
 * await schedule.yield() // resumes when the host is idle
 * ```
 */
export function createIdleSchedule(): ScheduleInterface {
	return new IdleSchedule()
}
