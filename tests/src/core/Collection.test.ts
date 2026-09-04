import { isWorkflowError } from '@src/core'
import { describe, expect, it } from 'vitest'
import { captureError } from '@orkestrel/test'
import { buildCollection, buildTasks } from '../../setup.js'

// The one insertion-ordered gated store behind both lean managers. Driven directly over real live
// tasks minted by `createWorkflow`, with the real compiled `taskUpdateShape` guard — no mocks. The
// gate reads only the target's own existence, `pending` status, id, and bounds, so every refusal
// here is the store's own rather than an owning entity's.

describe('Collection — append (the build-time wiring path)', () => {
	it('appends in call order and reads back through entry / entries / count', () => {
		const [first, second] = buildTasks()
		const store = buildCollection()

		store.append(first)
		store.append(second)

		expect(store.count).toBe(2)
		expect(store.entry(first.id)).toBe(first)
		expect(store.entries()).toEqual([first, second])
	})

	it('throws a MUTATION WorkflowError naming the constructor noun on a duplicate id', () => {
		const [first] = buildTasks()
		const store = buildCollection()
		store.append(first)

		const error = captureError(() => {
			store.append(first)
		})

		expect(isWorkflowError(error)).toBe(true)
		expect(isWorkflowError(error) && error.code).toBe('MUTATION')
		expect(isWorkflowError(error) && error.message).toBe(`duplicate task id '${first.id}'`)
	})

	it('names the noun the constructor was given, not a hard-coded one', () => {
		const [first] = buildTasks()
		const store = buildCollection('phase')
		store.append(first)

		const error = captureError(() => {
			store.append(first)
		})

		expect(isWorkflowError(error) && error.message).toBe(`duplicate phase id '${first.id}'`)
	})
})

describe('Collection — add (the graceful insert)', () => {
	it('prepends at index 0 and appends past the end', () => {
		const [first, second, third] = buildTasks()
		const store = buildCollection()
		store.append(first)

		expect(store.add(second, 0).success).toBe(true)
		expect(store.entries()).toEqual([second, first])

		expect(store.add(third).success).toBe(true)
		expect(store.entries()).toEqual([second, first, third])
	})

	it('fails on a duplicate id without disturbing the order', () => {
		const [first, second] = buildTasks()
		const store = buildCollection()
		store.append(first)
		store.append(second)

		const outcome = store.add(first, 0)

		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error.code).toBe('MUTATION')
		expect(!outcome.success && outcome.error.message).toBe(`duplicate task id '${first.id}'`)
		expect(store.entries()).toEqual([first, second])
	})

	it('fails an index below 0 or above count, and accepts exactly count', () => {
		const [first, second, third] = buildTasks()
		const store = buildCollection()
		store.append(first)

		const below = store.add(second, -1)
		expect(below.success).toBe(false)
		expect(!below.success && below.error.code).toBe('MUTATION')

		const above = store.add(second, 2)
		expect(above.success).toBe(false)

		// `count` itself is the inclusive upper bound — the append position.
		expect(store.add(second, 1).success).toBe(true)
		expect(store.add(third, 2).success).toBe(true)
		expect(store.entries()).toEqual([first, second, third])
	})
})

