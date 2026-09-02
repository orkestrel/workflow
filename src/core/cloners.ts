import type { TaskActivity, WorkflowSnapshot } from './types.js'
import { cloneJSONValue, isArray, isContractError, isRecord } from '@orkestrel/contract'
import { WorkflowError, isWorkflowError } from './errors.js'
import { scanSnapshotContext } from './helpers.js'
import { isOwnedWorkflowSnapshot, isTaskActivity } from './validators.js'

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
			scanSnapshotContext(cloned),
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
 * Validates and owns one list of task activity claims.
 *
 * @remarks
 * The one cloner behind both claim lists of a task activity frame — its `operations` and its
 * `constraints` — since {@link import('./types.js').TaskOperation} and
 * {@link import('./types.js').TaskConstraint} are the same {@link import('./types.js').TaskClaim}
 * shape. An omitted
 * list is an empty one. Each member is read exactly once inside the caller's protected boundary
 * and returned frozen; the semantic pass over the copied values is
 * {@link import('./validators.js').isTaskClaimList}, so this cloner refuses only what it cannot
 * read: a non-array list, a non-record member, a hostile prototype, or an unexpected key.
 *
 * @param input - The untrusted claim list
 * @param noun - The singular claim noun the refusal message names, pluralized by adding `s`
 * @returns The owned frozen claims, in input order
 * @throws {WorkflowError} With `MUTATION` when the list or one of its members cannot be read
 *
 * @example
 * ```ts
 * cloneTaskClaims([{ id: 'fetch', name: 'Fetch', started: 1 }], 'operation')
 * ```
 */
export function cloneTaskClaims(input: unknown, noun: string): readonly unknown[] {
	const inputs = input === undefined ? [] : isArray(input) ? [...input] : undefined
	if (inputs === undefined) {
		throw new WorkflowError('MUTATION', `task activity ${noun}s must be an array`)
	}
	const claims: unknown[] = []
	for (const claim of inputs) {
		if (!isRecord(claim)) {
			throw new WorkflowError('MUTATION', `task activity contains an invalid ${noun}`)
		}
		const prototype = Object.getPrototypeOf(claim)
		if (
			(prototype !== Object.prototype && prototype !== null) ||
			!Object.keys(claim).every((key) => key === 'id' || key === 'name' || key === 'started')
		) {
			throw new WorkflowError('MUTATION', `task activity contains an invalid ${noun}`)
		}
		const id = claim.id
		const name = claim.name
		const started = claim.started
		claims.push(Object.freeze({ id, name, started }))
	}
	return claims
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

		const operations = cloneTaskClaims(operationsInput, 'operation')

		let progress: unknown
		if (progressInput !== undefined) {
			if (!isRecord(progressInput)) {
				throw new WorkflowError('MUTATION', 'task activity contains invalid progress')
			}
			const progressPrototype = Object.getPrototypeOf(progressInput)
			if (
				(progressPrototype !== Object.prototype && progressPrototype !== null) ||
				!Object.keys(progressInput).every(
					(key) => key === 'progress' || key === 'total' || key === 'message',
				)
			) {
				throw new WorkflowError('MUTATION', 'task activity contains invalid progress')
			}
			const reported = progressInput.progress
			const total = progressInput.total
			const message = progressInput.message
			progress = Object.freeze({
				progress: reported,
				...(total === undefined ? {} : { total }),
				...(message === undefined ? {} : { message }),
			})
		}

		const constraints = cloneTaskClaims(constraintsInput, 'constraint')

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
