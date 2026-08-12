import type { WorkflowDefinition, WorkflowSnapshot, WorkflowStoreInterface } from '@src/core'
import { createWorkflow, createWorkflowRunner, WorkflowPersistence } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createGate, createRecordingScheduler } from '../../setup.js'

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
