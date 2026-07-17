import { describe, expect, it } from 'vitest'
import { createRunner } from '@src/core'
import {
	createErrorRecorder,
	createGate,
	createRecorder,
	recordEmitterEvents,
	waitForDelay,
} from '../../setup.js'

describe('Runner', () => {
	it('execute runs every input and returns results in declared order', async () => {
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: (controller) => controller.input * 10,
		})
		// Out-of-order completion (later inputs finish first) must NOT reorder results.
		const slow = createRunner<number, number>({
			concurrency: 4,
			handler: async (controller) => {
				await waitForDelay(controller.input === 1 ? 10 : 0)
				return controller.input * 10
			},
		})
		expect(await runner.execute([1, 2, 3])).toEqual([10, 20, 30])
		expect(await slow.execute([1, 2, 3])).toEqual([10, 20, 30])
	})

	it('empty execute resolves to []', async () => {
		const runner = createRunner<number, number>({ handler: (controller) => controller.input })
		expect(await runner.execute([])).toEqual([])
	})

	it('spawned siblings actually run and are ordered after declared units (B2)', async () => {
		const ran: number[] = []
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: (controller) => {
				ran.push(controller.input)
				// Each declared unit < 10 fans out exactly one sibling (fire-and-track).
				if (controller.input < 10) controller.spawn(controller.input + 100)
				return controller.input
			},
		})
		const results = await runner.execute([1, 2, 3])
		// The spawned units (101/102/103) ran — a stale snapshot would have skipped them.
		expect(ran.sort((a, b) => a - b)).toEqual([1, 2, 3, 101, 102, 103])
		// Declared first (in input order), then spawns (in spawn order).
		expect(results).toEqual([1, 2, 3, 101, 102, 103])
	})

	it('nested spawns (a spawn that spawns) all drain and order', async () => {
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: (controller) => {
				// 1 → spawns 2 → spawns 3 (a transitive chain), then stop.
				if (controller.input < 3) controller.spawn(controller.input + 1)
				return controller.input
			},
		})
		const results = await runner.execute([1])
		// The whole closure ran: declared 1, then spawn 2, then 2's spawn 3.
		expect(results).toEqual([1, 2, 3])
	})

	it('bounded concurrency limits handlers in flight', async () => {
		const gate = createGate()
		let inFlight = 0
		let peak = 0
		const runner = createRunner<number, number>({
			concurrency: 2,
			handler: async (controller) => {
				inFlight += 1
				peak = Math.max(peak, inFlight)
				await gate.promise
				inFlight -= 1
				return controller.input
			},
		})
		const run = runner.execute([1, 2, 3, 4, 5])
		// Let the queue saturate its two slots before releasing the gate.
		await waitForDelay(10)
		expect(peak).toBe(2)
		gate.resolve()
		expect(await run).toEqual([1, 2, 3, 4, 5])
		expect(peak).toBe(2)
	})

	it('retries re-run a flaky unit until it succeeds', async () => {
		let attempts = 0
		const runner = createRunner<number, number>({
			retries: 2,
			handler: (controller) => {
				attempts += 1
				if (attempts < 3) throw new Error('flaky')
				return controller.input
			},
		})
		expect(await runner.execute([7])).toEqual([7])
		expect(attempts).toBe(3) // two retries after the first attempt
	})

	it('entries overrides retries PER ENTRY — a retried input recovers while a no-retry sibling fails', async () => {
		// The per-entry channel: `entries` resolves a RunnerEntryOptions from each input, spread
		// into that unit's enqueue so it OVERRIDES the (absent) runner-level default. The 'retry' unit
		// gets retries:2 and fails its first two attempts then succeeds (3 runs); the 'once' unit gets
		// retries:0 and always fails (exactly 1 run). bail:false is N/A — this is plain fail-fast, so
		// the run rejects on 'once', but the divergence is read from the real per-input attempt counts.
		const attempts = new Map<string, number>()
		const runner = createRunner<string, string>({
			concurrency: 1, // serialize so the retried unit fully recovers before the sibling runs
			handler: (controller) => {
				const seen = (attempts.get(controller.input) ?? 0) + 1
				attempts.set(controller.input, seen)
				// 'retry' fails its first TWO attempts (recovers on the 3rd, given retries:2); 'once'
				// always throws (given retries:0 it is terminal on its single attempt).
				if (controller.input === 'retry' && seen < 3) throw new Error('flaky')
				if (controller.input === 'once') throw new Error('always')
				return controller.input
			},
			entries: (input) => (input === 'retry' ? { retries: 2 } : { retries: 0 }),
		})
		// 'retry' first so it recovers (its retries are spent) before the no-retry 'once' fails fast.
		await expect(runner.execute(['retry', 'once'])).rejects.toThrow('always')
		// THE per-entry divergence: the retried input ran 3 times and SUCCEEDED; the no-retry sibling
		// ran exactly once and FAILED — different reliability resolved from the same runner, per input.
		expect(attempts.get('retry')).toBe(3)
		expect(attempts.get('once')).toBe(1)
	})

	it('fail-fast: a unit failure rejects execute and aborts the siblings', async () => {
		const release = createGate()
		const observed: boolean[] = []
		const runner = createRunner<string, string>({
			concurrency: 4,
			retries: 0,
			handler: async (controller) => {
				if (controller.input === 'boom') throw new Error('kaboom')
				// A sibling that parks until aborted — it should see its signal fire.
				await Promise.race([controller.wait(), release.promise])
				observed.push(controller.aborted)
				return controller.input
			},
		})
		await expect(runner.execute(['a', 'boom', 'b'])).rejects.toThrow('kaboom')
		release.resolve()
		await waitForDelay(0)
		// The surviving siblings observed their signal aborted (fail-fast propagation).
		expect(observed.every((aborted) => aborted)).toBe(true)
		expect(observed.length).toBeGreaterThan(0)
		expect(runner.stopped).toBe(true)
	})

	it('abort() mid-run rejects execute and fires every unit signal', async () => {
		const aborted: boolean[] = []
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: async (controller) => {
				await controller.wait() // park until cancelled
				aborted.push(controller.aborted)
				return controller.input
			},
		})
		const run = runner.execute([1, 2, 3])
		await waitForDelay(10)
		runner.abort(new Error('shutting down'))
		await expect(run).rejects.toThrow('shutting down')
		await waitForDelay(0)
		expect(aborted.length).toBe(3)
		expect(aborted.every((value) => value)).toBe(true)
		expect(runner.stopped).toBe(true)
	})

	it('is one-shot — a second execute throws', async () => {
		const runner = createRunner<number, number>({ handler: (controller) => controller.input })
		await runner.execute([1])
		await expect(runner.execute([2])).rejects.toThrow('already executed')
	})

	it('spawn outside an active run throws', async () => {
		let escaped: ((input: number) => Promise<number>) | undefined
		const runner = createRunner<number, number>({
			handler: (controller) => {
				escaped = (input) => controller.spawn(input)
				return controller.input
			},
		})
		await runner.execute([1])
		// The run has settled — the captured spawn is now invalid (throws synchronously).
		expect(escaped).toBeDefined()
		expect(() => escaped?.(2)).toThrow('spawn is unavailable outside an active run')
	})

	it('active reports the outstanding unit count, stopped flips after abort', async () => {
		const gate = createGate()
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: async (controller) => {
				await gate.promise
				return controller.input
			},
		})
		expect(runner.active).toBe(0)
		expect(runner.stopped).toBe(false)
		const run = runner.execute([1, 2, 3])
		await waitForDelay(10)
		expect(runner.active).toBe(3)
		gate.resolve()
		await run
		expect(runner.active).toBe(0)
	})

	it('destroy is idempotent and stops the runner', async () => {
		const runner = createRunner<number, number>({ handler: (controller) => controller.input })
		runner.destroy()
		runner.destroy() // no throw
		expect(runner.stopped).toBe(true)
		await expect(runner.execute([1])).rejects.toThrow('stopped')
	})

	it('preserves an undefined / void result at each index (boxed-outcome, not a sentinel)', async () => {
		// The single most important invariant: a unit whose handler returns nothing must
		// still occupy its slot in the ordered output as `undefined`. The boxed `#values`
		// outcome exists precisely so presence is map-membership, not an `undefined`
		// sentinel — a sentinel-based `#collect` would silently drop every void result.
		const runner = createRunner<number, void>({
			concurrency: 4,
			handler: () => {
				// returns undefined (void)
			},
		})
		const results = await runner.execute([1, 2, 3])
		expect(results.length).toBe(3) // a sentinel `#collect` would yield length 0 here
		expect(results).toEqual([undefined, undefined, undefined])
		expect(results[0]).toBeUndefined()
		expect(results[1]).toBeUndefined()
		expect(results[2]).toBeUndefined()
	})

	it('concurrency:1 fan-out drains without self-starvation (parent frees the slot, then the spawn)', async () => {
		// The headline fire-and-track guarantee at the tightest setting: one slot. The
		// parent must return (freeing the only slot) for the spawned child to run FIFO; if
		// the runner ever awaited the spawn inside the parent's slot, this would deadlock.
		const ran: string[] = []
		const runner = createRunner<string, string>({
			concurrency: 1,
			handler: (controller) => {
				ran.push(controller.input)
				if (controller.input === 'parent') controller.spawn('child') // fire-and-track
				return controller.input
			},
		})
		const results = await runner.execute(['parent'])
		// Parent ran first and returned; only then did the single slot run the spawned child.
		expect(ran).toEqual(['parent', 'child'])
		// Declared first, then the spawn — in order, at one slot.
		expect(results).toEqual(['parent', 'child'])
	})

	it('timeout fail-fast: a stalled unit times out, rejecting execute and aborting siblings', async () => {
		const observed: boolean[] = []
		const runner = createRunner<string, string>({
			concurrency: 4,
			retries: 0,
			timeout: 10, // each attempt is bounded — a never-resolving unit fails on the deadline
			handler: async (controller) => {
				if (controller.input === 'stall') {
					await controller.wait() // never resolves on its own — only the timeout fires it
					return controller.input
				}
				// A sibling that parks until its signal fires — by the fail-fast abort fanning
				// out, or its own per-attempt deadline; either way the unit is cancelled.
				await controller.wait()
				observed.push(controller.signal.aborted)
				return controller.input
			},
		})
		// The stalled unit's attempt times out (retries: 0 → terminal), failing the run.
		await expect(runner.execute(['stall', 'a', 'b'])).rejects.toThrow('attempt timed out')
		await waitForDelay(0)
		// The surviving siblings observed their signal abort (fail-fast / timeout propagation).
		expect(observed.length).toBeGreaterThan(0)
		expect(observed.every((aborted) => aborted)).toBe(true)
		expect(runner.stopped).toBe(true)
	})

	it('abort(reason) preserves a non-Error reason on both the rejection and the unit signals', async () => {
		const reasons: unknown[] = []
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: async (controller) => {
				await controller.wait() // park until cancelled
				reasons.push(controller.signal.reason)
				return controller.input
			},
		})
		const run = runner.execute([1, 2, 3])
		await waitForDelay(10)
		runner.abort('shutdown') // a non-Error reason — must NOT be coerced to a generic Error
		// `execute` rejects with the EXACT value the caller passed (FIX 2), not `new Error(...)`.
		await expect(run).rejects.toBe('shutdown')
		await waitForDelay(0)
		// Every unit's signal carries that same reason verbatim.
		expect(reasons.length).toBe(3)
		expect(reasons.every((reason) => reason === 'shutdown')).toBe(true)
	})

	it('a handler that spawns then synchronously throws aborts the child, balances the drain, and rejects', async () => {
		const ran: number[] = []
		const error = new Error('sync boom')
		// concurrency:1 — the single worker is occupied by the parent through its synchronous
		// throw, so the fail-fast abort drains the just-spawned child before any worker can
		// run its handler (at a higher concurrency an idle worker could race in and run it).
		const runner = createRunner<number, number>({
			concurrency: 1,
			retries: 0,
			handler: (controller) => {
				ran.push(controller.input)
				if (controller.input === 1) {
					controller.spawn(99) // launched (count++), then the parent fails fast
					throw error
				}
				return controller.input
			},
		})
		// The parent's throw is the first failure → fail-fast aborts the run; the just-spawned
		// child is cancelled before its handler runs, the count still balances, and the run rejects.
		await expect(runner.execute([1])).rejects.toBe(error)
		await waitForDelay(0)
		// The spawned child (99) was aborted-without-running — only the parent's handler ran.
		expect(ran).toEqual([1])
		expect(runner.stopped).toBe(true)
	})

	it('active returns to 0 after an aborted run drains (active is settle-based)', async () => {
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: async (controller) => {
				await controller.wait() // park until cancelled
				return controller.input
			},
		})
		const run = runner.execute([1, 2, 3])
		await waitForDelay(10)
		expect(runner.active).toBe(3)
		runner.abort(new Error('stop'))
		await expect(run).rejects.toThrow('stop')
		await waitForDelay(0)
		// Every unit settled (its parked wait was released by the abort), so the outstanding
		// count is back to 0 — `active` is settle-based, not a one-time snapshot.
		expect(runner.active).toBe(0)
	})

	it('destroy() mid-run rejects the in-flight execute', async () => {
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: async (controller) => {
				await controller.wait() // park until torn down
				return controller.input
			},
		})
		const run = runner.execute([1, 2, 3])
		await waitForDelay(10)
		expect(runner.active).toBe(3)
		runner.destroy() // abort + stop the queue, mid-run
		// destroy() aborts with no reason → the run rejects with the synthesized abort error.
		await expect(run).rejects.toThrow('runner aborted')
		expect(runner.stopped).toBe(true)
	})

	it('abort fans out to a deeply-spawned grandchild (nested-spawn propagation)', async () => {
		const release = createGate()
		let grandchildAborted: boolean | undefined
		const runner = createRunner<number, number>({
			concurrency: 8,
			retries: 0,
			handler: async (controller) => {
				if (controller.input === 1) {
					controller.spawn(2) // child
					await Promise.race([controller.wait(), release.promise])
					return controller.input
				}
				if (controller.input === 2) {
					controller.spawn(3) // grandchild (depth 2)
					await Promise.race([controller.wait(), release.promise])
					return controller.input
				}
				// The grandchild parks until the ancestor's failure fans out to its signal.
				await controller.wait()
				grandchildAborted = controller.aborted
				return controller.input
			},
		})
		const run = runner.execute([1])
		// Let the chain spawn down to the grandchild before aborting.
		await waitForDelay(20)
		runner.abort(new Error('cascade'))
		await expect(run).rejects.toThrow('cascade')
		release.resolve()
		await waitForDelay(0)
		// The grandchild — spawned two levels deep — observed its signal fire: `abort`
		// reaches every tracked unit, not just the declared roots.
		expect(grandchildAborted).toBe(true)
	})

	it('abort() is idempotent at the runner level', async () => {
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: async (controller) => {
				await controller.wait()
				return controller.input
			},
		})
		const run = runner.execute([1, 2, 3])
		await waitForDelay(10)
		runner.abort(new Error('first'))
		runner.abort(new Error('second')) // a second abort is a no-op (no throw, no overwrite)
		// The run rejects with the FIRST reason — the second abort did not overwrite it.
		await expect(run).rejects.toThrow('first')
		expect(runner.stopped).toBe(true)
	})

	// ── Large fan-out + deep nesting (production scale) ──────────────────────────
	//
	// The existing suite proves the count gate + ordered id-list on SMALL inputs
	// (1–5 units, depth ≤ 3). Production runs are larger and deeper: a backend fans
	// hundreds of units through a bounded queue and trees nest several levels. These
	// lock in that the count-based drain balances to exactly 0 at scale (no premature
	// drain when many units settle out-of-order, no hang when the closure is large),
	// and that declaration→spawn ordering holds across the whole transitive closure.

	it('large declared fan-out at bounded concurrency: every unit runs once, ordered, count→0', async () => {
		// 100 declared units, only 4 slots — the Queue's backpressure must run each
		// exactly once and the Runner must return them in declared order regardless of
		// completion order. A premature drain (count hitting 0 before all settle) would
		// truncate the result array; a double-run would inflate the per-input counts.
		const total = 100
		const runs = new Map<number, number>()
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: async (controller) => {
				runs.set(controller.input, (runs.get(controller.input) ?? 0) + 1)
				// Stagger completion so later inputs can finish before earlier ones — the
				// ordered id-list, not completion order, must drive the output.
				await waitForDelay(controller.input % 3)
				return controller.input * 2
			},
		})
		const inputs = Array.from({ length: total }, (_, index) => index)
		const results = await runner.execute(inputs)
		// Ordered by declaration, one result per input, each the handler's value.
		expect(results).toEqual(inputs.map((input) => input * 2))
		// Each declared unit ran exactly once (no slot double-dispatch under load).
		expect(runs.size).toBe(total)
		expect([...runs.values()].every((count) => count === 1)).toBe(true)
		// The count gate balanced precisely back to zero — nothing stuck outstanding.
		expect(runner.active).toBe(0)
		expect(runner.stopped).toBe(false)
	})

	it('wide + deep spawn tree drains the full transitive closure in declaration→spawn order', async () => {
		// A root that fans out a wide tree several levels deep: 3 declared roots, each
		// spawns 3 children, each child spawns 3 grandchildren (depth 3). `execute` must
		// await the ENTIRE closure (3 + 9 + 27 = 39 units) via the count gate — not a
		// one-time snapshot of the 3 declared roots — and order is declared-first, then
		// every spawn in spawn order (the live id-list append order).
		const ran: number[] = []
		const runner = createRunner<number, number>({
			concurrency: 6,
			handler: async (controller) => {
				ran.push(controller.input)
				// Encode depth in the value: roots are 1-digit, children 2-digit, grandchildren
				// 3-digit. A node spawns three children unless it is already a grandchild.
				if (controller.input < 100) {
					controller.spawn(controller.input * 10 + 1)
					controller.spawn(controller.input * 10 + 2)
					controller.spawn(controller.input * 10 + 3)
				}
				await waitForDelay(0)
				return controller.input
			},
		})
		const results = await runner.execute([1, 2, 3])
		// The whole closure ran: 3 roots + 9 children + 27 grandchildren.
		expect(results.length).toBe(3 + 9 + 27)
		expect(ran.length).toBe(3 + 9 + 27)
		// Every node ran exactly once (no duplicates across the tree).
		expect(new Set(results).size).toBe(results.length)
		// Declared roots come first (in input order); the rest are their descendants.
		expect(results.slice(0, 3)).toEqual([1, 2, 3])
		// Each grandchild (3-digit) is present — proof the count gate awaited depth 3.
		const grandchildren = results.filter((value) => value >= 100)
		expect(grandchildren.length).toBe(27)
		expect(runner.active).toBe(0)
	})

	it('deep linear spawn chain (depth 50) drains without premature drain or hang', async () => {
		// One declared unit that spawns a single successor 50 times — a long transitive
		// chain where the count returns to exactly 1 between each parent-settle and the
		// next launch (the parent holds the count up until it returns, having already
		// spawned). A premature-drain bug would resolve `execute` early at some depth.
		const depth = 50
		const runner = createRunner<number, number>({
			concurrency: 1, // tightest setting — each link runs only after the prior frees the slot
			handler: (controller) => {
				if (controller.input < depth) controller.spawn(controller.input + 1)
				return controller.input
			},
		})
		const results = await runner.execute([0])
		// The full chain 0..depth ran, in spawn order (each link after its parent).
		expect(results).toEqual(Array.from({ length: depth + 1 }, (_, index) => index))
		expect(runner.active).toBe(0)
	})

	// ── Boxed-outcome under load: mixed falsy / undefined results ────────────────

	it('preserves a MIX of falsy / undefined / object results at the right index under load', async () => {
		// The single most fragile invariant at scale: `#values` boxes each outcome as
		// `{ value }`, so presence is map MEMBERSHIP, never an `undefined` (or any falsy)
		// sentinel. Here a large run returns a deliberate mix — `0`, `''`, `false`,
		// `null`, `undefined`, and real objects — at known indices. A regression to a
		// sentinel-based `#collect` (e.g. `if (value)` or `value !== SENTINEL`) would
		// silently DROP whichever falsy values collided with the sentinel, shifting every
		// later result left. Asserting the exact array at every index catches that.
		const palette: readonly unknown[] = [0, '', false, null, undefined, { ok: true }, 42, 'x']
		const total = 80
		// Deterministic value per index, cycling the palette — so index i ↦ palette[i % 8].
		const expected = Array.from({ length: total }, (_, index) => palette[index % palette.length])
		const runner = createRunner<number, unknown>({
			concurrency: 8,
			handler: async (controller) => {
				// Stagger so completion order diverges from declaration order — only the
				// boxed id→value map (not arrival order) may determine the output.
				await waitForDelay(controller.input % 4)
				return palette[controller.input % palette.length]
			},
		})
		const inputs = Array.from({ length: total }, (_, index) => index)
		const results = await runner.execute(inputs)
		// Length is preserved (a sentinel collapse would shorten it) and every falsy /
		// undefined / object value sits at exactly its declared index.
		expect(results.length).toBe(total)
		expect(results).toEqual(expected)
		// Spot-check the falsy members survived as themselves, not as holes.
		expect(results[0]).toBe(0)
		expect(results[1]).toBe('')
		expect(results[2]).toBe(false)
		expect(results[3]).toBeNull()
		expect(results[4]).toBeUndefined()
		expect(runner.active).toBe(0)
	})

	it('mixed falsy results survive across the declared + spawned boundary', async () => {
		// The boxed-outcome guarantee must hold for spawned units too: a declared unit
		// returns a falsy value AND spawns a sibling that also returns a (different) falsy
		// value. Both must land — declared first, then the spawn — neither dropped.
		const runner = createRunner<number, unknown>({
			concurrency: 4,
			handler: (controller) => {
				if (controller.input === 1) controller.spawn(2)
				// 1 → 0 (falsy), spawned 2 → '' (falsy).
				return controller.input === 1 ? 0 : ''
			},
		})
		const results = await runner.execute([1])
		// Declared `0` first, then the spawned `''` — both falsy, both present.
		expect(results).toEqual([0, ''])
		expect(results.length).toBe(2)
	})

	// ── Failure cascade under large fan-out ──────────────────────────────────────

	it('one failure with a large pending backlog: first error wins, in-flight abort, all pending drain', async () => {
		// A realistic cascade: one unit fails while a few siblings are in flight and a LARGE
		// backlog is still pending behind the bounded slots. Fail-fast must (a) reject
		// `execute` with the FIRST error, (b) fire every IN-FLIGHT sibling's signal so it
		// observes cancellation, and (c) still drain to count 0 — the queue rejects the whole
		// pending backlog and the parked in-flight siblings wake on their aborted signal. The
		// failer sits inside the first `concurrency` units so it actually gets a slot (a
		// failer queued behind permanently-parked siblings could never run — by design).
		const total = 60
		const concurrency = 8
		const release = createGate()
		const observed: boolean[] = []
		const boom = new Error('in-flight failure')
		const runner = createRunner<number, number>({
			concurrency,
			retries: 0,
			handler: async (controller) => {
				if (controller.input === 3) throw boom // in the first batch of slots → runs, fails fast
				// The other in-flight siblings park until the fail-fast abort cancels them
				// (or the test releases them as a fallback), then record their aborted state.
				await Promise.race([controller.wait(), release.promise])
				observed.push(controller.aborted)
				return controller.input
			},
		})
		const inputs = Array.from({ length: total }, (_, index) => index)
		await expect(runner.execute(inputs)).rejects.toBe(boom)
		release.resolve()
		await waitForDelay(0)
		// The in-flight siblings (the rest of the first batch) observed their signal aborted.
		expect(observed.length).toBeGreaterThan(0)
		expect(observed.every((aborted) => aborted)).toBe(true)
		// The run drained fully despite the large pending backlog — nothing left outstanding.
		expect(runner.active).toBe(0)
		expect(runner.stopped).toBe(true)
	})

	it('multiple near-simultaneous failures: the first wins, no double-settle, no hang', async () => {
		// Several units throw within the same macrotask. Only the FIRST recorded failure
		// may surface (the `#failure === undefined` guard); the rest — and the abort-induced
		// rejections — are ignored. The count must still balance to 0 exactly (the `=== 0`
		// drain assertion would mask nothing here): no over-decrement from a double-settle.
		const errors = [new Error('boom-0'), new Error('boom-1'), new Error('boom-2')]
		const runner = createRunner<number, number>({
			concurrency: 8, // all three failing units run in the same batch
			retries: 0,
			handler: (controller) => {
				if (controller.input < errors.length) throw errors[controller.input]
				return controller.input
			},
		})
		// Whichever the queue dispatches first wins; assert it is ONE of the thrown errors
		// (not a synthesized/duplicated one) and the run rejects exactly once.
		const rejection = await runner.execute([0, 1, 2, 3, 4, 5]).then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(errors).toContain(rejection)
		await waitForDelay(0)
		// Balanced drain — exactly zero outstanding, no hang, no negative/leftover count.
		expect(runner.active).toBe(0)
		expect(runner.stopped).toBe(true)
	})

	it('a failure deep in a spawn tree aborts units spawned both before and after it', async () => {
		// Cascade across the spawn boundary at scale: a root spawns a wide set of children;
		// one child fails while its siblings (spawned before AND after it) are parked. The
		// fail-fast abort must reach every tracked unit — earlier spawns, later spawns, and
		// the still-running root — not just the declared root.
		const release = createGate()
		const abortedInputs: number[] = []
		const boom = new Error('child failure')
		const runner = createRunner<number, number>({
			concurrency: 16,
			retries: 0,
			handler: async (controller) => {
				if (controller.input === 0) {
					// Root spawns ten children: 10..19. Child 15 will fail; 10..14 are spawned
					// before it, 16..19 after — all must observe the cascade.
					for (let child = 10; child < 20; child += 1) controller.spawn(child)
					await Promise.race([controller.wait(), release.promise])
					return controller.input
				}
				if (controller.input === 15) throw boom
				await Promise.race([controller.wait(), release.promise])
				if (controller.aborted) abortedInputs.push(controller.input)
				return controller.input
			},
		})
		await expect(runner.execute([0])).rejects.toBe(boom)
		release.resolve()
		await waitForDelay(0)
		// Children spawned before the failure (10–14) and after it (16–19) all aborted.
		expect(abortedInputs).toContain(11) // spawned before 15
		expect(abortedInputs).toContain(18) // spawned after 15
		expect(abortedInputs.every((input) => input !== 15)).toBe(true) // the failer didn't park
		expect(runner.active).toBe(0)
	})

	// ── Handler shapes + wait / lifecycle under load ─────────────────────────────

	it('mixed handler shapes in one run (sync value / async value / undefined / object) all settle ordered', async () => {
		// Production handlers are heterogeneous. A single run mixes: a synchronous value,
		// an async-resolved value, a void return, and an object — each at a known index.
		// All four shapes must flow through the same launch/settle path and land ordered.
		const runner = createRunner<number, unknown>({
			concurrency: 4,
			handler: (controller) => {
				switch (controller.input % 4) {
					case 0:
						return controller.input // sync value
					case 1:
						return Promise.resolve(`async-${controller.input}`) // async value
					case 2:
						return undefined // void
					default:
						return { id: controller.input } // object
				}
			},
		})
		const results = await runner.execute([0, 1, 2, 3])
		expect(results).toEqual([0, 'async-1', undefined, { id: 3 }])
		expect(runner.active).toBe(0)
	})

	it('many parked wait() handlers are all woken by a single runner.abort() (no hang)', async () => {
		// A large set of handlers all park on `controller.wait()` (promise-parked, zero
		// CPU). A single `runner.abort()` must wake EVERY one — each one-shot 'abort'
		// listener fires — so the run drains and `execute` rejects. A wait that failed to
		// observe the runner-level abort would hang the drain forever.
		const total = 50
		const woken = createRecorder<readonly [number]>()
		const runner = createRunner<number, number>({
			concurrency: total, // every unit parks concurrently
			handler: async (controller) => {
				await controller.wait()
				woken.handler(controller.input)
				return controller.input
			},
		})
		const run = runner.execute(Array.from({ length: total }, (_, index) => index))
		await waitForDelay(10)
		expect(runner.active).toBe(total) // all parked, outstanding
		runner.abort(new Error('shutdown'))
		await expect(run).rejects.toThrow('shutdown')
		await waitForDelay(0)
		// Every parked handler woke (its signal fired) and settled — full drain.
		expect(woken.count).toBe(total)
		expect(runner.active).toBe(0)
		expect(runner.stopped).toBe(true)
	})

	it('many parked wait() handlers are all woken by destroy() mid-run', async () => {
		// Same drain guarantee via the teardown verb: `destroy()` aborts + stops the queue,
		// so every parked handler wakes and `execute` rejects with the synthesized abort.
		const total = 40
		const woken = createRecorder<readonly [number]>()
		const runner = createRunner<number, number>({
			concurrency: total,
			handler: async (controller) => {
				await controller.wait()
				woken.handler(controller.input)
				return controller.input
			},
		})
		const run = runner.execute(Array.from({ length: total }, (_, index) => index))
		await waitForDelay(10)
		expect(runner.active).toBe(total)
		runner.destroy()
		await expect(run).rejects.toThrow('runner aborted')
		await waitForDelay(0)
		expect(woken.count).toBe(total)
		expect(runner.active).toBe(0)
		expect(runner.stopped).toBe(true)
	})

	it('a never-aborted parked handler keeps the run open until abort wakes it (no spurious drain)', async () => {
		// By design `wait()` parks forever until the signal fires. Confirm a run with a
		// permanently-parked unit does NOT drain on its own — the count gate stays armed —
		// and only an explicit `abort` releases it. (A timer-polled `wait` regression, or a
		// premature drain, would let the run settle without the abort.)
		const settled = createRecorder<readonly []>()
		const runner = createRunner<number, number>({
			handler: async (controller) => {
				await controller.wait() // never resolves on its own
				return controller.input
			},
		})
		const run = runner.execute([1]).then(
			() => settled.handler(),
			() => settled.handler(),
		)
		// Park across several real macrotasks — the run must still be pending.
		await waitForDelay(5)
		await waitForDelay(5)
		await waitForDelay(5)
		expect(settled.count).toBe(0)
		expect(runner.active).toBe(1) // still outstanding, gate armed
		// Only the abort releases it.
		runner.abort()
		await run
		expect(settled.count).toBe(1)
		expect(runner.active).toBe(0)
	})

	it('fire-and-track at scale: a large fan-out of un-awaited spawns all run and order', async () => {
		// The headline `spawn` contract under load: a handler fans out many siblings WITHOUT
		// awaiting their promises, and every one must still run (routed through the queue)
		// and join the ordered output after the declared units. A stale-snapshot regression
		// would silently skip the un-awaited spawns.
		const fanout = 30
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: (controller) => {
				if (controller.input === 0) {
					// Fan out 30 children (values 1000..1029) — none awaited.
					for (let child = 0; child < fanout; child += 1) controller.spawn(1000 + child)
				}
				return controller.input
			},
		})
		const results = await runner.execute([0])
		// Declared root first, then all 30 spawns in spawn order — none dropped.
		expect(results.length).toBe(1 + fanout)
		expect(results[0]).toBe(0)
		expect(results.slice(1)).toEqual(Array.from({ length: fanout }, (_, index) => 1000 + index))
		expect(runner.active).toBe(0)
	})

	// ── Map / count balance + determinism ────────────────────────────────────────

	it('count returns to exactly 0 after a large successful run (no leak, balanced gate)', async () => {
		// `active` reads `#count`, incremented once per launch and decremented once per
		// settle. After a large run it must read EXACTLY 0 — proof the per-unit bookkeeping
		// (the `#aborts` map, `#order` list, `#values` map, and `#count`) balanced and
		// nothing leaked outstanding.
		const total = 120
		const runner = createRunner<number, number>({
			concurrency: 10,
			handler: (controller) => controller.input,
		})
		expect(runner.active).toBe(0)
		const results = await runner.execute(Array.from({ length: total }, (_, index) => index))
		expect(results.length).toBe(total)
		expect(runner.active).toBe(0) // balanced back to zero
	})

	it('active climbs to the outstanding count mid-run, then returns to 0 after an aborted large run', async () => {
		// Verify the gate is genuinely tracking outstanding units at scale: with every unit
		// gated open, `active` equals the full input count mid-run; after an abort releases
		// them all and the run drains, it returns to exactly 0 (settle-based, not a snapshot).
		const total = 64
		const gate = createGate()
		const runner = createRunner<number, number>({
			concurrency: total,
			handler: async (controller) => {
				await Promise.race([gate.promise, controller.wait()])
				return controller.input
			},
		})
		const run = runner.execute(Array.from({ length: total }, (_, index) => index))
		await waitForDelay(10)
		expect(runner.active).toBe(total) // all outstanding at once
		runner.abort(new Error('drain'))
		await expect(run).rejects.toThrow('drain')
		await waitForDelay(0)
		expect(runner.active).toBe(0)
		gate.resolve() // releasing the gate after the fact changes nothing — already drained
		await waitForDelay(0)
		expect(runner.active).toBe(0)
	})

	it('one-shot enforcement holds after a large run — a second execute throws', async () => {
		// The one-shot guard is independent of run size: after draining a big closure (with
		// spawns), a second `execute` must still throw rather than re-running on dirty state.
		const runner = createRunner<number, number>({
			concurrency: 8,
			handler: (controller) => {
				if (controller.input < 10) controller.spawn(controller.input + 100)
				return controller.input
			},
		})
		await runner.execute(Array.from({ length: 10 }, (_, index) => index))
		await expect(runner.execute([999])).rejects.toThrow('already executed')
	})

	it('a spawn captured during a large run throws once that run has settled', async () => {
		// `spawn` is valid only during an active run. A handler in a big fan-out leaks its
		// `controller.spawn`; after the whole closure settles, invoking it must throw — a
		// captured controller cannot inject work into a finished run.
		let escaped: ((input: number) => Promise<number>) | undefined
		const runner = createRunner<number, number>({
			concurrency: 8,
			handler: (controller) => {
				if (controller.input === 0) escaped = (input) => controller.spawn(input)
				return controller.input
			},
		})
		await runner.execute(Array.from({ length: 20 }, (_, index) => index))
		expect(escaped).toBeDefined()
		expect(() => escaped?.(5)).toThrow('spawn is unavailable outside an active run')
	})

	it('deterministic spawn ordering: results are spawn-order, not completion-order (gate-driven)', async () => {
		// Determinism under out-of-order completion at the spawn level. A root spawns three
		// children whose completion is gated in REVERSE order (the last-spawned finishes
		// first). The output must still be declared-root then spawns in SPAWN order — the
		// ordered id-list, never arrival order, defines the result sequence.
		const gates = [createGate(), createGate(), createGate()]
		const runner = createRunner<number, number>({
			concurrency: 8,
			handler: async (controller) => {
				if (controller.input === 0) {
					controller.spawn(1)
					controller.spawn(2)
					controller.spawn(3)
					return controller.input
				}
				// Child n waits on gate[n-1]; the test opens them last-to-first.
				await gates[controller.input - 1].promise
				return controller.input
			},
		})
		const run = runner.execute([0])
		await waitForDelay(10)
		// Release in reverse spawn order — child 3 finishes first, child 1 last.
		gates[2].resolve()
		await waitForDelay(0)
		gates[1].resolve()
		await waitForDelay(0)
		gates[0].resolve()
		const results = await run
		// Spawn order (1, 2, 3) regardless of the reversed completion order.
		expect(results).toEqual([0, 1, 2, 3])
	})

	// ── Retries / timeout under concurrency (the Queue engine, as the Runner composes it) ──

	it('retries recover several flaky units under bounded concurrency while siblings succeed', async () => {
		// Production composition: the per-unit retry budget is the Queue's, driven through the
		// Runner under load. Several units fail their first attempt and must each retry to
		// success independently while non-flaky siblings pass first try — all results ordered,
		// the run succeeds (no premature fail-fast from a recoverable first attempt).
		const attempts = new Map<number, number>()
		const flaky = new Set([2, 5, 7])
		const runner = createRunner<number, number>({
			concurrency: 4,
			retries: 1, // exactly one extra attempt — enough to recover a single first-attempt fault
			handler: (controller) => {
				const seen = (attempts.get(controller.input) ?? 0) + 1
				attempts.set(controller.input, seen)
				if (flaky.has(controller.input) && seen === 1) throw new Error(`flaky-${controller.input}`)
				return controller.input * 10
			},
		})
		const inputs = Array.from({ length: 10 }, (_, index) => index)
		const results = await runner.execute(inputs)
		// Every unit resolved (the flaky ones on their retry) — ordered by declaration.
		expect(results).toEqual(inputs.map((input) => input * 10))
		// Each flaky unit was attempted twice; each stable unit exactly once.
		for (const input of inputs) {
			expect(attempts.get(input)).toBe(flaky.has(input) ? 2 : 1)
		}
		expect(runner.active).toBe(0)
	})

	it('per-attempt timeout under concurrency: stalled units fail-fast while a fast batch was in flight', async () => {
		// The per-attempt deadline is the Queue's, composed by the Runner. With a bounded set
		// of fast units plus one that never resolves, the stalled unit's attempt times out
		// (retries: 0 → terminal), failing the run and aborting the in-flight siblings — the
		// whole thing drains rather than hanging on the stalled handler.
		const observed: boolean[] = []
		const release = createGate()
		const runner = createRunner<number, number>({
			concurrency: 4,
			retries: 0,
			timeout: 20, // each attempt is bounded — the stalled unit fails on its deadline
			handler: async (controller) => {
				if (controller.input === 0) {
					await controller.wait() // never resolves on its own — only the timeout fires it
					return controller.input
				}
				await Promise.race([controller.wait(), release.promise])
				observed.push(controller.signal.aborted)
				return controller.input
			},
		})
		// The stalled unit (0) is in the first batch of slots, so it runs and its attempt
		// times out, failing the run; the in-flight siblings are aborted by the cascade.
		await expect(runner.execute([0, 1, 2, 3])).rejects.toThrow('attempt timed out')
		release.resolve()
		await waitForDelay(0)
		expect(observed.length).toBeGreaterThan(0)
		expect(observed.every((aborted) => aborted)).toBe(true)
		expect(runner.active).toBe(0)
		expect(runner.stopped).toBe(true)
	})
})

