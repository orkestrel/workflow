import { createWorkflow } from '@src/core'
import { describe, expect, it } from 'vitest'

// The lean phase child manager (AGENTS §9): a positional accessor + count, order preserved
// across an interior skip. Exercised through a live tree — real data, no mocks (AGENTS §16).

/** A live workflow whose `phases` manager holds `a, b, c`. */
function workflowWithPhases() {
	return createWorkflow({
		id: 'wf',
		name: 'WF',
		phases: [
			{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'f' } }] },
			{ id: 'b', name: 'B', tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'f' } }] },
			{ id: 'c', name: 'C', tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'f' } }] },
		],
	})
}

describe('PhaseManager — accessors (§9)', () => {
	it('count reflects the appended phases', () => {
		expect(workflowWithPhases().phases.count).toBe(3)
	})

	it('phase(id) looks one up, undefined for an unknown id', () => {
		const phases = workflowWithPhases().phases
		expect(phases.phase('b')?.id).toBe('b')
		expect(phases.phase('missing')).toBeUndefined()
	})

	it('phases() lists in positional (append) order', () => {
		expect(
			workflowWithPhases()
				.phases.phases()
				.map((phase) => phase.id),
		).toEqual(['a', 'b', 'c'])
	})
})

describe('PhaseManager — positional order survives an interior skip', () => {
	it('a skipped interior phase keeps its slot', () => {
		const workflow = workflowWithPhases()
		// Skip the MIDDLE phase — a status change, not a removal.
		workflow.phase('b')?.skip()
		expect(workflow.phases.phases().map((phase) => phase.id)).toEqual(['a', 'b', 'c'])
		expect(workflow.phase('b')?.status).toBe('skipped')
		expect(workflow.phases.count).toBe(3)
	})
})

describe('PhaseManager — add/remove/move/update Result matrix (via Workflow, AGENTS §12)', () => {
	it('add succeeds with the minted phase as the success value, appended at the end by default', () => {
		const workflow = workflowWithPhases()
		const result = workflow.add({
			id: 'd',
			name: 'D',
			tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'f' } }],
		})
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.value.id).toBe('d')
		expect(workflow.phases.phases().map((phase) => phase.id)).toEqual(['a', 'b', 'c', 'd'])
	})

	it('add at an explicit (in-bounds, suffix) index inserts there, shifting the pending suffix', () => {
		const workflow = workflowWithPhases()
		const result = workflow.add(
			{
				id: 'mid',
				name: 'Mid',
				tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'f' } }],
			},
			1,
		)
		expect(result.success).toBe(true)
		expect(workflow.phases.phases().map((phase) => phase.id)).toEqual(['a', 'mid', 'b', 'c'])
	})

	it('add fails MUTATION on a duplicate id, leaving the workflow unchanged', () => {
		const workflow = workflowWithPhases()
		const result = workflow.add({ id: 'b', name: 'Dup', tasks: [] })
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error.code).toBe('MUTATION')
		expect(workflow.phases.count).toBe(3)
	})

	it('add fails MUTATION for an index BEFORE the boundary (an already-started prefix)', () => {
		const workflow = workflowWithPhases()
		workflow.phase('a')?.skip() // 'a' is now non-pending → boundary is 1
		const result = workflow.add({ id: 'x', name: 'X', tasks: [] }, 0)
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error.code).toBe('MUTATION')
		expect(workflow.phases.count).toBe(3)
	})

	it('add fails MUTATION when the workflow is terminal', () => {
		const workflow = workflowWithPhases()
		workflow.stop()
		const result = workflow.add({ id: 'x', name: 'X', tasks: [] })
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error.code).toBe('MUTATION')
	})

	it('remove succeeds on a pending suffix phase and returns it as the success value', () => {
		const workflow = workflowWithPhases()
		const result = workflow.remove('c')
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.value.id).toBe('c')
		expect(workflow.phases.phases().map((phase) => phase.id)).toEqual(['a', 'b'])
	})

	it('remove fails MUTATION on a missing id', () => {
		const workflow = workflowWithPhases()
		const result = workflow.remove('missing')
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error.code).toBe('MUTATION')
	})

	it('remove fails MUTATION on a phase before the boundary', () => {
		const workflow = workflowWithPhases()
		workflow.phase('a')?.skip() // boundary now 1
		const result = workflow.remove('a')
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error.code).toBe('MUTATION')
		expect(workflow.phases.count).toBe(3)
	})

	it('move repositions a suffix phase within the suffix, order asserted via phases()', () => {
		const workflow = workflowWithPhases()
		const result = workflow.move('a', 2)
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.value.id).toBe('a')
		expect(workflow.phases.phases().map((phase) => phase.id)).toEqual(['b', 'c', 'a'])
	})

	it('move fails MUTATION on a missing id / a source before the boundary / a destination before the boundary', () => {
		const missing = workflowWithPhases()
		expect(missing.move('nope', 0).success).toBe(false)

		const sourceBeforeBoundary = workflowWithPhases()
		sourceBeforeBoundary.phase('a')?.skip() // boundary now 1
		const sourceResult = sourceBeforeBoundary.move('a', 2)
		expect(sourceResult.success).toBe(false)
		if (sourceResult.success) return
		expect(sourceResult.error.code).toBe('MUTATION')

		const destBeforeBoundary = workflowWithPhases()
		destBeforeBoundary.phase('a')?.skip() // boundary now 1
		const destResult = destBeforeBoundary.move('c', 0)
		expect(destResult.success).toBe(false)
		if (destResult.success) return
		expect(destResult.error.code).toBe('MUTATION')
	})

	it('update applies a valid patch to a suffix phase and returns it', () => {
		const workflow = workflowWithPhases()
		const result = workflow.update('a', { name: 'Renamed', concurrency: 2 })
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.value.name).toBe('Renamed')
		expect(workflow.phase('a')?.name).toBe('Renamed')
	})

	it('update fails MUTATION on a missing id / a phase before the boundary / a terminal workflow', () => {
		const missing = workflowWithPhases()
		expect(missing.update('nope', { name: 'x' }).success).toBe(false)

		const beforeBoundary = workflowWithPhases()
		beforeBoundary.phase('a')?.skip() // boundary now 1
		const boundaryResult = beforeBoundary.update('a', { name: 'x' })
		expect(boundaryResult.success).toBe(false)
		if (boundaryResult.success) return
		expect(boundaryResult.error.code).toBe('MUTATION')

		const terminal = workflowWithPhases()
		terminal.stop()
		const terminalResult = terminal.update('b', { name: 'x' })
		expect(terminalResult.success).toBe(false)
		if (terminalResult.success) return
		expect(terminalResult.error.code).toBe('MUTATION')
	})

	it('emits add/move/remove/update only on success', () => {
		const workflow = workflowWithPhases()
		const events = [] as string[]
		workflow.emitter.on('add', () => events.push('add'))
		workflow.emitter.on('move', () => events.push('move'))
		workflow.emitter.on('remove', () => events.push('remove'))
		workflow.emitter.on('update', () => events.push('update'))

		workflow.add({ id: 'd', name: 'D', tasks: [] })
		workflow.move('a', 1)
		workflow.update('b', { name: 'x' })
		workflow.remove('c')
		expect(events).toEqual(['add', 'move', 'update', 'remove'])

		// A failing call (dup id) emits nothing further.
		workflow.add({ id: 'd', name: 'Dup', tasks: [] })
		expect(events).toEqual(['add', 'move', 'update', 'remove'])
	})
})
