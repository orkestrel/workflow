import type {
	WorkflowDefinition,
	WorkflowFunctions,
	WorkflowOptions,
	WorkflowSnapshot,
	WorkflowStoreInterface,
} from '@src/core'
import {
	createWorkflow,
	createWorkflowRunner,
	isWorkflowError,
	recoverWorkflow,
	restoreWorkflow,
	WorkflowPersistence,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { captureError, createGate, createRecordingScheduler } from '../../setup.js'

const DEFINITION: WorkflowDefinition = {
	id: 'durable',
	name: 'Durable',
	bail: false,
	phases: [
		{
			id: 'phase',
			name: 'Phase',
			tasks: [{ id: 'task', name: 'Task', run: 'work', retries: 1 }],
		},
	],
}

const VALIDATED_FUNCTIONS = { work: () => 'validated' }
const SHIFTED_FUNCTIONS = { work: () => 'shifted' }

function runner(): ReturnType<typeof createWorkflowRunner> {
	return createWorkflowRunner({ scheduler: createRecordingScheduler() })
}

function taskSnapshot(
	snapshot: WorkflowSnapshot,
): WorkflowSnapshot['phases'][number]['tasks'][number] {
	const task = snapshot.phases[0]?.tasks[0]
	if (task === undefined) throw new Error('expected task snapshot')
	return task
}

describe('workflow recovery', () => {
	it('uses the exact once-read functions registry for validation and recovered handlers', () => {
		const source = createWorkflow(DEFINITION, { functions: VALIDATED_FUNCTIONS })
		const task = source.phase('phase')?.task('task')
		if (task === undefined) throw new Error('expected recoverable task')
		task.start()
		let reads = 0
		const options: WorkflowOptions = {}
		Object.defineProperty(options, 'functions', {
			get: () => {
				reads += 1
				return reads === 1 ? VALIDATED_FUNCTIONS : SHIFTED_FUNCTIONS
			},
		})

		const recovered = recoverWorkflow(source.snapshot(), options)

		expect(reads).toBe(1)
		expect(recovered.phase('phase')?.task('task')?.handler).toBe(VALIDATED_FUNCTIONS.work)
	})

	it('captures each unique initial run once and retains the registry for later live additions', () => {
		const definition: WorkflowDefinition = {
			id: 'captured-runs',
			name: 'Captured runs',
			phases: [
				{
					id: 'phase',
					name: 'Phase',
					tasks: [
						{ id: 'first', name: 'First', run: 'work' },
						{ id: 'second', name: 'Second', run: 'work' },
					],
				},
			],
		}
		const snapshot = createWorkflow(definition, { functions: VALIDATED_FUNCTIONS }).snapshot()
		let reads = 0
		const functions: WorkflowFunctions = {}
		Object.defineProperty(functions, 'work', {
			get: () => {
				reads += 1
				return reads === 1 ? VALIDATED_FUNCTIONS.work : SHIFTED_FUNCTIONS.work
			},
		})

		const recovered = recoverWorkflow(snapshot, { functions })

		expect(reads).toBe(1)
		expect(recovered.phase('phase')?.task('first')?.handler).toBe(VALIDATED_FUNCTIONS.work)
		expect(recovered.phase('phase')?.task('second')?.handler).toBe(VALIDATED_FUNCTIONS.work)
		const added = recovered.phase('phase')?.add({ id: 'later', name: 'Later', run: 'work' })
		if (added === undefined || !added.success) throw new Error('expected live task addition')
		expect(reads).toBe(2)
		expect(added.value.handler).toBe(SHIFTED_FUNCTIONS.work)
	})

	it('rejects the first unresolved keyed binding without rereading a later valid value', () => {
		const snapshot = createWorkflow(DEFINITION, { functions: VALIDATED_FUNCTIONS }).snapshot()
		let reads = 0
		const functions: WorkflowFunctions = {}
		Object.defineProperty(functions, 'work', {
			get: () => {
				reads += 1
				return reads === 1 ? undefined : VALIDATED_FUNCTIONS.work
			},
		})

		const error = captureError(() => recoverWorkflow(snapshot, { functions }))

		expect(reads).toBe(1)
		expect(isWorkflowError(error) ? error.code : undefined).toBe('RESTORE')
	})

	it('preserves out-of-order completed siblings and executes only recovered pending work', async () => {
		const definition: WorkflowDefinition = {
			id: 'mixed',
			name: 'Mixed',
			bail: false,
			phases: [
				{
					id: 'phase',
					name: 'Phase',
					tasks: [
						{ id: 'first', name: 'First', run: 'first' },
						{ id: 'done', name: 'Done', run: 'done' },
						{ id: 'interrupted', name: 'Interrupted', run: 'interrupted', retries: 1 },
					],
				},
			],
		}
		const functions = {
			first: () => 'first',
			done: () => 'done',
			interrupted: () => 'interrupted',
		}
		const source = createWorkflow(definition, { functions })
		const done = source.phase('phase')?.task('done')
		const interrupted = source.phase('phase')?.task('interrupted')
		if (done === undefined || interrupted === undefined) throw new Error('expected mixed tasks')
		done.start()
		done.complete('persisted')
		interrupted.start()

		const exact = restoreWorkflow(source.snapshot(), { functions })
		expect(() => runner().execute(exact)).toThrow(/not drivable/)

		const calls: string[] = []
		const recovered = recoverWorkflow(source.snapshot(), {
			functions: {
				first: () => {
					calls.push('first')
					return 'first'
				},
				done: () => {
					calls.push('done')
					return 'wrong'
				},
				interrupted: () => {
					calls.push('interrupted')
					return 'interrupted'
				},
			},
		})
		const result = await runner().execute(recovered)

		expect(result.status).toBe('completed')
		expect(calls.sort()).toEqual(['first', 'interrupted'])
		expect(result.workflow.phase('phase')?.task('done')?.result?.result).toEqual({
			success: true,
			value: 'persisted',
		})
	})

	it('resumes an interrupted task at its remaining persisted attempt budget', async () => {
		const source = createWorkflow(DEFINITION, { functions: { work: () => null } })
		const interrupted = source.phase('phase')?.task('task')
		if (interrupted === undefined) throw new Error('expected task')
		interrupted.start()
		const reported = interrupted.report({ note: 'interrupted attempt' })
		if (!reported.success) throw reported.error
		const stale = reported.value

		const attempts: number[] = []
		const recovered = recoverWorkflow(source.snapshot(), {
			functions: {
				work: (controller) => {
					attempts.push(controller.attempt)
					return 'done'
				},
			},
		})

		expect(recovered.status).toBe('pending')
		expect(recovered.phase('phase')?.task('task')?.status).toBe('pending')
		expect(recovered.phase('phase')?.task('task')?.attempts).toBe(1)
		expect(recovered.phase('phase')?.task('task')?.activity).toBeUndefined()
		expect(recovered.snapshot().phases[0]?.tasks[0]).not.toHaveProperty('activity')

		const result = await runner().execute(recovered)
		expect(result.status).toBe('completed')
		expect(attempts).toEqual([2])
		expect(result.workflow.phase('phase')?.task('task')?.attempts).toBe(2)
		const started = result.workflow.phase('phase')?.task('task')?.activity
		expect(started).not.toBe(stale)
		expect(started?.note).toBeUndefined()
		expect(started?.operations).toEqual([])
		expect(started?.constraints).toEqual([])
		expect(started?.updated).toBeGreaterThanOrEqual(stale.updated)
	})

	it('never regresses a future persisted workflow stamp during recovery', () => {
		const source = createWorkflow(DEFINITION, { functions: { work: () => null } })
		const interrupted = source.phase('phase')?.task('task')
		if (interrupted === undefined) throw new Error('expected task')
		interrupted.start()
		const snapshot = source.snapshot()
		const future = Date.now() + 60_000

		const recovered = recoverWorkflow(
			{ ...snapshot, updated: future },
			{ functions: { work: () => null } },
		)

		expect(recovered.snapshot().updated).toBe(future)
	})

	it('converts an exhausted interrupted task into a normalized recovery failure', () => {
		const source = createWorkflow(
			{
				...DEFINITION,
				phases: [
					{
						id: 'phase',
						name: 'Phase',
						tasks: [{ id: 'task', name: 'Task', run: 'work' }],
					},
				],
			},
			{ functions: { work: () => null } },
		)
		const interrupted = source.phase('phase')?.task('task')
		if (interrupted === undefined) throw new Error('expected task')
		interrupted.start()

		const recovered = recoverWorkflow(source.snapshot(), {
			functions: { work: () => null },
		})
		const result = recovered.phase('phase')?.task('task')?.result
		expect(result?.status).toBe('failed')
		expect(result?.result).toEqual({
			success: false,
			error: {
				origin: 'recovery',
				message: "task 'task' exhausted its retry budget during recovery",
			},
		})
	})

	it('never replenishes attempts across repeated crash and recovery projections', () => {
		const source = createWorkflow(
			{
				...DEFINITION,
				phases: [
					{
						id: 'phase',
						name: 'Phase',
						tasks: [{ id: 'task', name: 'Task', run: 'work', retries: 2 }],
					},
				],
			},
			{ functions: { work: () => null } },
		)
		const first = source.phase('phase')?.task('task')
		if (first === undefined) throw new Error('expected first attempt')
		first.start()

		const once = recoverWorkflow(source.snapshot(), { functions: { work: () => null } })
		expect(once.phase('phase')?.task('task')?.attempts).toBe(1)
		once.phase('phase')?.task('task')?.start()

		const twice = recoverWorkflow(once.snapshot(), { functions: { work: () => null } })
		expect(twice.phase('phase')?.task('task')?.attempts).toBe(2)
		twice.phase('phase')?.task('task')?.start()

		const exhausted = recoverWorkflow(twice.snapshot(), { functions: { work: () => null } })
		expect(exhausted.phase('phase')?.task('task')?.attempts).toBe(3)
		expect(exhausted.phase('phase')?.task('task')?.status).toBe('failed')
	})

	it.each([
		{
			bail: true,
			expected: ['skipped', 'failed', 'skipped', 'skipped'],
			later: 'skipped',
		},
		{
			bail: false,
			expected: ['pending', 'failed', 'pending', 'pending'],
			later: 'pending',
		},
	])(
		'applies the whole-phase exhausted recovery policy under bail:$bail',
		({ bail, expected, later }) => {
			const definition: WorkflowDefinition = {
				id: `policy-${String(bail)}`,
				name: 'Policy',
				bail,
				phases: [
					{
						id: 'current',
						name: 'Current',
						tasks: [
							{ id: 'left', name: 'Left', run: 'work' },
							{ id: 'exhausted', name: 'Exhausted', run: 'work' },
							{ id: 'retryable', name: 'Retryable', run: 'work', retries: 1 },
							{ id: 'right', name: 'Right', run: 'work' },
						],
					},
					{
						id: 'later',
						name: 'Later',
						tasks: [{ id: 'later', name: 'Later', run: 'work' }],
					},
				],
			}
			const source = createWorkflow(definition, { functions: { work: () => null } })
			const exhausted = source.phase('current')?.task('exhausted')
			const retryable = source.phase('current')?.task('retryable')
			if (exhausted === undefined || retryable === undefined) {
				throw new Error('expected recovery policy tasks')
			}
			exhausted.start()
			retryable.start()

			const recovered = recoverWorkflow(source.snapshot(), {
				functions: { work: () => null },
			})
			expect(
				recovered
					.phase('current')
					?.tasks.tasks()
					.map((task) => task.status),
			).toEqual(expected)
			expect(recovered.phase('later')?.task('later')?.status).toBe(later)
		},
	)

	it('treats an existing strict-phase failure as the recovery halt boundary', () => {
		const source = createWorkflow(
			{
				id: 'established-halt',
				name: 'Established halt',
				bail: true,
				phases: [
					{
						id: 'current',
						name: 'Current',
						tasks: [
							{ id: 'failed', name: 'Failed', run: 'work' },
							{ id: 'interrupted', name: 'Interrupted', run: 'work', retries: 1 },
							{ id: 'pending', name: 'Pending', run: 'work' },
						],
					},
					{
						id: 'later',
						name: 'Later',
						tasks: [{ id: 'later', name: 'Later', run: 'work' }],
					},
				],
			},
			{ functions: { work: () => null } },
		)
		const failed = source.phase('current')?.task('failed')
		const interrupted = source.phase('current')?.task('interrupted')
		if (failed === undefined || interrupted === undefined) {
			throw new Error('expected strict recovery tasks')
		}
		interrupted.start()
		failed.start()
		failed.fail({ origin: 'handler', message: 'established' })

		const recovered = recoverWorkflow(source.snapshot(), {
			functions: { work: () => null },
		})
		expect(recovered.phase('current')?.task('failed')?.status).toBe('failed')
		expect(recovered.phase('current')?.task('failed')?.result?.result).toEqual({
			success: false,
			error: { origin: 'handler', message: 'established' },
		})
		expect(recovered.phase('current')?.task('interrupted')?.status).toBe('skipped')
		expect(recovered.phase('current')?.task('interrupted')?.attempts).toBe(1)
		expect(recovered.phase('current')?.task('pending')?.status).toBe('skipped')
		expect(recovered.phase('later')?.task('later')?.status).toBe('skipped')
	})

	it('keeps exact restore distinct from recovery and rejects the quiescent running tree', () => {
		const source = createWorkflow(DEFINITION, { functions: { work: () => null } })
		const interrupted = source.phase('phase')?.task('task')
		if (interrupted === undefined) throw new Error('expected task')
		interrupted.start()
		const restored = restoreWorkflow(source.snapshot(), {
			functions: { work: () => null },
		})

		expect(restored.phase('phase')?.task('task')?.status).toBe('running')
		const error = captureError(() => runner().execute(restored))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('TRANSITION')
	})

	it('keeps unresolved behavior inspectable but rejects its execution and hostile snapshots', () => {
		const snapshot = createWorkflow(DEFINITION, {
			functions: { work: () => null },
		}).snapshot()
		const restored = restoreWorkflow(snapshot)
		expect(restored.phase('phase')?.task('task')?.run).toBe('work')
		expect(() => runner().execute(restored)).toThrow(/not drivable/)

		const hostile = {
			get id(): string {
				throw new Error('accessor must not run')
			},
		}
		const error = captureError(() => restoreWorkflow(hostile))
		expect(isWorkflowError(error)).toBe(true)
		if (!isWorkflowError(error)) throw new Error('expected WorkflowError')
		expect(error.code).toBe('RESTORE')
		expect(error.message).toContain('not enumerable data')
	})

	it('treats separately restored objects with the same workflow id as separate local claims', async () => {
		const snapshot = createWorkflow(DEFINITION, {
			functions: { work: () => null },
		}).snapshot()
		let calls = 0
		const functions = {
			work: () => {
				calls += 1
				return null
			},
		}
		const first = restoreWorkflow(snapshot, { functions })
		const second = restoreWorkflow(snapshot, { functions })
		expect(first).not.toBe(second)

		const results = await Promise.all([runner().execute(first), runner().execute(second)])
		expect(results.map((result) => result.status)).toEqual(['completed', 'completed'])
		expect(calls).toBe(2)
	})
})

describe('runner durability', () => {
	it('reserves the writer before a synchronous store mutation and persists the latest state', async () => {
		const workflow = createWorkflow(DEFINITION, { functions: { work: () => null } })
		const task = workflow.phase('phase')?.task('task')
		if (task === undefined) throw new Error('expected persistence task')
		const snapshots: WorkflowSnapshot[] = []
		let active = 0
		let maximum = 0
		const store: WorkflowStoreInterface = {
			get: () => Promise.resolve(undefined),
			delete: () => Promise.resolve(),
			set: (snapshot) => {
				active += 1
				maximum = Math.max(maximum, active)
				snapshots.push(snapshot)
				if (snapshots.length === 1) task.start()
				return Promise.resolve().then(() => {
					active -= 1
				})
			},
		}
		const persistence = new WorkflowPersistence(workflow, store)

		await expect(persistence.checkpoint('initial')).resolves.toBe(true)
		await expect(persistence.finalize()).resolves.toBe(true)

		expect(maximum).toBe(1)
		expect(taskSnapshot(snapshots.at(-1) ?? workflow.snapshot()).status).toBe('running')
	})

	it('does not request persistence for runtime-only pause or resume events', async () => {
		let writes = 0
		const store: WorkflowStoreInterface = {
			get: () => Promise.resolve(undefined),
			delete: () => Promise.resolve(),
			set: () => {
				writes += 1
				return Promise.resolve()
			},
		}
		const workflow = createWorkflow(DEFINITION, { functions: { work: () => null } })
		const persistence = new WorkflowPersistence(workflow, store)
		const phase = workflow.phase('phase')
		const task = phase?.task('task')
		if (phase === undefined || task === undefined) throw new Error('expected pause fixtures')

		workflow.pause()
		workflow.resume()
		phase.pause()
		phase.resume()
		task.pause()
		task.resume()
		await Promise.resolve()

		expect(writes).toBe(0)
		await persistence.finalize()
		expect(writes).toBe(1)
	})

	it.each(['workflow', 'phase'])(
		'requests best-effort persistence when a %s is skipped before finalization',
		async (tier) => {
			const snapshots: WorkflowSnapshot[] = []
			const store: WorkflowStoreInterface = {
				get: () => Promise.resolve(undefined),
				delete: () => Promise.resolve(),
				set: (snapshot) => {
					snapshots.push(snapshot)
					return Promise.resolve()
				},
			}
			const workflow = createWorkflow(DEFINITION, { functions: { work: () => null } })
			const persistence = new WorkflowPersistence(workflow, store)

			if (tier === 'workflow') workflow.skip()
			else workflow.phase('phase')?.skip()
			await Promise.resolve()

			expect(
				snapshots.some((snapshot) =>
					tier === 'workflow'
						? snapshot.status === 'skipped'
						: snapshot.phases[0]?.status === 'skipped',
				),
			).toBe(true)
			await persistence.finalize()
		},
	)

	it('awaits a successful attempt checkpoint before invoking the handler', async () => {
		const entered = createGate<void>()
		const release = createGate<void>()
		let calls = 0
		let writes = 0
		const store: WorkflowStoreInterface = {
			get: () => Promise.resolve(undefined),
			delete: () => Promise.resolve(),
			set: async () => {
				writes += 1
				if (writes === 2) {
					entered.resolve()
					await release.promise
				}
			},
		}
		const running = runner().execute(DEFINITION, {
			store,
			functions: {
				work: () => {
					calls += 1
					return null
				},
			},
		})

		await entered.promise
		expect(calls).toBe(0)
		release.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(calls).toBe(1)
	})

	it.each([
		{ call: 1, checkpoint: 'initial', dispatched: false, status: 'stopped', durable: true },
		{ call: 3, checkpoint: 'attempt', dispatched: false, status: 'stopped', durable: true },
		{ call: 5, checkpoint: 'settlement', dispatched: true, status: 'completed', durable: true },
		{ call: 6, checkpoint: 'final', dispatched: true, status: 'completed', durable: false },
	])(
		'surfaces a required $checkpoint failure with final-state durability',
		async ({ call, checkpoint, dispatched, status, durable }) => {
			let calls = 0
			let handler = false
			const store: WorkflowStoreInterface = {
				get: () => Promise.resolve(undefined),
				delete: () => Promise.resolve(),
				set: () => {
					calls += 1
					return calls === call
						? Promise.reject(new Error(`${checkpoint} unavailable`))
						: Promise.resolve()
				},
			}
			const result = await runner().execute(DEFINITION, {
				store,
				functions: {
					work: () => {
						handler = true
						return null
					},
				},
			})

			expect(handler).toBe(dispatched)
			expect(result.status).toBe(status)
			expect(result.durable).toBe(durable)
			expect(result.fault).toMatchObject({
				origin: 'persistence',
				checkpoint,
				message: `${checkpoint} unavailable`,
			})
			expect(taskSnapshot(result.workflow.snapshot()).status === 'completed').toBe(dispatched)
		},
	)

	it('does not retain a repaired best-effort activity write as a required fault', async () => {
		let writes = 0
		const failed = createGate<void>()
		const store: WorkflowStoreInterface = {
			get: () => Promise.resolve(undefined),
			delete: () => Promise.resolve(),
			set: () => {
				writes += 1
				if (writes === 4) {
					failed.resolve()
					return Promise.reject(new Error('activity unavailable'))
				}
				return Promise.resolve()
			},
		}
		const result = await runner().execute(DEFINITION, {
			store,
			functions: {
				work: async (controller) => {
					controller.report({ note: 'first' })
					await failed.promise
					await Promise.resolve()
					controller.report({ note: 'repaired' })
					return null
				},
			},
		})

		expect(result.status).toBe('completed')
		expect(result.durable).toBe(true)
		expect(result.fault).toBeUndefined()
		expect(taskSnapshot(result.workflow.snapshot()).activity?.note).toBe('repaired')
	})

	it('emits terminal state before settlement storage and awaits final durability', async () => {
		const entered = createGate<void>()
		const release = createGate<void>()
		let writes = 0
		let settled = false
		const store: WorkflowStoreInterface = {
			get: () => Promise.resolve(undefined),
			delete: () => Promise.resolve(),
			set: async () => {
				writes += 1
				if (writes === 5) {
					entered.resolve()
					await release.promise
				}
			},
		}
		const workflow = createWorkflow(DEFINITION, {
			functions: { work: () => null },
		})
		const completed = createGate<void>()
		workflow
			.phase('phase')
			?.task('task')
			?.emitter.on('complete', () => completed.resolve())
		const running = runner().execute(workflow, { store })
		void running.then(() => {
			settled = true
		})

		await completed.promise
		await entered.promise
		expect(settled).toBe(false)
		release.resolve()
		const result = await running
		expect(result.durable).toBe(true)
		expect(settled).toBe(true)
	})

	it('persists initial, attempt, settlement, and final states without concurrent writes', async () => {
		const release = createGate<void>()
		const activity = createGate<void>()
		const snapshots: WorkflowSnapshot[] = []
		let active = 0
		let maximum = 0
		const store: WorkflowStoreInterface = {
			get: () => Promise.resolve(undefined),
			delete: () => Promise.resolve(),
			set: async (snapshot) => {
				active += 1
				maximum = Math.max(maximum, active)
				snapshots.push(snapshot)
				if (snapshots.length === 2) {
					activity.resolve()
					await release.promise
				}
				active -= 1
			},
		}
		const run = runner().execute(DEFINITION, {
			store,
			functions: {
				work: (controller) => {
					controller.report({ note: 'one' })
					controller.report({ note: 'two' })
					controller.pulse()
					return 'done'
				},
			},
		})
		await activity.promise
		release.resolve()
		const result = await run

		expect(result.durable).toBe(true)
		expect(result.fault).toBeUndefined()
		expect(maximum).toBe(1)
		expect(taskSnapshot(snapshots[0] ?? result.workflow.snapshot()).attempts).toBe(0)
		expect(snapshots.some((snapshot) => taskSnapshot(snapshot).status === 'running')).toBe(true)
		expect(taskSnapshot(snapshots.at(-1) ?? result.workflow.snapshot()).status).toBe('completed')
	})

	it('coalesces rapid activity with one writer, persists the latest frame, and detaches after final', async () => {
		const entered = createGate<void>()
		const release = createGate<void>()
		const snapshots: WorkflowSnapshot[] = []
		let active = 0
		let maximum = 0
		const store: WorkflowStoreInterface = {
			get: () => Promise.resolve(undefined),
			delete: () => Promise.resolve(),
			set: async (snapshot) => {
				active += 1
				maximum = Math.max(maximum, active)
				snapshots.push(snapshot)
				if (snapshots.length === 4) {
					entered.resolve()
					await release.promise
				}
				active -= 1
			},
		}
		const workflow = createWorkflow(DEFINITION, {
			functions: {
				work: (controller) => {
					controller.report({ note: 'first' })
					controller.report({ note: 'latest' })
					controller.pulse()
					return null
				},
			},
		})
		const running = runner().execute(workflow, { store })
		await entered.promise
		release.resolve()
		const result = await running

		expect(maximum).toBe(1)
		expect(snapshots.length).toBeLessThanOrEqual(7)
		expect(taskSnapshot(snapshots.at(-1) ?? workflow.snapshot()).activity?.note).toBe('latest')
		const writes = snapshots.length
		const task = workflow.phase('phase')?.task('task')
		if (task?.activity === undefined) throw new Error('expected final activity')
		task.emitter.emit('pulse', task.activity)
		await Promise.resolve()
		await Promise.resolve()
		expect(snapshots).toHaveLength(writes)
		expect(result.durable).toBe(true)
	})

	it('surfaces an initial persistence failure as result data before dispatch', async () => {
		let dispatched = false
		const store: WorkflowStoreInterface = {
			get: () => Promise.resolve(undefined),
			delete: () => Promise.resolve(),
			set: () => Promise.reject(new Error('disk unavailable')),
		}
		const result = await runner().execute(DEFINITION, {
			store,
			functions: {
				work: () => {
					dispatched = true
					return null
				},
			},
		})

		expect(dispatched).toBe(false)
		expect(result.status).toBe('stopped')
		expect(result.durable).toBe(false)
		expect(result.fault).toEqual({
			origin: 'persistence',
			checkpoint: 'initial',
			message: 'disk unavailable',
		})
	})
})
