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
