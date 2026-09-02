import type {
	WorkflowDefinition,
	WorkflowFunctions,
	WorkflowInterface,
	WorkflowManagerInterface,
	WorkflowManagerOptions,
	WorkflowOptions,
	WorkflowSnapshot,
	WorkflowStoreInterface,
} from './types.js'
import { isArray } from '@orkestrel/contract'
import { cloneWorkflowSnapshot } from './cloners.js'
import { createWorkflowTree } from './factories.js'
import { captureWorkflowOptions } from './helpers.js'
import { Workflow } from './Workflow.js'

/**
 * The store-backed registry of {@link WorkflowInterface}s keyed by `id`, in insertion order —
 * the additive manager tier mirroring the `@orkestrel/agent` line's `ConversationManager` /
 * `WorkspaceManager`. Event-free (a registry, like its twins); the observability lives on each
 * {@link WorkflowInterface}.
 *
 * @remarks
 * - **Registry.** Workflows live in an insertion-ordered `Map` keyed by `id`. `add(definition)`
 *   mints a live {@link WorkflowInterface} through the same construction path
 *   {@link import('./factories.js').createWorkflow} takes (flowing the manager's
 *   `functions` registry in) and stores it under `definition.id` — an already-present id
 *   OVERWRITES (last write wins). `count` is the map size, `workflow(id)` looks one up,
 *   `workflows()` lists them in insertion order.
 * - **Durable open / save.** `open(id)` returns an already-registered workflow directly; same-id
 *   misses share one hydration. A concurrent `add` wins, while `remove` / `clear` invalidate
 *   earlier reads; wrong-key payloads reject with `RESTORE`. `save(id)` captures a registered
 *   workflow's snapshot at invocation and serializes same-id writes without coupling other ids.
 *   Both remain lenient without a store or registered id.
 * - **Removal.** `remove` drops one by id, or a batch (§9.2, array overload FIRST) — `true` when
 *   any was removed. `clear` empties the registry.
 * - **No active pointer.** Unlike its `ConversationManager` / `WorkspaceManager` twins, there is
 *   no `active` / `switch` — nothing in the workflow domain renders "the current workflow".
 *
 * @example
 * ```ts
 * const manager = new WorkflowManager({
 * 	functions: { compile: async (controller) => `built ${controller.task.id}` },
 * })
 * const workflow = manager.add(definition) // minted, registered, RUNNABLE
 * manager.workflow(workflow.id) // the same workflow
 * manager.count // 1
 * ```
 */
export class WorkflowManager implements WorkflowManagerInterface {
	readonly #workflows = new Map<string, WorkflowInterface>()
	readonly #opens = new Map<string, Promise<WorkflowInterface | undefined>>()
	readonly #saves = new Map<string, Promise<void>>()
	readonly #mutations = new Map<string, symbol>()
	readonly #additions = new Map<string, symbol>()
	readonly #hydrations = new Map<string, Set<symbol>>()
	#generation = Symbol()
	// The functions registry flowed into every workflow this manager mints or hydrates, so
	// each live task's `behavior` resolves to a real `handler` (RUNNABLE) rather than the
	// inspectable unresolved state; the runner rejects it until matching functions are supplied.
	readonly #functions: WorkflowFunctions | undefined
	// The optional durable store backing `open` / `save`; `undefined` ⇒ registry-only (both lenient).
	readonly #store: WorkflowStoreInterface | undefined

	constructor(options?: WorkflowManagerOptions) {
		this.#functions = options?.functions
		this.#store = options?.store
	}

	get count(): number {
		return this.#workflows.size
	}

	workflow(id: string): WorkflowInterface | undefined {
		return this.#workflows.get(id)
	}

