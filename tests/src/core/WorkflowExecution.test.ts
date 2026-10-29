import { createWorkflow, RunHolder, WorkflowExecution } from '@src/core'
import { describe, expect, it } from 'vitest'

describe('WorkflowExecution', () => {
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
