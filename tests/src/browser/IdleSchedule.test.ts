import { IdleSchedule } from '@src/browser'
import { describe, expect, it } from 'vitest'
import { instrumentSignal, waitForDelay } from '../../../setup.js'

// IdleSchedule — the idle-time browser cooperative-yield backend, run in REAL headless
// Chromium where `requestIdleCallback` exists, so `yield` exercises the NATIVE idle path here
// (AGENTS §16.2: do not fake a browser API the browser has). The `setTimeout(0)` fallback (for
// engines without rIC, e.g. Safari) is covered by the guard logic in `#idleAPI` + this note —
// we never fake away the native API to force it. abort cancels the pending idle callback and
// rejects with the verbatim `signal.reason`.

describe('IdleSchedule', () => {
	it('exposes requestIdleCallback in this Chromium (the native path is under test)', () => {
		expect(typeof Reflect.get(globalThis, 'requestIdleCallback')).toBe('function')
		expect(typeof Reflect.get(globalThis, 'cancelIdleCallback')).toBe('function')
	})

	describe('yield', () => {
		it('resolves — the real requestIdleCallback fires, after the current task', async () => {
			const schedule = new IdleSchedule()
			let resumed = false

			const pending = schedule.yield().then(() => {
				resumed = true
			})
			expect(resumed).toBe(false) // not synchronously

			await pending
			expect(resumed).toBe(true)
		})

		it('accepts every priority (a no-op) and resolves the same', async () => {
			const schedule = new IdleSchedule()

			for (const priority of ['user', 'normal', 'background'] as const) {
				await expect(schedule.yield({ priority })).resolves.toBeUndefined()
			}
		})

		it('rejects with the reason when the signal is already aborted, scheduling nothing', async () => {
			const schedule = new IdleSchedule()
			const controller = new AbortController()
			const reason = new Error('pre-aborted')
			controller.abort(reason)

			await expect(schedule.yield({ signal: controller.signal })).rejects.toBe(reason)
		})

		it('aborting while pending cancels the idle callback and rejects with the reason (verbatim)', async () => {
			const schedule = new IdleSchedule()
			const controller = new AbortController()
			const reason = { code: 'CANCELLED' }
			let resolved = false

			const pending = schedule.yield({ signal: controller.signal })
			pending.then(
				() => (resolved = true),
				() => {},
			)
			controller.abort(reason)
			await expect(pending).rejects.toBe(reason)

			await waitForDelay(50)
			expect(resolved).toBe(false)
		})

		it('a bare abort() rejects with the platform AbortError DOMException', async () => {
			const schedule = new IdleSchedule()
			const controller = new AbortController()
			controller.abort()

			await expect(schedule.yield({ signal: controller.signal })).rejects.toBeInstanceOf(
				DOMException,
			)
		})

		it('a completed yield removed its abort listener (no leak — counted on a real signal)', async () => {
			const schedule = new IdleSchedule()
			const controller = new AbortController()
			const { added, removed } = instrumentSignal(controller.signal)

			await schedule.yield({ signal: controller.signal })
			expect(added.count).toBe(1)
			expect(removed.count).toBe(1)
		})
	})

	describe('delay', () => {
		it('resolves after at least ms (real timing)', async () => {
			const schedule = new IdleSchedule()
			const start = Date.now()
			await schedule.delay(20)
			expect(Date.now() - start).toBeGreaterThanOrEqual(15)
		})

		it('aborting before the deadline rejects with the reason and the timer never fires', async () => {
			const schedule = new IdleSchedule()
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

			await waitForDelay(120)
			expect(resolved).toBe(false)
		})

		it('a completed delay removed its abort listener (no leak)', async () => {
			const schedule = new IdleSchedule()
			const controller = new AbortController()
			const { added, removed } = instrumentSignal(controller.signal)

			await schedule.delay(5, { signal: controller.signal })
			expect(added.count).toBe(1)
			expect(removed.count).toBe(1)
		})
	})
})
