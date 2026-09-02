import type { SchedulerInterface } from '@src/core'
import { BrowserScheduler } from './BrowserScheduler.js'
import { FrameScheduler } from './FrameScheduler.js'
import { IdleScheduler } from './IdleScheduler.js'

/**
 * Creates the browser-native cooperative-yield {@link SchedulerInterface} — `yield()` uses
 * the Prioritized Task Scheduling API (`scheduler.postTask`) at the requested priority
 * when present, falling back to a `setTimeout(0)` macrotask; `delay(ms)` is a real
 * `setTimeout`.
 *
 * @remarks
 * The default browser scheduler: it honours `options.priority` (`user` /
 * `normal` / `background`) when `scheduler.postTask` is available and degrades to a plain
 * macrotask elsewhere. Both methods are abort-aware: pass `options.signal` and a pending
 * yield/delay rejects with the signal's exact `reason`; the shared owned-signal lifecycle
 * cancels the native handle without invoking caller listener methods. Prefer
 * {@link createFrameScheduler} for paint-aligned work or
 * {@link createIdleScheduler} for idle-time background work.
 *
 * @returns A {@link SchedulerInterface} backed by `scheduler.postTask` (or a macrotask)
 *
 * @example
 * ```ts
 * import { createBrowserScheduler } from '@orkestrel/workflow/browser'
 *
 * const scheduler = createBrowserScheduler()
 * await scheduler.yield({ priority: 'background' })
 * ```
 */
export function createBrowserScheduler(): SchedulerInterface {
	return new BrowserScheduler()
}

/**
 * Creates the frame-aligned cooperative-yield {@link SchedulerInterface} — `yield()` resumes
 * just before the next paint through `requestAnimationFrame`; `delay(ms)` is a real
 * `setTimeout`.
 *
 * @remarks
 * Use it for work that batches per render frame (animation, incremental DOM updates) and
 * naturally pauses while the tab is hidden. `yield` is abort-aware: pass `options.signal`
 * and a pending yield rejects with the signal's `reason` verbatim, cancelling the pending
 * frame request. `options.priority` is accepted but a no-op — a frame callback has no
 * priority dimension.
 *
 * @returns A {@link SchedulerInterface} backed by `requestAnimationFrame`
 *
 * @example
 * ```ts
 * import { createFrameScheduler } from '@orkestrel/workflow/browser'
 *
 * const scheduler = createFrameScheduler()
 * await scheduler.yield() // resumes before the next paint
 * ```
 */
export function createFrameScheduler(): SchedulerInterface {
	return new FrameScheduler()
}

/**
 * Creates the idle-time cooperative-yield {@link SchedulerInterface} — `yield()` resumes when
 * the host is idle through `requestIdleCallback` when present, falling back to a `setTimeout(0)`
 * macrotask; `delay(ms)` is a real `setTimeout`.
 *
 * @remarks
 * Use it for low-priority background work that must not contend with rendering or input.
 * Where `requestIdleCallback` is absent (Safari today) it degrades to a plain macrotask.
 * `yield` is abort-aware: pass `options.signal` and a pending yield rejects with the
 * signal's `reason` verbatim, cancelling the pending idle callback. `options.priority` is
 * accepted but a no-op — idle scheduling has no priority dimension.
 *
 * @returns A {@link SchedulerInterface} backed by `requestIdleCallback` (or a macrotask)
 *
 * @example
 * ```ts
 * import { createIdleScheduler } from '@orkestrel/workflow/browser'
 *
 * const scheduler = createIdleScheduler()
 * await scheduler.yield() // resumes when the host is idle
 * ```
 */
export function createIdleScheduler(): SchedulerInterface {
	return new IdleScheduler()
}
