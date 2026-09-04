import type { TaskResult, TaskSnapshot, WorkflowEventMap, WorkflowSnapshot } from '@src/core'
import type { WorkflowEvent } from './setup.js'
import { describe, expect, it } from 'vitest'
import { createEmitter } from '@orkestrel/emitter'
import { captureError, createRecorder, createRecorders, requireValue } from '@orkestrel/test'
import { createWorkflow } from '@src/core'
import {
	buildCollection,
	buildReleaseDefinition,
	buildTasks,
	buildWorkflowDefinition,
	createErrorRecorder,
	createRecordingScheduler,
	createTaskControllerFixture,
	FaultBudget,
	instrumentSignal,
	INVALID_TASK_ACTIVITIES,
	isBrowserVuePath,
	omitTaskActivity,
	PHASE_EVENTS,
	RELEASE_FUNCTIONS,
	requireTask,
	RUNNER_EVENTS,
	settleSnapshot,
	TASK_EVENTS,
	WORKFLOW_EVENTS,
	WorkflowStoreBoundary,
} from './setup.js'

// The host-independent setup module's own contract — what the consuming suites in
// `tests/src/**` code against, asserted here rather than in any of them. Production
// behaviour stays out: each case reads a helper's own promise, and derives its
// expectation by a route the helper does not share (object rest over a real snapshot,
// the definition the fixture was built from, a real `AbortSignal`'s own delivery).

/** Every recorded-event table the consuming suites hand to `createRecorders`. */
const EVENT_TABLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
	WORKFLOW_EVENTS,
	PHASE_EVENTS,
	TASK_EVENTS,
	RUNNER_EVENTS,
})

describe('recorded-event tables', () => {
	it('freezes each table and names each event once', () => {
		const tables = Object.entries(EVENT_TABLES)

		// Each assertion reports the offending table by name. A shared table one suite could
		// mutate would silently change another suite's recorder set; an empty one would wire no
		// recorder at all; and a repeated name collapses two recorders into one, after which
		// every count double-reports.
		expect(tables.filter(([, events]) => !Object.isFrozen(events)).map(([table]) => table)).toEqual(
			[],
		)
		expect(tables.filter(([, events]) => events.length === 0).map(([table]) => table)).toEqual([])
		expect(
			tables.filter(([, events]) => new Set(events).size !== events.length).map(([table]) => table),
		).toEqual([])
	})

	it('wires one independent live recorder per named event', () => {
		const workflow = createWorkflow(buildWorkflowDefinition())
		const events = createRecorders<WorkflowEventMap, WorkflowEvent>(
			workflow.emitter,
			WORKFLOW_EVENTS,
		)

		workflow.pause()

		// The real emission reaches its own recorder and no other: the names are distinct channels.
		expect(WORKFLOW_EVENTS.filter((event) => events[event].count > 0)).toEqual(['pause'])
	})
})

describe('INVALID_TASK_ACTIVITIES', () => {
	it('is a frozen table of distinct single-argument cases', () => {
		// `validators.test.ts` and `cloners.test.ts` spread each row through `it.each`, so a row
		// of any other arity feeds the wrong argument to the case it registers.
		expect(Object.isFrozen(INVALID_TASK_ACTIVITIES)).toBe(true)
		expect(INVALID_TASK_ACTIVITIES.length).toBeGreaterThan(0)
		for (const row of INVALID_TASK_ACTIVITIES) expect(row.length).toBe(1)
		const frames = INVALID_TASK_ACTIVITIES.map((row) => JSON.stringify(row))
		expect(new Set(frames).size).toBe(frames.length)
	})
})

