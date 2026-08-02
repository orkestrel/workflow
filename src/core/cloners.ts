import type { TaskActivity, WorkflowSnapshot } from './types.js'
import { cloneJSONValue, isArray, isContractError, isRecord } from '@orkestrel/contract'
import { WorkflowError, isWorkflowError } from './errors.js'
import { isOwnedWorkflowSnapshot, isTaskActivity, workflowSnapshotContext } from './validators.js'

/**
 * Validate and own a workflow snapshot before live construction.
 *
 * @param input - The hostile snapshot boundary
 * @param id - The optional storage key the owned snapshot must match
 * @returns A deeply owned frozen snapshot
 * @throws {WorkflowError} With `RESTORE` when the snapshot is invalid or does not match `id`
 */
export function cloneWorkflowSnapshot(input: unknown, id?: string): WorkflowSnapshot {
	let cloned: unknown
	try {
		cloned = cloneJSONValue(input)
	} catch (error) {
		if (isWorkflowError(error)) throw error
		if (isContractError(error)) {
			throw new WorkflowError(
				'RESTORE',
				`workflow snapshot could not be read safely: ${error.message}`,
			)
		}
		throw new WorkflowError('RESTORE', 'workflow snapshot could not be read safely')
	}
	if (!isOwnedWorkflowSnapshot(cloned)) {
		throw new WorkflowError(
			'RESTORE',
			'workflow snapshot is inconsistent',
			workflowSnapshotContext(cloned),
		)
	}
	if (id !== undefined && cloned.id !== id) {
		throw new WorkflowError(
			'RESTORE',
			`workflow snapshot '${cloned.id}' does not match storage key '${id}'`,
			{ requested: id, payload: cloned.id },
		)
	}
	return cloned
}

/**
 * Validate and clone one complete task activity frame.
 *
 * @remarks
 * This is the hostile boundary behind task reports and snapshot hydration. Supplying
 * `updated` stamps an input frame without reading an `updated` property from it; omitting
 * `updated` restores a stored frame and reads its persisted timestamp exactly once. Every
 * untrusted property is captured once inside one protected boundary. The returned frame,
 * collections, progress, operations, and constraints are copied and frozen.
 *
 * @param input - The untrusted complete activity frame
 * @param updated - An optional accepted timestamp used instead of a persisted `updated`
 * @returns An immutable cloned {@link TaskActivity}
 * @throws {WorkflowError} With `MUTATION` when the frame cannot be read or validated
 */
export function cloneTaskActivity(input: unknown, updated?: number): TaskActivity {
	try {
		if (!isRecord(input)) {
			throw new WorkflowError('MUTATION', 'task activity must be a record')
		}
		const inputPrototype = Object.getPrototypeOf(input)
		if (
			(inputPrototype !== Object.prototype && inputPrototype !== null) ||
			!Object.keys(input).every(
				(key) =>
					key === 'note' ||
					key === 'progress' ||
					key === 'operations' ||
					key === 'constraints' ||
					(updated === undefined && key === 'updated'),
			)
		) {
			throw new WorkflowError('MUTATION', 'task activity must be a record')
		}
		const note = input.note
		const progressInput = input.progress
		const operationsInput = input.operations
		const constraintsInput = input.constraints
		const accepted = updated === undefined ? input.updated : updated

		const operationInputs =
			operationsInput === undefined
				? []
				: isArray(operationsInput)
					? [...operationsInput]
					: undefined
		if (operationInputs === undefined) {
			throw new WorkflowError('MUTATION', 'task activity operations must be an array')
		}
		const operations: unknown[] = []
		for (const operation of operationInputs) {
			if (!isRecord(operation)) {
				throw new WorkflowError('MUTATION', 'task activity contains an invalid operation')
			}
			const operationPrototype = Object.getPrototypeOf(operation)
			if (
				(operationPrototype !== Object.prototype && operationPrototype !== null) ||
				!Object.keys(operation).every((key) => key === 'id' || key === 'name' || key === 'started')
			) {
				throw new WorkflowError('MUTATION', 'task activity contains an invalid operation')
			}
			const id = operation.id
			const name = operation.name
			const started = operation.started
			operations.push(Object.freeze({ id, name, started }))
		}

		let progress: unknown
		if (progressInput !== undefined) {
			if (!isRecord(progressInput)) {
				throw new WorkflowError('MUTATION', 'task activity contains invalid progress')
			}
			const progressPrototype = Object.getPrototypeOf(progressInput)
			if (
				(progressPrototype !== Object.prototype && progressPrototype !== null) ||
				!Object.keys(progressInput).every(
					(key) => key === 'current' || key === 'total' || key === 'unit',
				)
			) {
				throw new WorkflowError('MUTATION', 'task activity contains invalid progress')
			}
			const current = progressInput.current
			const total = progressInput.total
			const unit = progressInput.unit
			progress = Object.freeze({
				current,
				...(total === undefined ? {} : { total }),
				...(unit === undefined ? {} : { unit }),
			})
		}

		const constraintInputs =
			constraintsInput === undefined
				? []
				: isArray(constraintsInput)
					? [...constraintsInput]
					: undefined
		if (constraintInputs === undefined) {
			throw new WorkflowError('MUTATION', 'task activity constraints must be an array')
		}
		const constraints: unknown[] = []
		for (const constraint of constraintInputs) {
			if (!isRecord(constraint)) {
				throw new WorkflowError('MUTATION', 'task activity contains an invalid constraint')
			}
			const constraintPrototype = Object.getPrototypeOf(constraint)
			if (
				(constraintPrototype !== Object.prototype && constraintPrototype !== null) ||
				!Object.keys(constraint).every((key) => key === 'id' || key === 'name' || key === 'started')
			) {
				throw new WorkflowError('MUTATION', 'task activity contains an invalid constraint')
			}
			const id = constraint.id
			const name = constraint.name
			const started = constraint.started
			constraints.push(Object.freeze({ id, name, started }))
		}

		const activity = Object.freeze({
			...(note === undefined ? {} : { note }),
			...(progress === undefined ? {} : { progress }),
			operations: Object.freeze(operations),
			constraints: Object.freeze(constraints),
			updated: accepted,
		})
		if (!isTaskActivity(activity)) {
			throw new WorkflowError('MUTATION', 'task activity is invalid')
		}
		return activity
	} catch (error) {
		if (isWorkflowError(error)) throw error
		throw new WorkflowError('MUTATION', 'task activity could not be read safely')
	}
}
