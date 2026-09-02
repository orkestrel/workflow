import type { TaskResult } from '@src/core'
import { createWorkflow } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	buildWorkflowDefinition,
	createTaskControllerFixture,
	requireTask,
} from '../../../setup.js'

describe('TaskController — surface', () => {
	it('exposes folded cancellation, input, lineage, and live results', () => {
		const abort = new AbortController()
		const task = requireTask(
			createWorkflow(buildWorkflowDefinition()),
			'phase-build',
			'task-compile',
		)
		const tree: TaskResult[] = []
		const handle = createTaskControllerFixture(task, abort.signal, () => tree)
		expect(handle.signal).toBe(abort.signal)
		expect(handle.task).toBe(task.context)
		expect(handle.aborted).toBe(false)
		expect(handle.results()).toEqual([])
		task.start()
		task.complete('done')
		if (task.result === undefined) throw new Error('expected settled result')
		tree.push(task.result)
		expect(handle.results()).toEqual([task.result])
		abort.abort()
		expect(handle.aborted).toBe(true)
	})

	it('folds workflow, phase, and task cooperative gates and cancellation', async () => {
		const task = requireTask(
			createWorkflow(buildWorkflowDefinition()),
			'phase-build',
			'task-compile',
		)
		const abort = new AbortController()
		const handle = createTaskControllerFixture(task, abort.signal, () => [])
		task.workflow.pause()
		task.phase.pause()
		task.pause()
		expect(handle.paused).toBe(true)
		const waiting = handle.wait()
		task.workflow.resume()
		task.phase.resume()
		task.resume()
		await waiting
		expect(handle.paused).toBe(false)

		task.pause()
		const cancelled = handle.wait()
		abort.abort()
		await cancelled
		expect(handle.paused).toBe(true)
	})

	it('leaves a descendant gate when an ancestor stops without aborting the attempt', async () => {
		const task = requireTask(
			createWorkflow(buildWorkflowDefinition()),
			'phase-build',
			'task-compile',
		)
		const abort = new AbortController()
		const handle = createTaskControllerFixture(task, abort.signal, () => [])
		task.start()
		task.pause()
		expect(handle.paused).toBe(true)
		const waiting = handle.wait()
		task.workflow.stop()
		await waiting
		expect(handle.paused).toBe(false)
		expect(handle.aborted).toBe(false)
		expect(task.status).toBe('running')
	})

	it('delegates report and pulse through the attempt-scoped closures', () => {
		const task = requireTask(
			createWorkflow(buildWorkflowDefinition()),
			'phase-build',
			'task-compile',
		)
		const handle = createTaskControllerFixture(task, new AbortController().signal, () => [])
		expect(handle.report({}).success).toBe(false)
		expect(handle.pulse()).toBe(false)
		task.start()
		expect(handle.report({ note: 'working' }).success).toBe(true)
		expect(handle.pulse()).toBe(true)
	})

	it('retains the explicit claimed attempt after the live task advances', () => {
		const task = requireTask(
			createWorkflow({
				...buildWorkflowDefinition(),
				phases: [
					{
						id: 'phase-build',
						name: 'Build',
						tasks: [
							{
								id: 'task-compile',
								name: 'Compile',
								behavior: 'compile',
								retries: 1,
							},
						],
					},
				],
			}),
			'phase-build',
			'task-compile',
		)
		task.start()
		const handle = createTaskControllerFixture(task, new AbortController().signal, () => [])
		expect(handle.attempt).toBe(1)
		task.start()
		expect(task.attempts).toBe(2)
		expect(handle.attempt).toBe(1)
	})
})
