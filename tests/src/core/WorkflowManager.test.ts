import { createMemoryDriver } from '@orkestrel/database'
import {
	Workflow,
	createDatabaseWorkflowStore,
	createMemoryWorkflowStore,
	createWorkflowManager,
	createWorkflowRunner,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { RELEASE_FUNCTIONS, buildReleaseDefinition } from '../../setup.js'

// WorkflowManager (`createWorkflowManager`) is the additive §9 registry over the workflow
// layer mirroring the `@orkestrel/agent` line's ConversationManager / WorkspaceManager: an
// insertion-ordered store keyed by id (add / workflow / workflows / count / remove(id|ids[]) /
// clear) PLUS the optional store seam (open / save). UNLIKE the twins there is NO active /
// switch pointer (AGENTS §21 — nothing renders "the current workflow"). The workflow-specific
// nuance: `functions` flows into every mint AND every hydrate, so a restored tree stays
// RUNNABLE rather than a dead snapshot mirror. Event-free (each Workflow owns its own emitter).

describe('WorkflowManager — add / accessors / count', () => {
	it('starts empty', () => {
		const manager = createWorkflowManager()

		expect(manager.count).toBe(0)
		expect(manager.workflows()).toEqual([])
	})

	it('add(definition) mints a Workflow, stores it, and returns it', () => {
		const manager = createWorkflowManager()

		const workflow = manager.add(buildReleaseDefinition())

		expect(workflow).toBeInstanceOf(Workflow)
		expect(manager.count).toBe(1)
		expect(manager.workflow(workflow.id)).toBe(workflow)
		expect(manager.workflows()).toEqual([workflow])
	})

	it("the minted workflow's id is the definition's id", () => {
		const manager = createWorkflowManager()

		const workflow = manager.add(buildReleaseDefinition('fixed'))

		expect(workflow.id).toBe('fixed')
		expect(manager.workflow('fixed')).toBe(workflow)
	})

	it('workflow(id) returns undefined for an unknown id', () => {
		const manager = createWorkflowManager()

		expect(manager.workflow('nope')).toBeUndefined()
	})

	it('workflows() lists in insertion order', () => {
		const manager = createWorkflowManager()
		const a = manager.add(buildReleaseDefinition('a'))
		const b = manager.add(buildReleaseDefinition('b'))
		const c = manager.add(buildReleaseDefinition('c'))

		expect(manager.workflows()).toEqual([a, b, c])
	})

	it('a re-add of the same id OVERWRITES (last write wins)', () => {
		const manager = createWorkflowManager()
		const first = manager.add(buildReleaseDefinition('dup'))
		const second = manager.add(buildReleaseDefinition('dup'))

		expect(manager.count).toBe(1)
		expect(manager.workflow('dup')).toBe(second)
		expect(manager.workflow('dup')).not.toBe(first)
	})
})

describe('WorkflowManager — remove (§9.2) / clear', () => {
	it('remove(id) drops one and reports whether any was removed', () => {
		const manager = createWorkflowManager()
		manager.add(buildReleaseDefinition('a'))
		manager.add(buildReleaseDefinition('b'))

		expect(manager.remove('a')).toBe(true)
		expect(manager.remove('missing')).toBe(false)
		expect(manager.count).toBe(1)
		expect(manager.workflow('a')).toBeUndefined()
	})

	it('remove(ids[]) drops a batch — true if ANY was removed (array overload first)', () => {
		const manager = createWorkflowManager()
		manager.add(buildReleaseDefinition('a'))
		manager.add(buildReleaseDefinition('b'))
		manager.add(buildReleaseDefinition('c'))

		expect(manager.remove(['a', 'missing'])).toBe(true)
		expect(manager.count).toBe(2)
		expect(manager.remove(['missing', 'also-missing'])).toBe(false)
	})

	it('clear() empties the registry', () => {
		const manager = createWorkflowManager()
		manager.add(buildReleaseDefinition('a'))
		manager.add(buildReleaseDefinition('b'))

		manager.clear()

		expect(manager.count).toBe(0)
		expect(manager.workflows()).toEqual([])
	})
})

describe('WorkflowManager — functions flow (RUNNABLE workflows)', () => {
	it('a manager with `functions` mints workflows whose tasks carry a resolved handler and can run to completion', async () => {
		const manager = createWorkflowManager({ functions: RELEASE_FUNCTIONS })

		const workflow = manager.add(buildReleaseDefinition())
		expect(workflow.phase('build')?.task('compile')?.handler).toBeDefined()

		const result = await createWorkflowRunner().execute(workflow)
		expect(result.status).toBe('completed')
		expect(workflow.phase('ship')?.task('publish')?.status).toBe('completed')
	})

	it('a manager with NO `functions` mints workflows whose tasks auto-complete (no-handler rule)', async () => {
		const manager = createWorkflowManager()

		const workflow = manager.add(buildReleaseDefinition())
		expect(workflow.phase('build')?.task('compile')?.handler).toBeUndefined()

		const result = await createWorkflowRunner().execute(workflow)
		expect(result.status).toBe('completed')
		expect(workflow.phase('build')?.task('compile')?.status).toBe('completed')
	})
})

// The open/save store seam, parametrized over BOTH the Memory and the Database twins (AGENTS
// §16.1 — one shared assertion suite driven over each real backend, no mocks).
const stores: readonly (readonly [string, () => ReturnType<typeof createMemoryWorkflowStore>])[] = [
	['MemoryWorkflowStore', () => createMemoryWorkflowStore()],
	['DatabaseWorkflowStore', () => createDatabaseWorkflowStore(createMemoryDriver())],
]

for (const [label, makeStore] of stores) {
	describe(`WorkflowManager — durable open / save over ${label}`, () => {
		it('open(id) resolves an ALREADY-registered workflow directly, WITHOUT a store hit', async () => {
			const store = makeStore()
			const manager = createWorkflowManager({ store })
			const workflow = manager.add(buildReleaseDefinition())

			const opened = await manager.open(workflow.id)

			expect(opened).toBe(workflow)
		})

		it('open(id) HYDRATES from the store on a registry miss (an identical snapshot)', async () => {
			const store = makeStore()
			const writer = createWorkflowManager({ store, functions: RELEASE_FUNCTIONS })
			const workflow = writer.add(buildReleaseDefinition('persisted'))
			workflow.phase('build')?.task('compile')?.start()
			workflow.phase('build')?.task('compile')?.complete('built compile')
			await store.set(workflow.snapshot())

			const reader = createWorkflowManager({ store, functions: RELEASE_FUNCTIONS })
			const opened = await reader.open('persisted')

			expect(opened).toBeDefined()
			expect(opened?.snapshot()).toEqual(workflow.snapshot())
			expect(reader.workflow('persisted')).toBe(opened)
		})

		it('open(id) HYDRATES a RUNNABLE workflow — the rehydrated task carries a resolved handler and can run', async () => {
			const store = makeStore()
			const writer = createWorkflowManager({ store })
			const workflow = writer.add(buildReleaseDefinition('runnable'))
			await store.set(workflow.snapshot())

			const reader = createWorkflowManager({ store, functions: RELEASE_FUNCTIONS })
			const opened = await reader.open('runnable')

			expect(opened?.phase('build')?.task('compile')?.handler).toBeDefined()
			if (opened === undefined) throw new Error('expected an opened workflow')
			const result = await createWorkflowRunner().execute(opened)
			expect(result.status).toBe('completed')
		})

		it('open(unknownId) with a store MISS returns undefined (lenient)', async () => {
			const store = makeStore()
			const manager = createWorkflowManager({ store })

			expect(await manager.open('never-stored')).toBeUndefined()
		})

		it('open(unknownId) with NO store returns undefined (lenient)', async () => {
			const manager = createWorkflowManager()

			expect(await manager.open('ghost')).toBeUndefined()
		})

		it('save(id) persists a registered workflow, and a FRESH manager opens it back', async () => {
			const store = makeStore()
			const manager = createWorkflowManager({ store })
			const workflow = manager.add(buildReleaseDefinition('doc'))

			expect(await manager.save('doc')).toBe(true)

			const reopened = createWorkflowManager({ store })
			const opened = await reopened.open('doc')

			expect(opened?.snapshot()).toEqual(workflow.snapshot())
		})

		it('save(id) re-save UPSERTS the latest snapshot', async () => {
			const store = makeStore()
			const manager = createWorkflowManager({ store, functions: RELEASE_FUNCTIONS })
			const workflow = manager.add(buildReleaseDefinition('evolving'))
			await manager.save('evolving')

			workflow.phase('build')?.task('compile')?.start()
			workflow.phase('build')?.task('compile')?.complete('done')
			await manager.save('evolving')

			const reopened = createWorkflowManager({ store })
			const opened = await reopened.open('evolving')
			expect(opened?.phase('build')?.task('compile')?.status).toBe('completed')
		})

		it('save(id) with NO store returns false (no-op)', async () => {
			const manager = createWorkflowManager()
			manager.add(buildReleaseDefinition('a'))

			expect(await manager.save('a')).toBe(false)
		})

		it('save(unknownId) returns false (no-op)', async () => {
			const store = makeStore()
			const manager = createWorkflowManager({ store })

			expect(await manager.save('missing')).toBe(false)
		})
	})
}

// Not covered: an `active` / `switch` suite — dropped by design (AGENTS §21). Unlike its
// ConversationManager / WorkspaceManager twins, nothing in the workflow domain renders "the
// current workflow", so carrying a render pointer with no consumer would be a speculative extra.