describe('omitTaskActivity', () => {
	it('drops activity and copies every other field, present and absent alike', () => {
		const workflow = createWorkflow(buildWorkflowDefinition())
		// `task-scan` carries a `description`; `task-compile` carries none, so one case covers a
		// present optional and an absent one.
		const described = requireTask(workflow, 'phase-build', 'task-scan')
		described.start()
		expect(described.report({ note: 'scanning' }).success).toBe(true)
		const bare = requireTask(workflow, 'phase-build', 'task-compile').snapshot()
		const rich = described.snapshot()
		expect(rich.activity).toBeDefined()

		for (const snapshot of [rich, bare]) {
			// The expectation is built by object rest over the real snapshot — a route the helper's
			// hand-written field list cannot share, so a field it forgets to copy surfaces here.
			const expected: Record<string, unknown> = { ...snapshot }
			delete expected.activity
			const copy: Record<string, unknown> = { ...omitTaskActivity(snapshot) }
			expect(copy).toStrictEqual(expected)
			// A copied-but-undefined optional would add a key `exactOptionalPropertyTypes` forbids.
			expect(Object.keys(copy).toSorted()).toEqual(Object.keys(expected).toSorted())
		}
	})
})

describe('requireTask', () => {
	it('resolves the live task the workflow holds at that address', () => {
		const workflow = createWorkflow(buildWorkflowDefinition())

		expect(requireTask(workflow, 'phase-build', 'task-compile')).toBe(
			workflow.phase('phase-build')?.task('task-compile'),
		)
	})

	it('refuses a missing address by naming it', () => {
		const workflow = createWorkflow(buildWorkflowDefinition())

		expect(() => requireTask(workflow, 'phase-build', 'task-absent')).toThrow(
			"expected task 'phase-build/task-absent'",
		)
	})
})

describe('createTaskControllerFixture', () => {
	it('builds a controller whose handle drives the live task it was given', () => {
		const abort = new AbortController()
		const results: TaskResult[] = []
		const task = requireTask(createWorkflow(buildWorkflowDefinition()), 'phase-build', 'task-scan')
		task.start()
		const handle = createTaskControllerFixture(task, abort.signal, () => results)

		expect(handle.signal).toBe(abort.signal)
		expect(handle.task).toBe(task.context)
		expect(handle.attempt).toBe(task.attempts)
		expect(handle.report({ note: 'through the handle' }).success).toBe(true)
		// The reported frame landed on the real task, so the handle is wired to it rather than to
		// a private copy of its state.
		expect(task.activity?.note).toBe('through the handle')
		expect(handle.pulse()).toBe(true)
		expect(handle.results()).toBe(results)
		expect(handle.aborted).toBe(false)
		abort.abort()
		expect(handle.aborted).toBe(true)
	})
})

describe('WorkflowStoreBoundary', () => {
	it('records every durable call and answers an ungated read as a miss', async () => {
		const store = new WorkflowStoreBoundary()
		const snapshot = createWorkflow(buildReleaseDefinition('recorded')).snapshot()

		expect(await store.get('recorded')).toBeUndefined()
		await store.set(snapshot)
		await store.delete('recorded')

		expect(store.gets).toEqual(['recorded'])
		expect(store.sets).toEqual([snapshot])
		expect(store.deletes).toEqual(['recorded'])
	})

	it('hands each queued gate to calls in the order they were made', async () => {
		const first = Promise.withResolvers<WorkflowSnapshot | undefined>()
		const second = Promise.withResolvers<WorkflowSnapshot | undefined>()
		const write = Promise.withResolvers<void>()
		const store = new WorkflowStoreBoundary([first, second], [write])
		const stored = createWorkflow(buildReleaseDefinition('queued')).snapshot()

		const reads = [store.get('first'), store.get('second')]
		const writes = store.set(stored)
		// Settling out of call order proves the queue is positional rather than first-settled-wins.
		second.resolve(undefined)
		first.resolve(stored)
		write.resolve()

		expect(await Promise.all(reads)).toEqual([stored, undefined])
		await writes
		expect(store.gets).toEqual(['first', 'second'])
	})
})

describe('FaultBudget', () => {
	it('throws the supplied failure from signal while counting start and clear', () => {
		const failure = new Error('budget signal unavailable')
		const budget = new FaultBudget(failure)

		expect(budget.starts).toBe(0)
		expect(budget.clears).toBe(0)
		budget.start()
		budget.consume({ prompt: 1, completion: 2, total: 3 })
		budget.clear()

		expect(budget.starts).toBe(1)
		expect(budget.clears).toBe(1)
		// The identical error, not merely one with the same message: a runner that swallows and
		// rewraps the setup failure fails here.
		expect(captureError(() => budget.signal)).toBe(failure)
	})
})

