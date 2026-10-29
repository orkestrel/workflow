import type { WorkflowErrorCode } from './types.js'
import { holds, INTRINSICS, isFunction, isObject } from '@orkestrel/contract'

// The fault kinds: an illegal state-machine transition, structurally invalid restore, refused
// mutation, refused host schedule, or broken internal invariant carries a machine-readable
// `code`, so a `catch` branches on `error.code` instead of parsing the message. The `context`
// bag names the offending node / status / parameter. Optional lookups (`task` / `phase`) return
// `undefined` — they never throw.

/**
 * Represents an error the workflow runtime raises for an operation it refuses — a
 * {@link WorkflowErrorCode} (`TRANSITION`, `RESTORE`, `MUTATION`, `SCHEDULE`, or `INVARIANT`)
 * beside an optional `context` naming the node or the parameter at fault.
 *
 * @remarks
 * Raised for an illegal lifecycle transition
 * (`TRANSITION`), a structurally invalid {@link import('./types.js').WorkflowSnapshot}
 * boundary (`RESTORE`), a refused structural/activity edit (`MUTATION`), a host
 * schedule refused before arming because the caller's `signal` is not a native
 * `AbortSignal` (`SCHEDULE`, delivered as a rejected promise), or a broken internal
 * invariant (`INVARIANT`).
 */
export class WorkflowError extends Error {
	readonly code: WorkflowErrorCode
	readonly context?: Readonly<Record<string, unknown>>

	constructor(
		code: WorkflowErrorCode,
		message: string,
		context?: Readonly<Record<string, unknown>>,
	) {
		super(message)
		INTRINSICS.define(this, Symbol.for('@orkestrel/workflow.WorkflowError'), { value: this })
		this.name = 'WorkflowError'
		this.code = code
		if (context !== undefined) this.context = context
	}
}

/**
 * Narrows an unknown caught value to a {@link WorkflowError}.
 *
 * @remarks
 * Accepts the own self-brand across package copies and subclasses without requiring a name.
 * Requires the global Error prototype boundary, a declared code, and an optional object or
 * callable context. Refuses transparent proxies and contains hostile reads.
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns True if `value` is a {@link WorkflowError}; false otherwise
 *
 * @example
 * ```ts
 * try {
 * 	task.complete('done')
 * } catch (error) {
 * 	if (isWorkflowError(error) && error.code === 'TRANSITION') retry()
 * }
 * ```
 */
export function isWorkflowError(value: unknown): value is WorkflowError {
	return holds(() => {
		if (!(value instanceof Error) || INTRINSICS.prototype(value) === Error.prototype) return false
		const brand = INTRINSICS.describe(value, Symbol.for('@orkestrel/workflow.WorkflowError'))
		if (brand === undefined || brand.value !== value) return false
		const code: unknown = INTRINSICS.reflect.read(value, 'code')
		const context: unknown = INTRINSICS.reflect.read(value, 'context')
		return (
			(code === 'TRANSITION' ||
				code === 'RESTORE' ||
				code === 'MUTATION' ||
				code === 'SCHEDULE' ||
				code === 'INVARIANT') &&
			(context === undefined || isObject(context) || isFunction(context))
		)
	})
}
