import type { SchedulePriority } from '@src/core'
import { Schedule } from '@src/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRecorder } from '../../../setup.js'

// Schedule — the cross-environment setTimeout-based cooperative-yield default.
// Timing assertions use fake timers for determinism (AGENTS §16); the macrotask
// proof uses real microtask/macrotask ordering (fake timers don't reorder the two).

describe('Schedule', () => {
	describe('yield', () => {
		it('resolves asynchronously — the continuation runs after the current task', async () => {
			const schedule = new Schedule()
			let resumed = false

			const pending = schedule.yield().then(() => {
				resumed = true
			})
			// Synchronously after the call, the continuation has NOT run yet.
			expect(resumed).toBe(false)

			await pending
			expect(resumed).toBe(true)
		})

		it('yields as a macrotask, not a microtask — a microtask queued after it runs first', async () => {
			const schedule = new Schedule()
			const order: string[] = []

			const yielded = schedule.yield().then(() => order.push('yield'))
			// A microtask queued AFTER the yield call. If yield were microtask-backed
			// (queueMicrotask), it would resume before this; a setTimeout(0) macrotask
			// resolves strictly after the microtask queue drains, so 'microtask' wins.
			queueMicrotask(() => order.push('microtask'))

			await yielded
			expect(order).toEqual(['microtask', 'yield'])
		})

		it('rejects with the reason when the signal is already aborted', async () => {
			const schedule = new Schedule()
			const controller = new AbortController()
			const reason = new Error('pre-aborted')
			controller.abort(reason)

			await expect(schedule.yield({ signal: controller.signal })).rejects.toBe(reason)
		})

		it('rejects with the reason when the signal aborts while pending', async () => {
			const schedule = new Schedule()
			const controller = new AbortController()
			const reason = new Error('aborted while pending')

			const pending = schedule.yield({ signal: controller.signal })
			controller.abort(reason)

			await expect(pending).rejects.toBe(reason)
		})

		it('aborting clears the pending macrotask timer, with no late resolution (fake timers)', async () => {
			vi.useFakeTimers()
			try {
				const schedule = new Schedule()
				const controller = new AbortController()
				const reason = new Error('aborted before the turn')
				const resolved = createRecorder<readonly []>()

				const pending = schedule.yield({ signal: controller.signal })
				pending.then(resolved.handler, () => {})
				// yield arms a setTimeout(0) macrotask, so there is exactly one pending timer.
				expect(vi.getTimerCount()).toBe(1)

				controller.abort(reason)
				await expect(pending).rejects.toBe(reason)
				// The abort path cleared the timer before the macrotask could fire.
				expect(vi.getTimerCount()).toBe(0)

				// Draining the (now-empty) macrotask queue is a no-op: the already-rejected
				// promise never also resolves — no double-settle, no late resolution.
				await vi.advanceTimersByTimeAsync(0)
				expect(resolved.count).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		})

		it('a completed yield leaves no pending timer, so a later abort is inert (fake timers)', async () => {
			vi.useFakeTimers()
			try {
				const schedule = new Schedule()
				const controller = new AbortController()
				const aborted = createRecorder<readonly []>()
				controller.signal.addEventListener('abort', aborted.handler)
				const resolved = createRecorder<readonly []>()

				const pending = schedule.yield({ signal: controller.signal }).then(resolved.handler)
				await vi.advanceTimersByTimeAsync(0)
				await pending
				expect(resolved.count).toBe(1)
				expect(vi.getTimerCount()).toBe(0)

				// The internal listener was removed on resolve, so a later abort is inert for
				// the (already-settled) yield — only our own listener fires, and nothing re-settles.
				controller.abort(new Error('after the turn'))
				expect(aborted.count).toBe(1)
				expect(resolved.count).toBe(1)
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe('delay (fake timers)', () => {
		afterEach(() => {
			vi.useRealTimers()
		})

		it('resolves after ms', async () => {
			vi.useFakeTimers()
			const schedule = new Schedule()
			const resolved = createRecorder<readonly []>()

			const pending = schedule.delay(50).then(resolved.handler)
			// Not yet — the timer has not elapsed.
			await vi.advanceTimersByTimeAsync(49)
			expect(resolved.count).toBe(0)

			await vi.advanceTimersByTimeAsync(1)
			await pending
			expect(resolved.count).toBe(1)
		})

		it('rejects on abort before ms elapses, and the timer never later fires', async () => {
			vi.useFakeTimers()
			const schedule = new Schedule()
			const controller = new AbortController()
			const reason = new Error('aborted before deadline')
			const resolved = createRecorder<readonly []>()

			const pending = schedule.delay(50, { signal: controller.signal })
			pending.then(resolved.handler, () => {})

			await vi.advanceTimersByTimeAsync(20)
			controller.abort(reason)
			await expect(pending).rejects.toBe(reason)

			// The timer was cleared — advancing past the original deadline is a no-op,
			// so the (already-rejected) promise never also resolves (no double-settle).
			await vi.advanceTimersByTimeAsync(100)
			expect(resolved.count).toBe(0)
		})

		it('an already-aborted signal rejects immediately without arming a timer', async () => {
			vi.useFakeTimers()
			const schedule = new Schedule()
			const controller = new AbortController()
			const reason = new Error('pre-aborted')
			controller.abort(reason)

			await expect(schedule.delay(50, { signal: controller.signal })).rejects.toBe(reason)
			// No timer should be pending — nothing to run.
			expect(vi.getTimerCount()).toBe(0)
		})

		it('aborting clears the pending timer (no leaked timer)', async () => {
			vi.useFakeTimers()
			const schedule = new Schedule()
			const controller = new AbortController()

			const pending = schedule.delay(50, { signal: controller.signal })
			pending.catch(() => {})
			expect(vi.getTimerCount()).toBe(1)

			controller.abort(new Error('clear it'))
			await expect(pending).rejects.toThrow('clear it')
			expect(vi.getTimerCount()).toBe(0)
		})

		it('a completed delay leaves no pending timer or abort listener', async () => {
			vi.useFakeTimers()
			const schedule = new Schedule()
			const controller = new AbortController()
			const aborted = createRecorder<readonly []>()
			controller.signal.addEventListener('abort', aborted.handler)

			const pending = schedule.delay(10, { signal: controller.signal })
			await vi.advanceTimersByTimeAsync(10)
			await pending
			expect(vi.getTimerCount()).toBe(0)

			// The internal listener was removed on resolve, so a later abort is inert
			// for the (already-settled) delay — only our own listener still fires.
			controller.abort(new Error('after resolve'))
			expect(aborted.count).toBe(1)
		})
	})

	describe('priority', () => {
		const priorities: readonly SchedulePriority[] = ['user', 'normal', 'background']

		it('yield accepts every priority without error and resolves the same', async () => {
			const schedule = new Schedule()

			for (const priority of priorities) {
				await expect(schedule.yield({ priority })).resolves.toBeUndefined()
			}
		})

		it('delay accepts every priority without error and resolves the same', async () => {
			const schedule = new Schedule()

			for (const priority of priorities) {
				await expect(schedule.delay(1, { priority })).resolves.toBeUndefined()
			}
		})

		it('every priority arms exactly one timer of the same duration — urgency is uniform (fake timers)', async () => {
			vi.useFakeTimers()
			try {
				const schedule = new Schedule()
				const resolved = createRecorder<readonly []>()

				// All three fire at the same instant — none is fast-tracked or deferred by its hint.
				const pending = Promise.all(
					priorities.map((priority) => schedule.delay(50, { priority }).then(resolved.handler)),
				)
				expect(vi.getTimerCount()).toBe(priorities.length)

				await vi.advanceTimersByTimeAsync(49)
				expect(resolved.count).toBe(0) // not before the shared deadline
				await vi.advanceTimersByTimeAsync(1)
				await pending
				expect(resolved.count).toBe(priorities.length) // and all together at it
			} finally {
				vi.useRealTimers()
			}
		})

		it('priority combined with signal is still abort-aware (pre-aborted and while pending)', async () => {
			const schedule = new Schedule()
			const preReason = new Error('pre-aborted with priority')
			const pre = new AbortController()
			pre.abort(preReason)
			await expect(schedule.delay(50, { priority: 'background', signal: pre.signal })).rejects.toBe(
				preReason,
			)

			const live = new AbortController()
			const liveReason = new Error('aborted while pending with priority')
			const pending = schedule.yield({ priority: 'user', signal: live.signal })
			live.abort(liveReason)
			await expect(pending).rejects.toBe(liveReason)
		})
	})
})

// Production-hardening — churn/leak-safety, one-signal-N-operations, concurrent
// multi-`ms` delays, abort-timing edges, and `ms` boundary/clamp behaviour. All
// timing and leak assertions run on fake timers so the host timer count is an exact,
// observable quantity (`vi.getTimerCount()`) and deadlines step deterministically —
// no arbitrary sleeps, no mocks of the Schedule (AGENTS §16). Mirrors the Timeout
// suite's fake-timer leak proofs.

describe('Schedule — churn & leak-safety (fake timers)', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('thousands of resolved yields never accumulate host timers (each fires and is consumed)', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()

		for (let cycle = 0; cycle < 2_000; cycle += 1) {
			const pending = schedule.yield()
			// Exactly one timer armed per call — the prior cycle's was consumed, never stacked.
			expect(vi.getTimerCount()).toBe(1)
			await vi.advanceTimersByTimeAsync(0)
			await pending
			expect(vi.getTimerCount()).toBe(0)
		}

		// No residue after two thousand resolved yields.
		expect(vi.getTimerCount()).toBe(0)
	})

	it('thousands of resolved delays never accumulate host timers', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()

		for (let cycle = 0; cycle < 2_000; cycle += 1) {
			const pending = schedule.delay(10)
			expect(vi.getTimerCount()).toBe(1)
			await vi.advanceTimersByTimeAsync(10)
			await pending
			expect(vi.getTimerCount()).toBe(0)
		}

		expect(vi.getTimerCount()).toBe(0)
	})

	it('thousands of ABORTED yields clear every timer — no leak on the cancellation path', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()

		for (let cycle = 0; cycle < 2_000; cycle += 1) {
			const controller = new AbortController()
			const pending = schedule.yield({ signal: controller.signal })
			pending.catch(() => {}) // swallow — the assertion is on cleanup, not the rejection value
			expect(vi.getTimerCount()).toBe(1)
			controller.abort(new Error('churn'))
			await expect(pending).rejects.toThrow('churn')
			// The abort path cleared the armed timer before the macrotask could fire.
			expect(vi.getTimerCount()).toBe(0)
		}

		expect(vi.getTimerCount()).toBe(0)
	})

	it('thousands of ABORTED delays clear every timer — no leak on the cancellation path', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()

		for (let cycle = 0; cycle < 2_000; cycle += 1) {
			const controller = new AbortController()
			const pending = schedule.delay(50, { signal: controller.signal })
			pending.catch(() => {})
			expect(vi.getTimerCount()).toBe(1)
			controller.abort(new Error('churn'))
			await expect(pending).rejects.toThrow('churn')
			expect(vi.getTimerCount()).toBe(0)
		}

		expect(vi.getTimerCount()).toBe(0)
	})

	it('a churn of mixed resolved + aborted calls on fresh signals ends with zero pending timers', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()

		for (let cycle = 0; cycle < 1_000; cycle += 1) {
			// Alternate the two settle paths on fresh signals: even cycles resolve by
			// advancing to the deadline; odd cycles reject by aborting before it. Both
			// must leave the timer count at zero — proven uniformly after the branch.
			const resolves = cycle % 2 === 0
			const controller = new AbortController()
			const pending = resolves
				? schedule.delay(10)
				: schedule.delay(10, { signal: controller.signal }).then(null, () => 'aborted')
			if (resolves) await vi.advanceTimersByTimeAsync(10)
			else controller.abort(new Error('odd'))
			await pending
			expect(vi.getTimerCount()).toBe(0)
		}

		expect(vi.getTimerCount()).toBe(0)
	})

	it('abort-listener bookkeeping nets to zero across churn (directly counted, no leak)', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		// Observe the REAL signal's listener bookkeeping by counting calls to its own
		// add/remove (delegating to the genuine implementation) — instrumenting a
		// test-owned signal, not mocking the Schedule (AGENTS §16). The single signal
		// is reused, so it must NEVER carry an abort listener after a call settles by
		// resolving: if `#sleep` failed to remove the listener on the timer path, adds
		// would outpace removes and the running net would climb without bound.
		const controller = new AbortController()
		let added = 0
		let removed = 0
		const realAdd = controller.signal.addEventListener.bind(controller.signal)
		const realRemove = controller.signal.removeEventListener.bind(controller.signal)
		controller.signal.addEventListener = (
			type: string,
			listener: EventListener,
			options?: boolean | AddEventListenerOptions,
		): void => {
			if (type === 'abort') added += 1
			realAdd(type, listener, options)
		}
		controller.signal.removeEventListener = (
			type: string,
			listener: EventListener,
			options?: boolean | EventListenerOptions,
		): void => {
			if (type === 'abort') removed += 1
			realRemove(type, listener, options)
		}

		// The signal never aborts here — every call settles by RESOLVING, which is the
		// path that must remove the listener it added (the abort path is proven above).
		for (let cycle = 0; cycle < 1_000; cycle += 1) {
			const pending = schedule.delay(5, { signal: controller.signal })
			await vi.advanceTimersByTimeAsync(5)
			await pending
		}

		// Every resolved call detached the listener it attached: adds and removes balance
		// exactly, so the long-lived signal holds no accumulated listeners.
		expect(added).toBe(1_000)
		expect(added - removed).toBe(0)
	})
})

