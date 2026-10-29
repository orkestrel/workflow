import { FOREIGN_ACTIVITY_VALUES } from '../../setup.js'
import {
	cloneTaskProgress,
	cloneTaskActivity,
	cloneWorkflowSnapshot,
	createWorkflow,
	isWorkflowError,
} from '@src/core'
import { captureError } from '@orkestrel/test'
import {
	INVALID_TASK_ACTIVITIES,
	WorkflowObservation,
	buildWorkflowClaim,
	buildActivityStamp,
} from '../../setup.js'
import { describe, expect, it } from 'vitest'

describe('cloneTaskProgress', () => {
	it('copies and freezes a supplied progress frame and preserves absence', () => {
		const input = { progress: 1, total: 2, message: 'Copy' }
		const cloned = cloneTaskProgress(input)
		expect(cloned).toEqual(input)
		expect(cloned).not.toBe(input)
		expect(Object.isFrozen(cloned)).toBe(true)
		expect(cloneTaskProgress(undefined)).toBeUndefined()
		expect(() => cloneTaskProgress({ progress: 1, extra: true })).toThrow(
			'task activity contains invalid progress',
		)
	})
})

describe('cloneTaskActivity', () => {
	it('clones and freezes a complete frame without retaining caller aliases', () => {
		const operations = [{ id: 'operation', name: 'Operation', started: 1 }]
		const constraints = [{ id: 'constraint', name: 'Constraint', started: 2 }]
		const progress = { progress: 2, total: 4, message: 'steps' }
		const activity = cloneTaskActivity({ note: 'working', operations, constraints, progress }, 10)
		operations.length = 0
		constraints.length = 0
		progress.progress = 3

		expect(activity).toEqual({
			note: 'working',
			progress: { progress: 2, total: 4, message: 'steps' },
			operations: [{ id: 'operation', name: 'Operation', started: 1 }],
			constraints: [{ id: 'constraint', name: 'Constraint', started: 2 }],
			updated: 10,
		})
		expect(Object.isFrozen(activity)).toBe(true)
		expect(Object.isFrozen(activity.progress)).toBe(true)
		expect(Object.isFrozen(activity.operations)).toBe(true)
		expect(Object.isFrozen(activity.operations[0])).toBe(true)
		expect(Object.isFrozen(activity.constraints)).toBe(true)
		expect(Object.isFrozen(activity.constraints[0])).toBe(true)
	})

	it('rejects unknown keys and class instances at every activity level', () => {
		for (const input of FOREIGN_ACTIVITY_VALUES) {
			expect(isWorkflowError(captureError(() => cloneTaskActivity(input, 0)))).toBe(true)
		}
	})

	it.each(INVALID_TASK_ACTIVITIES)('rejects invalid frame %#', (input) => {
		const error = captureError(() => cloneTaskActivity(input, 0))
		expect(isWorkflowError(error)).toBe(true)
	})

	it('contains revoked proxies and even revoked proxies thrown by hostile getters', () => {
		const revokedInput = Proxy.revocable({}, {})
		revokedInput.revoke()
		const inputError = captureError(() => cloneTaskActivity(revokedInput.proxy, 0))
		expect(isWorkflowError(inputError)).toBe(true)

		const revokedError = Proxy.revocable({}, {})
		revokedError.revoke()
		const hostile = Object.defineProperty({}, 'note', {
			get: () => {
				throw revokedError.proxy
			},
		})
		const thrownError = captureError(() => cloneTaskActivity(hostile, 0))
		expect(isWorkflowError(thrownError)).toBe(true)
	})

	it('captures shifting values once, rejects reporter stamps, and restores persisted stamps', () => {
		const idReads = new WorkflowObservation(0)
		const operation = buildWorkflowClaim(idReads)
		const stampedReads = new WorkflowObservation(0)
		const stamped = buildActivityStamp(() => {
			stampedReads.value += 1
			throw new Error('updated must not be read')
		}, [operation])
		expect(isWorkflowError(captureError(() => cloneTaskActivity(stamped, 5)))).toBe(true)
		expect(idReads.value).toBe(0)
		expect(stampedReads.value).toBe(0)

		const restoredReads = new WorkflowObservation(0)
		const restored = buildActivityStamp(
			() => {
				restoredReads.value += 1
				return restoredReads.value === 1 ? 7 : Number.NaN
			},
			[],
			[],
		)
		expect(cloneTaskActivity(restored).updated).toBe(7)
		expect(restoredReads.value).toBe(1)
	})
})