describe('Collection — remove / move / update share the pending gate', () => {
	it('remove drops a pending entry and refuses an absent id', () => {
		const [first, second] = buildTasks()
		const store = buildCollection()
		store.append(first)
		store.append(second)

		expect(store.remove(first.id).success).toBe(true)
		expect(store.entries()).toEqual([second])

		const missing = store.remove('absent')
		expect(missing.success).toBe(false)
		expect(!missing.success && missing.error.message).toBe(`task 'absent' is not a pending task`)
	})

	it('remove refuses a target that is no longer pending', () => {
		const [first] = buildTasks()
		const store = buildCollection()
		store.append(first)
		first.skip()

		const outcome = store.remove(first.id)

		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error.code).toBe('MUTATION')
		expect(!outcome.success && outcome.error.message).toBe(
			`task '${first.id}' is not a pending task`,
		)
		expect(store.entry(first.id)).toBe(first)
	})

	it('move repositions a pending entry and refuses an absent or settled one', () => {
		const [first, second, third] = buildTasks()
		const store = buildCollection()
		store.append(first)
		store.append(second)
		store.append(third)

		expect(store.move(first.id, 2).success).toBe(true)
		expect(store.entries()).toEqual([second, third, first])

		const missing = store.move('absent', 0)
		expect(missing.success).toBe(false)
		expect(!missing.success && missing.error.message).toBe(`task 'absent' is not a pending task`)

		second.skip()
		const settled = store.move(second.id, 2)
		expect(settled.success).toBe(false)
		expect(!settled.success && settled.error.message).toBe(
			`task '${second.id}' is not a pending task`,
		)
	})

	it('move refuses an index below 0 or at count — the last valid index is count minus one', () => {
		const [first, second] = buildTasks()
		const store = buildCollection()
		store.append(first)
		store.append(second)

		const below = store.move(first.id, -1)
		expect(below.success).toBe(false)
		expect(!below.success && below.error.code).toBe('MUTATION')

		const atCount = store.move(first.id, 2)
		expect(atCount.success).toBe(false)
		expect(!atCount.success && atCount.error.code).toBe('MUTATION')

		expect(store.move(first.id, 1).success).toBe(true)
		expect(store.entries()).toEqual([second, first])
	})

	it('update applies a patch the compiled guard accepts and refuses one it rejects', () => {
		const [first] = buildTasks()
		const store = buildCollection()
		store.append(first)

		expect(store.update(first.id, { name: 'Renamed task' }).success).toBe(true)
		expect(first.name).toBe('Renamed task')

		// The real `taskUpdateShape` guard refuses an empty `name` (`min: 1`).
		const rejected = store.update(first.id, { name: '' })
		expect(rejected.success).toBe(false)
		expect(!rejected.success && rejected.error.code).toBe('MUTATION')
		expect(!rejected.success && rejected.error.message).toBe(`invalid patch for task '${first.id}'`)
		expect(first.name).toBe('Renamed task')
	})

	it('update refuses an absent id and a settled target', () => {
		const [first] = buildTasks()
		const store = buildCollection()
		store.append(first)

		const missing = store.update('absent', { name: 'Renamed task' })
		expect(missing.success).toBe(false)
		expect(!missing.success && missing.error.message).toBe(`task 'absent' is not a pending task`)

		first.skip()
		const settled = store.update(first.id, { name: 'Renamed again' })
		expect(settled.success).toBe(false)
		expect(!settled.success && settled.error.message).toBe(
			`task '${first.id}' is not a pending task`,
		)
	})
})

describe('Collection — insertion order survives interior change', () => {
	it('keeps the surviving order after an interior remove', () => {
		const [first, second, third] = buildTasks()
		const store = buildCollection()
		store.append(first)
		store.append(second)
		store.append(third)

		expect(store.remove(second.id).success).toBe(true)

		expect(store.entries()).toEqual([first, third])
		expect(store.count).toBe(2)
	})

	it('keeps the order across an interior status change to skipped', () => {
		const [first, second, third] = buildTasks()
		const store = buildCollection()
		store.append(first)
		store.append(second)
		store.append(third)

		second.skip()

		// A skip is a status change, never a removal — the position is untouched.
		expect(second.status).toBe('skipped')
		expect(store.entries()).toEqual([first, second, third])
		expect(store.count).toBe(3)
	})

	it('reads an absent id back as undefined and an empty store as an empty list', () => {
		const store = buildCollection()

		expect(store.entry('absent')).toBeUndefined()
		expect(store.entries()).toEqual([])
		expect(store.count).toBe(0)
	})
})
