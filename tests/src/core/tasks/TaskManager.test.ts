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
					{ id: 't0', name: 'T0', run: 'f' },
					{ id: 't1', name: 'T1', run: 'f' },
					{ id: 't2', name: 'T2', run: 'f' },
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

describe('TaskManager — add/remove/move/update Result matrix (via Phase, AGENTS §12)', () => {
	it('add succeeds with the minted task as the success value, appended at the end by default', () => {
		const phase = phaseWithTasks()
		const result = phase.add({ id: 't3', name: 'T3', run: 'f' })
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.value.id).toBe('t3')
		expect(phase.tasks.tasks().map((task) => task.id)).toEqual(['t0', 't1', 't2', 't3'])
	})

	it('add at an explicit index inserts there, shifting the suffix (order asserted via tasks())', () => {
		const phase = phaseWithTasks()
		const result = phase.add({ id: 't-mid', name: 'Mid', run: 'f' }, 1)
		expect(result.success).toBe(true)
		expect(phase.tasks.tasks().map((task) => task.id)).toEqual(['t0', 't-mid', 't1', 't2'])
	})

	it('add fails MUTATION on a duplicate id, leaving the manager unchanged', () => {
		const phase = phaseWithTasks()
		const result = phase.add({ id: 't1', name: 'Dup', run: 'f' })
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error.code).toBe('MUTATION')
		expect(phase.tasks.count).toBe(3)
	})

	it('add fails MUTATION on an out-of-bounds index', () => {
		const phase = phaseWithTasks()
		for (const index of [-1, 4]) {
			const result = phase.add({ id: 't-oob', name: 'OOB', run: 'f' }, index)
			expect(result.success).toBe(false)
			if (result.success) return
			expect(result.error.code).toBe('MUTATION')
		}
		expect(phase.tasks.count).toBe(3)
	})

	it('remove succeeds on a pending task and returns it as the success value', () => {
		const phase = phaseWithTasks()
		const result = phase.remove('t1')
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.value.id).toBe('t1')
		expect(phase.tasks.tasks().map((task) => task.id)).toEqual(['t0', 't2'])
		expect(phase.tasks.count).toBe(2)
	})

	it('remove fails MUTATION on a missing id', () => {
		const phase = phaseWithTasks()
		const result = phase.remove('missing')
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error.code).toBe('MUTATION')
	})

	it('remove fails MUTATION on a non-pending (running) task', () => {
		const phase = phaseWithTasks()
		phase.task('t0')?.start()
		const result = phase.remove('t0')
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error.code).toBe('MUTATION')
		expect(phase.tasks.count).toBe(3)
	})

	it('move repositions a pending task, order asserted via tasks()', () => {
		const phase = phaseWithTasks()
		const result = phase.move('t0', 2)
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.value.id).toBe('t0')
		expect(phase.tasks.tasks().map((task) => task.id)).toEqual(['t1', 't2', 't0'])
	})

	it('move fails MUTATION on a missing id / non-pending task / out-of-bounds destination', () => {
		const missing = phaseWithTasks()
		expect(missing.move('nope', 0).success).toBe(false)

		const running = phaseWithTasks()
		running.task('t0')?.start()
		expect(running.move('t0', 1).success).toBe(false)

		const oob = phaseWithTasks()
		for (const index of [-1, 3]) {
			const result = oob.move('t0', index)
			expect(result.success).toBe(false)
			if (result.success) continue
			expect(result.error.code).toBe('MUTATION')
		}
	})

	it('update applies a valid patch to a pending task and returns it', () => {
		const phase = phaseWithTasks()
		const result = phase.update('t0', { name: 'Renamed' })
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.value.name).toBe('Renamed')
		expect(phase.task('t0')?.name).toBe('Renamed')
	})

	it('update fails MUTATION on a missing id / non-pending task', () => {
		const missing = phaseWithTasks()
		expect(missing.update('nope', { name: 'x' }).success).toBe(false)

		const running = phaseWithTasks()
		running.task('t0')?.start()
		const result = running.update('t0', { name: 'x' })
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error.code).toBe('MUTATION')
	})

	it('append throws MUTATION on a duplicate id (via a duplicate task id in the same phase definition)', () => {
		expect(() =>
			createWorkflow({
				id: 'wf',
				name: 'WF',
				phases: [
					{
						id: 'p',
						name: 'P',
						tasks: [
							{ id: 'dup', name: 'A', run: 'f' },
							{ id: 'dup', name: 'B', run: 'f' },
						],
					},
				],
			}),
		).toThrow(/duplicate task id/)
	})
})
