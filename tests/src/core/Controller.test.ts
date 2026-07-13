import type { ControllerInterface } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createAbort } from '@orkestrel/abort'
import { Controller } from '@src/core'
import { createGate, createRecorder, waitForDelay } from '../../setup.js'

// Build a Controller the way the Runner does — over a real `Abort` whose signal is
// the unit's cancellation. `signal` is that abort's signal (in the Runner it is the
// queue attempt's signal, which ANY-includes this abort), so `abort()` fires it.
function buildController<TInput, TResult>(
	input: TInput,
	spawn: (input: TInput) => Promise<TResult> = () => Promise.reject(new Error('no spawn')),
): { readonly controller: ControllerInterface<TInput, TResult>; readonly id: string } {
	const id = crypto.randomUUID()
	const abort = createAbort()
	const controller = new Controller<TInput, TResult>(id, input, abort, abort.signal, spawn)
	return { controller, id }
}

describe('Controller', () => {
	it('reflects the unit id, input, signal, and aborted state', () => {
		const { controller, id } = buildController<string, number>('payload')
		expect(controller.id).toBe(id)
		expect(controller.input).toBe('payload')
		expect(controller.signal).toBeInstanceOf(AbortSignal)
		expect(controller.aborted).toBe(false)
	})

	it('abort(reason) fires the signal with the reason and flips aborted', () => {
		const { controller } = buildController<string, number>('payload')
		const reason = new Error('cancelled')
		controller.abort(reason)
		expect(controller.aborted).toBe(true)
		expect(controller.signal.aborted).toBe(true)
		expect(controller.signal.reason).toBe(reason)
	})

	it('wait() resolves immediately when the signal is already aborted', async () => {
		const { controller } = buildController<string, number>('payload')
		controller.abort()
		await expect(controller.wait()).resolves.toBeUndefined()
	})

	it('wait() promise-parks — stays pending across delays until abort, never timer-polled', async () => {
		const { controller } = buildController<string, number>('payload')
		const settled = createRecorder<readonly []>()
		const waiting = controller.wait().then(() => settled.handler())

		// B1 regression: a busy-yield `wait` (setTimeout(0)) would resolve within a
		// macrotask. Park across several real macrotasks and assert it is STILL pending.
		await waitForDelay(0)
		await waitForDelay(5)
		await waitForDelay(5)
		expect(settled.count).toBe(0)
		expect(controller.aborted).toBe(false)

		// Only the abort releases it.
		controller.abort()
		await waiting
		expect(settled.count).toBe(1)
	})

	it('wait() resolves the moment a gated abort fires (driven by a gate)', async () => {
		const { controller } = buildController<string, number>('payload')
		const gate = createGate()
		const settled = createRecorder<readonly []>()
		const waiting = controller.wait().then(() => settled.handler())
		// The abort is wired to the gate — `wait` resolves only once the gate opens.
		void gate.promise.then(() => controller.abort())

		await waitForDelay(5)
		expect(settled.count).toBe(0)

		gate.resolve()
		await waiting
		expect(settled.count).toBe(1)
	})

	it('spawn delegates to the injected callback and returns its promise', async () => {
		const calls = createRecorder<readonly [number]>()
		const { controller } = buildController<number, number>(7, (input) => {
			calls.handler(input)
			return Promise.resolve(input * 2)
		})
		const result = await controller.spawn(21)
		expect(result).toBe(42)
		expect(calls.calls).toEqual([[21]])
	})

	it('wait() parks on the exposed signal — resolves when a PARENT fires, not just the own abort', async () => {
		// Faithful to the Runner's real wiring: the Controller's `signal` is the queue
		// attempt's signal, which ANY-combines the unit's own `Abort` with parent signals
		// (the runner-level abort, the per-attempt timeout). `wait()` must park on THAT
		// exposed signal, so a parent firing (here a runner-level abort, the unit's own abort
		// never touched) wakes it. A `wait` that parked on the unit `#abort` instead of the
		// exposed `signal` would hang forever when only the parent aborts.
		const unit = createAbort()
		const parent = createAbort()
		const signal = AbortSignal.any([unit.signal, parent.signal])
		const controller = new Controller<string, number>(
			crypto.randomUUID(),
			'payload',
			unit,
			signal,
			() => Promise.reject(new Error('no spawn')),
		)
		const settled = createRecorder<readonly []>()
		const waiting = controller.wait().then(() => settled.handler())
		// Park across real macrotasks — neither signal has fired, so it must stay pending.
		await waitForDelay(5)
		expect(settled.count).toBe(0)
		// Fire the PARENT only — the unit's own abort is never called.
		parent.abort(new Error('runner abort'))
		await waiting
		expect(settled.count).toBe(1)
		// The exposed signal aborted; `aborted` (the unit `#abort`) stays false — proof
		// `wait` keyed off the combined `signal`, not the unit's own cancellation.
		expect(controller.signal.aborted).toBe(true)
		expect(controller.aborted).toBe(false)
	})

	it('multiple concurrent wait() calls on one controller all resolve on a single abort', async () => {
		// Defensive: a handler (or composed helpers) may park more than once on the same
		// controller. Each `wait()` registers its own one-shot listener; one abort must
		// release every outstanding wait — none left dangling.
		const { controller } = buildController<string, number>('payload')
		const settled = createRecorder<readonly []>()
		const waits = [
			controller.wait().then(() => settled.handler()),
			controller.wait().then(() => settled.handler()),
			controller.wait().then(() => settled.handler()),
		]
		await waitForDelay(5)
		expect(settled.count).toBe(0)
		controller.abort()
		await Promise.all(waits)
		expect(settled.count).toBe(3)
	})
})