describe('Schedule — one signal, N pending operations (fake timers)', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('one abort rejects ALL pending yields/delays sharing the signal, with its reason', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const controller = new AbortController()
		const reason = new Error('shared abort')

		// A single signal threaded through a mix of concurrent yields and delays.
		const pending = [
			schedule.yield({ signal: controller.signal }),
			schedule.yield({ signal: controller.signal }),
			schedule.delay(10, { signal: controller.signal }),
			schedule.delay(50, { signal: controller.signal }),
			schedule.delay(100, { signal: controller.signal }),
		]
		// One armed timer per pending operation.
		expect(vi.getTimerCount()).toBe(pending.length)

		controller.abort(reason)

		// EVERY pending operation rejects with the SAME reason — none is missed. Folding
		// each outcome to a plain `{ status, reason }` lets one unconditional assertion
		// cover the whole batch (a fulfilled outcome carries no `reason`).
		const settled = await Promise.allSettled(pending)
		const outcomes = settled.map((outcome) => ({
			status: outcome.status,
			reason: outcome.status === 'rejected' ? outcome.reason : undefined,
		}))
		expect(outcomes).toEqual(pending.map(() => ({ status: 'rejected', reason })))
		// And every armed timer was cleared — the shared abort cleaned them all up.
		expect(vi.getTimerCount()).toBe(0)
	})

	it('aborting a shared signal removes ALL listeners — no double-settle when the deadlines pass', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const controller = new AbortController()
		const settled = createRecorder<readonly ['resolved' | 'rejected']>()

		const pending = [10, 20, 30, 40].map((ms) =>
			schedule.delay(ms, { signal: controller.signal }).then(
				() => settled.handler('resolved'),
				() => settled.handler('rejected'),
			),
		)
		expect(vi.getTimerCount()).toBe(pending.length)

		controller.abort(new Error('all at once'))
		await Promise.all(pending)
		// All four settled exactly once, all by rejection.
		expect(settled.count).toBe(4)
		expect(settled.calls.every(([outcome]) => outcome === 'rejected')).toBe(true)

		// Advancing well past every original deadline fires nothing — the timers are gone
		// and the listeners were removed, so none of the four can settle a second time.
		await vi.advanceTimersByTimeAsync(1_000)
		expect(settled.count).toBe(4)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('a shared signal already aborted rejects every new call immediately, arming no timer', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const controller = new AbortController()
		const reason = new Error('already gone')
		controller.abort(reason)

		const calls = [
			schedule.yield({ signal: controller.signal }),
			schedule.delay(10, { signal: controller.signal }),
			schedule.delay(50, { signal: controller.signal }),
		]
		// Pre-aborted: each call short-circuits to a rejected promise, arming no timer.
		expect(vi.getTimerCount()).toBe(0)

		for (const call of calls) await expect(call).rejects.toBe(reason)
		expect(vi.getTimerCount()).toBe(0)
	})
})

