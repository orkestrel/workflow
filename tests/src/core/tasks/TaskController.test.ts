import type { TaskContext, TaskResult } from '@src/core'
import { TaskController } from '@src/core'
import { describe, expect, it } from 'vitest'

// The lean per-task handle the WorkflowRunner hands a WorkflowFunction — its folded `signal`
// / `aborted`, its `input` bag, its lineage `task`, and the read-UP `results()` closure. A
// thin wrapper, so the unit tests pin its surface directly; its INTEGRATION (the runner
// driving real tasks around it) is covered in WorkflowRunner.test.ts. Real values, no mocks.

/** A minimal {@link TaskContext} for a leaf at `task` under `phase` / `workflow`. */
function taskContext(id: string): TaskContext {
	const workflow = { id: 'wf', name: 'WF' }
	return { id, name: id, phase: { id: 'p', name: 'P', workflow } }
}

describe('TaskController — surface', () => {
	it('exposes the folded signal, input, lineage, and aborted = signal.aborted', () => {
		const controller = new AbortController()
		const input = { retries: 3 }
		const context = taskContext('t0')
		const handle = new TaskController(controller.signal, input, context, () => [])
		expect(handle.signal).toBe(controller.signal)
		expect(handle.input).toBe(input)
		expect(handle.task).toBe(context)
		expect(handle.task.phase.workflow.id).toBe('wf')
		expect(handle.aborted).toBe(false)
	})

	it('aborted flips to true once the signal fires', () => {
		const controller = new AbortController()
		const handle = new TaskController(controller.signal, {}, taskContext('t0'), () => [])
		expect(handle.aborted).toBe(false)
		controller.abort()
		expect(handle.aborted).toBe(true)
	})

	it('results() delegates to the injected closure (the live result tree, read on demand)', () => {
		const tree: TaskResult[] = []
		const handle = new TaskController(
			new AbortController().signal,
			{},
			taskContext('t0'),
			() => tree,
		)
		expect(handle.results()).toEqual([])
		// The closure reads the live array — a result appended later is visible on the next read.
		const result: TaskResult = {
			task: taskContext('done'),
			phase: taskContext('done').phase,
			workflow: taskContext('done').phase.workflow,
			status: 'completed',
			result: { success: true, value: 1 },
			timestamp: 0,
		}
		tree.push(result)
		expect(handle.results()).toHaveLength(1)
		expect(handle.results()[0]?.task.id).toBe('done')
	})

	it('a born-aborted signal makes the handle report aborted immediately', () => {
		const handle = new TaskController(AbortSignal.abort(), {}, taskContext('t0'), () => [])
		expect(handle.aborted).toBe(true)
	})
})
