import type { PhaseInterface, WorkflowDefinition, WorkflowInterface } from '@src/core'
import { createWorkflow, restoreWorkflow } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createErrorRecorder, recordEmitterEvents } from '../../../../setup.js'

// The DERIVED phase state machine (W-b): status derived from its tasks via the W-a
// helper, recomputed reactively as a task transitions (the cascade's middle tier), the
// override, and the phase tier of the result tree. Real definition stubs — no mocks.

/** A definition stub of one phase holding `count` function-tasks (`t0..t{count-1}`). */
function buildPhaseWorkflow(count: number): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		phases: [
			{
				id: 'p',
				name: 'P',
				tasks: Array.from({ length: count }, (_unused, index) => ({
					id: `t${index}`,
					name: `T${index}`,
					run: { via: 'function', name: 'f' } as const,
				})),
			},
		],
	}
}

/** Resolve the lone phase of a {@link buildPhaseWorkflow} tree. */
function lonePhase(workflow: WorkflowInterface): PhaseInterface {
	const phase = workflow.phase('p')
	if (phase === undefined) throw new Error('expected the lone phase to exist')
	return phase
}

describe('Phase — derived status (the cascade)', () => {
	it('is pending while every task is pending', () => {
		expect(lonePhase(createWorkflow(buildPhaseWorkflow(2))).status).toBe('pending')
	})

	it('becomes running when a task starts', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		phase.task('t0')?.start()
		expect(phase.status).toBe('running')
	})

	it('becomes completed when all tasks complete', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		for (const task of phase.tasks.tasks()) {
			task.start()
			task.complete('ok')
		}
		expect(phase.status).toBe('completed')
	})

	it('becomes failed when any task fails (bail-agnostic at the phase tier)', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		phase.task('t0')?.start()
		phase.task('t0')?.complete('ok')
		phase.task('t1')?.start()
		phase.task('t1')?.fail(new Error('boom'))
		expect(phase.status).toBe('failed')
	})

	it('is skipped when every task is skipped, completed when some complete + some skip', () => {
		const allSkipped = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		for (const task of allSkipped.tasks.tasks()) task.skip()
		expect(allSkipped.status).toBe('skipped')

		const mixed = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		mixed.task('t0')?.start()
		mixed.task('t0')?.complete('ok')
		mixed.task('t1')?.skip()
		expect(mixed.status).toBe('completed')
	})

	it('becomes stopped when every task is stopped (the entity path, not just the helper)', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		for (const task of phase.tasks.tasks()) task.stop()
		expect(phase.status).toBe('stopped')
	})

	it('stays running while one terminal task sits beside a still-pending sibling', () => {
		// The "started but not all settled" class at the entity tier: one task completed, one never
		// ran — the phase is NOT done, so the derived status is running (not completed).
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		phase.task('t0')?.start()
		phase.task('t0')?.complete('ok')
		expect(phase.status).toBe('running')
	})
})

describe('Phase — degenerate sizes (zero-task + single-task)', () => {
	it('a zero-task phase derives pending (an empty set of children)', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(0)))
		expect(phase.tasks.count).toBe(0)
		expect(phase.status).toBe('pending')
	})

	it('a single-task phase tracks its one task through the lifecycle', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		expect(phase.status).toBe('pending')
		phase.task('t0')?.start()
		expect(phase.status).toBe('running')
		phase.task('t0')?.complete('ok')
		expect(phase.status).toBe('completed')
	})

	it('a zero-task phase can still be force-skipped / force-stopped via the override', () => {
		const skipped = lonePhase(createWorkflow(buildPhaseWorkflow(0)))
		skipped.skip()
		expect(skipped.status).toBe('skipped')
		const stopped = lonePhase(createWorkflow(buildPhaseWorkflow(0)))
		stopped.stop()
		expect(stopped.status).toBe('stopped')
	})
})

describe('Phase — emits on a derived-status change', () => {
	it('fires start, then complete, exactly once each across the cascade', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		const events = recordEmitterEvents(phase.emitter, ['start', 'complete', 'fail', 'stop'])
		// First task starting flips pending → running (one start)…
		phase.task('t0')?.start()
		phase.task('t1')?.start()
		expect(events.start.count).toBe(1)
		expect(events.start.calls[0]?.[0]).toBe('p')
		// …and only the LAST settle flips running → completed (one complete).
		phase.task('t0')?.complete('ok')
		expect(events.complete.count).toBe(0)
		phase.task('t1')?.complete('ok')
		expect(events.complete.count).toBe(1)
	})

	it('fires fail carrying the failing task’s result', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		const events = recordEmitterEvents(phase.emitter, ['fail'])
		phase.task('t0')?.start()
		phase.task('t0')?.fail(new Error('kaboom'))
		expect(events.fail.count).toBe(1)
		expect(events.fail.calls[0]?.[0]?.status).toBe('failed')
		expect(events.fail.calls[0]?.[0]?.task.id).toBe('t0')
	})
})

