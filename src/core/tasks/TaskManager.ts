import type { Result } from '@orkestrel/contract'
import type { TaskInterface, TaskManagerInterface, TaskUpdate } from '../types.js'
import { compileGuard } from '@orkestrel/contract'
import { WorkflowError } from '../errors.js'
import { taskUpdateShape } from '../shapers.js'

// The compiled guard validating a `TaskUpdate` patch (AGENTS §14) before it reaches
// `update`'s `task.patch` call — a module-scope constant would be a stray non-exported
// centralized-file member, so it is compiled once here as a private field instead.
const isTaskUpdate = compileGuard(taskUpdateShape)

/**
 * The lean child manager (AGENTS §9) of a {@link import('../phases/Phase.js').Phase}'s live
 * tasks — an insertion-ordered registry keyed by task `id`, so positional order is
 * preserved across an interior `skip` / `remove`.
 *
 * @remarks
 * - **Positional store.** Tasks live in an insertion-ordered `Map` keyed by `id`;
 *   `append` adds one at the end (the build-time wiring path), `task(id)` looks one up,
 *   `tasks()` lists them in positional order, `count` is the size. A `skip` is a STATUS
 *   change on a stored task (never a removal), so order survives it; a snapshot RESTORE
 *   re-`append`s in the snapshot's order, reproducing it exactly.
 * - **Gated mutation API (AGENTS §12).** `add` / `remove` / `move` / `update` are the
 *   graceful `Result` counterparts to `append`, gating ONLY on the target's OWN
 *   existence/status/id/bounds — a duplicate id, an absent/non-`pending` target, an
 *   out-of-bounds `index`, or a patch that fails {@link taskUpdateShape} validation all
 *   fail gracefully with a `MUTATION` {@link WorkflowError} instead of throwing.
 * - **No batch matrix.** A phase's tasks are a fixed positional set, so AGENTS §9.2 (the
 *   bulk verb overloads) is deliberately omitted — there is no `remove` family here.
 * - **Event-free.** A purely structural container — the live {@link TaskInterface}s own
 *   their own emitters; the manager observes nothing.
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
	readonly #tasks = new Map<string, TaskInterface>()

	get count(): number {
		return this.#tasks.size
	}

	append(task: TaskInterface): void {
		if (this.#tasks.has(task.id)) {
			throw new WorkflowError('MUTATION', `duplicate task id '${task.id}'`, { id: task.id })
		}
		this.#tasks.set(task.id, task)
	}

	add(task: TaskInterface, index?: number): Result<TaskInterface, WorkflowError> {
		if (this.#tasks.has(task.id)) {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `duplicate task id '${task.id}'`, { id: task.id }),
			}
		}
		const at = index ?? this.#tasks.size
		if (at < 0 || at > this.#tasks.size) {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `index '${at}' out of bounds`, { index: at }),
			}
		}
		const entries = [...this.#tasks.entries()]
		entries.splice(at, 0, [task.id, task])
		this.#reorder(entries)
		return { success: true, value: task }
	}

	remove(id: string): Result<TaskInterface, WorkflowError> {
		const target = this.#tasks.get(id)
		if (target === undefined || target.status !== 'pending') {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `task '${id}' is not a pending task`, { id }),
			}
		}
		this.#tasks.delete(id)
		return { success: true, value: target }
	}

	move(id: string, index: number): Result<TaskInterface, WorkflowError> {
		const target = this.#tasks.get(id)
		if (target === undefined || target.status !== 'pending') {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `task '${id}' is not a pending task`, { id }),
			}
		}
		if (index < 0 || index >= this.#tasks.size) {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `index '${index}' out of bounds`, { index }),
			}
		}
		const entries = [...this.#tasks.entries()]
		const at = entries.findIndex(([key]) => key === id)
		const [entry] = entries.splice(at, 1)
		if (entry !== undefined) entries.splice(index, 0, entry)
		this.#reorder(entries)
		return { success: true, value: target }
	}

	update(id: string, patch: TaskUpdate): Result<TaskInterface, WorkflowError> {
		const target = this.#tasks.get(id)
		if (target === undefined || target.status !== 'pending') {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `task '${id}' is not a pending task`, { id }),
			}
		}
		if (!isTaskUpdate(patch)) {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `invalid patch for task '${id}'`, { id }),
			}
		}
		target.patch(patch)
		return { success: true, value: target }
	}

	task(id: string): TaskInterface | undefined {
		return this.#tasks.get(id)
	}

	tasks(): readonly TaskInterface[] {
		return [...this.#tasks.values()]
	}

	// Rebuild the positional store from `entries` — the shared reorder step behind
	// `add` (insert) and `move` (reposition), keeping the `Map`'s insertion order the
	// single source of positional truth.
	#reorder(entries: readonly (readonly [string, TaskInterface])[]): void {
		this.#tasks.clear()
		for (const [key, value] of entries) this.#tasks.set(key, value)
	}
}
