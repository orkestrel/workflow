import type { SchedulerPriority } from '@src/core'
import { Scheduler } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createRecorder, waitForDelay } from '@orkestrel/test'
import { instrumentSignal } from '../../setup.js'

// Scheduler is exercised against the real host clock. These tests observe ordering,
// elapsed time, cancellation, and listener ownership without inspecting timer internals.

describe('Scheduler', () => {
	describe('yield', () => {
		it('resolves asynchronously after the current task', async () => {
			const scheduler = new Scheduler()
			let resumed = false

			const pending = scheduler.yield().then(() => {
				resumed = true
			})
			expect(resumed).toBe(false)

			await pending
			expect(resumed).toBe(true)
		})

		it('yields as a macrotask after an already-queued microtask', async () => {
			const scheduler = new Scheduler()
			const order: string[] = []

			const pending = scheduler.yield().then(() => order.push('yield'))
			queueMicrotask(() => order.push('microtask'))

			await pending
			expect(order).toEqual(['microtask', 'yield'])
		})

		it('rejects a pre-aborted call with the exact reason and attaches no listener', async () => {
			const scheduler = new Scheduler()
			const controller = new AbortController()
			const reason = new Error('pre-aborted')
			controller.abort(reason)
			const { added, removed } = instrumentSignal(controller.signal)

			await expect(scheduler.yield({ signal: controller.signal })).rejects.toBe(reason)
			expect(added.count).toBe(0)
			expect(removed.count).toBe(0)
		})

		it('rejects a pending call promptly with the exact reason', async () => {
			const scheduler = new Scheduler()
			const controller = new AbortController()
			const reason = { code: 'STOPPED' }
			const pending = scheduler.yield({ signal: controller.signal })

			controller.abort(reason)
			const outcome = await Promise.race([
				pending.then(
					() => 'resolved',
					(error) => error,
				),
				waitForDelay(50).then(() => 'late'),
			])
			expect(outcome).toBe(reason)
		})

		it('accepts every priority without changing completion', async () => {
			const scheduler = new Scheduler()
			const priorities: readonly SchedulerPriority[] = ['user', 'normal', 'background']

			for (const priority of priorities) {
				await expect(scheduler.yield({ priority })).resolves.toBeUndefined()
			}
		})
	})

	describe('delay', () => {
		it('does not resolve before its requested interval', async () => {
			const scheduler = new Scheduler()
			const start = performance.now()

			await scheduler.delay(20)

			expect(performance.now() - start).toBeGreaterThanOrEqual(20)
		})

		it('rejects before the deadline and never settles again after it passes', async () => {
			const scheduler = new Scheduler()
			const controller = new AbortController()
			const reason = new Error('aborted before deadline')
			const settled = createRecorder<readonly ['resolved' | 'rejected']>()
			const pending = scheduler.delay(40, { signal: controller.signal })
			const observed = pending.then(
				() => settled.handler('resolved'),
				() => settled.handler('rejected'),
			)

			await waitForDelay(10)
			controller.abort(reason)
			const outcome = await Promise.race([
				pending.then(
					() => 'resolved',
					(error) => error,
				),
				waitForDelay(10).then(() => 'late'),
			])
			expect(outcome).toBe(reason)
			await observed
			expect(settled.calls).toEqual([['rejected']])

			await waitForDelay(40)
			expect(settled.calls).toEqual([['rejected']])
		})

		it('never invokes caller-owned listener methods for completed yield and delay calls', async () => {
			const scheduler = new Scheduler()
			const controller = new AbortController()
			const { added, removed } = instrumentSignal(controller.signal)

			await scheduler.yield({ signal: controller.signal })
			await scheduler.delay(10, { signal: controller.signal })
			expect(added.count).toBe(0)
			expect(removed.count).toBe(0)

			controller.abort(new Error('after completion'))
			await waitForDelay(0)
			expect(added.count).toBe(0)
			expect(removed.count).toBe(0)
		})

		it('rejects every operation sharing one signal with the same reason', async () => {
			const scheduler = new Scheduler()
			const controller = new AbortController()
			const reason = { code: 'SHARED' }
			const settled = createRecorder<readonly ['resolved' | 'rejected']>()
			const pending = [20, 30, 40].map((ms) =>
				scheduler.delay(ms, { signal: controller.signal }).then(
					() => settled.handler('resolved'),
					(error) => {
						settled.handler('rejected')
						return error
					},
				),
			)

			controller.abort(reason)
			const outcomes = await Promise.all(pending)
			expect(outcomes).toEqual([reason, reason, reason])
			expect(settled.calls).toEqual([['rejected'], ['rejected'], ['rejected']])

			await waitForDelay(50)
			expect(settled.count).toBe(3)
		})

		it('resolves concurrent delays in deadline order rather than call order', async () => {
			const scheduler = new Scheduler()
			const order: number[] = []
			const durations: readonly number[] = [40, 10, 25]

			await Promise.all(
				durations.map((ms) =>
					scheduler.delay(ms).then(() => {
						order.push(ms)
					}),
				),
			)

			expect(order).toEqual([10, 25, 40])
		})

		it('uses the host asynchronous clamp for zero, negative, and NaN values', async () => {
			const scheduler = new Scheduler()
			const values: readonly number[] = [0, -0, -100, Number.NaN]

			for (const value of values) {
				let resumed = false
				const pending = scheduler.delay(value).then(() => {
					resumed = true
				})
				expect(resumed).toBe(false)
				await pending
				expect(resumed).toBe(true)
			}
		})

		it('accepts every priority together with cancellation', async () => {
			const scheduler = new Scheduler()
			const priorities: readonly SchedulerPriority[] = ['user', 'normal', 'background']

			for (const priority of priorities) {
				await expect(scheduler.delay(0, { priority })).resolves.toBeUndefined()
			}

			const controller = new AbortController()
			const reason = new Error('priority abort')
			const pending = scheduler.delay(40, {
				priority: 'background',
				signal: controller.signal,
			})
			controller.abort(reason)
			await expect(pending).rejects.toBe(reason)
		})
	})

	describe('pressure', () => {
		it('keeps caller listener methods untouched through modest resolved churn', async () => {
			const scheduler = new Scheduler()
			const controller = new AbortController()
			const { added, removed } = instrumentSignal(controller.signal)

			for (let cycle = 0; cycle < 25; cycle += 1) {
				await scheduler.delay(0, { signal: controller.signal })
			}

			expect(added.count).toBe(0)
			expect(removed.count).toBe(0)
		})

		it('settles modest aborted churn promptly without late resolutions', async () => {
			const scheduler = new Scheduler()
			const settled = createRecorder<readonly ['resolved' | 'rejected']>()

			for (let cycle = 0; cycle < 25; cycle += 1) {
				const controller = new AbortController()
				const pending = scheduler.delay(20, { signal: controller.signal }).then(
					() => settled.handler('resolved'),
					() => settled.handler('rejected'),
				)
				controller.abort(new Error('churn'))
				await pending
			}

			expect(settled.count).toBe(25)
			expect(settled.calls.every(([outcome]) => outcome === 'rejected')).toBe(true)
			await waitForDelay(30)
			expect(settled.count).toBe(25)
		})
	})

	it('forwards platform, string, and object abort reasons verbatim', async () => {
		const scheduler = new Scheduler()
		const platform = new AbortController()
		platform.abort()
		await expect(scheduler.delay(20, { signal: platform.signal })).rejects.toBeInstanceOf(
			DOMException,
		)

		const string = new AbortController()
		string.abort('stop')
		await expect(scheduler.yield({ signal: string.signal })).rejects.toBe('stop')

		const object = new AbortController()
		const reason = { code: 'CANCELLED', detail: { at: 1 } }
		const pending = scheduler.delay(20, { signal: object.signal })
		object.abort(reason)
		await expect(pending).rejects.toBe(reason)
	})
})
