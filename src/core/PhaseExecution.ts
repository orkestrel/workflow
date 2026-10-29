import type { PhaseExecutionInterface, TaskInterface } from './types.js'

/** Owns task launch membership, attempt counts, and active claims for one phase execution. */
export class PhaseExecution implements PhaseExecutionInterface {
	readonly #launched = new Set<string>()
	readonly #attempts = new Map<string, number>()
	readonly #owners = new Map<string, number>()

	get launched(): ReadonlySet<string> {
		return this.#launched
	}

	get attempts(): ReadonlyMap<string, number> {
		return this.#attempts
	}

	get owners(): ReadonlyMap<string, number> {
		return this.#owners
	}

	add(task: TaskInterface): void {
		this.#launched.add(task.id)
	}

	restore(task: TaskInterface): void {
		this.#attempts.set(task.id, task.attempts)
	}

	record(task: TaskInterface): number {
		const attempt = (this.#attempts.get(task.id) ?? 0) + 1
		this.#attempts.set(task.id, attempt)
		return attempt
	}

	claim(task: TaskInterface, attempt: number): void {
		this.#owners.set(task.id, attempt)
	}

	revoke(id: string, attempt: number): void {
		if (this.#owners.get(id) === attempt) this.#owners.delete(id)
	}
}
