import { createWorkflow } from '@src/core'
import { describe, expect, it } from 'vitest'

// The lean task child manager (AGENTS §9): a positional accessor + count, order preserved
// across an interior skip. Exercised through a live tree (the manager is populated by the
// factory build) — real data, no mocks (AGENTS §16).

/** A live phase whose `tasks` manager holds `t0, t1, t2`. */
function phaseWithTasks() {
	const workflow = createWorkflow({
		id: 'wf',
		name: 'WF',
		phases: [
			{
				id: 'p',
				name: 'P',
				tasks: [
					{ id: 't0', name: 'T0', run: { via: 'function', name: 'f' } },
					{ id: 't1', name: 'T1', run: { via: 'function', name: 'f' } },
					{ id: 't2', name: 'T2', run: { via: 'function', name: 'f' } },
				],
			},
		],
	})
	const phase = workflow.phase('p')
	if (phase === undefined) throw new Error('expected the phase to exist')
	return phase
}

describe('TaskManager — accessors (§9)', () => {
	it('count reflects the appended tasks', () => {
		expect(phaseWithTasks().tasks.count).toBe(3)
	})

	it('task(id) looks one up, undefined for an unknown id', () => {
		const tasks = phaseWithTasks().tasks
		expect(tasks.task('t1')?.id).toBe('t1')
		expect(tasks.task('missing')).toBeUndefined()
	})

	it('tasks() lists in positional (append) order', () => {
		expect(
			phaseWithTasks()
				.tasks.tasks()
				.map((task) => task.id),
		).toEqual(['t0', 't1', 't2'])
	})
})

describe('TaskManager — positional order survives an interior skip', () => {
	it('a skipped interior task keeps its slot', () => {
		const phase = phaseWithTasks()
		// Skip the MIDDLE task — a status change, not a removal, so order is unchanged.
		phase.task('t1')?.skip()
		expect(phase.tasks.tasks().map((task) => task.id)).toEqual(['t0', 't1', 't2'])
		expect(phase.task('t1')?.status).toBe('skipped')
		expect(phase.tasks.count).toBe(3)
	})
})
