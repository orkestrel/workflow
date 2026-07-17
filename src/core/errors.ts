import type { WorkflowErrorCode } from './types.js'

// AGENTS §12: an illegal state-machine transition, a structurally invalid restore, an
// over-deep / cyclic nested-workflow dispatch, or a malformed workflow-tool args blob
// `throw`s a `WorkflowError` carrying a machine-readable `code`, so a `catch` branches
// on `error.code` instead of parsing the message. The `context` bag names the offending
// node / status. Optional lookups (`task` / `phase`) return `undefined` — they never throw.

/**
 * An error thrown by the workflow entity + W-c2 recursion layer.
 *
 * @remarks
 * Carries a {@link WorkflowErrorCode} and an optional `context` bag naming the
 * offending node id / status. Thrown for an illegal lifecycle transition
 * (`TRANSITION`), a structurally invalid {@link import('./types.js').WorkflowSnapshot}
 * passed to {@link import('./factories.js').restoreWorkflow} (`RESTORE`), an over-deep /
 * cyclic nested-workflow dispatch (`DEPTH`), and a malformed workflow-authoring-tool args
 * blob (`TOOL`). `DEPTH` and `TOOL` are public type surface constructed by the
 * `@orkestrel/tool` package's workflow-tool / agent-function adapters; on that seam the
 * throw is ISOLATED by its `ToolManager` into the tool result's top-level `error`
 * (AGENTS §14 — the universal tool-handler contract).
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
		this.context = context
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
	return value instanceof WorkflowError
}
