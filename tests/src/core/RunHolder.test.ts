import type { RunnerInterface, TaskInterface } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createRunner } from '@src/core'
import { RunHolder } from '../../../src/core/RunHolder.js'

/** A substrate runner over live tasks — the exact shape a phase hands the holder. */
function buildPhaseRunner(): RunnerInterface<TaskInterface, void> {
	return createRunner<TaskInterface, void>({ handler: () => undefined })
}

describe('RunHolder — the run-scoped active-phase-runner cell', () => {
	it('starts empty', () => {
		expect(new RunHolder().runner).toBeUndefined()
	})

	it('holds the runner a phase hands it, then releases it', () => {
		const holder = new RunHolder()
		const runner = buildPhaseRunner()

		holder.hold(runner)
		expect(holder.runner).toBe(runner)

		holder.hold()
		expect(holder.runner).toBeUndefined()
	})

	it('swaps to the runner of the phase now starting', () => {
		const holder = new RunHolder()
		const first = buildPhaseRunner()
		const second = buildPhaseRunner()

		holder.hold(first)
		holder.hold(second)

		expect(holder.runner).toBe(second)
	})

	it('reads current through a closure, so a cancel armed early reaches the live runner', () => {
		const holder = new RunHolder()
		// The engine arms its run-level abort listener before any phase starts, closing over the
		// holder rather than over a runner — this is the read that makes the late swap visible.
		const readActive = (): RunnerInterface<TaskInterface, void> | undefined => holder.runner
		const runner = buildPhaseRunner()

		expect(readActive()).toBeUndefined()
		holder.hold(runner)

		expect(readActive()).toBe(runner)
	})

	it('gives each run its own cell, so a nested run cannot clobber the outer one', () => {
		const outer = new RunHolder()
		const inner = new RunHolder()
		const outerRunner = buildPhaseRunner()
		const innerRunner = buildPhaseRunner()

		outer.hold(outerRunner)
		inner.hold(innerRunner)
		inner.hold()

		expect(outer.runner).toBe(outerRunner)
		expect(inner.runner).toBeUndefined()
	})
})
