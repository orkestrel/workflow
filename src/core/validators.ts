import type {
	LifecycleStatus,
	TaskActivity,
	TaskActivityInput,
	TaskClaim,
	TaskFailure,
	WorkflowInterface,
	WorkflowSnapshot,
} from './types.js'
import {
	attempt,
	cloneJSONValue,
	isArray,
	isBoolean,
	isFiniteNumber,
	isFunction,
	isInteger,
	isJSONValue,
	isNonEmptyString,
	isObject,
	isRecord,
} from '@orkestrel/contract'
import { LIFECYCLE_STATUSES, MAX_TIMER_MS } from './constants.js'
import { derivePhaseStatus, deriveWorkflowStatus, isTaskResult } from './helpers.js'

/**
 * Checks whether an unknown value belongs to the workflow lifecycle vocabulary.
 *
 * @remarks
 * Reads {@link import('./constants.js').LIFECYCLE_STATUSES}, the runtime array every tier draws
 * from, so the vocabulary has one definition rather than a hard-coded copy per guard.
 *
 * @param value - The value to test
 * @returns True if `value` is a {@link LifecycleStatus}; false otherwise
 *
 * @example
 * ```ts
 * isLifecycleStatus('running') // true
 * isLifecycleStatus('paused') // false
 * ```
 */
export function isLifecycleStatus(value: unknown): value is LifecycleStatus {
	return LIFECYCLE_STATUSES.some((status) => status === value)
}

/**
 * Tests a normalized persisted task failure.
 *
 * @remarks
 * The exact-record guard behind a persisted {@link TaskFailure}: exactly `origin` and `message`,
 * an `origin` drawn from the {@link import('./types.js').TaskFailureOrigin} vocabulary, and a
 * non-empty `message`. Total — a hostile prototype or accessor answers `false` rather than
 * throwing.
 *
 * @param value - The value to test
 * @returns True if `value` is a persisted {@link TaskFailure}; false otherwise
 *
 * @example
 * ```ts
 * isTaskFailure({ origin: 'handler', message: 'boom' }) // true
 * isTaskFailure({ origin: 'handler' }) // false
 * ```
 */
export function isTaskFailure(value: unknown): value is TaskFailure {
	try {
		return (
			isRecord(value) &&
			Object.keys(value).every((key) => key === 'origin' || key === 'message') &&
			(value.origin === 'handler' || value.origin === 'timeout' || value.origin === 'recovery') &&
			isNonEmptyString(value.message)
		)
	} catch {
		return false
	}
}

/**
 * Checks whether an unknown value is a live workflow entity rather than a definition.
 *
 * @remarks
 * The discriminator behind the overloaded
 * {@link import('./types.js').WorkflowRunnerInterface.execute}: a
 * {@link import('./types.js').WorkflowInterface} is the only one of the two carrying `destroyed`
 * (RUNTIME-ONLY, never a field on the pure-JSON
 * {@link import('./types.js').WorkflowDefinition}) AND a callable `snapshot`. Requiring both is
 * sturdier than `destroyed` alone — a definition could coincidentally carry a `destroyed` field as
 * arbitrary data, and pairing it with a function-typed `snapshot` narrows to the actual entity
 * shape without an `as`. It reads a live class instance, so it tests object identity rather than a
 * plain-record brand, and it is total: any other value answers `false`.
 *
 * @param value - The value to test
 * @returns True if `value` is a live {@link WorkflowInterface}; false otherwise
 *
 * @example
 * ```ts
 * isWorkflowInterface(createWorkflow(definition)) // true
 * isWorkflowInterface(definition) // false
 * ```
 */
export function isWorkflowInterface(value: unknown): value is WorkflowInterface {
	try {
		return (
			isObject(value) && 'destroyed' in value && 'snapshot' in value && isFunction(value.snapshot)
		)
	} catch {
		return false
	}
}