describe('createErrorRecorder', () => {
	it('records a listener throw as the emitter channel orders it', () => {
		const errors = createErrorRecorder()
		const emitter = createEmitter<{ readonly ping: readonly [] }>({ error: errors.handler })
		const failure = new Error('listener failed')
		emitter.on('ping', () => {
			throw failure
		})

		emitter.emit('ping')

		// `(error, event)` is `EmitterErrorHandler`'s own order; a swapped tuple reads as a working
		// recorder everywhere until an assertion names the event.
		expect(errors.calls).toEqual([[failure, 'ping']])
	})
})

describe('instrumentSignal', () => {
	it('counts an abort subscription and leaves the real notification intact', () => {
		const controller = new AbortController()
		const counts = instrumentSignal(controller.signal)
		const heard = createRecorder<readonly [Event]>()

		controller.signal.addEventListener('abort', heard.handler)

		expect(counts.added.count).toBe(1)
		expect(counts.removed.count).toBe(0)
		controller.abort()
		expect(heard.count).toBe(1)
	})

	it('counts a removal that genuinely detached the listener', () => {
		const controller = new AbortController()
		const counts = instrumentSignal(controller.signal)
		const heard = createRecorder<readonly [Event]>()

		controller.signal.addEventListener('abort', heard.handler)
		controller.signal.removeEventListener('abort', heard.handler)

		expect(counts.removed.count).toBe(1)
		controller.abort()
		// A wrapper that counted without delegating would leave the listener attached, and the
		// leak proofs would read a detached signal as clean.
		expect(heard.count).toBe(0)
	})

	it('ignores another event type while still delegating it', () => {
		const controller = new AbortController()
		const counts = instrumentSignal(controller.signal)
		const heard = createRecorder<readonly [Event]>()

		controller.signal.addEventListener('pulse', heard.handler)
		controller.signal.dispatchEvent(new Event('pulse'))

		expect(counts.added.count).toBe(0)
		expect(heard.count).toBe(1)
	})
})

describe('createRecordingScheduler', () => {
	it('counts each yield and still crosses a real turn boundary', async () => {
		const scheduler = createRecordingScheduler()
		const order: string[] = []
		const queued = Promise.resolve().then(() => order.push('queued'))

		expect(scheduler.yields).toBe(0)
		await scheduler.yield()
		order.push('resumed')

		await queued
		expect(scheduler.yields).toBe(1)
		// Work already queued ran before the yield returned, so the delegate really paced a turn.
		expect(order).toEqual(['queued', 'resumed'])
	})

	it('delegates delay to the shipped scheduler without counting a yield', async () => {
		const scheduler = createRecordingScheduler()

		const started = performance.now()
		await scheduler.delay(20)
		const elapsed = performance.now() - started

		expect(elapsed).toBeGreaterThan(5)
		expect(scheduler.yields).toBe(0)
	})
})

describe('buildWorkflowDefinition', () => {
	it('builds a definition the shipped factory accepts as a live tree', () => {
		const definition = buildWorkflowDefinition()
		const phase = requireValue(definition.phases[0], 'expected a declared first phase')

		const workflow = createWorkflow(definition)

		expect(workflow.id).toBe(definition.id)
		// The live tree is compared against the definition it came from, not against a copy of the
		// fixture's own literal.
		expect(workflow.snapshot().phases.map((entry) => entry.id)).toEqual(
			definition.phases.map((entry) => entry.id),
		)
		expect(
			workflow
				.phase(phase.id)
				?.snapshot()
				.tasks.map((task) => task.id),
		).toEqual(phase.tasks.map((task) => task.id))
	})

	it('replaces a declared field with its override and leaves the rest', () => {
		const overridden = buildWorkflowDefinition({ id: 'wf-override', bail: true })

		expect(overridden.id).toBe('wf-override')
		expect(overridden.bail).toBe(true)
		expect(overridden.phases).toEqual(buildWorkflowDefinition().phases)
	})
})

