import type { Result } from '@orkestrel/contract'
import type { TaskInterface, TaskManagerInterface, TaskUpdate } from '../types.js'
import type { WorkflowError } from '../errors.js'
import { compileGuard } from '@orkestrel/contract'
import { Collection } from '../Collection.js'
import { taskUpdateShape } from '../shapers.js'

/**
 * Implements the lean child manager of a {@link import('../phases/Phase.js').Phase}'s live
 * tasks — the task vocabulary over one insertion-ordered {@link Collection}, so positional order
 * is preserved across an interior `skip` / `remove`.
 *
 * @remarks
 * - **One shared store.** The insertion-ordered `Map`, the reorder step, the bounds checks, and
 *   the gated `add` / `remove` / `move` / `update` all live in {@link Collection}, built with the
 *   `task` noun its refusals name and the compiled {@link taskUpdateShape} guard. This class adds
 *   the domain accessors `task` / `tasks` and nothing else, so the task and phase managers cannot
 *   drift apart.
 * - **Positional store.** `append` adds one live {@link TaskInterface} at the end (the build-time
 *   wiring path), `task(id)` looks one up, `tasks()` lists them in positional order, `count` is
 *   the tally. A `skip` is a STATUS change on a stored task (never a removal), so order survives
 *   it; a snapshot RESTORE re-`append`s in the snapshot's order, reproducing it exactly.
 * - **Gated mutation API.** `add` / `remove` / `move` / `update` are the graceful
 *   `Result` counterparts to `append`, gating ONLY on the target's OWN existence/status/id/bounds
 *   — a duplicate id, an absent/non-`pending` target, an out-of-bounds `index`, or a patch that
 *   fails {@link taskUpdateShape} validation all fail gracefully with a `MUTATION`
 *   {@link WorkflowError} instead of throwing.
 * - **No batch matrix.** A phase's tasks are a fixed positional set, so
 *   `.claude/rules/patterns.md` § Batch operations (the bulk verb
 *   overloads) is deliberately omitted — no `remove` family lives here.
 * - **Event-free.** A purely structural container — the live {@link TaskInterface}s own their own
 *   emitters; the manager observes nothing.
 *
 * @example
 * ```ts
 * const tasks = new TaskManager()
 * tasks.append(task) // a live Task
 * tasks.task(task.id) // the same task
 * tasks.count // 1
 * ```
 */
export class TaskManager implements TaskManagerInterface {
	readonly #tasks = new Collection<TaskInterface, TaskUpdate>('task', compileGuard(taskUpdateShape))

	get count(): number {
		return this.#tasks.count
	}

	append(task: TaskInterface): void {
		this.#tasks.append(task)
	}

	add(task: TaskInterface, index?: number): Result<TaskInterface, WorkflowError> {
		return this.#tasks.add(task, index)
	}

	remove(id: string): Result<TaskInterface, WorkflowError> {
		return this.#tasks.remove(id)
	}

	move(id: string, index: number): Result<TaskInterface, WorkflowError> {
		return this.#tasks.move(id, index)
	}

	update(id: string, patch: TaskUpdate): Result<TaskInterface, WorkflowError> {
		return this.#tasks.update(id, patch)
	}

	task(id: string): TaskInterface | undefined {
		return this.#tasks.entry(id)
	}

	tasks(): readonly TaskInterface[] {
		return this.#tasks.entries()
	}
}
