import type {
	TaskActivity,
	TaskActivityInput,
	TaskContext,
	TaskControllerInterface,
	TaskInterface,
	TaskResult,
} from '../types.js'
import type { JSONRecord, Result } from '@orkestrel/contract'
import type { WorkflowError } from '../errors.js'
import { isTerminalStatus } from '../helpers.js'

/**
 * The attempt-scoped handle a {@link import('./types.js').WorkflowFunction} receives.
 *
 * @remarks
 * - **A leaf handle, NOT the runner `Controller`.** A workflow task is a leaf of the
 *   declarative W-b tree, not a fan-out unit, so it has no `spawn`; its `wait` instead
 *   checkpoints the workflow, phase, and task cooperative gates.
 * - **Folded signal.** `signal` is the cancellation folded for THIS attempt: its per-attempt
 *   deadline, task stop/skip, workflow abort/timeout/budget/destroy, or a sibling fail-fast.
 *   A handler races its work against it; `aborted` reads it.
 * - **Attempt ownership.** `report` / `pulse` are closures supplied by the runner and refuse
 *   after this signal aborts or a retry token supersedes this handle.
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
	readonly input: JSONRecord
	readonly task: TaskContext
	readonly attempt: number
	readonly #entity: TaskInterface
	readonly #report: (input: TaskActivityInput) => Result<TaskActivity, WorkflowError>
	readonly #pulse: () => boolean
	// Read the live workflow's settled results on demand — a closure injected by the runner,
	// so the handle reaches UP the tree without holding a back-reference to the workflow entity.
	readonly #results: () => readonly TaskResult[]

	constructor(
		signal: AbortSignal,
		input: JSONRecord,
		task: TaskInterface,
		attempt: number,
		results: () => readonly TaskResult[],
		report: (input: TaskActivityInput) => Result<TaskActivity, WorkflowError>,
		pulse: () => boolean,
	) {
		this.signal = signal
		this.input = input
		this.task = task.context
		this.attempt = attempt
		this.#entity = task
		this.#results = results
		this.#report = report
		this.#pulse = pulse
	}

	get aborted(): boolean {
		return this.signal.aborted
	}

	get paused(): boolean {
		if (this.#ancestorTerminal()) return false
		return (
			this.#entity.workflow.paused ||
			this.#entity.phase.paused ||
			(!isTerminalStatus(this.#entity.status) && this.#entity.paused)
		)
	}

	report(input: TaskActivityInput): Result<TaskActivity, WorkflowError> {
		return this.#report(input)
	}

	pulse(): boolean {
		return this.#pulse()
	}

	async wait(): Promise<void> {
		while (this.paused && !this.signal.aborted) {
			await this.#race(this.#gates())
		}
	}

	results(): readonly TaskResult[] {
		return this.#results()
	}

	#gates(): ReadonlyArray<Promise<void>> {
		if (this.#ancestorTerminal()) return []
		const gates: Array<Promise<void>> = []
		if (this.#entity.workflow.paused) gates.push(this.#entity.workflow.wait())
		if (this.#entity.phase.paused) gates.push(this.#entity.phase.wait())
		if (!isTerminalStatus(this.#entity.status) && this.#entity.paused) {
			gates.push(this.#entity.wait())
		}
		return gates
	}

	async #race(gates: ReadonlyArray<Promise<void>>): Promise<void> {
		if (this.signal.aborted || gates.length === 0) return
		const deferred = Promise.withResolvers<void>()
		const onAbort = this.#resolve.bind(this, deferred)
		const onTerminal = this.#resolve.bind(this, deferred)
		this.signal.addEventListener('abort', onAbort, { once: true })
		this.#entity.workflow.emitter.on('skip', onTerminal)
		this.#entity.workflow.emitter.on('stop', onTerminal)
		this.#entity.phase.emitter.on('skip', onTerminal)
		this.#entity.phase.emitter.on('stop', onTerminal)
		try {
			if (this.#ancestorTerminal()) deferred.resolve()
			await Promise.race([Promise.all(gates), deferred.promise])
		} finally {
			this.signal.removeEventListener('abort', onAbort)
			this.#entity.workflow.emitter.off('skip', onTerminal)
			this.#entity.workflow.emitter.off('stop', onTerminal)
			this.#entity.phase.emitter.off('skip', onTerminal)
			this.#entity.phase.emitter.off('stop', onTerminal)
		}
	}

	#ancestorTerminal(): boolean {
		return (
			isTerminalStatus(this.#entity.workflow.status) || isTerminalStatus(this.#entity.phase.status)
		)
	}

	#resolve(deferred: PromiseWithResolvers<void>): void {
		deferred.resolve()
	}
}