describe('buildTasks', () => {
	it('returns every live task the definition declares, in declaration order', () => {
		const definition = buildWorkflowDefinition()

		const tasks = buildTasks()

		// The expectation is derived from the definition the fixture builds from, not from a copy of
		// the addresses `buildTasks` names.
		expect(tasks.map((task) => task.id)).toEqual(
			definition.phases.flatMap((phase) => phase.tasks.map((task) => task.id)),
		)
		expect(tasks.map((task) => task.status)).toEqual(tasks.map(() => 'pending'))
	})

	it('mints a fresh tree per call, so a transition on one call cannot reach a later one', () => {
		const [started] = buildTasks()
		started.start()

		const [later] = buildTasks()

		expect(started.status).toBe('running')
		expect(later.status).toBe('pending')
		expect(later).not.toBe(started)
	})
})

describe('buildCollection', () => {
	it('returns an empty store naming the entity noun it was given', () => {
		const [first] = buildTasks()
		const store = buildCollection('phase')
		expect(store.count).toBe(0)
		expect(store.entries()).toEqual([])
		store.append(first)

		const error = captureError(() => {
			store.append(first)
		})

		// The noun reached the real constructor, so a caller reads its own vocabulary back.
		expect(error instanceof Error && error.message).toBe(`duplicate phase id '${first.id}'`)
	})

	it('defaults the noun to the task vocabulary and wires the real compiled guard', () => {
		const [first] = buildTasks()
		const store = buildCollection()
		store.append(first)

		const duplicate = captureError(() => {
			store.append(first)
		})

		expect(duplicate instanceof Error && duplicate.message).toBe(`duplicate task id '${first.id}'`)
		// A permissive stand-in guard would accept the empty `name` the real `taskUpdateShape`
		// refuses, so this reads the wiring rather than the store's gate.
		expect(store.update(first.id, { name: '' }).success).toBe(false)
	})
})

describe('buildReleaseDefinition and RELEASE_FUNCTIONS', () => {
	it('names a registered handler on every release task', () => {
		const definition = buildReleaseDefinition()

		const behaviors = definition.phases.flatMap((phase) => phase.tasks.map((task) => task.behavior))

		// An unregistered name leaves its task with no behaviour, and every store twin driving this
		// definition would settle a task that never ran.
		expect(
			behaviors.filter((name) => name === undefined || RELEASE_FUNCTIONS[name] === undefined),
		).toEqual([])
	})

	it('takes its id from the argument and defaults it otherwise', () => {
		expect(buildReleaseDefinition().id).toBe('release')
		expect(buildReleaseDefinition('audit').id).toBe('audit')
	})
})

describe('settleSnapshot', () => {
	it('drives the definition to a settled snapshot carrying a distinct result per task', async () => {
		const definition = buildReleaseDefinition('settled')

		const snapshot = await settleSnapshot(definition)

		expect(snapshot.id).toBe('settled')
		const tasks: readonly TaskSnapshot[] = snapshot.phases.flatMap((phase) => phase.tasks)
		expect(tasks.map((task) => task.id)).toEqual(
			definition.phases.flatMap((phase) => phase.tasks.map((task) => task.id)),
		)
		expect(tasks.map((task) => task.status)).toEqual(tasks.map(() => 'completed'))
		const values = tasks.map((task) => {
			const boxed = task.result?.result
			return boxed !== undefined && boxed.success ? JSON.stringify(boxed.value) : undefined
		})
		// Every handler recorded a real boxed value, and no two tasks are indistinguishable — the
		// store twins tell their tasks apart by exactly this.
		expect(values.filter((value) => value === undefined)).toEqual([])
		expect(new Set(values).size).toBe(values.length)
	})
})

describe('isBrowserVuePath', () => {
	it('accepts a browser application path under either separator family', () => {
		expect(isBrowserVuePath('app/browser/views/Home.vue')).toBe(true)
		expect(isBrowserVuePath('app\\browser\\views\\Home.vue')).toBe(true)
	})

	it('refuses a sibling environment, a prefix lookalike, and a nested match', () => {
		expect(isBrowserVuePath('app/server/views/Home.vue')).toBe(false)
		expect(isBrowserVuePath('app/browserish/views/Home.vue')).toBe(false)
		expect(isBrowserVuePath('src/app/browser/views/Home.vue')).toBe(false)
	})
})
