import type {
	LifecycleStatus,
	TaskActivity,
	TaskActivityInput,
	TaskFailure,
	TaskResult,
	WorkflowFunctions,
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
	isRecord,
} from '@orkestrel/contract'
import { MAX_TIMER_MS } from './constants.js'
import { derivePhaseStatus, deriveWorkflowStatus } from './helpers.js'

/** Test the workflow lifecycle vocabulary. */
export function isLifecycleStatus(value: unknown): value is LifecycleStatus {
	return (
		value === 'pending' ||
		value === 'running' ||
		value === 'completed' ||
		value === 'failed' ||
		value === 'skipped' ||
		value === 'stopped'
	)
}

/** Test a normalized persisted task failure. */
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

/** Compare two optional description values. */
export function matchesDescription(left: unknown, right: unknown): boolean {
	return left === right && (left === undefined || typeof left === 'string')
}

/** Test a result's lineage against its containing snapshot nodes. */
export function isTaskResult(
	value: unknown,
	workflow: unknown,
	phase: unknown,
	task: unknown,
): value is TaskResult {
	try {
		if (
			!isRecord(value) ||
			!isRecord(workflow) ||
			!isRecord(phase) ||
			!isRecord(task) ||
			!Object.keys(value).every(
				(key) =>
					key === 'task' ||
					key === 'phase' ||
					key === 'workflow' ||
					key === 'status' ||
					key === 'result' ||
					key === 'timestamp',
			) ||
			!isLifecycleStatus(value.status) ||
			value.status !== task.status ||
			!isFiniteNumber(value.timestamp) ||
			value.timestamp < 0 ||
			!isRecord(value.task) ||
			!isRecord(value.phase) ||
			!isRecord(value.workflow) ||
			!Object.keys(value.workflow).every(
				(key) => key === 'id' || key === 'name' || key === 'description',
			) ||
			!Object.keys(value.phase).every(
				(key) => key === 'id' || key === 'name' || key === 'description' || key === 'workflow',
			) ||
			!Object.keys(value.task).every(
				(key) => key === 'id' || key === 'name' || key === 'description' || key === 'phase',
			)
		) {
			return false
		}
		if (
			value.task.id !== task.id ||
			value.task.name !== task.name ||
			!matchesDescription(value.task.description, task.description) ||
			value.phase.id !== phase.id ||
			value.phase.name !== phase.name ||
			!matchesDescription(value.phase.description, phase.description) ||
			value.workflow.id !== workflow.id ||
			value.workflow.name !== workflow.name ||
			!matchesDescription(value.workflow.description, workflow.description)
		) {
			return false
		}
		if (
			!isRecord(value.task.phase) ||
			!isRecord(value.task.phase.workflow) ||
			!isRecord(value.phase.workflow) ||
			!Object.keys(value.task.phase).every(
				(key) => key === 'id' || key === 'name' || key === 'description' || key === 'workflow',
			) ||
			!Object.keys(value.task.phase.workflow).every(
				(key) => key === 'id' || key === 'name' || key === 'description',
			) ||
			!Object.keys(value.phase.workflow).every(
				(key) => key === 'id' || key === 'name' || key === 'description',
			)
		) {
			return false
		}
		if (
			value.task.phase.id !== phase.id ||
			value.task.phase.name !== phase.name ||
			!matchesDescription(value.task.phase.description, phase.description) ||
			value.phase.workflow.id !== workflow.id ||
			value.phase.workflow.name !== workflow.name ||
			!matchesDescription(value.phase.workflow.description, workflow.description) ||
			value.task.phase.workflow.id !== workflow.id ||
			value.task.phase.workflow.name !== workflow.name ||
			!matchesDescription(value.task.phase.workflow.description, workflow.description)
		) {
			return false
		}
		if (value.status === 'completed') {
			return (
				isRecord(value.result) &&
				value.result.success === true &&
				Object.keys(value.result).every((key) => key === 'success' || key === 'value') &&
				isJSONValue(value.result.value)
			)
		}
		if (value.status === 'failed') {
			return (
				isRecord(value.result) &&
				value.result.success === false &&
				Object.keys(value.result).every((key) => key === 'success' || key === 'error') &&
				isTaskFailure(value.result.error)
			)
		}
		return false
	} catch {
		return false
	}
}

/**
 * Validate a safe owned JSON graph as a coherent workflow snapshot.
 *
 * @remarks
 * Callers at hostile boundaries use {@link isWorkflowSnapshot}, which owns the
 * graph first so this semantic pass never observes accessors or prototypes.
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
		const derivations: { status: LifecycleStatus; bail: boolean }[] = []
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
							key === 'run' ||
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
					(task.run !== undefined && !isNonEmptyString(task.run)) ||
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

/** Total hostile-boundary workflow snapshot guard. */
export function isWorkflowSnapshot(value: unknown): value is WorkflowSnapshot {
	const cloned = attempt(() => cloneJSONValue(value))
	return cloned.success && isOwnedWorkflowSnapshot(cloned.value)
}