	workflows(): readonly WorkflowInterface[] {
		return [...this.#workflows.values()]
	}

	add(definition: WorkflowDefinition): WorkflowInterface {
		// Mints keyed by the definition's own id — a re-add under the same id overwrites,
		// exactly as `createWorkflow` keys the live tree by `definition.id`.
		const workflow = this.#build(definition)
		const mutation = this.#invalidate(workflow.id)
		if (mutation === undefined) this.#additions.delete(workflow.id)
		else this.#additions.set(workflow.id, mutation)
		this.#workflows.set(workflow.id, workflow)
		return workflow
	}

	open(id: string): Promise<WorkflowInterface | undefined> {
		// Already registered ⇒ the registry is the live source, no store hit.
		const existing = this.#workflows.get(id)
		if (existing !== undefined) return Promise.resolve(existing)
		// No store ⇒ a registry miss resolves nothing (lenient).
		if (this.#store === undefined) return Promise.resolve(undefined)
		const pending = this.#opens.get(id)
		if (pending !== undefined) return pending
		const mutation = this.#mutations.get(id)
		const generation = this.#generation
		const lease = this.#retain(id)
		const reservation = Promise.withResolvers<WorkflowInterface | undefined>()
		const opening = reservation.promise
		// Reserve identity before hydration can synchronously cross the external store boundary.
		this.#opens.set(id, opening)
		void this.#hydrate(id, mutation, generation, lease, this.#store).then(
			reservation.resolve,
			reservation.reject,
		)
		void opening.then(
			() => this.#releaseOpen(id, opening),
			() => this.#releaseOpen(id, opening),
		)
		return opening
	}

	save(id: string): Promise<boolean> {
		// Lenient: persist only when a store is set AND the id is registered; otherwise a no-op.
		const workflow = this.#workflows.get(id)
		if (this.#store === undefined || workflow === undefined) return Promise.resolve(false)
		const snapshot = workflow.snapshot()
		const previous = this.#saves.get(id)
		const reservation = Promise.withResolvers<void>()
		const saving = reservation.promise
		// Reserve the serialization predecessor before persistence can synchronously reenter.
		this.#saves.set(id, saving)
		void this.#persist(this.#store, previous, snapshot).then(
			reservation.resolve,
			reservation.reject,
		)
		void saving.then(
			() => this.#settle(id, saving),
			() => this.#settle(id, saving),
		)
		return saving.then(() => true)
	}

	// §9.2: the array overload FIRST, so a list resolves to the batch form.
	remove(ids: readonly string[]): boolean
	remove(id: string): boolean
	remove(ids: string | readonly string[]): boolean {
		if (isArray(ids)) {
			let removed = false
			for (const id of ids) {
				this.#invalidate(id)
				this.#additions.delete(id)
				if (this.#workflows.delete(id)) removed = true
			}
			return removed
		}
		this.#invalidate(ids)
		this.#additions.delete(ids)
		return this.#workflows.delete(ids)
	}

	clear(): void {
		this.#generation = Symbol()
		this.#mutations.clear()
		this.#additions.clear()
		this.#opens.clear()
		this.#workflows.clear()
	}

	async #hydrate(
		id: string,
		mutation: symbol | undefined,
		generation: symbol,
		lease: symbol,
		store: WorkflowStoreInterface,
	): Promise<WorkflowInterface | undefined> {
		try {
			const snapshot = await store.get(id)
			if (!this.#owns(id, mutation, generation)) return this.#resolve(id, generation)
			if (snapshot === undefined) return undefined
			let owned: WorkflowSnapshot
			try {
				owned = cloneWorkflowSnapshot(snapshot, id)
			} catch (error) {
				if (!this.#owns(id, mutation, generation)) return this.#resolve(id, generation)
				throw error
			}
			if (!this.#owns(id, mutation, generation)) return this.#resolve(id, generation)
			let workflow: WorkflowInterface
			try {
				workflow = this.#restore(owned)
			} catch (error) {
				if (!this.#owns(id, mutation, generation)) return this.#resolve(id, generation)
				throw error
			}
			if (!this.#owns(id, mutation, generation)) return this.#resolve(id, generation)
			return this.#register(id, workflow, mutation, generation)
		} finally {
			this.#releaseHydration(id, lease)
		}
	}

	// Build the live tree through the one shared construction path `createWorkflow` and the
	// runner also take, so a minted workflow can never drift from a directly built one.
	#build(definition: WorkflowDefinition): WorkflowInterface {
		const captured = this.#captured()
		return createWorkflowTree(definition, captured.bail, captured)
	}

	// Rebuild the live tree from an already-owned snapshot exactly as `createRestoredWorkflow`
	// does — the hostile-boundary clone stays, so a hydrated tree is owned by this manager rather
	// than sharing the store's payload.
	#restore(snapshot: WorkflowSnapshot): WorkflowInterface {
		return new Workflow(cloneWorkflowSnapshot(snapshot), this.#captured())
	}

	// The owned construction options every mint and hydrate carries — this manager's retained
	// `functions` registry and nothing else.
	#captured(): WorkflowOptions {
		return captureWorkflowOptions(
			this.#functions === undefined ? {} : { functions: this.#functions },
		)
	}

	#owns(id: string, mutation: symbol | undefined, generation: symbol): boolean {
		return this.#generation === generation && this.#mutations.get(id) === mutation
	}

	#resolve(id: string, generation: symbol): WorkflowInterface | undefined {
		if (this.#generation !== generation) return undefined
		const mutation = this.#mutations.get(id)
		const workflow = this.#workflows.get(id)
		return workflow !== undefined && this.#additions.get(id) === mutation ? workflow : undefined
	}

	#register(
		id: string,
		workflow: WorkflowInterface,
		mutation: symbol | undefined,
		generation: symbol,
	): WorkflowInterface | undefined {
		if (!this.#owns(id, mutation, generation)) return this.#resolve(id, generation)
		this.#workflows.set(id, workflow)
		return workflow
	}

	async #persist(
		store: WorkflowStoreInterface,
		previous: Promise<void> | undefined,
		snapshot: WorkflowSnapshot,
	): Promise<void> {
		if (previous !== undefined) {
			try {
				await previous
			} catch {
				// The prior caller owns its rejection; this invocation still reaches the store.
			}
		}
		await store.set(snapshot)
	}

	#invalidate(id: string): symbol | undefined {
		this.#opens.delete(id)
		if (!this.#hydrations.has(id)) {
			this.#mutations.delete(id)
			this.#additions.delete(id)
			return undefined
		}
		const mutation = Symbol()
		this.#mutations.set(id, mutation)
		return mutation
	}

	#retain(id: string): symbol {
		const lease = Symbol()
		const hydrations = this.#hydrations.get(id)
		if (hydrations === undefined) this.#hydrations.set(id, new Set([lease]))
		else hydrations.add(lease)
		return lease
	}

	#releaseOpen(id: string, opening: Promise<WorkflowInterface | undefined>): void {
		if (this.#opens.get(id) === opening) this.#opens.delete(id)
	}

	#releaseHydration(id: string, lease: symbol): void {
		const hydrations = this.#hydrations.get(id)
		if (hydrations === undefined) return
		hydrations.delete(lease)
		if (hydrations.size !== 0) return
		this.#hydrations.delete(id)
		this.#mutations.delete(id)
		this.#additions.delete(id)
	}

	#settle(id: string, saving: Promise<void>): void {
		if (this.#saves.get(id) === saving) this.#saves.delete(id)
	}
}