// ── Emitter — the PUSH observation surface (AGENTS §13) ──────────────────────
//
// The Runner exposes a typed `emitter` (`RunnerEventMap<TResult>`) carrying its run
// lifecycle — `start` / `unit` / `spawn` / `settle` / `fail` / `finish` / `abort` — for
// fire-and-forget observers, alongside the eventual `execute` result. Every event is emitted
// directly; the emitter isolates a listener throw (it never escapes into the one-shot /
// fail-fast / spawn-tracking engine, AGENTS §13, routing it to the emitter's own `error`
// handler — the `error` option), each placed AFTER its launch / settle / drain transition.
// These pin: each event fires at the right moment with the right payload; `on?` wires initial
// listeners; and the LOAD-BEARING emit-safety guarantee — a throwing observer cannot unbalance
// the count gate or break fail-fast (the run still drains / still rejects with the first
// error), yet the `error` handler fires.

// The RunnerEventMap event names recorded across the emitter tests — fed to the shared
// `recordEmitterEvents` (AGENTS §16.1: the per-event wiring is centralized; this file
// keeps only the names its scenarios observe).
const RUNNER_EVENTS = ['start', 'unit', 'spawn', 'settle', 'fail', 'finish', 'abort'] as const

describe('Runner — emitter (push observation surface)', () => {
	it('a simple run fires start → unit (per unit) → settle (per unit) → finish', async () => {
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: (controller) => controller.input * 10,
		})
		const events = recordEmitterEvents(runner.emitter, RUNNER_EVENTS)
		const results = await runner.execute([1, 2, 3])
		expect(results).toEqual([10, 20, 30])
		// `start` once; one `unit` + one `settle` per declared unit; `finish` once with the
		// ordered results (the same array `execute` resolved).
		expect(events.start.count).toBe(1)
		expect(events.unit.count).toBe(3)
		expect(events.settle.count).toBe(3)
		expect(events.finish.calls).toEqual([[[10, 20, 30]]])
		// A clean run fires neither `spawn` / `fail` / `abort`.
		expect(events.spawn.count).toBe(0)
		expect(events.fail.count).toBe(0)
		expect(events.abort.count).toBe(0)
	})

	it('an empty run fires start then finish([]) (no units)', async () => {
		const runner = createRunner<number, number>({ handler: (controller) => controller.input })
		const events = recordEmitterEvents(runner.emitter, RUNNER_EVENTS)
		expect(await runner.execute([])).toEqual([])
		expect(events.start.count).toBe(1)
		expect(events.finish.calls).toEqual([[[]]])
		expect(events.unit.count).toBe(0)
	})

	it('fires spawn (child id + parent id) when a unit spawns a sibling', async () => {
		const idByInput = new Map<number, string>()
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: (controller) => {
				idByInput.set(controller.input, controller.id)
				if (controller.input === 1) controller.spawn(101)
				return controller.input
			},
		})
		const events = recordEmitterEvents(runner.emitter, RUNNER_EVENTS)
		const results = await runner.execute([1])
		expect(results).toEqual([1, 101])
		// Exactly one spawn — its parent is the declared unit `1`'s id.
		expect(events.spawn.count).toBe(1)
		const [childId, parentId] = events.spawn.calls[0] ?? []
		expect(parentId).toBe(idByInput.get(1))
		// The spawned child later ran as a `unit` under that same id.
		expect(events.unit.calls.some(([id]) => id === childId)).toBe(true)
		// Two units settled (declared + spawn); `finish` carries both, in order.
		expect(events.settle.count).toBe(2)
		expect(events.finish.calls).toEqual([[[1, 101]]])
	})

	it('fires fail then abort on a unit failure (fail-fast), and no finish', async () => {
		const boom = new Error('kaboom')
		const release = createGate()
		const runner = createRunner<string, string>({
			concurrency: 4,
			retries: 0,
			handler: async (controller) => {
				if (controller.input === 'boom') throw boom
				await Promise.race([controller.wait(), release.promise])
				return controller.input
			},
		})
		const events = recordEmitterEvents(runner.emitter, RUNNER_EVENTS)
		await expect(runner.execute(['a', 'boom', 'b'])).rejects.toBe(boom)
		release.resolve()
		await waitForDelay(0)
		// Exactly one `fail` (the first failure) carrying the failing unit + the error.
		expect(events.fail.count).toBe(1)
		expect(events.fail.calls[0]?.[1]).toBe(boom)
		// The fail-fast cascade fired the run-level `abort` (with the same error as reason).
		expect(events.abort.calls).toEqual([[boom]])
		// A failed run rejects — it emits NO `finish`.
		expect(events.finish.count).toBe(0)
	})

	it('a user abort() mid-run fires abort (and no per-unit fail)', async () => {
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: async (controller) => {
				await controller.wait()
				return controller.input
			},
		})
		const events = recordEmitterEvents(runner.emitter, RUNNER_EVENTS)
		const run = runner.execute([1, 2, 3])
		await waitForDelay(10)
		const reason = new Error('shutting down')
		runner.abort(reason)
		await expect(run).rejects.toBe(reason)
		await waitForDelay(0)
		// The run-level `abort` fired once; the units were cancelled, not failed → no `fail`.
		expect(events.abort.calls).toEqual([[reason]])
		expect(events.fail.count).toBe(0)
		expect(events.finish.count).toBe(0)
	})

	it('wires initial listeners from the `on` option at construction', async () => {
		const finish = createRecorder<[results: readonly number[]]>()
		const runner = createRunner<number, number>({
			handler: (controller) => controller.input,
			on: { finish: finish.handler },
		})
		await runner.execute([1, 2])
		expect(finish.calls).toEqual([[[1, 2]]])
	})

	it('EMIT SAFETY: a throwing settle listener cannot unbalance the count gate, and routes EVERY throw to the error handler', async () => {
		const thrown = new Error('settle observer blew up')
		const errors = createErrorRecorder()
		const runner = createRunner<number, number>({
			concurrency: 8,
			error: errors.handler,
			handler: (controller) => controller.input * 2,
		})
		// A buggy `settle` observer that throws on EVERY unit — on the audited count-gate path.
		// It must NOT unbalance `#count` (a premature/late drain would truncate or hang).
		runner.emitter.on('settle', () => {
			throw thrown
		})
		const total = 50
		const results = await runner.execute(Array.from({ length: total }, (_unused, index) => index))
		// THE LOAD-BEARING ASSERTION: the run drained and returned every result in order despite
		// the throwing observer — the count gate balanced to exactly 0 (no early drain
		// truncating the array, no hang).
		expect(results).toEqual(Array.from({ length: total }, (_unused, index) => index * 2))
		expect(results.length).toBe(total)
		expect(runner.active).toBe(0)
		// EVERY throw routed to the emitter's error handler for the `settle` event — (error, event).
		expect(errors.count).toBe(total)
		expect(errors.calls.every(([, event]) => event === 'settle')).toBe(true)
	})

	it('EMIT SAFETY: a throwing fail listener cannot break fail-fast, and routes to the error handler', async () => {
		const boom = new Error('kaboom')
		const release = createGate()
		const observed: boolean[] = []
		const errors = createErrorRecorder()
		const runner = createRunner<string, string>({
			concurrency: 4,
			retries: 0,
			error: errors.handler,
			handler: async (controller) => {
				if (controller.input === 'boom') throw boom
				await Promise.race([controller.wait(), release.promise])
				observed.push(controller.aborted)
				return controller.input
			},
		})
		// A buggy `fail` observer that throws — the fail-fast cascade must still fire (every
		// sibling aborted) and `execute` must still reject with the FIRST error.
		runner.emitter.on('fail', () => {
			throw new Error('fail observer blew up')
		})
		// THE LOAD-BEARING ASSERTION: fail-fast is intact despite the throwing observer.
		await expect(runner.execute(['a', 'boom', 'b'])).rejects.toBe(boom)
		release.resolve()
		await waitForDelay(0)
		expect(observed.length).toBeGreaterThan(0)
		expect(observed.every((aborted) => aborted)).toBe(true) // siblings were aborted
		expect(runner.active).toBe(0) // drained fully
		expect(runner.stopped).toBe(true)
		// The throw routed to the emitter's error handler for the `fail` event — (error, event).
		expect(errors.calls).toEqual([[expect.any(Error), 'fail']])
	})

	it('EMIT SAFETY: a throwing error handler neither escapes nor recurses', async () => {
		const errors = createErrorRecorder()
		const runner = createRunner<number, number>({
			handler: (controller) => controller.input,
			error: (error, event) => {
				errors.handler(error, event)
				throw new Error('error handler blew up too')
			},
		})
		runner.emitter.on('settle', () => {
			throw new Error('settle listener blew up')
		})
		// The run STILL settles cleanly — neither throw escaped into the engine.
		expect(await runner.execute([1])).toEqual([1])
		expect(runner.active).toBe(0)
		// The error handler fired exactly once (its own throw was swallowed).
		expect(errors.count).toBe(1)
		expect(errors.calls[0]?.[1]).toBe('settle')
	})
})

