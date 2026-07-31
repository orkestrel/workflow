import type { WorkflowErrorCode } from './types.js'

// AGENTS §12: an illegal state-machine transition, structurally invalid restore, or
// refused mutation carries a machine-readable `code`, so a `catch` branches on
// `error.code` instead of parsing the message. The `context` bag names the offending
// node / status. Optional lookups (`task` / `phase`) return `undefined` — they never throw.

/**
 * An error raised by the workflow runtime.
 *
 * @remarks
 * Carries a {@link WorkflowErrorCode} and an optional `context` bag naming the
 * offending node id / status. Raised for an illegal lifecycle transition
 * (`TRANSITION`), a structurally invalid {@link import('./types.js').WorkflowSnapshot}
 * boundary (`RESTORE`), or a refused structural/activity edit (`MUTATION`).
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
 * Narrow an unknown caught value to a {@link WorkflowError}.
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns `true` when `value` is a {@link WorkflowError}
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
