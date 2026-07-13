import type { TaskContext, TaskControllerInterface, TaskResult } from '../types.js'

/**
 * The lean per-task handle a {@link import('./types.js').WorkflowFunction} receives — the
 * running task's folded cancellation, its input, its lineage, and read-UP access to the
 * result tree.
 *
 * @remarks
 * - **A leaf handle, NOT the runner `Controller`.** A workflow task is a leaf of the
 *   declarative W-b tree, not a fan-out unit, so this carries none of the runner
 *   `Controller`'s `spawn` / `wait` — only what a leaf needs.
 * - **Folded signal.** `signal` is the cancellation the runner folds for THIS run: it fires
 *   on a workflow-level abort / timeout / budget ceiling, or — under `bail: true` — when a
 *   sibling task fails (the runner aborts the in-flight siblings via the substrate's
 *   fail-fast). A handler races its work against it; `aborted` reads it.
 * - **Input + lineage.** `input` is the task's open `metadata` bag (its
 *   {@link import('./types.js').TaskInput} payload, `{}` when none); `task` is the full
 *   {@link TaskContext}, so `task.phase` / `task.phase.workflow` navigate UP the lineage.
 * - **Read-up results.** `results()` returns every settled task's {@link TaskResult} across
 *   the phases that have already finished (a closure over the live
 *   {@link import('./types.js').WorkflowInterface}), so a `function` task can read an earlier
 *   phase's output. Read-only — a task records its OWN outcome by returning / throwing, not
 *   by mutating the tree.
 * - **Event-free.** Like the runner `Controller`, the per-task handle carries no Emitter;
 *   observe the W-b entities' own emitters (`task.emitter` / `phase.emitter`) instead.
 */
export class TaskController implements TaskControllerInterface {
	readonly signal: AbortSignal
	readonly input: Readonly<Record<string, unknown>>
	readonly task: TaskContext
	// Read the live workflow's settled results on demand — a closure injected by the runner,
	// so the handle reaches UP the tree without holding a back-reference to the workflow entity.
	readonly #results: () => readonly TaskResult[]

	constructor(
		signal: AbortSignal,
		input: Readonly<Record<string, unknown>>,
		task: TaskContext,
		results: () => readonly TaskResult[],
	) {
		this.signal = signal
		this.input = input
		this.task = task
		this.#results = results
	}

	get aborted(): boolean {
		return this.signal.aborted
	}

	results(): readonly TaskResult[] {
		return this.#results()
	}
}
