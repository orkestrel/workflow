import { PERSISTENCE_FAILURE_CASES, PERSISTENCE_TIER_CASES } from '../../setup.js'
import type { WorkflowSnapshot } from '@src/core'
import { createWorkflow, WorkflowPersistence } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	buildWorkflowStore,
	createDurabilityRunner,
	DEFINITION,
	readDurabilityTask,
	WorkflowObservation,
} from '../../setup.js'

describe('runner durability', () => {
	it('reserves the writer before a synchronous store mutation and persists the most recent state', async () => {
		const workflow = createWorkflow(DEFINITION, { functions: { work: () => null } })
		const task = workflow.phase('phase')?.task('task')
		if (task === undefined) throw new Error('expected persistence task')
		const snapshots: WorkflowSnapshot[] = []
		const active = new WorkflowObservation(0)
		const maximum = new WorkflowObservation(0)
		const store = buildWorkflowStore({
			set: (snapshot) => {
				active.value += 1
				maximum.value = Math.max(maximum.value, active.value)
				snapshots.push(snapshot)
				if (snapshots.length === 1) task.start()
				return Promise.resolve().then(() => {
					active.value -= 1
				})
			},
		})
		const persistence = new WorkflowPersistence(workflow, store)

		await expect(persistence.checkpoint('initial')).resolves.toBe(true)
		await expect(persistence.finalize()).resolves.toBe(true)

		expect(maximum.value).toBe(1)
		expect(readDurabilityTask(snapshots.at(-1) ?? workflow.snapshot()).status).toBe('running')
	})

	it('does not request persistence for runtime-only pause or resume events', async () => {
		const writes = new WorkflowObservation(0)
		const store = buildWorkflowStore({
			set: () => {
				writes.value += 1
				return Promise.resolve()
			},
		})
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

		expect(writes.value).toBe(0)
		await persistence.finalize()
		expect(writes.value).toBe(1)
	})

	it.each(PERSISTENCE_TIER_CASES)(
		'requests best-effort persistence when a %s is skipped before finalization',
		async (tier) => {
			const snapshots: WorkflowSnapshot[] = []
			const store = buildWorkflowStore({
				set: (snapshot) => {
					snapshots.push(snapshot)
					return Promise.resolve()
				},
			})
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
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const calls = new WorkflowObservation(0)
		const writes = new WorkflowObservation(0)
		const store = buildWorkflowStore({
			set: async () => {
				writes.value += 1
				if (writes.value === 2) {
					entered.resolve()
					await release.promise
				}
			},
		})
		const running = createDurabilityRunner().execute(DEFINITION, {
			store,
			functions: {
				work: () => {
					calls.value += 1
					return null
				},
			},
		})

		await entered.promise
		expect(calls.value).toBe(0)
		release.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(calls.value).toBe(1)
	})

	it.each(PERSISTENCE_FAILURE_CASES)(
		'surfaces a required $checkpoint failure with final-state durability',
		async ({ call, checkpoint, dispatched, status, durable }) => {
			const calls = new WorkflowObservation(0)
			const handler = new WorkflowObservation(false)
			const store = buildWorkflowStore({
				set: () => {
					calls.value += 1
					return calls.value === call
						? Promise.reject(new Error(`${checkpoint} unavailable`))
						: Promise.resolve()
				},
			})
			const result = await createDurabilityRunner().execute(DEFINITION, {
				store,
				functions: {
					work: () => {
						handler.value = true
						return null
					},
				},
			})

			expect(handler.value).toBe(dispatched)
			expect(result.status).toBe(status)
			expect(result.durable).toBe(durable)
			expect(result.fault).toMatchObject({
				checkpoint,
				message: `${checkpoint} unavailable`,
			})
			expect(readDurabilityTask(result.workflow.snapshot()).status === 'completed').toBe(dispatched)
		},
	)

	it('does not retain a repaired best-effort activity write as a required fault', async () => {
		const writes = new WorkflowObservation(0)
		const failed = Promise.withResolvers<void>()
		const store = buildWorkflowStore({
			set: () => {
				writes.value += 1
				if (writes.value === 4) {
					failed.resolve()
					return Promise.reject(new Error('activity unavailable'))
				}
				return Promise.resolve()
			},
		})
		const result = await createDurabilityRunner().execute(DEFINITION, {
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
		expect(readDurabilityTask(result.workflow.snapshot()).activity?.note).toBe('repaired')
	})

	it('emits terminal state before settlement storage and awaits final durability', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const writes = new WorkflowObservation(0)
		const settled = new WorkflowObservation(false)
		const store = buildWorkflowStore({
			set: async () => {
				writes.value += 1
				if (writes.value === 5) {
					entered.resolve()
					await release.promise
				}
			},
		})
		const workflow = createWorkflow(DEFINITION, {
			functions: { work: () => null },
		})
		const completed = Promise.withResolvers<void>()
		workflow
			.phase('phase')
			?.task('task')
			?.emitter.on('complete', () => completed.resolve())
		const running = createDurabilityRunner().execute(workflow, { store })
		void running.then(() => {
			settled.value = true
		})

		await completed.promise
		await entered.promise
		expect(settled.value).toBe(false)
		release.resolve()
		const result = await running
		expect(result.durable).toBe(true)
		expect(settled.value).toBe(true)
	})

	it('persists initial, attempt, settlement, and final states without concurrent writes', async () => {
		const release = Promise.withResolvers<void>()
		const activity = Promise.withResolvers<void>()
		const snapshots: WorkflowSnapshot[] = []
		const active = new WorkflowObservation(0)
		const maximum = new WorkflowObservation(0)
		const store = buildWorkflowStore({
			set: async (snapshot) => {
				active.value += 1
				maximum.value = Math.max(maximum.value, active.value)
				snapshots.push(snapshot)
				if (snapshots.length === 2) {
					activity.resolve()
					await release.promise
				}
				active.value -= 1
			},
		})
		const run = createDurabilityRunner().execute(DEFINITION, {
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
		expect(maximum.value).toBe(1)
		expect(readDurabilityTask(snapshots[0] ?? result.workflow.snapshot()).attempts).toBe(0)
		expect(snapshots.some((snapshot) => readDurabilityTask(snapshot).status === 'running')).toBe(
			true,
		)
		expect(readDurabilityTask(snapshots.at(-1) ?? result.workflow.snapshot()).status).toBe(
			'completed',
		)
	})

	it('coalesces rapid activity with one writer, persists the most recent frame, and detaches after final', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const snapshots: WorkflowSnapshot[] = []
		const active = new WorkflowObservation(0)
		const maximum = new WorkflowObservation(0)
		const store = buildWorkflowStore({
			set: async (snapshot) => {
				active.value += 1
				maximum.value = Math.max(maximum.value, active.value)
				snapshots.push(snapshot)
				if (snapshots.length === 4) {
					entered.resolve()
					await release.promise
				}
				active.value -= 1
			},
		})
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
		const running = createDurabilityRunner().execute(workflow, { store })
		await entered.promise
		release.resolve()
		const result = await running

		expect(maximum.value).toBe(1)
		expect(snapshots.length).toBeLessThanOrEqual(7)
		expect(readDurabilityTask(snapshots.at(-1) ?? workflow.snapshot()).activity?.note).toBe(
			'latest',
		)
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
		const dispatched = new WorkflowObservation(false)
		const store = buildWorkflowStore({
			set: () => Promise.reject(new Error('disk unavailable')),
		})
		const result = await createDurabilityRunner().execute(DEFINITION, {
			store,
			functions: {
				work: () => {
					dispatched.value = true
					return null
				},
			},
		})

		expect(dispatched.value).toBe(false)
		expect(result.status).toBe('stopped')
		expect(result.durable).toBe(false)
		expect(result.fault).toEqual({
			checkpoint: 'initial',
			message: 'disk unavailable',
		})
	})
})
