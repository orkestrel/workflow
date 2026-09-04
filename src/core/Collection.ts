import type { Guard, Result } from '@orkestrel/contract'
import type { CollectionEntry, CollectionInterface } from './types.js'
import { WorkflowError } from './errors.js'
import { failure, insertEntry, moveEntry, success } from './helpers.js'

/**
 * Implements the insertion-ordered gated store both lean managers hold — entities keyed by `id`,
 * positional order preserved across an interior `skip` or `remove`.
 *
 * @remarks
 * - **One engine, two managers.** {@link import('./tasks/TaskManager.js').TaskManager} and
 *   {@link import('./phases/PhaseManager.js').PhaseManager} differ only in the entity noun and the
 *   patch shape they validate, so both hold one of these and add only their domain accessors
 *   (`task` / `tasks`, `phase` / `phases`). The `Map`'s insertion order is the single source of
 *   positional truth; `add` and `move` rebuild it through the pure
 *   {@link import('./helpers.js').insertEntry} / {@link import('./helpers.js').moveEntry} leaves.
 * - **Gated mutation API.** `append` is the build-time wiring path and THROWS on a
 *   duplicate id; `add` / `remove` / `move` / `update` return a graceful `MUTATION`
 *   {@link WorkflowError} failure instead. Gating reads ONLY the target's own existence, `pending`
 *   status, id, and bounds — a container's own status is the owning entity's gate, applied before
 *   it delegates here.
 * - **Event-free.** A purely structural container; the entity that owns it emits on success.
 *
 * @typeParam TEntry - The stored entity
 * @typeParam TPatch - The declarative partial update `update` validates and applies
 *
 * @example
 * ```ts
 * import { compileGuard } from '@orkestrel/contract'
 * import { Collection, taskUpdateShape } from '@orkestrel/workflow'
 * import type { TaskInterface, TaskUpdate } from '@orkestrel/workflow'
 *
 * const tasks = new Collection<TaskInterface, TaskUpdate>('task', compileGuard(taskUpdateShape))
 * tasks.append(task) // a live Task
 * tasks.entry(task.id) // the same task
 * tasks.entries() // [task]
 * tasks.count // 1
 * tasks.add(other, 0) // Result — inserted first
 * tasks.move(other.id, 1) // Result — repositioned
 * tasks.update(task.id, { name: 'Renamed task' }) // Result — patched
 * tasks.remove(other.id) // Result — dropped
 * ```
 */
export class Collection<
	TEntry extends CollectionEntry<TPatch>,
	TPatch,
> implements CollectionInterface<TEntry, TPatch> {
	readonly #entries = new Map<string, TEntry>()
	// The entity noun every refusal message names, so a task store and a phase store report the
	// same gate in their own vocabulary.
	readonly #noun: string
	// The compiled guard validating a patch before it reaches the entity's own `patch`.
	readonly #isPatch: Guard<TPatch>

	constructor(noun: string, patch: Guard<TPatch>) {
		this.#noun = noun
		this.#isPatch = patch
	}

	get count(): number {
		return this.#entries.size
	}

	append(entry: TEntry): void {
		if (this.#entries.has(entry.id)) {
			throw new WorkflowError('MUTATION', `duplicate ${this.#noun} id '${entry.id}'`, {
				id: entry.id,
			})
		}
		this.#entries.set(entry.id, entry)
	}

	add(entry: TEntry, index?: number): Result<TEntry, WorkflowError> {
		if (this.#entries.has(entry.id)) {
			return failure(
				new WorkflowError('MUTATION', `duplicate ${this.#noun} id '${entry.id}'`, {
					id: entry.id,
				}),
			)
		}
		const at = index ?? this.#entries.size
		if (at < 0 || at > this.#entries.size) {
			return failure(new WorkflowError('MUTATION', `index '${at}' out of bounds`, { index: at }))
		}
		this.#reorder(insertEntry([...this.#entries.entries()], at, entry.id, entry))
		return success(entry)
	}

	remove(id: string): Result<TEntry, WorkflowError> {
		const target = this.#pending(id)
		if (target === undefined) return this.#refuse(id)
		this.#entries.delete(id)
		return success(target)
	}

	move(id: string, index: number): Result<TEntry, WorkflowError> {
		const target = this.#pending(id)
		if (target === undefined) return this.#refuse(id)
		if (index < 0 || index >= this.#entries.size) {
			return failure(new WorkflowError('MUTATION', `index '${index}' out of bounds`, { index }))
		}
		this.#reorder(moveEntry([...this.#entries.entries()], id, index))
		return success(target)
	}

	update(id: string, patch: TPatch): Result<TEntry, WorkflowError> {
		const target = this.#pending(id)
		if (target === undefined) return this.#refuse(id)
		if (!this.#isPatch(patch)) {
			return failure(
				new WorkflowError('MUTATION', `invalid patch for ${this.#noun} '${id}'`, { id }),
			)
		}
		target.patch(patch)
		return success(target)
	}

	entry(id: string): TEntry | undefined {
		return this.#entries.get(id)
	}

	entries(): readonly TEntry[] {
		return [...this.#entries.values()]
	}

	// The gate every targeted mutation shares: the entry exists AND is still `pending`. Returns the
	// entry so the caller reads state once, or `undefined` for the one refusal `#refuse` names.
	#pending(id: string): TEntry | undefined {
		const target = this.#entries.get(id)
		return target === undefined || target.status !== 'pending' ? undefined : target
	}

	#refuse(id: string): Result<TEntry, WorkflowError> {
		return failure(
			new WorkflowError('MUTATION', `${this.#noun} '${id}' is not a pending ${this.#noun}`, { id }),
		)
	}

	// Rebuild the positional store from `entries` — the shared reorder step behind `add` (insert)
	// and `move` (reposition), keeping the `Map`'s insertion order the single source of positional
	// truth.
	#reorder(entries: ReadonlyArray<readonly [string, TEntry]>): void {
		this.#entries.clear()
		for (const [key, value] of entries) this.#entries.set(key, value)
	}
}