/**
 * Validates a safe owned JSON graph as a coherent workflow snapshot.
 *
 * @remarks
 * Callers at hostile boundaries use {@link isWorkflowSnapshot}, which owns the
 * graph first so this semantic pass never observes accessors or prototypes.
 *
 * @param value - The already-owned JSON graph to validate
 * @returns True if `value` is a coherent {@link WorkflowSnapshot}; false otherwise
 *
 * @example
 * ```ts
 * isOwnedWorkflowSnapshot(workflow.snapshot()) // true
 * ```
 */
export function isOwnedWorkflowSnapshot(value: unknown): value is WorkflowSnapshot {
	try {
		if (
			!isRecord(value) ||
			!Object.keys(value).every(
				(key) =>
					key === 'id' ||
					key === 'name' ||
					key === 'description' ||
					key === 'status' ||
					key === 'override' ||
					key === 'bail' ||
					key === 'phases' ||
					key === 'created' ||
					key === 'updated',
			) ||
			!isNonEmptyString(value.id) ||
			!isNonEmptyString(value.name) ||
			(value.description !== undefined && typeof value.description !== 'string') ||
			!isLifecycleStatus(value.status) ||
			(value.override !== undefined &&
				value.override !== 'completed' &&
				value.override !== 'skipped' &&
				value.override !== 'stopped') ||
			!isBoolean(value.bail) ||
			!isArray(value.phases) ||
			!isFiniteNumber(value.created) ||
			value.created < 0 ||
			!isFiniteNumber(value.updated) ||
			value.updated < value.created
		) {
			return false
		}
		const phaseIds = new Set<string>()
		const derivations: Array<{ status: LifecycleStatus; bail: boolean }> = []
		let frontier = false
		let running = false
		let vacuous = true
		for (const phase of value.phases) {
			if (
				!isRecord(phase) ||
				!Object.keys(phase).every(
					(key) =>
						key === 'id' ||
						key === 'name' ||
						key === 'description' ||
						key === 'status' ||
						key === 'override' ||
						key === 'bail' ||
						key === 'concurrency' ||
						key === 'tasks',
				) ||
				!isNonEmptyString(phase.id) ||
				phaseIds.has(phase.id) ||
				!isNonEmptyString(phase.name) ||
				(phase.description !== undefined && typeof phase.description !== 'string') ||
				!isLifecycleStatus(phase.status) ||
				(phase.override !== undefined &&
					phase.override !== 'skipped' &&
					phase.override !== 'stopped') ||
				!isBoolean(phase.bail) ||
				(phase.concurrency !== undefined &&
					(!isInteger(phase.concurrency) || phase.concurrency < 1)) ||
				!isArray(phase.tasks)
			) {
				return false
			}
			const forced = phase.override === 'skipped' || phase.override === 'stopped'
			const started =
				phase.status === 'running' || phase.status === 'completed' || phase.status === 'failed'
			if ((!forced && frontier && started) || (phase.status === 'running' && running)) {
				return false
			}
			if (phase.status === 'running') running = true
			if (
				!forced &&
				(phase.status === 'pending' ||
					phase.status === 'running' ||
					(phase.status === 'failed' && phase.bail))
			) {
				frontier = true
			}
			phaseIds.add(phase.id)
			const taskIds = new Set<string>()
			const statuses: LifecycleStatus[] = []
			if (phase.tasks.length > 0) vacuous = false
			for (const task of phase.tasks) {
				if (
					!isRecord(task) ||
					!Object.keys(task).every(
						(key) =>
							key === 'id' ||
							key === 'name' ||
							key === 'description' ||
							key === 'status' ||
							key === 'result' ||
							key === 'metadata' ||
							key === 'attempts' ||
							key === 'behavior' ||
							key === 'retries' ||
							key === 'timeout' ||
							key === 'activity',
					) ||
					!isNonEmptyString(task.id) ||
					taskIds.has(task.id) ||
					!isNonEmptyString(task.name) ||
					(task.description !== undefined && typeof task.description !== 'string') ||
					!isLifecycleStatus(task.status) ||
					!isRecord(task.metadata) ||
					!isJSONValue(task.metadata) ||
					!isInteger(task.attempts) ||
					task.attempts < 0 ||
					(task.behavior !== undefined && !isNonEmptyString(task.behavior)) ||
					(task.retries !== undefined && (!isInteger(task.retries) || task.retries < 0)) ||
					(task.timeout !== undefined &&
						(!isInteger(task.timeout) || task.timeout < 0 || task.timeout > MAX_TIMER_MS))
				) {
					return false
				}
				const budget = (task.retries ?? 0) + 1
				if (task.attempts > budget || (task.status === 'pending' && task.attempts >= budget)) {
					return false
				}
				const activityValid = task.activity === undefined || isTaskActivity(task.activity)
				if (!activityValid) return false
				if (task.status === 'running' || task.status === 'completed' || task.status === 'failed') {
					if (task.attempts < 1 || task.activity === undefined) return false
				}
				if (task.status === 'pending' && task.activity !== undefined) {
					return false
				}
				if (task.status === 'completed' || task.status === 'failed') {
					if (!isTaskResult(task.result, value, phase, task)) return false
				} else if (task.result !== undefined) {
					return false
				}
				taskIds.add(task.id)
				statuses.push(task.status)
			}
			const derived = derivePhaseStatus(statuses)
			if (
				phase.status !== (phase.override ?? derived) ||
				(phase.override !== undefined && phase.status !== phase.override)
			) {
				return false
			}
			derivations.push({ status: phase.status, bail: phase.bail })
		}
		const derived = deriveWorkflowStatus(derivations)
		if (value.override === 'completed') {
			return value.status === 'completed' && derived === 'pending' && vacuous
		}
		return value.status === (value.override ?? derived)
	} catch {
		return false
	}
}