describe('Phase — the #override (skip / stop a whole phase)', () => {
	it('skip forces skipped, overriding the derived value', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		// A task is mid-flight, so the DERIVED status would be running…
		phase.task('t0')?.start()
		expect(phase.status).toBe('running')
		// …but skip FORCES skipped regardless.
		phase.skip()
		expect(phase.status).toBe('skipped')
	})

	it('stop forces stopped and emits', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		const events = recordEmitterEvents(phase.emitter, ['stop'])
		phase.stop()
		expect(phase.status).toBe('stopped')
		expect(events.stop.count).toBe(1)
	})

	it('the override pins the status against further child churn', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		phase.stop()
		// A child still transitions, but the forced status is unmoved.
		phase.task('t0')?.start()
		phase.task('t0')?.complete('ok')
		expect(phase.status).toBe('stopped')
	})
})

describe('Phase — the result tree (top-down)', () => {
	it('collects only settled tasks’ results, in positional order', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(3)))
		phase.task('t0')?.start()
		phase.task('t0')?.complete('a')
		phase.task('t2')?.start()
		phase.task('t2')?.fail(new Error('c'))
		// t1 never ran — it contributes no result; order follows task position (t0 then t2).
		const results = phase.results()
		expect(results.map((result) => result.task.id)).toEqual(['t0', 't2'])
		expect(results[0]?.status).toBe('completed')
		expect(results[1]?.status).toBe('failed')
	})

	it('collects across a mix of all four terminal kinds — only completed / failed box a result', () => {
		// One task per terminal kind (t0 completed, t1 failed, t2 skipped, t3 stopped). Only the
		// completed + failed leaves carry a boxed outcome; skip / stop are terminal WITHOUT one, so
		// they contribute no TaskResult — the phase result list is exactly [t0, t1], in order.
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(4)))
		phase.task('t0')?.start()
		phase.task('t0')?.complete('done')
		phase.task('t1')?.start()
		phase.task('t1')?.fail(new Error('boom'))
		phase.task('t2')?.skip()
		phase.task('t3')?.stop()
		const results = phase.results()
		expect(results.map((result) => result.task.id)).toEqual(['t0', 't1'])
		expect(results.map((result) => result.status)).toEqual(['completed', 'failed'])
		expect(results[1]?.result?.success).toBe(false)
		// The phase itself, with a real failure among the four, derives failed (failed is most-severe).
		expect(phase.status).toBe('failed')
	})
})

describe('Phase — the effective bail (per-phase override) round-trips', () => {
	// A graceful (bail:false) workflow with ONE strict-bail phase + one inheriting phase. Each live
	// phase exposes its EFFECTIVE bail, and a snapshot → restore reproduces both the per-phase bail
	// AND the phase status.
	function mixedBailWorkflow(): WorkflowDefinition {
		return {
			id: 'wf',
			name: 'WF',
			bail: false,
			phases: [
				{
					id: 'strict',
					name: 'Strict',
					bail: true,
					tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'f' } }],
				},
				{
					id: 'inherit',
					name: 'Inherit',
					tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'f' } }],
				},
			],
		}
	}

	it('exposes the effective bail — a phase override wins, else it inherits the workflow', () => {
		const workflow = createWorkflow(mixedBailWorkflow())
		expect(workflow.phase('strict')?.bail).toBe(true) // the override
		expect(workflow.phase('inherit')?.bail).toBe(false) // inherited from the graceful workflow
	})

	it('round-trips the per-phase bail AND the phase status through snapshot → restore', () => {
		const workflow = createWorkflow(mixedBailWorkflow())
		// Drive a leaf so the phase has a non-pending status worth round-tripping.
		const leaf = workflow.phase('strict')?.task('t')
		leaf?.start()
		leaf?.complete('ok')
		const original = workflow.phase('strict')
		const restored = restoreWorkflow(workflow.snapshot()).phase('strict')
		// The restored phase's status matches the original's…
		expect(restored?.status).toBe(original?.status)
		// …and its effective bail survives (the snapshot persisted it).
		expect(restored?.bail).toBe(true)
		expect(restoreWorkflow(workflow.snapshot()).phase('inherit')?.bail).toBe(false)
	})
})

describe('Phase — emit-safety (§13)', () => {
	it('isolates a throwing listener, routes it to the error handler, and still derives', () => {
		const errors = createErrorRecorder()
		const phase = lonePhase(
			createWorkflow(buildPhaseWorkflow(1), { phases: { p: { error: errors.handler } } }),
		)
		phase.emitter.on('start', () => {
			throw new Error('listener boom')
		})
		expect(() => phase.task('t0')?.start()).not.toThrow()
		expect(phase.status).toBe('running')
		// The throw is routed to the emitter's error handler — (error, event) order.
		expect(errors.count).toBe(1)
		expect(errors.calls[0]?.[1]).toBe('start')
	})
})
