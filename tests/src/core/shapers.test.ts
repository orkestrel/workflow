import type { WorkflowDefinition } from '@src/core'
import { literalShape } from '@orkestrel/contract'
import {
	createWorkflowContract,
	phaseDraftShape,
	phaseShape,
	stepShape,
	taskDraftShape,
	taskFormShape,
	taskShape,
	workflowDraftShape,
	workflowShape,
	workflowStepsShape,
} from '@src/core'
import { describe, expect, it } from 'vitest'

// The workflow contract shape VALUES are well-formed `ContractShape` descriptors
// that mirror the hand-written definition interfaces (types.ts). Structural checks
// on the descriptors — the four-way-parity behavior is covered in factories.test.ts.

describe('taskFormShape — the `via` tagged union', () => {
	it('is a union of three object variants', () => {
		expect(taskFormShape.type).toBe('union')
		expect(taskFormShape.variants).toHaveLength(3)
	})

	it('each variant discriminates on a `via` literal + carries a `name`', () => {
		const vias = taskFormShape.variants.map((variant) => {
			expect(variant.type).toBe('object')
			const via = variant.type === 'object' ? variant.properties.via : undefined
			expect(variant.type === 'object' ? variant.properties.name : undefined).toMatchObject({
				type: 'string',
				min: 1,
			})
			return via && via.type === 'literal' ? via.values[0] : undefined
		})
		expect(vias).toEqual(['function', 'tool', 'agent'])
	})
})

describe('taskShape', () => {
	it('requires id / name / run and makes description optional', () => {
		expect(taskShape.type).toBe('object')
		expect(taskShape.properties.id).toMatchObject({ type: 'string', min: 1 })
		expect(taskShape.properties.name).toMatchObject({ type: 'string', min: 1 })
		expect(taskShape.properties.description.type).toBe('optional')
		expect(taskShape.properties.run).toBe(taskFormShape)
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

// Rank 1 — per-field descriptions ride INSIDE the shapes (and thus the emitted JSON Schema),
// especially on the `via` discriminant + the `run` union and the flat `name` / `via` fields.
describe('per-field descriptions (Rank 1)', () => {
	it('each task-form variant describes its `via` discriminant + its `name`', () => {
		for (const variant of taskFormShape.variants) {
			const via = variant.type === 'object' ? variant.properties.via : undefined
			const name = variant.type === 'object' ? variant.properties.name : undefined
			expect(typeof (via && via.type === 'literal' ? via.description : undefined)).toBe('string')
			expect(typeof (name && name.type === 'string' ? name.description : undefined)).toBe('string')
		}
	})

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
})

// Rank 2 — the draft shapes mirror the strict shapes EXCEPT id/name are optional (run stays
// required); a provided id/name still carries minLength:1.
describe('workflowDraftShape / phaseDraftShape / taskDraftShape — id/name optional', () => {
	it('makes id and name OPTIONAL at all three levels, run still required', () => {
		expect(workflowDraftShape.properties.id.type).toBe('optional')
		expect(workflowDraftShape.properties.name.type).toBe('optional')
		expect(phaseDraftShape.properties.id.type).toBe('optional')
		expect(phaseDraftShape.properties.name.type).toBe('optional')
		expect(taskDraftShape.properties.id.type).toBe('optional')
		expect(taskDraftShape.properties.name.type).toBe('optional')
		// `run` stays required (not wrapped in optional), pointing at the shared taskFormShape.
		expect(taskDraftShape.properties.run).toBe(taskFormShape)
	})

	it('a PROVIDED id still carries minLength:1 (so an explicit empty id is rejected upstream)', () => {
		const id = workflowDraftShape.properties.id
		expect(id.type === 'optional' && id.inner).toMatchObject({ type: 'string', min: 1 })
	})

	it('nests draft phases under the draft workflow, and draft tasks under the draft phase', () => {
		const phases = workflowDraftShape.properties.phases
		expect(phases.type === 'array' && phases.items).toBe(phaseDraftShape)
		const tasks = phaseDraftShape.properties.tasks
		expect(tasks.type === 'array' && tasks.items).toBe(taskDraftShape)
	})
})

// Rank 3 — the FLAT advertised shape: `{ name?, steps: [{ name, via? }] }`.
describe('workflowStepsShape / stepShape — the flat advertised surface', () => {
	it('holds an optional name and an array of {name, via?} steps', () => {
		expect(workflowStepsShape.properties.name.type).toBe('optional')
		const steps = workflowStepsShape.properties.steps
		expect(steps.type).toBe('array')
		expect(steps.type === 'array' && steps.items).toBe(stepShape)
	})

	it('a step requires a non-empty `name` and an optional `via` literal', () => {
		expect(stepShape.properties.name).toMatchObject({ type: 'string', min: 1 })
		const via = stepShape.properties.via
		expect(via.type).toBe('optional')
		expect(via.type === 'optional' && via.inner).toMatchObject({
			type: 'literal',
			values: ['function', 'tool', 'agent'],
		})
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
						run: { via: 'function', name: 'f' },
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
})
