import { createMemoryDriver } from '@orkestrel/database'
import type {
	WorkflowFunctions,
	WorkflowFunction,
	WorkflowInterface,
	WorkflowManagerInterface,
	WorkflowSnapshot,
	WorkflowStoreInterface,
} from '@src/core'
import {
	Workflow,
	createDatabaseWorkflowStore,
	createMemoryWorkflowStore,
	createWorkflowManager,
	createWorkflowRunner,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	RELEASE_FUNCTIONS,
	WorkflowStoreBoundary,
	buildReleaseDefinition,
	createGate,
} from '../../setup.js'

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

	it('a manager with no functions mints an inert tree that execution rejects', () => {
		const manager = createWorkflowManager()

		const workflow = manager.add(buildReleaseDefinition())
		expect(workflow.phase('build')?.task('compile')?.handler).toBeUndefined()

		expect(() => createWorkflowRunner().execute(workflow)).toThrow(/not drivable/)
	})
})

describe('WorkflowManager — coordinated durable access', () => {
	it('returns the current registry object without consulting the store', async () => {
		const store = new WorkflowStoreBoundary()
		const manager = createWorkflowManager({ store })
		const current = manager.add(buildReleaseDefinition('current'))

		expect(await manager.open('current')).toBe(current)
		expect(store.gets).toEqual([])
	})

	it('coalesces same-id misses into one hydration promise and one live object', async () => {
		const read = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([read])
		const manager = createWorkflowManager({ store })
		const snapshot = createWorkflowManager().add(buildReleaseDefinition('shared')).snapshot()

		const first = manager.open('shared')
		const second = manager.open('shared')

		expect(second).toBe(first)
		expect(store.gets).toEqual(['shared'])
		read.resolve(snapshot)
		const [firstWorkflow, secondWorkflow] = await Promise.all([first, second])
		expect(firstWorkflow).toBe(secondWorkflow)
		expect(manager.workflow('shared')).toBe(firstWorkflow)
	})

	it('reserves a same-id open before a synchronous store read can reenter', async () => {
		const snapshot = createWorkflowManager().add(buildReleaseDefinition('sync-open')).snapshot()
		const managers: WorkflowManagerInterface[] = []
		let reentrant: Promise<WorkflowInterface | undefined> | undefined
		let reads = 0
		const store: WorkflowStoreInterface = {
			get: (id) => {
				reads += 1
				const current = managers[0]
				if (current === undefined) throw new Error('expected manager fixture')
				reentrant = current.open(id)
				return Promise.resolve(snapshot)
			},
			set: () => Promise.resolve(),
			delete: () => Promise.resolve(),
		}
		const manager = createWorkflowManager({ store })
		managers.push(manager)

		const opening = manager.open('sync-open')
		await Promise.resolve()

		expect(reentrant).toBe(opening)
		expect(reads).toBe(1)
		expect(await opening).toBe(manager.workflow('sync-open'))
	})

	it('returns a concurrent same-id add to every pending open', async () => {
		const read = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([read])
		const manager = createWorkflowManager({ store })
		const stored = createWorkflowManager().add(buildReleaseDefinition('race')).snapshot()
		const first = manager.open('race')
		const second = manager.open('race')

		const added = manager.add({ ...buildReleaseDefinition('race'), name: 'Added' })
		read.resolve(stored)

		expect(await first).toBe(added)
		expect(await second).toBe(added)
		expect(manager.workflow('race')).toBe(added)
	})

	it('keeps a concurrent add when hostile snapshot traversal reenters during cloning', async () => {
		const read = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([read])
		const manager = createWorkflowManager({ store })
		const snapshot = createWorkflowManager().add(buildReleaseDefinition('clone-add')).snapshot()
		let added: WorkflowInterface | undefined
		const hostile = new Proxy(snapshot, {
			getOwnPropertyDescriptor: (target, property) => {
				if (property === 'id') {
					added = manager.add({ id: 'clone-add', name: 'Added', phases: [] })
				}
				return Reflect.getOwnPropertyDescriptor(target, property)
			},
		})

		const opening = manager.open('clone-add')
		read.resolve(hostile)

		expect(await opening).toBe(added)
		expect(manager.workflow('clone-add')).toBe(added)
	})

	it('lets a reentrant clear outrank a hostile snapshot traversal failure', async () => {
		const read = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([read])
		const manager = createWorkflowManager({ store })
		const snapshot = createWorkflowManager().add(buildReleaseDefinition('clone-clear')).snapshot()
		const fault = new Error('snapshot traversal failed')
		const hostile = new Proxy(snapshot, {
			ownKeys: () => {
				manager.clear()
				throw fault
			},
		})

		const opening = manager.open('clone-clear')
		read.resolve(hostile)

		await expect(opening).resolves.toBeUndefined()
		expect(manager.workflow('clone-clear')).toBeUndefined()
	})

	it('keeps a concurrent add when a function entry reenters during restoration', async () => {
		const read = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([read])
		const managers: WorkflowManagerInterface[] = []
		let added: WorkflowInterface | undefined
		const functions: WorkflowFunctions = {
			get compile(): WorkflowFunction {
				const manager = managers[0]
				if (manager === undefined) throw new Error('expected manager fixture')
				added = manager.add({ id: 'restore-add', name: 'Added', phases: [] })
				return () => 'built'
			},
		}
		const manager = createWorkflowManager({ store, functions })
		managers.push(manager)
		const opening = manager.open('restore-add')
		read.resolve(createWorkflowManager().add(buildReleaseDefinition('restore-add')).snapshot())

		expect(await opening).toBe(added)
		expect(manager.workflow('restore-add')).toBe(added)
	})

	it('does not register a restoration whose function entry reenters remove', async () => {
		const read = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([read])
		const managers: WorkflowManagerInterface[] = []
		const functions: WorkflowFunctions = {
			get compile(): WorkflowFunction {
				const manager = managers[0]
				if (manager === undefined) throw new Error('expected manager fixture')
				manager.remove('restore-remove')
				return () => 'built'
			},
		}
		const manager = createWorkflowManager({ store, functions })
		managers.push(manager)
		const opening = manager.open('restore-remove')
		read.resolve(createWorkflowManager().add(buildReleaseDefinition('restore-remove')).snapshot())

		await expect(opening).resolves.toBeUndefined()
		expect(manager.workflow('restore-remove')).toBeUndefined()
	})

	it('lets a reentrant clear outrank a function-entry failure during restoration', async () => {
		const read = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([read])
		const fault = new Error('function resolution failed')
		const managers: WorkflowManagerInterface[] = []
		const functions: WorkflowFunctions = {
			get compile(): WorkflowFunction {
				const manager = managers[0]
				if (manager === undefined) throw new Error('expected manager fixture')
				manager.clear()
				throw fault
			},
		}
		const manager = createWorkflowManager({ store, functions })
		managers.push(manager)
		const opening = manager.open('restore-clear')
		read.resolve(createWorkflowManager().add(buildReleaseDefinition('restore-clear')).snapshot())

		await expect(opening).resolves.toBeUndefined()
		expect(manager.workflow('restore-clear')).toBeUndefined()
	})

	it('propagates the exact function-entry failure while hydration still owns the id', async () => {
		const read = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([read])
		const fault = new Error('current function resolution failed')
		const functions: WorkflowFunctions = {
			get compile(): WorkflowFunction {
				throw fault
			},
		}
		const manager = createWorkflowManager({ store, functions })
		const opening = manager.open('restore-failure')
		read.resolve(createWorkflowManager().add(buildReleaseDefinition('restore-failure')).snapshot())

		await expect(opening).rejects.toBe(fault)
		expect(manager.workflow('restore-failure')).toBeUndefined()
	})

	it('remove invalidates an earlier hydration even when the id was absent', async () => {
		const staleRead = createGate<WorkflowSnapshot | undefined>()
		const freshRead = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([staleRead, freshRead])
		const manager = createWorkflowManager({ store })
		const snapshot = createWorkflowManager().add(buildReleaseDefinition('removed')).snapshot()
		const stale = manager.open('removed')

		expect(manager.remove('removed')).toBe(false)
		const fresh = manager.open('removed')
		expect(store.gets).toEqual(['removed', 'removed'])
		staleRead.resolve(snapshot)

		expect(await stale).toBeUndefined()
		freshRead.resolve(snapshot)
		expect(await fresh).toBe(manager.workflow('removed'))
	})

	it('retains a newer same-id hydration lease after an older detached open settles', async () => {
		const staleRead = createGate<WorkflowSnapshot | undefined>()
		const freshRead = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([staleRead, freshRead])
		const manager = createWorkflowManager({ store })
		const snapshot = createWorkflowManager().add(buildReleaseDefinition('leased')).snapshot()
		const stale = manager.open('leased')

		manager.clear()
		const fresh = manager.open('leased')
		staleRead.resolve(snapshot)
		expect(await stale).toBeUndefined()

		expect(manager.remove('leased')).toBe(false)
		freshRead.resolve(snapshot)
		expect(await fresh).toBeUndefined()
		expect(manager.workflow('leased')).toBeUndefined()
	})

	it('does not resurrect any stale hydration after repeated add-remove churn', async () => {
		const staleReads = Array.from({ length: 32 }, () => createGate<WorkflowSnapshot | undefined>())
		const freshRead = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([...staleReads, freshRead])
		const manager = createWorkflowManager({ store })
		const snapshot = createWorkflowManager().add(buildReleaseDefinition('churn')).snapshot()
		const stale: Promise<WorkflowInterface | undefined>[] = []

		for (const read of staleReads) {
			stale.push(manager.open('churn'))
			manager.add(buildReleaseDefinition('churn'))
			expect(manager.remove('churn')).toBe(true)
			read.resolve(snapshot)
		}
		const fresh = manager.open('churn')

		expect((await Promise.all(stale)).every((workflow) => workflow === undefined)).toBe(true)
		expect(manager.workflow('churn')).toBeUndefined()
		freshRead.resolve(snapshot)
		expect(await fresh).toBe(manager.workflow('churn'))
	})

	it('clear invalidates every earlier hydration', async () => {
		const alphaRead = createGate<WorkflowSnapshot | undefined>()
		const betaRead = createGate<WorkflowSnapshot | undefined>()
		const freshRead = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([alphaRead, betaRead, freshRead])
		const manager = createWorkflowManager({ store })
		const alpha = manager.open('alpha')
		const beta = manager.open('beta')

		manager.clear()
		const fresh = manager.open('alpha')
		alphaRead.resolve(createWorkflowManager().add(buildReleaseDefinition('alpha')).snapshot())
		betaRead.resolve(createWorkflowManager().add(buildReleaseDefinition('beta')).snapshot())

		expect(await alpha).toBeUndefined()
		expect(await beta).toBeUndefined()
		expect(manager.workflows()).toEqual([])
		freshRead.resolve(createWorkflowManager().add(buildReleaseDefinition('alpha')).snapshot())
		expect(await fresh).toBe(manager.workflow('alpha'))
	})

	it('clears misses and failures from the in-flight registry so later opens retry', async () => {
		const miss = createGate<WorkflowSnapshot | undefined>()
		const failure = createGate<WorkflowSnapshot | undefined>()
		const hit = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([miss, failure, hit])
		const manager = createWorkflowManager({ store })
		const fault = new Error('read failed')
		const snapshot = createWorkflowManager().add(buildReleaseDefinition('retry')).snapshot()

		const missed = manager.open('retry')
		miss.resolve(undefined)
		expect(await missed).toBeUndefined()

		const failed = manager.open('retry')
		failure.reject(fault)
		await expect(failed).rejects.toBe(fault)

		const retried = manager.open('retry')
		hit.resolve(snapshot)
		expect(await retried).toBe(manager.workflow('retry'))
		expect(store.gets).toEqual(['retry', 'retry', 'retry'])
	})

	it('rejects a valid payload stored under the wrong requested key without registering either id', async () => {
		const read = createGate<WorkflowSnapshot | undefined>()
		const store = new WorkflowStoreBoundary([read])
		const manager = createWorkflowManager({ store })
		const opening = manager.open('requested')
		read.resolve(createWorkflowManager().add(buildReleaseDefinition('payload')).snapshot())

		await expect(opening).rejects.toMatchObject({
			code: 'RESTORE',
			context: { requested: 'requested', payload: 'payload' },
		})
		await expect(opening).rejects.toThrow(
			"workflow snapshot 'payload' does not match storage key 'requested'",
		)
		expect(manager.workflow('requested')).toBeUndefined()
		expect(manager.workflow('payload')).toBeUndefined()
	})

	it('captures same-id snapshots at invocation and writes them in order across a rejection', async () => {
		const firstWrite = createGate()
		const secondWrite = createGate()
		const store = new WorkflowStoreBoundary([], [firstWrite, secondWrite])
		const manager = createWorkflowManager({ store })
		manager.add({ ...buildReleaseDefinition('ordered'), name: 'First' })

		const first = manager.save('ordered')
		manager.add({ ...buildReleaseDefinition('ordered'), name: 'Second' })
		const second = manager.save('ordered')

		expect(store.sets.map((snapshot) => snapshot.name)).toEqual(['First'])
		const fault = new Error('write failed')
		firstWrite.reject(fault)
		await expect(first).rejects.toBe(fault)
		expect(store.sets.map((snapshot) => snapshot.name)).toEqual(['First', 'Second'])
		secondWrite.resolve()
		await expect(second).resolves.toBe(true)
	})

	it('reserves a same-id save before a synchronous store write can reenter', async () => {
		const managers: WorkflowManagerInterface[] = []
		let reentrant: Promise<boolean> | undefined
		let active = 0
		let maximum = 0
		const names: string[] = []
		const store: WorkflowStoreInterface = {
			get: () => Promise.resolve(undefined),
			delete: () => Promise.resolve(),
			set: (snapshot) => {
				active += 1
				maximum = Math.max(maximum, active)
				names.push(snapshot.name)
				if (names.length === 1) {
					const current = managers[0]
					if (current === undefined) throw new Error('expected manager fixture')
					current.add({ ...buildReleaseDefinition('sync-save'), name: 'Second' })
					reentrant = current.save('sync-save')
				}
				return Promise.resolve().then(() => {
					active -= 1
				})
			},
		}
		const manager = createWorkflowManager({ store })
		managers.push(manager)
		manager.add({ ...buildReleaseDefinition('sync-save'), name: 'First' })

		const saving = manager.save('sync-save')
		await expect(saving).resolves.toBe(true)
		if (reentrant === undefined) throw new Error('expected reentrant save')
		await expect(reentrant).resolves.toBe(true)

		expect(maximum).toBe(1)
		expect(names).toEqual(['First', 'Second'])
	})

	it('starts writes for different ids independently', async () => {
		const alphaWrite = createGate()
		const betaWrite = createGate()
		const store = new WorkflowStoreBoundary([], [alphaWrite, betaWrite])
		const manager = createWorkflowManager({ store })
		manager.add(buildReleaseDefinition('alpha'))
		manager.add(buildReleaseDefinition('beta'))

		const alpha = manager.save('alpha')
		const beta = manager.save('beta')

		expect(store.sets.map((snapshot) => snapshot.id)).toEqual(['alpha', 'beta'])
		betaWrite.resolve()
		await expect(beta).resolves.toBe(true)
		alphaWrite.resolve()
		await expect(alpha).resolves.toBe(true)
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

			const reopened = createWorkflowManager({ store, functions: RELEASE_FUNCTIONS })
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

			const reopened = createWorkflowManager({ store, functions: RELEASE_FUNCTIONS })
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