// ── Substrate hardening: live spawn(), pause/resume queue-native semantics, and
// graceful stop() with a never-dispatched pending backlog (the workflow Engine composes
// exactly this behavior over a live tree). Real timers/gates only (AGENTS §16), no mocks.

describe('Runner — spawn() (live, external — a Runner-level counterpart to controller.spawn)', () => {
	it('spawn mid-execute returns a promise that settles with the unit result, and execute() awaits it (count gate)', async () => {
		const gate = createGate()
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: async (controller) => {
				if (controller.input === 1) await gate.promise
				return controller.input * 10
			},
		})
		const run = runner.execute([1])
		await waitForDelay(10)
		const spawned = runner.spawn(2)
		expect(spawned).toBeInstanceOf(Promise)
		// The live spawn joined the outstanding count — execute() must not resolve yet.
		expect(runner.active).toBe(2)
		gate.resolve()
		const spawnedResult = await spawned
		expect(spawnedResult).toBe(20)
		const results = await run
		// Declared unit first, then the live spawn — execute() awaited both.
		expect(results).toEqual([10, 20])
	})

	it('spawn before start returns undefined (never started)', () => {
		const runner = createRunner<number, number>({ handler: (controller) => controller.input })
		expect(runner.spawn(1)).toBeUndefined()
	})

	it('spawn after natural drain returns undefined', async () => {
		const runner = createRunner<number, number>({ handler: (controller) => controller.input })
		await runner.execute([1])
		expect(runner.spawn(2)).toBeUndefined()
	})

	it('spawn after abort() returns undefined', async () => {
		const runner = createRunner<number, number>({
			concurrency: 4,
			handler: async (controller) => {
				await controller.wait()
				return controller.input
			},
		})
		const run = runner.execute([1])
		await waitForDelay(10)
		runner.abort(new Error('stop'))
		await expect(run).rejects.toThrow('stop')
		expect(runner.spawn(2)).toBeUndefined()
	})

	it('spawn after stop() returns undefined', () => {
		// stop() is a synchronous, unconditional gate on `spawn` (`#stopped`) — no run needs to
		// have started or drained for it to apply.
		const runner = createRunner<number, number>({ handler: (controller) => controller.input })
		runner.stop()
		expect(runner.spawn(1)).toBeUndefined()
	})

	it('spawn after destroy() returns undefined', async () => {
		const runner = createRunner<number, number>({ handler: (controller) => controller.input })
		runner.destroy()
		expect(runner.spawn(1)).toBeUndefined()
	})
})