describe('workflow snapshot ownership', () => {
	it('rejects a valid snapshot whose payload id differs from its storage key', () => {
		const snapshot = createWorkflow({
			id: 'payload',
			name: 'Payload',
			phases: [{ id: 'phase', name: 'Phase', tasks: [{ id: 'task', name: 'Task' }] }],
		}).snapshot()

		const error = captureError(() => cloneWorkflowSnapshot(snapshot, 'requested'))
		expect(isWorkflowError(error)).toBe(true)
		if (!isWorkflowError(error)) throw new Error('expected WorkflowError')
		expect(error.code).toBe('RESTORE')
		expect(error.message).toBe("workflow snapshot 'payload' does not match storage key 'requested'")
		expect(error.context).toEqual({ requested: 'requested', payload: 'payload' })
	})

	it('translates revoked snapshot reflection failures to RESTORE errors', () => {
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()

		const error = captureError(() => cloneWorkflowSnapshot(revoked.proxy))
		expect(isWorkflowError(error)).toBe(true)
		if (!isWorkflowError(error)) throw new Error('expected WorkflowError')
		expect(error.code).toBe('RESTORE')
		expect(error.message).toContain('could not be inspected')
	})

	it('survives a JSON round-trip and owns every persisted result lineage graph', () => {
		const workflow = createWorkflow({
			id: 'owned',
			name: 'Owned',
			phases: [{ id: 'phase', name: 'Phase', tasks: [{ id: 'task', name: 'Task' }] }],
		})
		const task = workflow.phase('phase')?.task('task')
		if (task === undefined) throw new Error('expected task')
		task.start()
		task.complete({ nested: ['value'] })
		const snapshot = cloneWorkflowSnapshot(JSON.parse(JSON.stringify(workflow.snapshot())))
		const result = snapshot.phases[0]?.tasks[0]?.result
		if (result === undefined) throw new Error('expected persisted result')

		expect(Object.isFrozen(snapshot)).toBe(true)
		expect(Object.isFrozen(snapshot.phases)).toBe(true)
		expect(Object.isFrozen(result)).toBe(true)
		expect(Object.isFrozen(result.task)).toBe(true)
		expect(Object.isFrozen(result.task.phase)).toBe(true)
		expect(Object.isFrozen(result.task.phase.workflow)).toBe(true)
		expect(Object.isFrozen(result.phase)).toBe(true)
		expect(Object.isFrozen(result.workflow)).toBe(true)
		expect(result.task.phase).not.toBe(result.phase)
		expect(result.task.phase.workflow).not.toBe(result.workflow)
	})

	it('rejects unknown keys inside persisted result lineage', () => {
		const workflow = createWorkflow({
			id: 'lineage',
			name: 'Lineage',
			phases: [{ id: 'phase', name: 'Phase', tasks: [{ id: 'task', name: 'Task' }] }],
		})
		const task = workflow.phase('phase')?.task('task')
		if (task === undefined) throw new Error('expected task')
		task.start()
		task.complete(null)
		const snapshot = workflow.snapshot()
		const phase = snapshot.phases[0]
		const leaf = phase?.tasks[0]
		const result = leaf?.result
		if (phase === undefined || leaf === undefined || result === undefined) {
			throw new Error('expected settled snapshot')
		}
		const invalid = {
			...snapshot,
			phases: [
				{
					...phase,
					tasks: [
						{
							...leaf,
							result: {
								...result,
								workflow: { ...result.workflow, extra: true },
							},
						},
					],
				},
			],
		}
		expect(isWorkflowError(captureError(() => cloneWorkflowSnapshot(invalid)))).toBe(true)
	})
})
