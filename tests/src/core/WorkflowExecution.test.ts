import { createWorkflow, isWorkflowError, RunHolder, WorkflowExecution } from '@src/core'
import { captureError } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'
import { INVALID_TIMER_BOUNDS } from '../../setup.js'

describe('WorkflowExecution', () => {
	for (const timeout of INVALID_TIMER_BOUNDS) {
		it(`refuses a timeout of ${timeout} instead of running with no bound`, () => {
			const workflow = createWorkflow({ id: 'run', name: 'Run', phases: [] })
			const execution = new WorkflowExecution()
			const error = captureError(() =>
				execution.start(workflow, new RunHolder(), undefined, timeout, undefined, undefined),
			)

			expect(isWorkflowError(error) && error.code).toBe('SCHEDULE')
		})
	}

	it('runs with no deadline only when the timeout is undefined', () => {
		const workflow = createWorkflow({ id: 'run', name: 'Run', phases: [] })
		const execution = new WorkflowExecution()
		const signal = execution.start(
			workflow,
			new RunHolder(),
			undefined,
			undefined,
			undefined,
			undefined,
		)

		expect(signal.aborted).toBe(false)
		execution.clear()
	})

	it('keeps the live cursor and bounds independent for each execution', () => {
		const workflow = createWorkflow({ id: 'run', name: 'Run', phases: [] })
		const first = new WorkflowExecution()
		const second = new WorkflowExecution()
		const caller = new AbortController()
		try {
			const signal = first.start(
				workflow,
				new RunHolder(),
				caller.signal,
				undefined,
				undefined,
				undefined,
			)
			expect(first.persistence).toBeUndefined()
			expect(first.cursor).toBe(0)
			first.advance()
			expect(first.cursor).toBe(1)
			expect(second.cursor).toBe(0)
			const reason = new Error('cancel')
			caller.abort(reason)
			expect(signal.aborted).toBe(true)
			expect(signal.reason).toBe(reason)
		} finally {
			first.clear()
			second.clear()
		}
	})
})
