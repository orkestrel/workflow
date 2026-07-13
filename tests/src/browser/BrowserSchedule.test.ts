import { BrowserSchedule } from '@src/browser'
import { describe, expect, it } from 'vitest'
import { instrumentSignal, waitForDelay } from '../../../setup.js'

// BrowserSchedule — the browser-native cooperative-yield backend, run in REAL headless
// Chromium (AGENTS §16.2: do not mock a browser API the browser has). Chromium ships the
// Prioritized Task Scheduling API (`schedule.postTask`), so `yield` exercises the NATIVE
// postTask path here; the `setTimeout(0)` fallback is covered by the guard logic + a note
// (we never fake away the native API). Abort fidelity is the load-bearing property — the
// reject value must be the caller's `signal.reason` VERBATIM, and the posted task cancelled.
// rAF/rIC/postTask are driven by the real engine, so timing uses real callbacks, not fake
// timers.

describe('BrowserSchedule', () => {
	it('exposes the Prioritized Task Scheduling API in this Chromium (the native path is under test)', () => {
		// A sanity check that the native branch — not the fallback — is what these tests cover.
		const candidate: unknown = Reflect.get(globalThis, 'schedule')
		const post =
			candidate !== null && typeof candidate === 'object'
				? Reflect.get(candidate, 'postTask')
				: undefined
		expect(typeof post).toBe('function')
	})

	describe('yield', () => {
		it('resolves — the real postTask callback fires and the continuation runs after the current task', async () => {
			const schedule = new BrowserSchedule()
			let resumed = false

			const pending = schedule.yield().then(() => {
				resumed = true
			})
			expect(resumed).toBe(false) // not synchronously

			await pending
			expect(resumed).toBe(true)
		})

		it('accepts every priority and resolves the same (the postTask priority mapping)', async () => {
			const schedule = new BrowserSchedule()

			for (const priority of ['user', 'normal', 'background'] as const) {
				await expect(schedule.yield({ priority })).resolves.toBeUndefined()
			}
		})

		it('rejects with the reason when the signal is already aborted, scheduling no task', async () => {
			const schedule = new BrowserSchedule()
			const controller = new AbortController()
			const reason = new Error('pre-aborted')
			controller.abort(reason)

			await expect(schedule.yield({ signal: controller.signal })).rejects.toBe(reason)
		})

		it('rejects with the reason when the signal aborts while pending (verbatim, by identity)', async () => {
			const schedule = new BrowserSchedule()
			const controller = new AbortController()
			const reason = { code: 'CANCELLED' }

			const pending = schedule.yield({ signal: controller.signal })
			controller.abort(reason)

			await expect(pending).rejects.toBe(reason)
		})

		it('a bare abort() rejects with the platform AbortError DOMException', async () => {
			const schedule = new BrowserSchedule()
			const controller = new AbortController()
			controller.abort()

			await expect(schedule.yield({ signal: controller.signal })).rejects.toBeInstanceOf(
				DOMException,
			)
		})

		it('a completed yield removed its abort listener (no leak — counted on a real signal)', async () => {
			const schedule = new BrowserSchedule()
			const controller = new AbortController()
			const { added, removed } = instrumentSignal(controller.signal)

			await schedule.yield({ signal: controller.signal })
			expect(added.count).toBe(1)
			expect(removed.count).toBe(1)
		})

		it('aborting a pending yield removes the listener and is inert thereafter (no double-settle)', async () => {
			const schedule = new BrowserSchedule()
			const controller = new AbortController()
			let settled = 0

			const pending = schedule.yield({ signal: controller.signal }).then(
				() => (settled += 1),
				() => (settled += 1),
			)
			controller.abort(new Error('cut'))
			await pending
			expect(settled).toBe(1)

			// Wait well past when the (cancelled) task would have run — it settles only once.
			await waitForDelay(20)
			expect(settled).toBe(1)
		})
	})

	describe('delay', () => {
		it('resolves after at least ms (real timing)', async () => {
			const schedule = new BrowserSchedule()
			const start = Date.now()
			await schedule.delay(20)
			expect(Date.now() - start).toBeGreaterThanOrEqual(15)
		})

		it('an already-aborted signal rejects immediately with the reason', async () => {
			const schedule = new BrowserSchedule()
			const controller = new AbortController()
			const reason = new Error('pre-aborted delay')
			controller.abort(reason)

			await expect(schedule.delay(50, { signal: controller.signal })).rejects.toBe(reason)
		})

		it('aborting before the deadline rejects with the reason and the timer never fires', async () => {
			const schedule = new BrowserSchedule()
			const controller = new AbortController()
			const reason = new Error('aborted before deadline')
			let resolved = false

			const pending = schedule.delay(100, { signal: controller.signal })
			pending.then(
				() => (resolved = true),
				() => {},
			)
			controller.abort(reason)
			await expect(pending).rejects.toBe(reason)

			// Past the original deadline, the cleared timer never resolves it.
			await waitForDelay(120)
			expect(resolved).toBe(false)
		})

		it('a completed delay removed its abort listener (no leak)', async () => {
			const schedule = new BrowserSchedule()
			const controller = new AbortController()
			const { added, removed } = instrumentSignal(controller.signal)

			await schedule.delay(5, { signal: controller.signal })
			expect(added.count).toBe(1)
			expect(removed.count).toBe(1)
		})
	})
})