/**
 * Test that every named task has a callable runtime handler before dispatch.
 *
 * @remarks
 * A snapshot lookup reads each unique `run` binding at most once from `functions`. A live workflow
 * validates its tasks' already-resolved handlers without consulting the retained registry again.
 *
 * @param workflow - The persisted snapshot or constructed live workflow to validate
 * @returns Whether every named task resolves to a callable handler
 */
export function hasWorkflowHandlers(workflow: WorkflowInterface): boolean
export function hasWorkflowHandlers(
	workflow: WorkflowSnapshot,
	functions: WorkflowFunctions | undefined,
): boolean
export function hasWorkflowHandlers(
	workflow: WorkflowInterface | WorkflowSnapshot,
	functions?: WorkflowFunctions,
): boolean {
	if ('destroyed' in workflow) {
		for (const phase of workflow.phases.phases()) {
			for (const task of phase.tasks.tasks()) {
				if (task.run !== undefined && !isFunction(task.handler)) return false
			}
		}
		return true
	}
	const runs = new Set<string>()
	for (const phase of workflow.phases) {
		for (const task of phase.tasks) {
			if (task.run === undefined || runs.has(task.run)) continue
			runs.add(task.run)
			if (!isFunction(functions?.[task.run])) return false
		}
	}
	return true
}

/** Locate the nearest identifiable node for an inconsistent owned snapshot. */
export function workflowSnapshotContext(
	value: unknown,
): Readonly<Record<string, unknown>> | undefined {
	if (!isRecord(value) || !isArray(value.phases)) return undefined
	for (const phase of value.phases) {
		if (!isRecord(phase)) continue
		const phaseContext = isNonEmptyString(phase.id) ? { phase: phase.id } : undefined
		if (
			!isBoolean(phase.bail) ||
			(phase.concurrency !== undefined &&
				(!isInteger(phase.concurrency) || phase.concurrency < 1)) ||
			!isArray(phase.tasks)
		) {
			return phaseContext
		}
		for (const task of phase.tasks) {
			if (!isRecord(task)) continue
			if (
				(task.run !== undefined && !isNonEmptyString(task.run)) ||
				(task.retries !== undefined && (!isInteger(task.retries) || task.retries < 0)) ||
				(task.timeout !== undefined &&
					(!isInteger(task.timeout) || task.timeout < 0 || task.timeout > MAX_TIMER_MS)) ||
				!isInteger(task.attempts) ||
				task.attempts < 0
			) {
				return {
					...(phaseContext ?? {}),
					...(isNonEmptyString(task.id) ? { task: task.id } : {}),
				}
			}
		}
	}
	return undefined
}

/**
 * Test whether an unknown value is a valid whole-frame activity report.
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
					(key) => key === 'current' || key === 'total' || key === 'unit',
				)
			) {
				return false
			}
			const current = progress.current
			const total = progress.total
			const unit = progress.unit
			if (
				!isFiniteNumber(current) ||
				current < 0 ||
				(total !== undefined && (!isFiniteNumber(total) || total < current)) ||
				(unit !== undefined && !isNonEmptyString(unit))
			) {
				return false
			}
		}
		if (operations !== undefined) {
			if (!isArray(operations)) return false
			const ids = new Set<string>()
			for (const operation of operations) {
				if (!isRecord(operation)) return false
				const operationPrototype = Object.getPrototypeOf(operation)
				if (
					(operationPrototype !== Object.prototype && operationPrototype !== null) ||
					!Object.keys(operation).every(
						(key) => key === 'id' || key === 'name' || key === 'started',
					)
				) {
					return false
				}
				const id = operation.id
				const name = operation.name
				const started = operation.started
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
		}
		if (constraints !== undefined) {
			if (!isArray(constraints)) return false
			const ids = new Set<string>()
			for (const constraint of constraints) {
				if (!isRecord(constraint)) return false
				const constraintPrototype = Object.getPrototypeOf(constraint)
				if (
					(constraintPrototype !== Object.prototype && constraintPrototype !== null) ||
					!Object.keys(constraint).every(
						(key) => key === 'id' || key === 'name' || key === 'started',
					)
				) {
					return false
				}
				const id = constraint.id
				const name = constraint.name
				const started = constraint.started
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
		}
		return true
	} catch {
		return false
	}
}

/**
 * Test whether an unknown value is valid persisted task activity.
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
