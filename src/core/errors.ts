import type { WorkflowErrorCode } from './types.js'

// AGENTS §12: an illegal state-machine transition, structurally invalid restore, refused
// mutation, refused host schedule, or broken internal invariant carries a machine-readable
// `code`, so a `catch` branches on `error.code` instead of parsing the message. The `context`
// bag names the offending node / status / parameter. Optional lookups (`task` / `phase`) return
// `undefined` — they never throw.

/**
 * Represents an error raised by the workflow runtime.
 *
 * @remarks
 * Carries a {@link WorkflowErrorCode} and an optional `context` bag naming the
 * offending node id / status / parameter. Raised for an illegal lifecycle transition
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
		this.name = 'WorkflowError'
		this.code = code
		if (context !== undefined) this.context = context
	}
}

/**
 * Narrows an unknown caught value to a {@link WorkflowError}.
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
	try {
		return value instanceof WorkflowError
	} catch {
		return false
	}
}
