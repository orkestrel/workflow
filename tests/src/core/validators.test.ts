import {
	createWorkflow,
	hasWorkflowHandlers,
	isLifecycleStatus,
	isOwnedWorkflowSnapshot,
	isTaskActivity,
	isTaskActivityInput,
	isTaskFailure,
	isTaskResult,
	isWorkflowSnapshot,
	matchesDescription,
	recoverWorkflowSnapshot,
	workflowSnapshotContext,
} from '@src/core'
import { INVALID_TASK_ACTIVITIES } from '../../setup.js'
import { describe, expect, it } from 'vitest'

describe('task activity validators', () => {
	it('accepts valid input and persisted frames', () => {
		expect(isTaskActivityInput({ progress: { current: 1 }, operations: [], constraints: [] })).toBe(
			true,
		)
		expect(
			isTaskActivity({
				operations: [{ id: 'op', name: 'Operation', started: 0 }],
				constraints: [],
				updated: 1,
			}),
		).toBe(true)
		expect(isTaskActivityInput({ operations: [], constraints: [], updated: 1 })).toBe(false)
	})

	it.each(INVALID_TASK_ACTIVITIES)('rejects invalid input %#', (input) => {
		expect(isTaskActivityInput(input)).toBe(false)
	})

	it('contains throwing getters, proxies, and cyclic input', () => {
		const throwing = Object.defineProperty({}, 'note', {
			enumerable: true,
			get: () => {
				throw new Error('hostile')
			},
		})
		const proxy = new Proxy(
			{},
			{
				getPrototypeOf: () => {
					throw new Error('hostile')
				},
			},
		)
		const cyclic: unknown[] = []
		cyclic.push(cyclic)
		expect(isTaskActivityInput(throwing)).toBe(false)
		expect(isTaskActivityInput(proxy)).toBe(false)
		expect(isTaskActivityInput({ operations: cyclic })).toBe(false)
		expect(isTaskActivity(throwing)).toBe(false)
		expect(isTaskActivity(proxy)).toBe(false)
	})

	it('captures shifting getters once instead of validating one value and storing another', () => {
		let reads = 0
		const operation = {
			get id() {
				reads += 1
				return reads === 1 ? 'stable' : ''
			},
			name: 'Operation',
			started: 0,
		}
		expect(isTaskActivityInput({ operations: [operation] })).toBe(true)
		expect(reads).toBe(1)

		let updatedReads = 0
		const activity = {
			operations: [],
			constraints: [],
			get updated() {
				updatedReads += 1
				return updatedReads === 1 ? 1 : Number.NaN
			},
		}
		expect(isTaskActivity(activity)).toBe(true)
		expect(updatedReads).toBe(1)
	})
})

