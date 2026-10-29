import { createWorkflow, ownsAttempt, PhaseExecution } from '@src/core'
import { describe, expect, it } from 'vitest'
import { requireWorkflowTask } from '../../setup.js'

describe('PhaseExecution', () => {
	it('retains current claims when an older invocation releases and isolates phase state', () => {
		const task = requireWorkflowTask(
			createWorkflow({
				id: 'wf',
				name: 'WF',
				phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', retries: 1 }] }],
			}),
		)
		const execution = new PhaseExecution()
		const other = new PhaseExecution()
		execution.add(task)
		execution.restore(task)
		expect(execution.launched.has(task.id)).toBe(true)
		expect(other.launched.has(task.id)).toBe(false)
		expect(execution.attempts.get(task.id)).toBe(0)
		const first = execution.record(task)
		task.start()
		execution.claim(task, first)
		expect(ownsAttempt(execution.owners, task, first)).toBe(true)
		const second = execution.record(task)
		task.start()
		execution.claim(task, second)
		execution.revoke(task.id, first)
		expect(ownsAttempt(execution.owners, task, second)).toBe(true)
		expect(ownsAttempt(execution.owners, task, first)).toBe(false)
		execution.revoke(task.id, second)
		expect(execution.owners.has(task.id)).toBe(false)
		expect(other.attempts.has(task.id)).toBe(false)
	})
})
