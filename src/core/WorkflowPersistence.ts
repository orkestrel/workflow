import type {
	PhaseInterface,
	TaskInterface,
	WorkflowCheckpoint,
	WorkflowFault,
	WorkflowInterface,
	WorkflowPersistenceInterface,
	WorkflowStoreInterface,
} from './types.js'
import { PERSISTED_NODE_EVENTS, PERSISTED_TASK_EVENTS } from './constants.js'
import { errorToMessage } from './helpers.js'

/**
 * Advanced run-local snapshot persistence with one writer and one coalesced latest obligation.
 *
 * @remarks
 * Normally composed by `WorkflowRunner.execute({ store })`; exported for hosts that need to
 * coordinate the same required boundaries around their own runner integration.
 */
export class WorkflowPersistence implements WorkflowPersistenceInterface {
	readonly #workflow: WorkflowInterface
	readonly #store: WorkflowStoreInterface
	readonly #phases = new Set<PhaseInterface>()
	readonly #tasks = new Set<TaskInterface>()
	// One bound change handler for every tier: the workflow, phase, and task subscriptions all
	// mark the same revision, so a handler per tier would be three names for one behavior.
	readonly #onChange: () => void
	readonly #onWorkflowAdd: (phase: PhaseInterface) => void
	readonly #onWorkflowRemove: (phase: PhaseInterface) => void
	readonly #onPhaseAdd: (task: TaskInterface) => void
	readonly #onPhaseRemove: (task: TaskInterface) => void
	#writing: Promise<void> | undefined
	#error: string | undefined
	#fault: WorkflowFault | undefined
	#attached = true
	#revision = 0
	#stored = 0

	constructor(workflow: WorkflowInterface, store: WorkflowStoreInterface) {
		this.#workflow = workflow
		this.#store = store
		this.#onChange = this.#change.bind(this)
		this.#onWorkflowAdd = this.#addPhase.bind(this)
		this.#onWorkflowRemove = this.#removePhase.bind(this)
		this.#onPhaseAdd = this.#addTask.bind(this)
		this.#onPhaseRemove = this.#removeTask.bind(this)
		this.#attachWorkflow()
	}

	get fault(): WorkflowFault | undefined {
		return this.#fault
	}

	/**
	 * Persist every change through this required boundary.
	 *
	 * @param checkpoint - The boundary being made durable
	 * @param task - The task owning an attempt or settlement
	 * @param attempt - The persisted attempt number
	 * @returns Whether the latest state reached the store
	 */
	async checkpoint(
		checkpoint: WorkflowCheckpoint,
		task?: TaskInterface,
		attempt?: number,
	): Promise<boolean> {
		const revision = this.#mark()
		while (this.#stored < revision) await this.#flush()
		if (this.#error === undefined) return true
		if (this.#fault === undefined) {
			this.#fault = Object.freeze({
				origin: 'persistence',
				checkpoint,
				message: this.#error,
				...(task === undefined ? {} : { task: task.id }),
				...(attempt === undefined ? {} : { attempt }),
			})
		}
		return false
	}

	/**
	 * Stop observing the live tree and persist its final state.
	 *
	 * @returns Whether the final snapshot reached the store
	 */
	async finalize(): Promise<boolean> {
		this.detach()
		return this.checkpoint('final')
	}

	/** Stop observing the live tree. */
	detach(): void {
		if (!this.#attached) return
		this.#attached = false
		for (const event of PERSISTED_NODE_EVENTS) this.#workflow.emitter.off(event, this.#onChange)
		this.#workflow.emitter.off('add', this.#onWorkflowAdd)
		this.#workflow.emitter.off('remove', this.#onWorkflowRemove)
		for (const phase of this.#phases) this.#detachPhase(phase)
	}

	#attachWorkflow(): void {
		for (const event of PERSISTED_NODE_EVENTS) this.#workflow.emitter.on(event, this.#onChange)
		this.#workflow.emitter.on('add', this.#onWorkflowAdd)
		this.#workflow.emitter.on('remove', this.#onWorkflowRemove)
		for (const phase of this.#workflow.phases.phases()) this.#attachPhase(phase)
	}

	#attachPhase(phase: PhaseInterface): void {
		if (this.#phases.has(phase)) return
		this.#phases.add(phase)
		for (const event of PERSISTED_NODE_EVENTS) phase.emitter.on(event, this.#onChange)
		phase.emitter.on('add', this.#onPhaseAdd)
		phase.emitter.on('remove', this.#onPhaseRemove)
		for (const task of phase.tasks.tasks()) this.#attachTask(task)
	}

	#detachPhase(phase: PhaseInterface): void {
		if (!this.#phases.delete(phase)) return
		for (const event of PERSISTED_NODE_EVENTS) phase.emitter.off(event, this.#onChange)
		phase.emitter.off('add', this.#onPhaseAdd)
		phase.emitter.off('remove', this.#onPhaseRemove)
		for (const task of phase.tasks.tasks()) this.#detachTask(task)
	}

	#attachTask(task: TaskInterface): void {
		if (this.#tasks.has(task)) return
		this.#tasks.add(task)
		for (const event of PERSISTED_TASK_EVENTS) task.emitter.on(event, this.#onChange)
	}

	#detachTask(task: TaskInterface): void {
		if (!this.#tasks.delete(task)) return
		for (const event of PERSISTED_TASK_EVENTS) task.emitter.off(event, this.#onChange)
	}

	#addPhase(phase: PhaseInterface): void {
		this.#attachPhase(phase)
		this.#change()
	}

	#removePhase(phase: PhaseInterface): void {
		this.#detachPhase(phase)
		this.#change()
	}

	#addTask(task: TaskInterface): void {
		this.#attachTask(task)
		this.#change()
	}

	#removeTask(task: TaskInterface): void {
		this.#detachTask(task)
		this.#change()
	}

	#change(): void {
		this.#mark()
		void this.#flush()
	}

	async #flush(): Promise<void> {
		if (this.#writing !== undefined) {
			await this.#writing
			return
		}
		const reservation = Promise.withResolvers<void>()
		const writing = reservation.promise
		// Reserve the writer before the drain can synchronously enter external store code.
		this.#writing = writing
		void this.#drain().then(reservation.resolve, reservation.reject)
		try {
			await writing
		} finally {
			if (this.#writing === writing) this.#writing = undefined
			if (this.#stored < this.#revision) void this.#flush()
		}
	}

	async #drain(): Promise<void> {
		while (this.#stored < this.#revision) {
			const revision = this.#revision
			try {
				await this.#store.set(this.#workflow.snapshot())
				this.#error = undefined
			} catch (error) {
				this.#error = errorToMessage(error)
			}
			this.#stored = revision
		}
	}

	#mark(): number {
		this.#revision += 1
		return this.#revision
	}
}
