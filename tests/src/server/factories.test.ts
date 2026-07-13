import { createNodeScheduler } from '@src/server'
import { describe, expect, it } from 'vitest'
import { waitForDelay } from '../../setup.js'

// createNodeScheduler — returns a working server-native SchedulerInterface over real
// setImmediate / setTimeout.

describe('createNodeScheduler', () => {
	it('returns a scheduler whose yield and delay round-trip (shape + real round-trip)', async () => {
		const scheduler = createNodeScheduler()
		// Shape: the two SchedulerInterface methods are present.
		expect(typeof scheduler.yield).toBe('function')
		expect(typeof scheduler.delay).toBe('function')

		await expect(scheduler.yield()).resolves.toBeUndefined()

		const start = Date.now()
		await scheduler.delay(20)
		// Real timing with tolerance — delay waited at least roughly its interval.
		expect(Date.now() - start).toBeGreaterThanOrEqual(15)
	})

	it('its delay is abort-aware — a pre-aborted signal rejects with the reason', async () => {
		const scheduler = createNodeScheduler()
		const controller = new AbortController()
		const reason = new Error('cancelled')
		controller.abort(reason)

		await expect(scheduler.delay(20, { signal: controller.signal })).rejects.toBe(reason)
		// A subsequent unguarded yield still works.
		await waitForDelay(0)
		await expect(scheduler.yield()).resolves.toBeUndefined()
	})

	it('returns independent, stateless instances — aborting one does not affect another', async () => {
		const first = createNodeScheduler()
		const second = createNodeScheduler()
		const controller = new AbortController()
		const reason = new Error('only the first')
		controller.abort(reason)

		await expect(first.delay(20, { signal: controller.signal })).rejects.toBe(reason)
		await expect(second.yield()).resolves.toBeUndefined()
		await expect(second.delay(10)).resolves.toBeUndefined()
		await expect(first.yield()).resolves.toBeUndefined()
	})
})
