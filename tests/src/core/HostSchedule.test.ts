import { createHostSchedule, HostSchedule } from '@src/core'
import { describe, expect, it } from 'vitest'
import { WorkflowObservation } from '../../setup.js'

describe('HostSchedule', () => {
	it('names createHostSchedule when refusing an invalid signal before host work', async () => {
		const starts = new WorkflowObservation(0)
		const pending: unknown = Reflect.apply(createHostSchedule, undefined, [
			() => {
				starts.value += 1
				return () => undefined
			},
			{},
		])
		if (!(pending instanceof Promise)) throw new Error('expected rejected scheduling promise')
		await expect(pending).rejects.toMatchObject({
			code: 'SCHEDULE',
			message: 'createHostSchedule signal must be an AbortSignal',
			context: { signal: 'object' },
		})
		expect(starts.value).toBe(0)
	})

	it('owns synchronous completion and its returned cancellation closure', async () => {
		const cancellations = new WorkflowObservation(0)
		const operation = new HostSchedule((complete) => {
			complete()
			return () => {
				cancellations.value += 1
			}
		})
		await expect(operation.promise).resolves.toBeUndefined()
		expect(cancellations.value).toBe(1)
	})
})
