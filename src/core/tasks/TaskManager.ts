import type { TaskInterface, TaskManagerInterface } from '../types.js'

/**
 * The lean child manager (AGENTS §9) of a {@link import('../Phase.js').Phase}'s live
 * tasks — an insertion-ordered registry keyed by task `id`, so positional order is
 * preserved across an interior `skip` / `remove`.
 *
 * @remarks
 * - **Positional store.** Tasks live in an insertion-ordered `Map` keyed by `id`;
 *   `append` adds one at the end (the build-time wiring path), `task(id)` looks one up,
 *   `tasks()` lists them in positional order, `count` is the size. A `skip` is a STATUS
 *   change on a stored task (never a removal), so order survives it; a snapshot RESTORE
 *   re-`append`s in the snapshot's order, reproducing it exactly.
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
		this.#tasks.set(task.id, task)
	}

	task(id: string): TaskInterface | undefined {
		return this.#tasks.get(id)
	}

	tasks(): readonly TaskInterface[] {
		return [...this.#tasks.values()]
	}
}
