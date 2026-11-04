import {
	MAX_TIMER_MS,
	phaseContract,
	phaseUpdateContract,
	taskDefinitionContract,
	taskUpdateContract,
	workflowContract,
} from '@src/core'
import { describe, expect, it } from 'vitest'

// The compiled contracts each door reads, compared to authored values rather than to their shapes.

describe('the compiled workflow contracts', () => {
	it('workflowContract accepts a definition and reports an undeclared key', () => {
		expect(workflowContract.is({ id: 'release', name: 'Release', phases: [] })).toBe(true)
		expect(
			workflowContract.audit({ id: 'release', name: 'Release', phases: [], bails: true }),
		).toEqual([{ reason: 'extra', path: ['bails'] }])
	})

	it('freezes what a shared contract exposes, so no caller can change what a door reads', () => {
		expect(Object.isFrozen(workflowContract)).toBe(true)
		expect(Object.isFrozen(workflowContract.schema)).toBe(true)
	})

	it('phaseContract bounds concurrency at the positive safe integers', () => {
		const phase = { id: 'build', name: 'Build', tasks: [] }

		expect(phaseContract.is({ ...phase, concurrency: 1 })).toBe(true)
		expect(phaseContract.is({ ...phase, concurrency: Number.MAX_SAFE_INTEGER })).toBe(true)
		expect(phaseContract.is({ ...phase, concurrency: 0 })).toBe(false)
		expect(phaseContract.is({ ...phase, concurrency: Number.MAX_SAFE_INTEGER + 1 })).toBe(false)
	})

	it('taskDefinitionContract bounds timeout from 1 through MAX_TIMER_MS', () => {
		const task = { id: 'compile', name: 'Compile' }

		expect(taskDefinitionContract.is({ ...task, timeout: 1 })).toBe(true)
		expect(taskDefinitionContract.is({ ...task, timeout: MAX_TIMER_MS })).toBe(true)
		expect(taskDefinitionContract.is({ ...task, timeout: 0 })).toBe(false)
		expect(taskDefinitionContract.is({ ...task, timeout: MAX_TIMER_MS + 1 })).toBe(false)
	})

	it('taskUpdateContract refuses an empty name and an undeclared key', () => {
		expect(taskUpdateContract.is({ name: 'Compile again' })).toBe(true)
		expect(taskUpdateContract.is({ name: '' })).toBe(false)
		expect(taskUpdateContract.is({ timeout: 5 })).toBe(false)
	})

	it('phaseUpdateContract bounds concurrency as the definition does', () => {
		expect(phaseUpdateContract.is({ concurrency: 4 })).toBe(true)
		expect(phaseUpdateContract.is({ concurrency: 0 })).toBe(false)
		expect(phaseUpdateContract.is({ tasks: [] })).toBe(false)
	})
})
