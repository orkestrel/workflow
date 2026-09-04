import type { WorkflowDefinition } from '@src/core'
import { literalShape } from '@orkestrel/contract'
import {
	createWorkflowContract,
	MAX_TIMER_MS,
	phaseShape,
	taskShape,
	workflowShape,
} from '@src/core'
import { describe, expect, it } from 'vitest'

// The workflow contract shape VALUES are well-formed `ContractShape` descriptors
// that mirror the hand-written definition interfaces (types.ts). Structural checks
// on the descriptors — the four-way-parity behavior is covered in factories.test.ts.

describe('taskShape', () => {
	it('requires id / name and makes description / behavior optional', () => {
		expect(taskShape.category).toBe('object')
		expect(taskShape.properties.id).toMatchObject({ category: 'string', min: 1 })
		expect(taskShape.properties.name).toMatchObject({ category: 'string', min: 1 })
		expect(taskShape.properties.description.category).toBe('optional')
		const behavior = taskShape.properties.behavior
		expect(behavior.category).toBe('optional')
		expect(behavior.category === 'optional' && behavior.inner).toMatchObject({
			category: 'string',
			min: 1,
		})
	})

	it('carries optional non-negative-integer retries / timeout reliability settings', () => {
		const keys: ReadonlyArray<'retries' | 'timeout'> = ['retries', 'timeout']
		for (const key of keys) {
			const field = taskShape.properties[key]
			expect(field.category).toBe('optional')
			expect(field.category === 'optional' && field.inner).toMatchObject({
				category: 'number',
				integer: true,
				min: 0,
			})
		}
		const timeout = taskShape.properties.timeout
		expect(timeout.category === 'optional' && timeout.inner).toMatchObject({ max: MAX_TIMER_MS })
	})
})

describe('phaseShape', () => {
	it('holds an array of tasks and an optional positive-integer concurrency', () => {
		expect(phaseShape.properties.tasks).toMatchObject({ category: 'array' })
		expect(
			phaseShape.properties.tasks.category === 'array' && phaseShape.properties.tasks.items,
		).toBe(taskShape)
		const concurrency = phaseShape.properties.concurrency
		expect(concurrency.category).toBe('optional')
		expect(concurrency.category === 'optional' && concurrency.inner).toMatchObject({
			category: 'number',
			integer: true,
			min: 1,
		})
	})

	it('carries an optional boolean-literal bail (the per-phase failure-policy override)', () => {
		const bail = phaseShape.properties.bail
		expect(bail.category).toBe('optional')
		expect(bail.category === 'optional' && bail.inner).toMatchObject({
			category: 'literal',
			values: [true, false],
		})
	})
})

describe('workflowShape', () => {
	it('holds an array of phases and an optional boolean-literal bail', () => {
		expect(workflowShape.properties.phases).toMatchObject({ category: 'array' })
		expect(
			workflowShape.properties.phases.category === 'array' && workflowShape.properties.phases.items,
		).toBe(phaseShape)
		const bail = workflowShape.properties.bail
		expect(bail.category).toBe('optional')
		expect(bail.category === 'optional' && bail.inner).toMatchObject({
			category: 'literal',
			values: [true, false],
		})
	})
})

describe('literalShape — a literal shape carrying a description', () => {
	it('attaches the description while preserving the literal values', () => {
		const shape = literalShape(['function', 'tool', 'agent'], { description: 'how to run' })
		expect(shape.category).toBe('literal')
		expect(shape.values).toEqual(['function', 'tool', 'agent'])
		expect(shape.description).toBe('how to run')
	})
})

// Rank 1 — per-field descriptions ride INSIDE the shapes (and thus the emitted JSON Schema).
describe('per-field descriptions (Rank 1)', () => {
	it('the strict shapes describe their key identity + structural fields', () => {
		expect(
			typeof (
				workflowShape.properties.id.category === 'string' && workflowShape.properties.id.description
			),
		).toBe('string')
		expect(
			typeof (
				workflowShape.properties.phases.category === 'array' &&
				workflowShape.properties.phases.description
			),
		).toBe('string')
		const bail = workflowShape.properties.bail
		expect(
			typeof (
				bail.category === 'optional' &&
				bail.inner.category === 'literal' &&
				bail.inner.description
			),
		).toBe('string')
	})

	it('the behavior field describes itself (a registry key, not a label)', () => {
		const behavior = taskShape.properties.behavior
		expect(
			typeof (
				behavior.category === 'optional' &&
				behavior.inner.category === 'string' &&
				behavior.inner.description
			),
		).toBe('string')
	})
})

// The compiled contract behavior for the new fields (the shapes flow into one guard / parser /
// schema / generator at the single regen point) — accept a phase `bail` + task `retries` / `timeout`,
// and reject a NEGATIVE retries/timeout (the `min: 0` refinement). Real contract, no mocks.
describe('the added optional fields flow through the compiled contract', () => {
	const contract = createWorkflowContract()
	const withFields = (overrides: {
		readonly bail?: boolean
		readonly retries?: number
		readonly timeout?: number
	}): WorkflowDefinition => ({
		id: 'w',
		name: 'W',
		phases: [
			{
				id: 'p',
				name: 'P',
				...(overrides.bail === undefined ? {} : { bail: overrides.bail }),
				tasks: [
					{
						id: 't',
						name: 'T',
						behavior: 'f',
						...(overrides.retries === undefined ? {} : { retries: overrides.retries }),
						...(overrides.timeout === undefined ? {} : { timeout: overrides.timeout }),
					},
				],
			},
		],
	})

	it('accepts a per-phase bail + per-task retries / timeout (and parses unchanged)', () => {
		const definition = withFields({ bail: true, retries: 2, timeout: 5000 })
		expect(contract.is(definition)).toBe(true)
		expect(contract.parse(definition)).toEqual(definition)
	})

	it('accepts retries / timeout of 0 (the min:0 boundary is inclusive)', () => {
		const definition = withFields({ retries: 0, timeout: 0 })
		expect(contract.is(definition)).toBe(true)
	})

	it('rejects a NEGATIVE retries (the min:0 refinement)', () => {
		const definition = withFields({ retries: -1 })
		expect(contract.is(definition)).toBe(false)
		expect(contract.parse(definition)).toBeUndefined()
	})

	it('rejects a NEGATIVE timeout (the min:0 refinement)', () => {
		const definition = withFields({ timeout: -1 })
		expect(contract.is(definition)).toBe(false)
		expect(contract.parse(definition)).toBeUndefined()
	})

	it('accepts BOTH bail literals on a phase', () => {
		expect(contract.is(withFields({ bail: true }))).toBe(true)
		expect(contract.is(withFields({ bail: false }))).toBe(true)
	})

	it('accepts an omitted run (no handler), and rejects an empty-string run', () => {
		const noBehavior: WorkflowDefinition = {
			id: 'w',
			name: 'W',
			phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T' }] }],
		}
		expect(contract.is(noBehavior)).toBe(true)
		const emptyBehavior: WorkflowDefinition = {
			id: 'w',
			name: 'W',
			phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', behavior: '' }] }],
		}
		expect(contract.is(emptyBehavior)).toBe(false)
	})

	it('rejects the old object-form behavior ({ via, name }) — behavior is a plain string', () => {
		const oldForm = {
			id: 'w',
			name: 'W',
			phases: [
				{
					id: 'p',
					name: 'P',
					tasks: [{ id: 't', name: 'T', behavior: { via: 'function', name: 'f' } }],
				},
			],
		}
		expect(contract.is(oldForm)).toBe(false)
	})
})
