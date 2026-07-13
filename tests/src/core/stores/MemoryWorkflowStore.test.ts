import type { WorkflowSnapshot } from '@src/core'
import { createMemoryWorkflowStore, createWorkflow, restoreWorkflow } from '@src/core'
import { describe, expect, it } from 'vitest'
import { buildReleaseDefinition, roundTripJSON, settleSnapshot } from '../../../setup.js'

// A higher per-test timeout for the `runner.execute`-driven round-trips below. The run is a
// GENUINELY real-async integration round-trip — a live W-b tree built + driven through the
// substrate `createRunner`/`Queue` (a cooperative wake-park loop awaiting real promises across many
// microtask turns), the per-task abort fold, the emitter cascade, then a full snapshot serialize
// (and, for the Database twin, a real `databases` driver round-trip). Pacing is already made
// deterministic by an injected `createRecordingScheduler` (no wall-clock `setTimeout`), but the
// chain itself cannot be made instantaneous without MOCKING the unit under test (forbidden, §16.2).
// Under full-`src:core`-project parallel load (~105 test files across the fork pool saturating every
// CPU), that real-async chain — which finishes in well under a millisecond in isolation — can be
// event-loop-starved past vitest's 5s default and flake. A generous ceiling (6× the default)
// absorbs worst-case starvation while still failing fast on a genuine hang (a real deadlock never
// settles, so 30s still catches it). Scoped to the real-async tests only (§16.3 — a measured
// setting with a current reason); the synchronous store tests keep the fast default.
const ROUND_TRIP_TIMEOUT_MS = 30_000

// The W-d MemoryWorkflowStore — the in-memory default behind the WorkflowStoreInterface
// persistence seam (get / set / delete, async, keyed by a snapshot's own id). It persists the
// W-a WorkflowSnapshot (the complete, self-contained, pure-JSON run state) UNCHANGED; restore is
// the shipped `restoreWorkflow`, never re-implemented here. REAL data only (AGENTS §16) — a real
// WorkflowDefinition, a real all-pending snapshot AND a real SETTLED snapshot driven through
// `createWorkflowRunner().execute` (so recorded statuses / results / bail are exercised), NO mocks.

// The real two-phase `release` WorkflowDefinition (`buildReleaseDefinition`), its by-name handler
// map, and the deterministic `settleSnapshot` driver (paced by an injected recording scheduler so
// the run is wall-clock-free, AGENTS §16) all live in `tests/setup.ts` — the shared store-test
// fixture this and the Database twin drive (AGENTS §16.1), so the definition + run stay in one place.

// The "driver-swap parity" check — the pure-JSON snapshot must survive a full
// `JSON.parse(JSON.stringify(...))` round-trip byte-for-byte — uses the shared `roundTripJSON`
// (tests/setup.ts, AGENTS §16.1), since a JSON / SQLite / IndexedDB backend persists the payload
// AS JSON.

describe('MemoryWorkflowStore — round-trip → identical live tree', () => {
	// Exercise BOTH the all-pending snapshot (createWorkflow(...).snapshot()) and the SETTLED one
	// (driven through the runner), proving the store persists each faithfully and a restore from
	// the retrieved snapshot rebuilds an IDENTICAL live tree.
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
				const store = createMemoryWorkflowStore()
				const snapshot = await make()

				await store.set(snapshot)
				const got = await store.get(snapshot.id)

				// The retrieved snapshot deep-equals what was stored (the durable payload survives).
				expect(got).toEqual(snapshot)
				// Narrow `got` to a concrete snapshot via an early-return guard (no `!`), so the restore
				// assertion below is UNCONDITIONAL — the `toEqual` above already proved it is present.
				expect(got).toBeDefined()
				if (got === undefined) return
				// Restoring from the RETRIEVED snapshot yields an IDENTICAL live tree — its own
				// re-serialization deep-equals the original snapshot (proves structure + every node's
				// status + recorded results + positional order + bail/override round-tripped).
				expect(restoreWorkflow(got).snapshot()).toEqual(snapshot)
			},
			ROUND_TRIP_TIMEOUT_MS,
		)
	}

	it(
		'the settled snapshot carries real completed statuses + recorded results',
		async () => {
			// Guards the "settled" case is non-vacuous: the run genuinely settled with results, so the
			// round-trip above is exercising recorded outcomes (not an all-pending tree in disguise).
			const snapshot = await settleSnapshot(buildReleaseDefinition())
			expect(snapshot.status).toBe('completed')
			const tasks = snapshot.phases.flatMap((phase) => phase.tasks)
			expect(tasks.map((task) => task.status)).toEqual(['completed', 'completed', 'completed'])
			expect(tasks.every((task) => task.result !== undefined)).toBe(true)
		},
		ROUND_TRIP_TIMEOUT_MS,
	)
})

describe('MemoryWorkflowStore — driver-swap parity (JSON portability)', () => {
	// After `set`, the retrieved payload must survive a full JSON round-trip AND restore identically
	// from the JSON-revived form — proving it persists unchanged across ANY JSON / SQLite / IndexedDB
	// backend (the real driver-swap guarantee). Run it for the settled snapshot (the richer payload).
	it(
		'the retrieved snapshot survives JSON.stringify/parse and restores identically',
		async () => {
			const store = createMemoryWorkflowStore()
			const snapshot = await settleSnapshot(buildReleaseDefinition())

			await store.set(snapshot)
			const got = await store.get(snapshot.id)
			expect(got).toBeDefined()
			if (got === undefined) return

			// The payload is pure JSON — a stringify/parse round-trip is identity.
			const revived = roundTripJSON(got)
			expect(revived).toEqual(got)
			// A backend that stored + reloaded it as JSON still restores the same live tree.
			expect(restoreWorkflow(revived).snapshot()).toEqual(snapshot)
		},
		ROUND_TRIP_TIMEOUT_MS,
	)
})

describe('MemoryWorkflowStore — delete & absent', () => {
	it('set → delete → get returns undefined', async () => {
		const store = createMemoryWorkflowStore()
		const snapshot = createWorkflow(buildReleaseDefinition()).snapshot()

		await store.set(snapshot)
		expect(await store.get(snapshot.id)).toBeDefined()

		await store.delete(snapshot.id)
		expect(await store.get(snapshot.id)).toBeUndefined()
	})

	it('deleting an absent id does not throw (a no-op)', async () => {
		const store = createMemoryWorkflowStore()
		await expect(store.delete('never-stored')).resolves.toBeUndefined()
	})

	it('get of an absent id returns undefined', async () => {
		const store = createMemoryWorkflowStore()
		expect(await store.get('never-stored')).toBeUndefined()
	})

	it(
		'set replaces an existing snapshot under the same id',
		async () => {
			// `set` keys off the snapshot's OWN id (no separate id param), so re-setting the same id
			// REPLACES — proving the insert-or-replace semantics, not an append.
			const store = createMemoryWorkflowStore()
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