describe('Runner — pause() / resume() (queue-native: in-flight finishes, next dispatch parks)', () => {
	it('concurrency:1, several units: pause() after the first dispatch lets it finish but withholds the next; resume() continues in order', async () => {
		const dispatched: number[] = []
		const gate = createGate()
		const runner = createRunner<number, number>({
			concurrency: 1,
			handler: async (controller) => {
				dispatched.push(controller.input)
				if (controller.input === 1) await gate.promise
				return controller.input
			},
		})
		const run = runner.execute([1, 2, 3])
		await waitForDelay(10)
		// Only the first unit has been dispatched (its handler holds the single slot on the gate).
		expect(dispatched).toEqual([1])
		runner.pause()
		expect(runner.paused).toBe(true)
		gate.resolve() // let the in-flight unit finish
		await waitForDelay(10)
		// The in-flight unit finished, but the NEXT dispatch was withheld by the pause.
		expect(dispatched).toEqual([1])
		runner.resume()
		expect(runner.paused).toBe(false)
		const results = await run
		// Dispatch order resumed and completed in declared order.
		expect(dispatched).toEqual([1, 2, 3])
		expect(results).toEqual([1, 2, 3])
	})

	it('pause()/resume() are no-ops once the runner is stopped (§10 — stop() is the terminal gate)', () => {
		const runner = createRunner<number, number>({ handler: (controller) => controller.input })
		runner.stop()
		runner.pause()
		expect(runner.paused).toBe(false) // a stopped runner never actually pauses
		runner.resume() // no throw
		expect(runner.paused).toBe(false)
	})
})