describe('snapshot logical leaves', () => {
	it('narrows real and revived workflow snapshots and stays total for hostile input', () => {
		const snapshot = createWorkflow({
			id: 'snapshot',
			name: 'Snapshot',
			phases: [
				{
					id: 'phase',
					name: 'Phase',
					tasks: [{ id: 'task', name: 'Task', run: 'work' }],
				},
			],
		}).snapshot()
		const revived: unknown = JSON.parse(JSON.stringify(snapshot))
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()

		expect(isWorkflowSnapshot(snapshot)).toBe(true)
		expect(isWorkflowSnapshot(revived)).toBe(true)
		for (const value of [
			undefined,
			null,
			42,
			'snapshot',
			[],
			{},
			{ id: 'snapshot' },
			{ ...snapshot, bail: 'yes' },
			{ ...snapshot, phases: 'none' },
			revoked.proxy,
		]) {
			expect(isWorkflowSnapshot(value)).toBe(false)
		}
		const { created: _omit, ...withoutCreated } = snapshot
		expect(isWorkflowSnapshot(withoutCreated)).toBe(false)
	})

	it.each(['pending', 'running', 'completed', 'failed', 'skipped', 'stopped'])(
		'narrows lifecycle status %s',
		(status) => {
			expect(isLifecycleStatus(status)).toBe(true)
		},
	)

	it.each([undefined, null, '', 'complete', 1, {}, []])(
		'rejects non-lifecycle value %#',
		(value) => {
			expect(isLifecycleStatus(value)).toBe(false)
		},
	)

	it('validates exact normalized task failures', () => {
		expect(isTaskFailure({ origin: 'handler', message: 'failed' })).toBe(true)
		expect(isTaskFailure({ origin: 'timeout', message: 'timed out' })).toBe(true)
		expect(isTaskFailure({ origin: 'recovery', message: 'exhausted' })).toBe(true)
		expect(isTaskFailure({ origin: 'handler', message: '' })).toBe(false)
		expect(isTaskFailure({ origin: 'other', message: 'failed' })).toBe(false)
		expect(isTaskFailure({ origin: 'handler', message: 'failed', extra: true })).toBe(false)
	})

	it('keeps task failure guards total for throwing ownKeys, getters, and revoked proxies', () => {
		const ownKeys = new Proxy(
			{},
			{
				ownKeys: () => {
					throw new Error('ownKeys')
				},
			},
		)
		const getter = Object.defineProperty({}, 'origin', {
			enumerable: true,
			get: () => {
				throw new Error('origin')
			},
		})
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()

		expect(isTaskFailure(ownKeys)).toBe(false)
		expect(isTaskFailure(getter)).toBe(false)
		expect(isTaskFailure(revoked.proxy)).toBe(false)
	})

	it('matches only equal optional descriptions', () => {
		expect(matchesDescription(undefined, undefined)).toBe(true)
		expect(matchesDescription('', '')).toBe(true)
		expect(matchesDescription('same', 'same')).toBe(true)
		expect(matchesDescription('left', 'right')).toBe(false)
		expect(matchesDescription(undefined, '')).toBe(false)
		expect(matchesDescription(1, 1)).toBe(false)
	})

	it('validates an exact result and rejects status, lineage, and nested-key drift', () => {
		const workflow = createWorkflow({
			id: 'result',
			name: 'Result',
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
			throw new Error('expected completed result')
		}

		expect(isTaskResult(result, { ...snapshot }, { ...phase }, { ...leaf })).toBe(true)
		expect(
			isTaskResult({ ...result, status: 'failed' }, { ...snapshot }, { ...phase }, { ...leaf }),
		).toBe(false)
		expect(
			isTaskResult(
				{ ...result, workflow: { ...result.workflow, id: 'other' } },
				{ ...snapshot },
				{ ...phase },
				{ ...leaf },
			),
		).toBe(false)
		expect(
			isTaskResult(
				{ ...result, task: { ...result.task, extra: true } },
				{ ...snapshot },
				{ ...phase },
				{ ...leaf },
			),
		).toBe(false)
	})

	it('keeps result guards total across hostile results and containing nodes', () => {
		const workflow = createWorkflow({
			id: 'hostile-result',
			name: 'Hostile result',
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
			throw new Error('expected result fixtures')
		}
		const ownKeys = new Proxy(
			{},
			{
				ownKeys: () => {
					throw new Error('ownKeys')
				},
			},
		)
		const hostileTask = Object.defineProperty({}, 'status', {
			enumerable: true,
			get: () => {
				throw new Error('status')
			},
		})
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()

		expect(isTaskResult(ownKeys, snapshot, phase, leaf)).toBe(false)
		expect(isTaskResult(result, snapshot, phase, hostileTask)).toBe(false)
		expect(isTaskResult(result, snapshot, revoked.proxy, leaf)).toBe(false)
	})

	it('validates owned coherent snapshots and rejects derived or attempt drift', () => {
		const snapshot = createWorkflow({
			id: 'owned',
			name: 'Owned',
			phases: [{ id: 'phase', name: 'Phase', tasks: [{ id: 'task', name: 'Task' }] }],
		}).snapshot()
		const phase = snapshot.phases[0]
		const task = phase?.tasks[0]
		if (phase === undefined || task === undefined) throw new Error('expected snapshot task')

		expect(isOwnedWorkflowSnapshot(snapshot)).toBe(true)
		expect(isOwnedWorkflowSnapshot({ ...snapshot, status: 'completed' })).toBe(false)
		expect(
			isOwnedWorkflowSnapshot({
				...snapshot,
				phases: [
					{
						...phase,
						tasks: [{ ...task, attempts: 1 }],
					},
				],
			}),
		).toBe(false)
	})

	it('rejects activity on every pending snapshot even after an interrupted attempt', () => {
		const source = createWorkflow({
			id: 'pending-activity',
			name: 'Pending activity',
			phases: [
				{
					id: 'phase',
					name: 'Phase',
					tasks: [{ id: 'task', name: 'Task', retries: 1 }],
				},
			],
		})
		source.phase('phase')?.task('task')?.start()
		const snapshot = source.snapshot()
		const phase = snapshot.phases[0]
		const task = phase?.tasks[0]
		if (phase === undefined || task?.activity === undefined) {
			throw new Error('expected running activity')
		}
		const invalid = {
			...snapshot,
			status: 'pending',
			phases: [
				{
					...phase,
					status: 'pending',
					tasks: [{ ...task, status: 'pending' }],
				},
			],
		}

		expect(isOwnedWorkflowSnapshot(invalid)).toBe(false)
		expect(isWorkflowSnapshot(invalid)).toBe(false)
	})

	it('keeps owned snapshot guards total for throwing ownKeys, getters, and revoked proxies', () => {
		const ownKeys = new Proxy(
			{},
			{
				ownKeys: () => {
					throw new Error('ownKeys')
				},
			},
		)
		const getter = Object.defineProperty({}, 'phases', {
			enumerable: true,
			get: () => {
				throw new Error('phases')
			},
		})
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()

		expect(isOwnedWorkflowSnapshot(ownKeys)).toBe(false)
		expect(isOwnedWorkflowSnapshot(getter)).toBe(false)
		expect(isOwnedWorkflowSnapshot(revoked.proxy)).toBe(false)
	})

	it('checks every persisted behavior reference against a registry', () => {
		const named = createWorkflow({
			id: 'handlers',
			name: 'Handlers',
			phases: [
				{
					id: 'phase',
					name: 'Phase',
					tasks: [
						{ id: 'named', name: 'Named', run: 'work' },
						{ id: 'noop', name: 'No-op' },
					],
				},
			],
		}).snapshot()
		expect(hasWorkflowHandlers(named, { work: () => null })).toBe(true)
		expect(hasWorkflowHandlers(named, {})).toBe(false)
		expect(hasWorkflowHandlers(named, undefined)).toBe(false)
		expect(
			hasWorkflowHandlers(
				createWorkflow({ id: 'empty', name: 'Empty', phases: [] }).snapshot(),
				undefined,
			),
		).toBe(true)
	})

	it('locates the nearest identifiable invalid phase or task', () => {
		const snapshot = createWorkflow({
			id: 'context',
			name: 'Context',
			phases: [{ id: 'phase', name: 'Phase', tasks: [{ id: 'task', name: 'Task' }] }],
		}).snapshot()
		const phase = snapshot.phases[0]
		const task = phase?.tasks[0]
		if (phase === undefined || task === undefined) throw new Error('expected context task')

		expect(workflowSnapshotContext(snapshot)).toBeUndefined()
		expect(
			workflowSnapshotContext({
				...snapshot,
				phases: [{ ...phase, concurrency: 0 }],
			}),
		).toEqual({ phase: 'phase' })
		expect(
			workflowSnapshotContext({
				...snapshot,
				phases: [
					{
						...phase,
						tasks: [{ ...task, retries: -1 }],
					},
				],
			}),
		).toEqual({ phase: 'phase', task: 'task' })
		expect(workflowSnapshotContext(null)).toBeUndefined()
	})

	it('projects retryable and exhausted running work directly', () => {
		const source = createWorkflow({
			id: 'recover',
			name: 'Recover',
			bail: false,
			phases: [
				{
					id: 'phase',
					name: 'Phase',
					tasks: [
						{ id: 'retryable', name: 'Retryable', retries: 1 },
						{ id: 'exhausted', name: 'Exhausted' },
					],
				},
			],
		})
		source.phase('phase')?.task('retryable')?.start()
		source.phase('phase')?.task('exhausted')?.start()

		const recovered = recoverWorkflowSnapshot(source.snapshot())
		expect(recovered.phases[0]?.tasks[0]?.status).toBe('pending')
		expect(recovered.phases[0]?.tasks[0]?.attempts).toBe(1)
		expect(recovered.phases[0]?.tasks[0]?.activity).toBeUndefined()
		expect(recovered.phases[0]?.tasks[1]?.status).toBe('failed')
		expect(recovered.phases[0]?.tasks[1]?.result?.result).toEqual({
			success: false,
			error: {
				origin: 'recovery',
				message: "task 'exhausted' exhausted its retry budget during recovery",
			},
		})
	})
})
