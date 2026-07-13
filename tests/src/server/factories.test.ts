import { createNodeSchedule } from '@src/server'
import { describe, expect, it } from 'vitest'
import { waitForDelay } from '../../../setup.js'

// createNodeSchedule — returns a working server-native ScheduleInterface over real
// setImmediate / setTimeout.

describe('createNodeSchedule', () => {
	it('returns a schedule whose yield and delay round-trip (shape + real round-trip)', async () => {
		const schedule = createNodeSchedule()
		// Shape: the two ScheduleInterface methods are present.
		expect(typeof schedule.yield).toBe('function')
		expect(typeof schedule.delay).toBe('function')

		await expect(schedule.yield()).resolves.toBeUndefined()

		const start = Date.now()
		await schedule.delay(20)
		// Real timing with tolerance — delay waited at least roughly its interval.
		expect(Date.now() - start).toBeGreaterThanOrEqual(15)
	})

	it('its delay is abort-aware — a pre-aborted signal rejects with the reason', async () => {
		const schedule = createNodeSchedule()
		const controller = new AbortController()
		const reason = new Error('cancelled')
		controller.abort(reason)

		await expect(schedule.delay(20, { signal: controller.signal })).rejects.toBe(reason)
		// A subsequent unguarded yield still works.
		await waitForDelay(0)
		await expect(schedule.yield()).resolves.toBeUndefined()
	})

	it('returns independent, stateless instances — aborting one does not affect another', async () => {
		const first = createNodeSchedule()
		const second = createNodeSchedule()
		const controller = new AbortController()
		const reason = new Error('only the first')
		controller.abort(reason)

		await expect(first.delay(20, { signal: controller.signal })).rejects.toBe(reason)
		await expect(second.yield()).resolves.toBeUndefined()
		await expect(second.delay(10)).resolves.toBeUndefined()
		await expect(first.yield()).resolves.toBeUndefined()
	})
})
