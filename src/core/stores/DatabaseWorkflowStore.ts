import type { TableInterface } from '@orkestrel/database'
import type { WorkflowSnapshot, WorkflowSnapshotRow, WorkflowStoreInterface } from '../types.js'
import { cloneWorkflowSnapshot } from '../cloners.js'

/**
 * A {@link WorkflowStoreInterface} backed by one table of the `databases` layer — a
 * workflow's durable run-state IS a row, so persistence reduces to keyed point-access
 * (`get` / `set` / `delete`) over a `TableInterface`, the driver-pluggable twin of the
 * plain-`Map` {@link import('./MemoryWorkflowStore.js').MemoryWorkflowStore}.
 *
 * @remarks
 * The store is driver-agnostic: it holds a single {@link TableInterface} whose backend
 * (memory, JSON, SQLite, IndexedDB) is chosen by whoever builds it (the factories), so a
 * JSON / SQLite / IndexedDB backend swaps in WITHOUT touching the runner or the entity tree
 * — the same seam as `@orkestrel/queue`'s `DatabaseQueueStore`.
 * The driver defaults to memory ({@link import('../factories.js').createDatabaseWorkflowStore}
 * passes `createMemoryDriver()`), so it ALSO works in memory out of the box; you opt into the
 * durable plumbing by passing a JSON / SQLite / IndexedDB driver.
 *
 * The {@link WorkflowSnapshot} is stored as ONE OPAQUE JSON COLUMN — the table is a row of
 * `{ id; snapshot }` ({@link WorkflowSnapshotRow}), the snapshot the whole JSON blob (a `rawShape`
 * column the factory builds) — exactly as `DatabaseQueueStore` stores its `input`. The snapshot is
 * already a COMPLETE, self-contained, pure-JSON payload, so storing it whole is lossless AND
 * sidesteps a TS2589 instantiation-depth blow-up: a structured multi-column table would force the
 * contract to `Infer` the deeply-nested snapshot shape (workflow → phases → tasks → results),
 * tripping the compiler — one JSON column keeps the row type flat (`snapshot` reads back as `unknown`).
 *
 * - **`set(snapshot)` upserts under the snapshot's OWN `id`** (no separate id param) — it writes
 *   the row `{ id: snapshot.id, snapshot }`.
 * - **`get(id)` resolves the stored snapshot for an id**, owning and narrowing the opaque JSON
 *   column back to a {@link WorkflowSnapshot} through
 *   {@link import('../cloners.js').cloneWorkflowSnapshot}, whose semantic pass is
 *   {@link import('../validators.js').isOwnedWorkflowSnapshot} — the AGENTS §14 boundary narrow for
 *   an untrusted storage read — or `undefined` if none is stored. A present snapshot whose own id
 *   differs from the requested key rejects with normalized `RESTORE` evidence.
 * - **`delete(id)` drops a snapshot by id**; an absent id is a no-op (no throw).
 *
 * UNLIKE the server package's `SessionStoreInterface` there is NO
 * idle-TTL / eviction — a persisted run-state is durable orchestration state that lives until an
 * explicit `delete`. The public surface is EXACTLY `get` / `set` / `delete` — no extra members (the
 * §22 method bijection with {@link WorkflowStoreInterface}). Restore stays a caller concern: read a
 * snapshot back and rebuild the live tree with {@link import('../factories.js').createRestoredWorkflow}.
 *
 * @example
 * ```ts
 * import { createMemoryDriver } from '@orkestrel/database'
 * import { createDatabaseWorkflowStore, createWorkflow, createRestoredWorkflow } from '@orkestrel/workflow'
 *
 * const store = createDatabaseWorkflowStore(createMemoryDriver()) // a durable driver swaps in here
 * const workflow = createWorkflow(definition)
 * await store.set(workflow.snapshot())            // persist the run state (one JSON column)
 * const snapshot = await store.get(definition.id)
 * const restored = snapshot && createRestoredWorkflow(snapshot) // an identical live tree
 * await store.delete(definition.id)                // drop it
 * ```
 */
export class DatabaseWorkflowStore implements WorkflowStoreInterface {
	readonly #table: TableInterface<WorkflowSnapshotRow>

	/**
	 * Wrap a table as a workflow store.
	 *
	 * @param table - The {@link TableInterface} holding the snapshots — its row is the
	 *   {@link WorkflowSnapshotRow} `{ id; snapshot }` shape (the snapshot one opaque JSON column)
	 */
	constructor(table: TableInterface<WorkflowSnapshotRow>) {
		this.#table = table
	}

	/** Resolve and key-check the snapshot for `id`, narrowing the opaque column to `WorkflowSnapshot`. */
	async get(id: string): Promise<WorkflowSnapshot | undefined> {
		const row = await this.#table.get(id)
		if (row === undefined) return undefined
		// The snapshot crosses back as an untrusted storage read. A present malformed row is
		// corruption, not absence, so preserve cloneWorkflowSnapshot's normalized RESTORE failure.
		return cloneWorkflowSnapshot(row.snapshot, id)
	}

	/** Insert or replace under the snapshot's OWN `id` (no separate id param) — the row is `{ id, snapshot }`. */
	async set(snapshot: WorkflowSnapshot): Promise<void> {
		const owned = cloneWorkflowSnapshot(snapshot)
		await this.#table.set({ id: owned.id, snapshot: owned })
	}

	/** Drop a snapshot by id; an absent id is a no-op (no throw). */
	async delete(id: string): Promise<void> {
		await this.#table.remove(id)
	}
}
