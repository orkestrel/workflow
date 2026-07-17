import type { WorkflowDefinition } from '@src/core'
import { literalShape } from '@orkestrel/contract'
import { createWorkflowContract, phaseShape, taskShape, workflowShape } from '@src/core'
import { describe, expect, it } from 'vitest'

// The workflow contract shape VALUES are well-formed `ContractShape` descriptors
// that mirror the hand-written definition interfaces (types.ts). Structural checks
// on the descriptors — the four-way-parity behavior is covered in factories.test.ts.

describe('taskShape', () => {
	it('requires id / name and makes description / run optional', () => {
		expect(taskShape.type).toBe('object')
		expect(taskShape.properties.id).toMatchObject({ type: 'string', min: 1 })
		expect(taskShape.properties.name).toMatchObject({ type: 'string', min: 1 })
		expect(taskShape.properties.description.type).toBe('optional')
		const run = taskShape.properties.run
		expect(run.type).toBe('optional')
		expect(run.type === 'optional' && run.inner).toMatchObject({ type: 'string', min: 1 })
	})

	it('carries optional non-negative-integer retries / timeout (the per-task reliability overrides)', () => {
		for (const key of ['retries', 'timeout'] as const) {
			const field = taskShape.properties[key]
			expect(field.type).toBe('optional')
			expect(field.type === 'optional' && field.inner).toMatchObject({
				type: 'number',
				integer: true,
				min: 0,
			})
		}
	})
})

describe('phaseShape', () => {
	it('holds an array of tasks and an optional positive-integer concurrency', () => {
		expect(phaseShape.properties.tasks).toMatchObject({ type: 'array' })
		expect(phaseShape.properties.tasks.type === 'array' && phaseShape.properties.tasks.items).toBe(
			taskShape,
		)
		const concurrency = phaseShape.properties.concurrency
		expect(concurrency.type).toBe('optional')
		expect(concurrency.type === 'optional' && concurrency.inner).toMatchObject({
			type: 'number',
			integer: true,
			min: 1,
		})
	})

	it('carries an optional boolean-literal bail (the per-phase failure-policy override)', () => {
		const bail = phaseShape.properties.bail
		expect(bail.type).toBe('optional')
		expect(bail.type === 'optional' && bail.inner).toMatchObject({
			type: 'literal',
			values: [true, false],
		})
	})
})

describe('workflowShape', () => {
	it('holds an array of phases and an optional boolean-literal bail', () => {
		expect(workflowShape.properties.phases).toMatchObject({ type: 'array' })
		expect(
			workflowShape.properties.phases.type === 'array' && workflowShape.properties.phases.items,
		).toBe(phaseShape)
		const bail = workflowShape.properties.bail
		expect(bail.type).toBe('optional')
		expect(bail.type === 'optional' && bail.inner).toMatchObject({
			type: 'literal',
			values: [true, false],
		})
	})
})

describe('literalShape — a literal shape carrying a description', () => {
	it('attaches the description while preserving the literal values', () => {
		const shape = literalShape(['function', 'tool', 'agent'], { description: 'how to run' })
		expect(shape.type).toBe('literal')
		expect(shape.values).toEqual(['function', 'tool', 'agent'])
		expect(shape.description).toBe('how to run')
	})
})

// Rank 1 — per-field descriptions ride INSIDE the shapes (and thus the emitted JSON Schema).
describe('per-field descriptions (Rank 1)', () => {
	it('the strict shapes describe their key identity + structural fields', () => {
		expect(
			typeof (
				workflowShape.properties.id.type === 'string' && workflowShape.properties.id.description
			),
		).toBe('string')
		expect(
			typeof (
				workflowShape.properties.phases.type === 'array' &&
				workflowShape.properties.phases.description
			),
		).toBe('string')
		const bail = workflowShape.properties.bail
		expect(
			typeof (bail.type === 'optional' && bail.inner.type === 'literal' && bail.inner.description),
		).toBe('string')
	})

	it('the run field describes itself (a registry key, not a label)', () => {
		const run = taskShape.properties.run
		expect(
			typeof (run.type === 'optional' && run.inner.type === 'string' && run.inner.description),
		).toBe('string')
	})
})

// The compiled contract behavior for the new fields (the shapes flow into one guard / parser /
// schema / generator at the single regen point) — accept a phase `bail` + task `retries` / `timeout`,
// and reject a NEGATIVE retries/timeout (the `min: 0` refinement). Real contract, no mocks (§16).
describe('the new optional fields flow through the compiled contract', () => {
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
						run: 'f',
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
		const noRun: WorkflowDefinition = {
			id: 'w',
			name: 'W',
			phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T' }] }],
		}
		expect(contract.is(noRun)).toBe(true)
		const emptyRun: WorkflowDefinition = {
			id: 'w',
			name: 'W',
			phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', run: '' }] }],
		}
		expect(contract.is(emptyRun)).toBe(false)
	})

	it('rejects the old object-form run ({ via, name }) — run is now a plain string', () => {
		const oldForm = {
			id: 'w',
			name: 'W',
			phases: [
				{
					id: 'p',
					name: 'P',
					tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'f' } }],
				},
			],
		}
		expect(contract.is(oldForm)).toBe(false)
	})
})
