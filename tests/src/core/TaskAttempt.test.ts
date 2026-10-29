import { TaskAttempt } from '@src/core'
import { describe, expect, it } from 'vitest'

describe('TaskAttempt', () => {
	it('captures each invocation outcome independently', () => {
		const first = new TaskAttempt()
		const second = new TaskAttempt()
		expect(first.outcome).toBeUndefined()
		first.resolve([true, 'result'])
		expect(first.outcome).toEqual([true, 'result'])
		expect(second.outcome).toBeUndefined()
		second.resolve([false, undefined, false])
		expect(second.outcome).toEqual([false, undefined, false])
		expect(first.outcome).toEqual([true, 'result'])
	})
})