describe('Schedule — concurrent delays at distinct deadlines (fake timers)', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('many delays in flight each resolve at exactly their own time, independently', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const order: number[] = []

		// Out-of-order arming with distinct deadlines — resolution order must follow the
		// deadlines (10, 20, 30, 40, 50), not the call order, and each fires at its own ms.
		const durations = [30, 10, 50, 20, 40]
		const pending = durations.map((ms) =>
			schedule.delay(ms).then(() => {
				order.push(ms)
			}),
		)
		expect(vi.getTimerCount()).toBe(durations.length)

		// Step to each deadline in turn; exactly the delays due by that instant have fired.
		await vi.advanceTimersByTimeAsync(10)
		expect(order).toEqual([10])
		expect(vi.getTimerCount()).toBe(4)

		await vi.advanceTimersByTimeAsync(10) // → 20ms
		expect(order).toEqual([10, 20])

		await vi.advanceTimersByTimeAsync(10) // → 30ms
		expect(order).toEqual([10, 20, 30])

		await vi.advanceTimersByTimeAsync(20) // → 50ms (covers 40 then 50)
		await Promise.all(pending)
		expect(order).toEqual([10, 20, 30, 40, 50])
		expect(vi.getTimerCount()).toBe(0)
	})

	it('delays with the same deadline all resolve together, none early or late', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const resolved = createRecorder<readonly []>()

		const pending = Promise.all(
			Array.from({ length: 8 }, () => schedule.delay(25).then(resolved.handler)),
		)
		expect(vi.getTimerCount()).toBe(8)

		await vi.advanceTimersByTimeAsync(24)
		expect(resolved.count).toBe(0) // none early
		await vi.advanceTimersByTimeAsync(1)
		await pending
		expect(resolved.count).toBe(8) // all at the deadline
		expect(vi.getTimerCount()).toBe(0)
	})

	it('aborting one shared signal mid-flight rejects all the staggered delays at once', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const controller = new AbortController()
		const reason = new Error('cut short')
		const resolved = createRecorder<readonly []>()

		const pending = [10, 100, 1_000].map((ms) =>
			schedule.delay(ms, { signal: controller.signal }).then(resolved.handler, () => {}),
		)
		expect(vi.getTimerCount()).toBe(3)

		// Abort after the shortest deadline has NOT yet been reached — all three are still
		// pending, so all three reject (none had resolved).
		controller.abort(reason)
		await Promise.all(pending)
		expect(resolved.count).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})
})

