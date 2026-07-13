import { createBrowserScheduler, createFrameScheduler, createIdleScheduler } from '@src/browser'
import { describe, expect, it } from 'vitest'

// The browser scheduler factories — each returns a working SchedulerInterface over its real
// browser primitive (postTask / requestAnimationFrame / requestIdleCallback), in real
// headless Chromium. The per-backend behaviour is covered in the *Scheduler.test.ts files;
// here each factory is asserted to wire up a usable scheduler end to end (shape + a real
// yield/delay round-trip + abort-awareness), grouped per factory under its own literal title
// (oxlint requires literal test titles).

describe('createBrowserScheduler', () => {
	it('returns a working SchedulerInterface (shape + real yield/delay round-trip)', async () => {
		const scheduler = createBrowserScheduler()
		expect(typeof scheduler.yield).toBe('function')
		expect(typeof scheduler.delay).toBe('function')

		await expect(scheduler.yield()).resolves.toBeUndefined()

		const start = Date.now()
		await scheduler.delay(20)
		expect(Date.now() - start).toBeGreaterThanOrEqual(15)
	})

	it('its yield is abort-aware — a pre-aborted signal rejects with the reason', async () => {
		const scheduler = createBrowserScheduler()
		const controller = new AbortController()
		const reason = new Error('cancelled')
		controller.abort(reason)

		await expect(scheduler.yield({ signal: controller.signal })).rejects.toBe(reason)
		// A subsequent unguarded yield still works.
		await expect(scheduler.yield()).resolves.toBeUndefined()
	})

	it('returns independent instances — aborting one does not affect another', async () => {
		const first = createBrowserScheduler()
		const second = createBrowserScheduler()
		const controller = new AbortController()
		const reason = new Error('only the first')
		controller.abort(reason)

		await expect(first.yield({ signal: controller.signal })).rejects.toBe(reason)
		await expect(second.yield()).resolves.toBeUndefined()
		await expect(first.yield()).resolves.toBeUndefined()
	})
})

describe('createFrameScheduler', () => {
	it('returns a working SchedulerInterface (shape + real yield/delay round-trip)', async () => {
		const scheduler = createFrameScheduler()
		expect(typeof scheduler.yield).toBe('function')
		expect(typeof scheduler.delay).toBe('function')

		await expect(scheduler.yield()).resolves.toBeUndefined()

		const start = Date.now()
		await scheduler.delay(20)
		expect(Date.now() - start).toBeGreaterThanOrEqual(15)
	})

	it('its yield is abort-aware — a pre-aborted signal rejects with the reason', async () => {
		const scheduler = createFrameScheduler()
		const controller = new AbortController()
		const reason = new Error('cancelled')
		controller.abort(reason)

		await expect(scheduler.yield({ signal: controller.signal })).rejects.toBe(reason)
		// A subsequent unguarded yield still works.
		await expect(scheduler.yield()).resolves.toBeUndefined()
	})

	it('returns independent instances — aborting one does not affect another', async () => {
		const first = createFrameScheduler()
		const second = createFrameScheduler()
		const controller = new AbortController()
		const reason = new Error('only the first')
		controller.abort(reason)

		await expect(first.yield({ signal: controller.signal })).rejects.toBe(reason)
		await expect(second.yield()).resolves.toBeUndefined()
		await expect(first.yield()).resolves.toBeUndefined()
	})
})

describe('createIdleScheduler', () => {
	it('returns a working SchedulerInterface (shape + real yield/delay round-trip)', async () => {
		const scheduler = createIdleScheduler()
		expect(typeof scheduler.yield).toBe('function')
		expect(typeof scheduler.delay).toBe('function')

		await expect(scheduler.yield()).resolves.toBeUndefined()

		const start = Date.now()
		await scheduler.delay(20)
		expect(Date.now() - start).toBeGreaterThanOrEqual(15)
	})

	it('its yield is abort-aware — a pre-aborted signal rejects with the reason', async () => {
		const scheduler = createIdleScheduler()
		const controller = new AbortController()
		const reason = new Error('cancelled')
		controller.abort(reason)

		await expect(scheduler.yield({ signal: controller.signal })).rejects.toBe(reason)
		// A subsequent unguarded yield still works.
		await expect(scheduler.yield()).resolves.toBeUndefined()
	})

	it('returns independent instances — aborting one does not affect another', async () => {
		const first = createIdleScheduler()
		const second = createIdleScheduler()
		const controller = new AbortController()
		const reason = new Error('only the first')
		controller.abort(reason)

		await expect(first.yield({ signal: controller.signal })).rejects.toBe(reason)
		await expect(second.yield()).resolves.toBeUndefined()
		await expect(first.yield()).resolves.toBeUndefined()
	})
})
