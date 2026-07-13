import { FrameScheduler } from '@src/browser'
import { describe, expect, it } from 'vitest'
import { instrumentSignal, waitForDelay } from '../../setup.js'

// FrameScheduler — the frame-aligned browser cooperative-yield backend, run in REAL headless
// Chromium where `requestAnimationFrame` is driven by the engine (AGENTS §16.2: do not fake a
// browser API the browser has; fake timers are the WRONG tool for rAF). `yield` resumes in a
// real frame callback; abort cancels the pending rAF handle and rejects with the verbatim
// `signal.reason`.

describe('FrameScheduler', () => {
	describe('yield', () => {
		it('resolves — the real requestAnimationFrame callback fires, after the current task', async () => {
			const scheduler = new FrameScheduler()
			let resumed = false

			const pending = scheduler.yield().then(() => {
				resumed = true
			})
			expect(resumed).toBe(false) // not synchronously — a frame must pass

			await pending
			expect(resumed).toBe(true)
		})

		it('accepts every priority (a no-op) and resolves the same', async () => {
			const scheduler = new FrameScheduler()

			for (const priority of ['user', 'normal', 'background'] as const) {
				await expect(scheduler.yield({ priority })).resolves.toBeUndefined()
			}
		})

		it('rejects with the reason when the signal is already aborted, requesting no frame', async () => {
			const scheduler = new FrameScheduler()
			const controller = new AbortController()
			const reason = new Error('pre-aborted')
			controller.abort(reason)

			await expect(scheduler.yield({ signal: controller.signal })).rejects.toBe(reason)
		})

		it('aborting while pending cancels the frame and rejects with the reason (verbatim)', async () => {
			const scheduler = new FrameScheduler()
			const controller = new AbortController()
			const reason = { code: 'CANCELLED' }
			let resolved = false

			const pending = scheduler.yield({ signal: controller.signal })
			pending.then(
				() => (resolved = true),
				() => {},
			)
			controller.abort(reason)
			await expect(pending).rejects.toBe(reason)

			// The cancelled frame never resolves it, even after several frames pass.
			await waitForDelay(50)
			expect(resolved).toBe(false)
		})

		it('a bare abort() rejects with the platform AbortError DOMException', async () => {
			const scheduler = new FrameScheduler()
			const controller = new AbortController()
			controller.abort()

			await expect(scheduler.yield({ signal: controller.signal })).rejects.toBeInstanceOf(
				DOMException,
			)
		})

		it('a completed yield removed its abort listener (no leak — counted on a real signal)', async () => {
			const scheduler = new FrameScheduler()
			const controller = new AbortController()
			const { added, removed } = instrumentSignal(controller.signal)

			await scheduler.yield({ signal: controller.signal })
			expect(added.count).toBe(1)
			expect(removed.count).toBe(1)
		})
	})

	describe('delay', () => {
		it('resolves after at least ms (real timing)', async () => {
			const scheduler = new FrameScheduler()
			const start = Date.now()
			await scheduler.delay(20)
			expect(Date.now() - start).toBeGreaterThanOrEqual(15)
		})

		it('aborting before the deadline rejects with the reason and the timer never fires', async () => {
			const scheduler = new FrameScheduler()
			const controller = new AbortController()
			const reason = new Error('aborted before deadline')
			let resolved = false

			const pending = scheduler.delay(100, { signal: controller.signal })
			pending.then(
				() => (resolved = true),
				() => {},
			)
			controller.abort(reason)
			await expect(pending).rejects.toBe(reason)

			await waitForDelay(120)
			expect(resolved).toBe(false)
		})

		it('a completed delay removed its abort listener (no leak)', async () => {
			const scheduler = new FrameScheduler()
			const controller = new AbortController()
			const { added, removed } = instrumentSignal(controller.signal)

			await scheduler.delay(5, { signal: controller.signal })
			expect(added.count).toBe(1)
			expect(removed.count).toBe(1)
		})
	})
})