describe('Schedule — abort-timing edges (fake timers)', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('a pre-aborted signal makes yield reject immediately and arm NO timer', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const controller = new AbortController()
		const reason = new Error('pre-aborted yield')
		controller.abort(reason)

		await expect(schedule.yield({ signal: controller.signal })).rejects.toBe(reason)
		// The short-circuit returns a rejected promise without entering the executor.
		expect(vi.getTimerCount()).toBe(0)
	})

	it('aborting exactly at the deadline tick: whichever path runs first wins, settling once', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const controller = new AbortController()
		const settled = createRecorder<readonly ['resolved' | 'rejected']>()

		const pending = schedule.delay(50, { signal: controller.signal }).then(
			() => settled.handler('resolved'),
			() => settled.handler('rejected'),
		)
		// Advance to the exact deadline so the timer callback runs and resolves; on the
		// timer path the abort listener is removed BEFORE resolving, so the abort that
		// follows can no longer reach reject.
		await vi.advanceTimersByTimeAsync(50)
		controller.abort(new Error('too late — already resolved'))

		await pending
		// Settled exactly once, and by the timer (resolution), since it ran first.
		expect(settled.count).toBe(1)
		expect(settled.calls).toEqual([['resolved']])
		expect(vi.getTimerCount()).toBe(0)
	})

	it('an abort AFTER a delay has resolved is inert — no late reject, no double-settle', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const controller = new AbortController()
		const aborted = createRecorder<readonly []>()
		controller.signal.addEventListener('abort', aborted.handler)
		const settled = createRecorder<readonly ['resolved' | 'rejected']>()

		const pending = schedule.delay(10, { signal: controller.signal }).then(
			() => settled.handler('resolved'),
			() => settled.handler('rejected'),
		)
		await vi.advanceTimersByTimeAsync(10)
		await pending
		expect(settled.calls).toEqual([['resolved']])
		expect(vi.getTimerCount()).toBe(0)

		// The internal listener was removed on resolve; a later abort only reaches OUR
		// listener and cannot re-settle the already-resolved delay.
		controller.abort(new Error('after resolution'))
		expect(aborted.count).toBe(1)
		expect(settled.count).toBe(1)
	})

	it('an abort AFTER a yield has resolved is inert — no late reject, no double-settle', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const controller = new AbortController()
		const settled = createRecorder<readonly ['resolved' | 'rejected']>()

		const pending = schedule.yield({ signal: controller.signal }).then(
			() => settled.handler('resolved'),
			() => settled.handler('rejected'),
		)
		await vi.advanceTimersByTimeAsync(0)
		await pending
		expect(settled.calls).toEqual([['resolved']])

		controller.abort(new Error('after the turn'))
		await vi.advanceTimersByTimeAsync(0)
		expect(settled.count).toBe(1)
		expect(vi.getTimerCount()).toBe(0)
	})
})

