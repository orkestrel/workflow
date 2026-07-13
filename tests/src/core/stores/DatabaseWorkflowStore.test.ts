import type { WorkflowSnapshot } from '@src/core'
import { createMemoryDriver } from '@orkestrel/database'
import { createDatabaseWorkflowStore, createWorkflow, restoreWorkflow } from '@src/core'
import { describe, expect, it } from 'vitest'
import { buildReleaseDefinition, settleSnapshot } from '../../../setup.js'

// A higher per-test timeout for the `runner.execute`-driven round-trips below. The run is a
// GENUINELY real-async integration round-trip — a live W-b tree built + driven through the
// substrate `createRunner`/`Queue` (a cooperative wake-park loop awaiting real promises across many
// microtask turns), the per-task abort fold, the emitter cascade, a full snapshot serialize, AND a
// real `databases` driver round-trip on every `set` / `get`. Pacing is already made deterministic
// by an injected `createRecordingScheduler` (no wall-clock `setTimeout`), but the chain itself
// cannot be made instantaneous without MOCKING the unit under test (forbidden, §16.2). Under
// full-`src:core`-project parallel load (~105 test files across the fork pool saturating every CPU),
// that real-async chain — which finishes in well under a millisecond in isolation — can be
// event-loop-starved past vitest's 5s default and flake. A generous ceiling (6× the default)
// absorbs worst-case starvation while still failing fast on a genuine hang (a real deadlock never
// settles, so 30s still catches it). Scoped to the real-async tests only (§16.3 — a measured
// setting with a current reason); the synchronous store tests keep the fast default.
const ROUND_TRIP_TIMEOUT_MS = 30_000

// src/core/workflows/stores/DatabaseWorkflowStore.ts — the durable, driver-pluggable twin of the
// plain-Map MemoryWorkflowStore behind the WorkflowStoreInterface seam (get / set / delete, async,
// keyed by a snapshot's own id). It persists the W-a WorkflowSnapshot as ONE OPAQUE JSON column
// over a `databases` table (driver default = createMemoryDriver), narrowing the column back to a
// WorkflowSnapshot on `get` (the §14 boundary narrow). Exercised over a REAL memory driver, with
// REAL WorkflowSnapshot values (§16 NO mocks) — a real WorkflowDefinition, a real all-pending
// snapshot AND a real SETTLED snapshot driven through createWorkflowRunner().execute (so recorded
// statuses / results / bail are exercised); restore is the shipped restoreWorkflow, never re-rolled.

// The real two-phase `release` WorkflowDefinition (`buildReleaseDefinition`), its by-name handler
// map, and the deterministic `settleSnapshot` driver (paced by an injected recording scheduler so
// the run is wall-clock-free, AGENTS §16) all live in `tests/setup.ts` — the SAME shared store-test
// fixture the Memory twin drives (AGENTS §16.1), so the definition + run stay in one place.

describe('DatabaseWorkflowStore — set → get round-trip (one opaque JSON column)', () => {
	// Exercise BOTH the all-pending snapshot and the SETTLED one, proving the store persists each
	// faithfully through the JSON column and a restore from the retrieved snapshot rebuilds an
	// IDENTICAL live tree. A genuine driver round-trip (through `databases`), not a Map shortcut.
	const cases: readonly (readonly [string, () => Promise<WorkflowSnapshot>])[] = [
		[
			'all-pending (createWorkflow)',
			async () => createWorkflow(buildReleaseDefinition()).snapshot(),
		],
		['settled (runner.execute)', () => settleSnapshot(buildReleaseDefinition())],
	]

	for (const [label, make] of cases) {
		it(
			`set → get returns the same snapshot and restores an identical tree (${label})`,
			async () => {
				const store = createDatabaseWorkflowStore(createMemoryDriver())
				const snapshot = await make()

				await store.set(snapshot)
				const got = await store.get(snapshot.id)

				// The retrieved snapshot deep-equals what was stored — the opaque column round-trips it
				// losslessly (it is pure JSON DATA by construction).
				expect(got).toEqual(snapshot)
				// Narrow `got` via an early-return guard (no `!`); the `toEqual` above already proved it.
				expect(got).toBeDefined()
				if (got === undefined) return
				// Restoring from the RETRIEVED snapshot yields an IDENTICAL live tree — its own
				// re-serialization deep-equals the original (structure + every node's status + recorded
				// results + positional order + bail/override survived the column round-trip).
				expect(restoreWorkflow(got).snapshot()).toEqual(snapshot)
			},
			ROUND_TRIP_TIMEOUT_MS,
		)
	}

	it(
		'the settled snapshot carries real completed statuses + recorded results',
		async () => {
			// Guards the "settled" case is non-vacuous: the run genuinely settled with results, so the
			// round-trip above exercises recorded outcomes (not an all-pending tree in disguise).
			const snapshot = await settleSnapshot(buildReleaseDefinition())
			expect(snapshot.status).toBe('completed')
			const tasks = snapshot.phases.flatMap((phase) => phase.tasks)
			expect(tasks.map((task) => task.status)).toEqual(['completed', 'completed', 'completed'])
			expect(tasks.every((task) => task.result !== undefined)).toBe(true)
		},
		ROUND_TRIP_TIMEOUT_MS,
	)
})

