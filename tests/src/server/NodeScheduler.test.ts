import { NodeScheduler } from '@src/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRecorder, instrumentSignal } from '../../setup.js'

// NodeScheduler — the server-native cooperative-yield backend over real setImmediate /
// setTimeout. The yield-ordering proof uses REAL timers (fake timers don't reorder a
// microtask vs. a setImmediate macrotask); delay timing + leak counts use fake timers so
// the host timer count is an exact observable quantity (AGENTS §16 / §16.2). Abort fidelity
// is the load-bearing property — the reject value must be the caller's `signal.reason`
// VERBATIM (node:timers/promises wraps it in a Node AbortError, hence the hand-rolled timer).

describe('NodeScheduler', () => {
	describe('yield', () => {
		it('resolves asynchronously — the continuation runs after the current task', async () => {
			const scheduler = new NodeScheduler()
			let resumed = false

			const pending = scheduler.yield().then(() => {
				resumed = true
			})
			// Synchronously after the call, the continuation has NOT run yet.
			expect(resumed).toBe(false)

			await pending
			expect(resumed).toBe(true)
		})

		it('yields as a setImmediate macrotask — a microtask queued after it runs first (real timers)', async () => {
			const scheduler = new NodeScheduler()
			const order: string[] = []

			const yielded = scheduler.yield().then(() => order.push('yield'))
			// A microtask queued AFTER the yield call. A setImmediate macrotask resolves
			// strictly after the microtask queue drains, so 'microtask' wins — proving yield
			// is a genuine host-turn, not a microtask.
			queueMicrotask(() => order.push('microtask'))

			await yielded
			expect(order).toEqual(['microtask', 'yield'])
		})

		it('rejects with the reason when the signal is already aborted', async () => {
			const scheduler = new NodeScheduler()
			const controller = new AbortController()
			const reason = new Error('pre-aborted')
			controller.abort(reason)

			await expect(scheduler.yield({ signal: controller.signal })).rejects.toBe(reason)
		})

		it('rejects with the reason when the signal aborts while pending', async () => {
			const scheduler = new NodeScheduler()
			const controller = new AbortController()
			const reason = new Error('aborted while pending')

			const pending = scheduler.yield({ signal: controller.signal })
			controller.abort(reason)

			await expect(pending).rejects.toBe(reason)
		})

		it('a completed yield removed its abort listener (no leak — counted on a real signal)', async () => {
			const scheduler = new NodeScheduler()
			const controller = new AbortController()
			const { added, removed } = instrumentSignal(controller.signal)

			await scheduler.yield({ signal: controller.signal })
			// The single listener the yield attached was detached on resolve.
			expect(added.count).toBe(1)
			expect(removed.count).toBe(1)

			// A later abort is therefore inert for the (already-settled) yield.
			controller.abort(new Error('after the turn'))
		})
	})

	describe('delay (fake timers)', () => {
		afterEach(() => {
			vi.useRealTimers()
		})

		it('resolves after ms', async () => {
			vi.useFakeTimers()
			const scheduler = new NodeScheduler()
			const resolved = createRecorder<readonly []>()

			const pending = scheduler.delay(50).then(resolved.handler)
			await vi.advanceTimersByTimeAsync(49)
			expect(resolved.count).toBe(0) // not before the deadline

			await vi.advanceTimersByTimeAsync(1)
			await pending
			expect(resolved.count).toBe(1)
		})

		it('an already-aborted signal rejects immediately without arming a timer', async () => {
			vi.useFakeTimers()
			const scheduler = new NodeScheduler()
			const controller = new AbortController()
			const reason = new Error('pre-aborted')
			controller.abort(reason)

			await expect(scheduler.delay(50, { signal: controller.signal })).rejects.toBe(reason)
			// No timer pending — the short-circuit preceded any setTimeout.
			expect(vi.getTimerCount()).toBe(0)
		})

		it('aborting before the deadline rejects with the reason and clears the timer (no leak)', async () => {
			vi.useFakeTimers()
			const scheduler = new NodeScheduler()
			const controller = new AbortController()
			const reason = new Error('aborted before deadline')
			const resolved = createRecorder<readonly []>()

			const pending = scheduler.delay(50, { signal: controller.signal })
			pending.then(resolved.handler, () => {})
			expect(vi.getTimerCount()).toBe(1)

			await vi.advanceTimersByTimeAsync(20)
			controller.abort(reason)
			await expect(pending).rejects.toBe(reason)
			// The abort path cleared the timer before it could fire.
			expect(vi.getTimerCount()).toBe(0)

			// Advancing past the original deadline is a no-op — no double-settle.
			await vi.advanceTimersByTimeAsync(100)
			expect(resolved.count).toBe(0)
		})

		it('a completed delay leaves no pending timer or abort listener', async () => {
			vi.useFakeTimers()
			const scheduler = new NodeScheduler()
			const controller = new AbortController()
			const { added, removed } = instrumentSignal(controller.signal)

			const pending = scheduler.delay(10, { signal: controller.signal })
			await vi.advanceTimersByTimeAsync(10)
			await pending
			expect(vi.getTimerCount()).toBe(0)
			// The internal listener was removed on resolve.
			expect(added.count).toBe(1)
			expect(removed.count).toBe(1)

			// A later abort is inert for the (already-settled) delay.
			controller.abort(new Error('after resolve'))
		})
	})

	describe('abort reason fidelity (the load-bearing property)', () => {
		// The reject value must be whatever `signal.reason` holds — forwarded VERBATIM, never
		// wrapped or substituted. This is why the timer is hand-rolled rather than delegated to
		// node:timers/promises (whose `{ signal }` rejects with a Node AbortError, code
		// 'ABORT_ERR', not the caller's reason). Both the pre-aborted and the while-pending
		// paths are pinned, across `yield` and `delay`.

		it('a bare abort() rejects with the platform AbortError DOMException (never a Node AbortError)', async () => {
			const scheduler = new NodeScheduler()
			const controller = new AbortController()
			controller.abort() // no reason supplied → the platform fills in a DOMException

			await expect(scheduler.delay(50, { signal: controller.signal })).rejects.toBeInstanceOf(
				DOMException,
			)
			await expect(scheduler.yield({ signal: controller.signal })).rejects.toHaveProperty(
				'name',
				'AbortError',
			)
		})

		it('forwards a custom Error reason by identity (pre-aborted)', async () => {
			const scheduler = new NodeScheduler()
			const controller = new AbortController()
			const reason = new Error('custom')
			controller.abort(reason)

			await expect(scheduler.delay(50, { signal: controller.signal })).rejects.toBe(reason)
			await expect(scheduler.yield({ signal: controller.signal })).rejects.toBe(reason)
		})

		it('forwards a string reason verbatim (not wrapped in an Error)', async () => {
			const scheduler = new NodeScheduler()
			const controller = new AbortController()
			controller.abort('stop')

			await expect(scheduler.yield({ signal: controller.signal })).rejects.toBe('stop')
		})

		it('forwards an object reason by identity on the while-pending path too', async () => {
			vi.useFakeTimers()
			try {
				const scheduler = new NodeScheduler()
				const controller = new AbortController()
				const reason = { code: 'CANCELLED', detail: { at: 1 } }

				const pending = scheduler.delay(50, { signal: controller.signal })
				controller.abort(reason)
				await expect(pending).rejects.toBe(reason)
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe('priority (accepted, a no-op on Node)', () => {
		it('yield and delay accept every priority without error and resolve the same (real timers)', async () => {
			const scheduler = new NodeScheduler()

			for (const priority of ['user', 'normal', 'background'] as const) {
				await expect(scheduler.yield({ priority })).resolves.toBeUndefined()
				await expect(scheduler.delay(1, { priority })).resolves.toBeUndefined()
			}
		})

		it('priority combined with a signal is still abort-aware', async () => {
			const scheduler = new NodeScheduler()
			const controller = new AbortController()
			const reason = new Error('pre-aborted with priority')
			controller.abort(reason)

			await expect(
				scheduler.delay(50, { priority: 'background', signal: controller.signal }),
			).rejects.toBe(reason)
		})
	})

	describe('churn & leak-safety (fake timers)', () => {
		afterEach(() => {
			vi.useRealTimers()
		})

		it('thousands of resolved delays never accumulate host timers', async () => {
			vi.useFakeTimers()
			const scheduler = new NodeScheduler()

			for (let cycle = 0; cycle < 2_000; cycle += 1) {
				const pending = scheduler.delay(10)
				expect(vi.getTimerCount()).toBe(1)
				await vi.advanceTimersByTimeAsync(10)
				await pending
				expect(vi.getTimerCount()).toBe(0)
			}

			expect(vi.getTimerCount()).toBe(0)
		})

		it('thousands of aborted delays clear every timer — no leak on the cancellation path', async () => {
			vi.useFakeTimers()
			const scheduler = new NodeScheduler()

			for (let cycle = 0; cycle < 2_000; cycle += 1) {
				const controller = new AbortController()
				const pending = scheduler.delay(50, { signal: controller.signal })
				pending.catch(() => {})
				expect(vi.getTimerCount()).toBe(1)
				controller.abort(new Error('churn'))
				await expect(pending).rejects.toThrow('churn')
				expect(vi.getTimerCount()).toBe(0)
			}

			expect(vi.getTimerCount()).toBe(0)
		})

		it('the abort listener nets to zero across a churn of resolved delays on one signal', async () => {
			vi.useFakeTimers()
			const scheduler = new NodeScheduler()
			const controller = new AbortController()
			const { added, removed } = instrumentSignal(controller.signal)

			// Every call settles by RESOLVING — the path that must remove the listener it added.
			for (let cycle = 0; cycle < 1_000; cycle += 1) {
				const pending = scheduler.delay(5, { signal: controller.signal })
				await vi.advanceTimersByTimeAsync(5)
				await pending
			}

			expect(added.count).toBe(1_000)
			expect(added.count - removed.count).toBe(0)
		})
	})
})