describe('Schedule — abort reason types', () => {
	// The reject value is whatever `signal.reason` holds — the Schedule forwards it
	// verbatim, never wrapping or substituting. These pin what each reason yields, both
	// on the pre-aborted short-circuit and the abort-while-pending path.

	it('a bare abort() rejects with the default AbortError DOMException (reason is never undefined)', async () => {
		const schedule = new Schedule()
		const controller = new AbortController()
		controller.abort() // no reason supplied

		// The platform fills in a DOMException named 'AbortError' — so the documented
		// "reason" is that, never literally `undefined`.
		await expect(schedule.delay(50, { signal: controller.signal })).rejects.toBeInstanceOf(
			DOMException,
		)
		await expect(schedule.delay(50, { signal: controller.signal })).rejects.toHaveProperty(
			'name',
			'AbortError',
		)
	})

	it('forwards a string reason verbatim (not wrapped in an Error)', async () => {
		const schedule = new Schedule()
		const controller = new AbortController()
		controller.abort('stop')

		await expect(schedule.yield({ signal: controller.signal })).rejects.toBe('stop')
	})

	it('forwards an object reason by identity', async () => {
		const schedule = new Schedule()
		const controller = new AbortController()
		const reason = { code: 'CANCELLED', detail: { at: 1 } }
		controller.abort(reason)

		await expect(schedule.delay(50, { signal: controller.signal })).rejects.toBe(reason)
	})

	it('forwards the reason by identity on the abort-while-pending path too', async () => {
		vi.useFakeTimers()
		try {
			const schedule = new Schedule()
			const controller = new AbortController()
			const reason = { kind: 'late' }

			const pending = schedule.delay(50, { signal: controller.signal })
			controller.abort(reason)
			await expect(pending).rejects.toBe(reason)
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('Schedule — ms boundaries & clamp (fake timers)', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('delay(0) resolves on the next macrotask turn (one armed timer, then none)', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const resolved = createRecorder<readonly []>()

		const pending = schedule.delay(0).then(resolved.handler)
		expect(vi.getTimerCount()).toBe(1)
		expect(resolved.count).toBe(0) // not synchronously

		await vi.advanceTimersByTimeAsync(0)
		await pending
		expect(resolved.count).toBe(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('delay(1) resolves after exactly one millisecond, not before', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const resolved = createRecorder<readonly []>()

		const pending = schedule.delay(1).then(resolved.handler)
		await vi.advanceTimersByTimeAsync(0)
		expect(resolved.count).toBe(0) // one tick short of the 1ms boundary

		await vi.advanceTimersByTimeAsync(1)
		await pending
		expect(resolved.count).toBe(1)
	})

	it('delay(-100) is clamped to ~0 by the host setTimeout — resolves on the next turn, never throws', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const resolved = createRecorder<readonly []>()

		// The primitive does no validation (documented): a negative ms passes straight to
		// setTimeout, which clamps it to ~0, so it resolves on the next macrotask turn.
		const pending = schedule.delay(-100).then(resolved.handler)
		expect(vi.getTimerCount()).toBe(1)
		expect(resolved.count).toBe(0)

		await vi.advanceTimersByTimeAsync(0)
		await pending
		expect(resolved.count).toBe(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('delay(NaN) is clamped to ~0 by the host setTimeout — resolves on the next turn, never throws', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const resolved = createRecorder<readonly []>()

		const pending = schedule.delay(Number.NaN).then(resolved.handler)
		expect(vi.getTimerCount()).toBe(1)

		await vi.advanceTimersByTimeAsync(0)
		await pending
		expect(resolved.count).toBe(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('a negative/NaN delay is still abort-aware — a pre-aborted signal rejects without arming a timer', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const controller = new AbortController()
		const reason = new Error('pre-aborted out-of-domain ms')
		controller.abort(reason)

		// The abort short-circuit precedes any setTimeout, so it holds regardless of ms.
		await expect(schedule.delay(-100, { signal: controller.signal })).rejects.toBe(reason)
		await expect(schedule.delay(Number.NaN, { signal: controller.signal })).rejects.toBe(reason)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('a large ms delay stays armed until its full duration elapses (no premature clamp)', async () => {
		vi.useFakeTimers()
		const schedule = new Schedule()
		const resolved = createRecorder<readonly []>()
		const big = 2_147_483_647 // the host setTimeout max (~24.8 days)

		const pending = schedule.delay(big).then(resolved.handler)
		await vi.advanceTimersByTimeAsync(big - 1)
		// Still pending one tick short of the deadline — not clamped down to ~0.
		expect(resolved.count).toBe(0)
		expect(vi.getTimerCount()).toBe(1)

		await vi.advanceTimersByTimeAsync(1)
		await pending
		expect(resolved.count).toBe(1)
		expect(vi.getTimerCount()).toBe(0)
	})
})