describe('DatabaseWorkflowStore — upsert (set replaces under the same id)', () => {
	it(
		'set replaces an existing snapshot under the same id',
		async () => {
			// `set` keys off the snapshot's OWN id (no separate id param), so re-setting the same id
			// REPLACES the row — proving insert-or-replace semantics, not an append (one row, latest wins).
			const store = createDatabaseWorkflowStore(createMemoryDriver())
			const pending = createWorkflow(buildReleaseDefinition()).snapshot()
			const settled = await settleSnapshot(buildReleaseDefinition())
			expect(settled.id).toBe(pending.id) // same workflow id

			await store.set(pending)
			await store.set(settled)
			expect(await store.get(pending.id)).toEqual(settled)
		},
		ROUND_TRIP_TIMEOUT_MS,
	)
})

describe('DatabaseWorkflowStore — delete & absent', () => {
	it('set → delete → get returns undefined', async () => {
		const store = createDatabaseWorkflowStore(createMemoryDriver())
		const snapshot = createWorkflow(buildReleaseDefinition()).snapshot()

		await store.set(snapshot)
		expect(await store.get(snapshot.id)).toBeDefined()

		await store.delete(snapshot.id)
		expect(await store.get(snapshot.id)).toBeUndefined()
	})

	it('deleting an absent id does not throw (a no-op)', async () => {
		const store = createDatabaseWorkflowStore(createMemoryDriver())
		await expect(store.delete('never-stored')).resolves.toBeUndefined()
	})

	it('get of an absent id returns undefined', async () => {
		const store = createDatabaseWorkflowStore(createMemoryDriver())
		expect(await store.get('never-stored')).toBeUndefined()
	})
})

describe('DatabaseWorkflowStore — driver-swap smoke (the memory driver default)', () => {
	// The store works the same over the default in-memory driver — the WorkflowStoreInterface seam
	// is driver-agnostic, so a JSON / SQLite / IndexedDB driver swaps in via the SAME interface (the
	// SessionStore / QueueStore driver-swap pattern). The default-driver factory overload (no arg)
	// builds an equivalent memory-backed store, so the same set → get round-trip holds.
	it(
		'the same store works over the default memory driver (no explicit driver)',
		async () => {
			const store = createDatabaseWorkflowStore() // driver defaults to createMemoryDriver()
			const snapshot = await settleSnapshot(buildReleaseDefinition())

			await store.set(snapshot)
			const got = await store.get(snapshot.id)
			expect(got).toEqual(snapshot)
			expect(got).toBeDefined()
			if (got === undefined) return
			// And it restores identically — the opaque-column persistence is faithful end-to-end.
			expect(restoreWorkflow(got).snapshot()).toEqual(snapshot)
		},
		ROUND_TRIP_TIMEOUT_MS,
	)

	it(
		'two distinct workflow ids coexist without cross-contamination',
		async () => {
			// A real durable store holds many run-states; distinct ids must not clobber each other.
			const store = createDatabaseWorkflowStore(createMemoryDriver())
			const alpha = createWorkflow(buildReleaseDefinition('alpha')).snapshot()
			const beta = await settleSnapshot(buildReleaseDefinition('beta'))

			await store.set(alpha)
			await store.set(beta)

			expect(await store.get('alpha')).toEqual(alpha)
			expect(await store.get('beta')).toEqual(beta)
			// Dropping one leaves the other intact.
			await store.delete('alpha')
			expect(await store.get('alpha')).toBeUndefined()
			expect(await store.get('beta')).toEqual(beta)
		},
		ROUND_TRIP_TIMEOUT_MS,
	)
})
