import type {
	WorkflowDefinition,
	WorkflowFunctions,
	WorkflowInterface,
	WorkflowManagerInterface,
	WorkflowManagerOptions,
	WorkflowStoreInterface,
} from './types.js'
import { isArray } from '@orkestrel/contract'
import { createWorkflow, restoreWorkflow } from './factories.js'

/**
 * The store-backed registry of {@link WorkflowInterface}s keyed by `id`, in insertion order —
 * the additive manager tier mirroring the `@orkestrel/agent` line's `ConversationManager` /
 * `WorkspaceManager`. Event-free (a registry, like its twins); the observability lives on each
 * {@link WorkflowInterface}.
 *
 * @remarks
 * - **Registry.** Workflows live in an insertion-ordered `Map` keyed by `id`. `add(definition)`
 *   mints a live {@link WorkflowInterface} through {@link createWorkflow} (flowing the manager's
 *   `functions` registry in) and stores it under `definition.id` — an already-present id
 *   OVERWRITES (last write wins). `count` is the map size, `workflow(id)` looks one up,
 *   `workflows()` lists them in insertion order.
 * - **Durable open / save.** `open(id)` returns an already-registered workflow directly; on a
 *   registry MISS with a `store` set it rehydrates through {@link restoreWorkflow} (flowing the
 *   manager's `functions` registry in so the rehydrated tree is RUNNABLE), registers it, and
 *   returns it — lenient (`undefined`) with no store or a store miss. `save(id)` persists a
 *   registered workflow's `snapshot()` to the `store` — lenient (`false`) with no store or an
 *   unknown id.
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
	// The functions registry flowed into every workflow this manager mints or hydrates, so
	// each live task's `run` resolves to a real `handler` (RUNNABLE) rather than the
	// no-handler auto-complete path.
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
		const workflow = createWorkflow(definition, { functions: this.#functions })
		this.#workflows.set(workflow.id, workflow)
		return workflow
	}

	async open(id: string): Promise<WorkflowInterface | undefined> {
		// Already registered ⇒ the registry is the live source, no store hit.
		const existing = this.#workflows.get(id)
		if (existing !== undefined) return existing
		// No store ⇒ a registry miss resolves nothing (lenient).
		if (this.#store === undefined) return undefined
		// Store hit ⇒ rehydrate through restoreWorkflow, flowing this manager's `functions`
		// registry in so the rehydrated tree is RUNNABLE (a restored tree is otherwise inert).
		const snapshot = await this.#store.get(id)
		if (snapshot === undefined) return undefined
		const workflow = restoreWorkflow(snapshot, { functions: this.#functions })
		this.#workflows.set(workflow.id, workflow)
		return workflow
	}

	async save(id: string): Promise<boolean> {
		// Lenient: persist only when a store is set AND the id is registered; otherwise a no-op.
		const workflow = this.#workflows.get(id)
		if (this.#store === undefined || workflow === undefined) return false
		await this.#store.set(workflow.snapshot())
		return true
	}

	// §9.2: the array overload FIRST, so a list resolves to the batch form.
	remove(ids: readonly string[]): boolean
	remove(id: string): boolean
	remove(ids: string | readonly string[]): boolean {
		if (isArray(ids)) {
			let removed = false
			for (const id of ids) {
				if (this.#workflows.delete(id)) removed = true
			}
			return removed
		}
		return this.#workflows.delete(ids)
	}

	clear(): void {
		this.#workflows.clear()
	}
}
