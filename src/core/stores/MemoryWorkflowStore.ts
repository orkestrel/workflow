import type { WorkflowSnapshot, WorkflowStoreInterface } from '../types.js'

/**
 * The in-memory {@link WorkflowStoreInterface} — a process-lifetime `Map` of
 * {@link WorkflowSnapshot}s keyed by workflow id, the DEFAULT store
 * {@link import('../factories.js').createMemoryWorkflowStore} builds.
 *
 * @remarks
 * A plain `Map<string, WorkflowSnapshot>` (AGENTS §21 — the snapshot is already pure,
 * self-contained JSON, so no encoding is needed for the memory tier). UNLIKE the server
 * package's `SessionStoreInterface`'s memory store there is
 * NO idle-TTL and NO eviction: a persisted workflow run-state is durable orchestration state
 * that lives until an explicit `delete`, never silently aging out (a run that vanished
 * mid-flight would be a silent data loss, not a freed session). A durable backend (JSON /
 * SQLite / IndexedDB) swaps in through the SAME interface without touching the runner or the
 * entity tree — its driver-pluggable twin is
 * {@link import('./DatabaseWorkflowStore.js').DatabaseWorkflowStore} (the snapshot as one opaque
 * JSON column), exactly as `@orkestrel/queue`'s `MemoryQueueStore`
 * twins `DatabaseQueueStore`.
 *
 * - **`get` resolves the persisted snapshot for an id**, or `undefined` if none is stored.
 * - **`set` inserts / replaces under the snapshot's OWN `id`** (no separate id param).
 * - **`delete` drops a snapshot by id**; an absent id is a no-op (no throw).
 *
 * The public surface is EXACTLY `get` / `set` / `delete` — no extra members (the §22 method
 * bijection with {@link WorkflowStoreInterface}). Restore is a caller concern: read a snapshot
 * back and rebuild the live tree with {@link import('../factories.js').restoreWorkflow}.
 *
 * @example
 * ```ts
 * import { createMemoryWorkflowStore, createWorkflow, restoreWorkflow } from '@src/core'
 *
 * const store = createMemoryWorkflowStore()
 * const workflow = createWorkflow(definition)
 * await store.set(workflow.snapshot())      // persist the run state
 * const snapshot = await store.get(definition.id)
 * const restored = snapshot && restoreWorkflow(snapshot) // an identical live tree
 * await store.delete(definition.id)          // drop it
 * ```
 */
export class MemoryWorkflowStore implements WorkflowStoreInterface {
	readonly #snapshots = new Map<string, WorkflowSnapshot>()

	get(id: string): Promise<WorkflowSnapshot | undefined> {
		return Promise.resolve(this.#snapshots.get(id))
	}

	set(snapshot: WorkflowSnapshot): Promise<void> {
		// Insert / replace under the snapshot's OWN id (no separate id param).
		this.#snapshots.set(snapshot.id, snapshot)
		return Promise.resolve()
	}

	delete(id: string): Promise<void> {
		// Drop by id; `Map.delete` of an absent id is already a no-op (no throw).
		this.#snapshots.delete(id)
		return Promise.resolve()
	}
}
