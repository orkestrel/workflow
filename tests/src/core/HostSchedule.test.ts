import { HostSchedule } from '@src/core'
import { describe, expect, it } from 'vitest'
import { WorkflowObservation } from '../../setup.js'

describe('HostSchedule', () => {
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