describe('Runner — stop() (graceful, permanent: never-dispatched pending settle WITHOUT failing)', () => {
	it('stop() with a never-dispatched pending backlog resolves execute() (no throw, no fail-fast trip)', async () => {
		const dispatched: number[] = []
		const gate = createGate()
		const runner = createRunner<number, number>({
			concurrency: 1,
			handler: async (controller) => {
				dispatched.push(controller.input)
				if (controller.input === 1) await gate.promise
				return controller.input
			},
		})
		const run = runner.execute([1, 2, 3])
		await waitForDelay(10)
		// Only the first unit is in flight; 2 and 3 are still pending, never dispatched.
		expect(dispatched).toEqual([1])
		runner.stop()
		gate.resolve() // let the in-flight unit finish
		// execute() RESOLVES — it does not throw/reject, even with a never-run backlog.
		const results = await run
		// Only the in-flight unit's result landed; the never-dispatched units never ran.
		expect(dispatched).toEqual([1])
		expect(results).toEqual([1])
		expect(runner.active).toBe(0)
		expect(runner.stopped).toBe(true)
	})

	it('stop() is idempotent', async () => {
		const runner = createRunner<number, number>({ handler: (controller) => controller.input })
		runner.stop()
		runner.stop() // no throw
		expect(runner.stopped).toBe(true)
	})

	it('spawn() after stop() returns undefined, even mid-run with an in-flight unit still settling', async () => {
		const gate = createGate()
		const runner = createRunner<number, number>({
			concurrency: 1,
			handler: async (controller) => {
				await gate.promise
				return controller.input
			},
		})
		const run = runner.execute([1])
		await waitForDelay(10)
		runner.stop()
		// stop() is synchronous — spawn is refused immediately, before the in-flight unit settles.
		expect(runner.spawn(2)).toBeUndefined()
		gate.resolve()
		await run
	})

	it('a graceful stop() does not trip fail-fast even when pending units would have failed', async () => {
		// A never-dispatched unit whose handler WOULD have thrown never gets the chance to — the
		// queue rejects it with its own "stopped" error, classified as a stop artifact (not a
		// failure), so `execute` still resolves rather than rejecting.
		const ran: number[] = []
		const gate = createGate()
		const runner = createRunner<number, number>({
			concurrency: 1,
			retries: 0,
			handler: async (controller) => {
				ran.push(controller.input)
				if (controller.input === 1) {
					await gate.promise
					return controller.input
				}
				throw new Error(`would have failed on ${controller.input}`)
			},
		})
		const run = runner.execute([1, 2, 3])
		await waitForDelay(10)
		runner.stop()
		gate.resolve()
		await expect(run).resolves.toEqual([1])
		// The would-have-failed units 2/3 never dispatched — the failing handler branch never ran.
		expect(ran).toEqual([1])
	})
})
