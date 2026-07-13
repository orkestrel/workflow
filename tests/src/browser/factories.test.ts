import { createBrowserSchedule, createFrameSchedule, createIdleSchedule } from '@src/browser'
import { describe, expect, it } from 'vitest'

// The browser schedule factories — each returns a working ScheduleInterface over its real
// browser primitive (postTask / requestAnimationFrame / requestIdleCallback), in real
// headless Chromium. The per-backend behaviour is covered in the *Schedule.test.ts files;
// here each factory is asserted to wire up a usable schedule end to end (shape + a real
// yield/delay round-trip + abort-awareness), grouped per factory under its own literal title
// (oxlint requires literal test titles).

describe('createBrowserSchedule', () => {
	it('returns a working ScheduleInterface (shape + real yield/delay round-trip)', async () => {
		const schedule = createBrowserSchedule()
		expect(typeof schedule.yield).toBe('function')
		expect(typeof schedule.delay).toBe('function')

		await expect(schedule.yield()).resolves.toBeUndefined()

		const start = Date.now()
		await schedule.delay(20)
		expect(Date.now() - start).toBeGreaterThanOrEqual(15)
	})

	it('its yield is abort-aware — a pre-aborted signal rejects with the reason', async () => {
		const schedule = createBrowserSchedule()
		const controller = new AbortController()
		const reason = new Error('cancelled')
		controller.abort(reason)

		await expect(schedule.yield({ signal: controller.signal })).rejects.toBe(reason)
		// A subsequent unguarded yield still works.
		await expect(schedule.yield()).resolves.toBeUndefined()
	})

	it('returns independent instances — aborting one does not affect another', async () => {
		const first = createBrowserSchedule()
		const second = createBrowserSchedule()
		const controller = new AbortController()
		const reason = new Error('only the first')
		controller.abort(reason)

		await expect(first.yield({ signal: controller.signal })).rejects.toBe(reason)
		await expect(second.yield()).resolves.toBeUndefined()
		await expect(first.yield()).resolves.toBeUndefined()
	})
})

describe('createFrameSchedule', () => {
	it('returns a working ScheduleInterface (shape + real yield/delay round-trip)', async () => {
		const schedule = createFrameSchedule()
		expect(typeof schedule.yield).toBe('function')
		expect(typeof schedule.delay).toBe('function')

		await expect(schedule.yield()).resolves.toBeUndefined()

		const start = Date.now()
		await schedule.delay(20)
		expect(Date.now() - start).toBeGreaterThanOrEqual(15)
	})

	it('its yield is abort-aware — a pre-aborted signal rejects with the reason', async () => {
		const schedule = createFrameSchedule()
		const controller = new AbortController()
		const reason = new Error('cancelled')
		controller.abort(reason)

		await expect(schedule.yield({ signal: controller.signal })).rejects.toBe(reason)
		// A subsequent unguarded yield still works.
		await expect(schedule.yield()).resolves.toBeUndefined()
	})

	it('returns independent instances — aborting one does not affect another', async () => {
		const first = createFrameSchedule()
		const second = createFrameSchedule()
		const controller = new AbortController()
		const reason = new Error('only the first')
		controller.abort(reason)

		await expect(first.yield({ signal: controller.signal })).rejects.toBe(reason)
		await expect(second.yield()).resolves.toBeUndefined()
		await expect(first.yield()).resolves.toBeUndefined()
	})
})

describe('createIdleSchedule', () => {
	it('returns a working ScheduleInterface (shape + real yield/delay round-trip)', async () => {
		const schedule = createIdleSchedule()
		expect(typeof schedule.yield).toBe('function')
		expect(typeof schedule.delay).toBe('function')

		await expect(schedule.yield()).resolves.toBeUndefined()

		const start = Date.now()
		await schedule.delay(20)
		expect(Date.now() - start).toBeGreaterThanOrEqual(15)
	})

	it('its yield is abort-aware — a pre-aborted signal rejects with the reason', async () => {
		const schedule = createIdleSchedule()
		const controller = new AbortController()
		const reason = new Error('cancelled')
		controller.abort(reason)

		await expect(schedule.yield({ signal: controller.signal })).rejects.toBe(reason)
		// A subsequent unguarded yield still works.
		await expect(schedule.yield()).resolves.toBeUndefined()
	})

	it('returns independent instances — aborting one does not affect another', async () => {
		const first = createIdleSchedule()
		const second = createIdleSchedule()
		const controller = new AbortController()
		const reason = new Error('only the first')
		controller.abort(reason)

		await expect(first.yield({ signal: controller.signal })).rejects.toBe(reason)
		await expect(second.yield()).resolves.toBeUndefined()
		await expect(first.yield()).resolves.toBeUndefined()
	})
})