/**
 * Guards the hostile boundary totally for a workflow snapshot.
 *
 * @remarks
 * Owns the value first through the exact-JSON clone of `@orkestrel/contract`, then runs the
 * semantic pass {@link isOwnedWorkflowSnapshot} over the owned copy — so no accessor, prototype,
 * or cycle in the caller's graph is ever observed by the semantic pass. Total: an unclonable
 * value answers `false` rather than throwing.
 *
 * @param value - The untrusted value to test
 * @returns True if `value` is a coherent {@link WorkflowSnapshot}; false otherwise
 *
 * @example
 * ```ts
 * isWorkflowSnapshot(JSON.parse(payload)) // true only for a coherent snapshot
 * ```
 */
export function isWorkflowSnapshot(value: unknown): value is WorkflowSnapshot {
	const cloned = attempt(() => cloneJSONValue(value))
	return cloned.success && isOwnedWorkflowSnapshot(cloned.value)
}

/**
 * Checks whether an unknown value is a valid list of task activity claims.
 *
 * @remarks
 * The one guard behind both claim lists of a {@link TaskActivityInput} — its `operations` and its
 * `constraints` — because {@link import('./types.js').TaskOperation} and
 * {@link import('./types.js').TaskConstraint} are the same {@link TaskClaim} shape. Every member must be a plain record carrying exactly `id`, `name`, and
 * `started`, with non-empty string `id` and `name`, a finite non-negative `started`, and an `id`
 * unique within the list. Total: a hostile prototype, an accessor, or a cycle returns `false`
 * rather than throwing.
 *
 * @param value - The value to test
 * @returns True if `value` is a list of valid, uniquely identified claims; false otherwise
 *
 * @example
 * ```ts
 * isTaskClaimList([{ id: 'fetch', name: 'Fetch', started: 1 }]) // true
 * isTaskClaimList([{ id: 'fetch', name: 'Fetch' }]) // false
 * ```
 */
export function isTaskClaimList(value: unknown): value is readonly TaskClaim[] {
	try {
		if (!isArray(value)) return false
		const ids = new Set<string>()
		for (const claim of value) {
			if (!isRecord(claim)) return false
			const prototype = Object.getPrototypeOf(claim)
			if (
				(prototype !== Object.prototype && prototype !== null) ||
				!Object.keys(claim).every((key) => key === 'id' || key === 'name' || key === 'started')
			) {
				return false
			}
			const id = claim.id
			const name = claim.name
			const started = claim.started
			if (
				!isNonEmptyString(id) ||
				!isNonEmptyString(name) ||
				!isFiniteNumber(started) ||
				started < 0 ||
				ids.has(id)
			) {
				return false
			}
			ids.add(id)
		}
		return true
	} catch {
		return false
	}
}

/**
 * Tests whether an unknown value is a valid whole-frame activity report.
 *
 * @remarks
 * The guard behind {@link import('./types.js').TaskInterface.report}: exactly the optional `note`,
 * `progress`, `operations`, and `constraints` keys, with the two claim lists checked by
 * {@link isTaskClaimList} and `progress` a finite non-negative value under an optional `total` at
 * least as large. Total — a hostile prototype or accessor answers `false` rather than throwing.
 *
 * @param value - The value to test
 * @returns True if `value` is a valid {@link TaskActivityInput}; false otherwise
 *
 * @example
 * ```ts
 * isTaskActivityInput({ note: 'compiling', progress: { progress: 2, total: 5 } }) // true
 * ```
 */
export function isTaskActivityInput(value: unknown): value is TaskActivityInput {
	try {
		if (!isRecord(value)) return false
		const prototype = Object.getPrototypeOf(value)
		if (
			(prototype !== Object.prototype && prototype !== null) ||
			!Object.keys(value).every(
				(key) =>
					key === 'note' || key === 'progress' || key === 'operations' || key === 'constraints',
			)
		) {
			return false
		}
		const note = value.note
		const progress = value.progress
		const operations = value.operations
		const constraints = value.constraints
		if (note !== undefined && !isNonEmptyString(note)) return false
		if (progress !== undefined) {
			if (!isRecord(progress)) return false
			const progressPrototype = Object.getPrototypeOf(progress)
			if (
				(progressPrototype !== Object.prototype && progressPrototype !== null) ||
				!Object.keys(progress).every(
					(key) => key === 'progress' || key === 'total' || key === 'message',
				)
			) {
				return false
			}
			const reported = progress.progress
			const total = progress.total
			const message = progress.message
			if (
				!isFiniteNumber(reported) ||
				reported < 0 ||
				(total !== undefined && (!isFiniteNumber(total) || total < reported)) ||
				(message !== undefined && !isNonEmptyString(message))
			) {
				return false
			}
		}
		if (operations !== undefined && !isTaskClaimList(operations)) return false
		if (constraints !== undefined && !isTaskClaimList(constraints)) return false
		return true
	} catch {
		return false
	}
}

/**
 * Tests whether an unknown value is valid persisted task activity.
 *
 * @remarks
 * The persisted counterpart of {@link isTaskActivityInput}: the same frame plus the REQUIRED
 * `operations`, `constraints`, and a finite non-negative `updated` stamp, because a stored frame
 * has already been accepted and normalized. Total — a hostile prototype or accessor answers
 * `false` rather than throwing.
 *
 * @param value - The value to test
 * @returns True if `value` is a persisted {@link TaskActivity}; false otherwise
 *
 * @example
 * ```ts
 * isTaskActivity({ operations: [], constraints: [], updated: 1 }) // true
 * ```
 */
export function isTaskActivity(value: unknown): value is TaskActivity {
	try {
		if (!isRecord(value)) return false
		const prototype = Object.getPrototypeOf(value)
		if (
			(prototype !== Object.prototype && prototype !== null) ||
			!Object.keys(value).every(
				(key) =>
					key === 'note' ||
					key === 'progress' ||
					key === 'operations' ||
					key === 'constraints' ||
					key === 'updated',
			)
		) {
			return false
		}
		const note = value.note
		const progress = value.progress
		const operations = value.operations
		const constraints = value.constraints
		const updated = value.updated
		if (
			operations === undefined ||
			constraints === undefined ||
			!isFiniteNumber(updated) ||
			updated < 0
		) {
			return false
		}
		return isTaskActivityInput({
			...(note === undefined ? {} : { note }),
			...(progress === undefined ? {} : { progress }),
			operations,
			constraints,
		})
	} catch {
		return false
	}
}
