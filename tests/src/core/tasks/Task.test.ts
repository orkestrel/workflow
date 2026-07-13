import type { TaskInterface, WorkflowDefinition, WorkflowInterface } from '@src/core'
import { createWorkflow, isWorkflowError } from '@src/core'
import { describe, expect, it } from 'vitest'
import { captureError, createErrorRecorder, recordEmitterEvents } from '../../../../setup.js'

// The leaf state machine (W-b): the legal AGENTS §10 transition graph + each illegal
// transition rejected, the recorded TaskResult (Success on complete, Failure on fail),
// and lineage. Real definition stubs drive a live tree — no mocks (AGENTS §16).

/** A single-task workflow definition stub — the minimal tree to exercise one leaf in isolation. */
function buildSingleTaskWorkflow(): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		phases: [
			{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'f' } }] },
		],
	}
}

/** Resolve the lone task of a {@link buildSingleTaskWorkflow} tree — a defined leaf for each test. */
function loneTask(workflow: WorkflowInterface): TaskInterface {
	const task = workflow.phase('p')?.task('t')
	if (task === undefined) throw new Error('expected the lone task to exist')
	return task
}

describe('Task — identity + lineage', () => {
	it('mirrors the definition identity and navigates UP its lineage', () => {
		const workflow = createWorkflow({
			id: 'wf',
			name: 'WF',
			phases: [
				{
					id: 'phase-1',
					name: 'Phase One',
					tasks: [{ id: 'task-1', name: 'Task One', run: { via: 'tool', name: 'x' } }],
				},
			],
		})
		const task = workflow.phase('phase-1')?.task('task-1')
		expect(task?.id).toBe('task-1')
		expect(task?.name).toBe('Task One')
		// Up the live tree…
		expect(task?.phase.id).toBe('phase-1')
		expect(task?.workflow.id).toBe('wf')
		// …and up the context chain (workflow → phase → task lineage).
		expect(task?.context.phase.id).toBe('phase-1')
		expect(task?.context.phase.workflow.id).toBe('wf')
	})

	it('starts pending with no result', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		expect(task.status).toBe('pending')
		expect(task.result).toBeUndefined()
	})
})

describe('Task — legal transitions', () => {
	it('start moves pending → running', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		expect(task.status).toBe('running')
		expect(task.result).toBeUndefined()
	})

	it('complete records a Success result with full lineage', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		task.complete({ artifact: 42 })
		expect(task.status).toBe('completed')
		const result = task.result
		expect(result?.status).toBe('completed')
		expect(result?.result).toBeDefined()
		if (result?.result === undefined) throw new Error('expected a boxed result')
		expect(result.result.success).toBe(true)
		if (!result.result.success) throw new Error('expected a Success')
		expect(result.result.value).toEqual({ artifact: 42 })
		// Lineage stamped on the result.
		expect(result.task.id).toBe('t')
		expect(result.phase.id).toBe('p')
		expect(result.workflow.id).toBe('wf')
		expect(typeof result.timestamp).toBe('number')
	})

	it('fail records a Failure result boxing the error', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		const boom = new Error('boom')
		task.fail(boom)
		expect(task.status).toBe('failed')
		const result = task.result
		expect(result?.status).toBe('failed')
		if (result?.result === undefined) throw new Error('expected a boxed result')
		expect(result.result.success).toBe(false)
		if (result.result.success) throw new Error('expected a Failure')
		expect(result.result.error).toBe(boom)
	})

	it('fail normalises a non-Error reason to an Error (preserving cause)', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		task.fail('plain string reason')
		const result = task.result
		if (result?.result === undefined || result.result.success) {
			throw new Error('expected a Failure')
		}
		expect(result.result.error).toBeInstanceOf(Error)
		expect(result.result.error.message).toBe('plain string reason')
		expect(result.result.error.cause).toBe('plain string reason')
	})

	it('boxes a falsy / undefined completion value as a present Success (value, not absence)', () => {
		// The boxed `result` is PRESENT for every `completed` leaf — even when the produced value is
		// falsy or `undefined`. A success with no payload must still read as a Success whose `value`
		// is that falsy value, never get mistaken for "no result" (the §10 completed ⇒ boxed rule).
		for (const value of [undefined, null, 0, '', false]) {
			const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
			task.start()
			task.complete(value)
			const result = task.result
			expect(result?.status).toBe('completed')
			if (result?.result === undefined)
				throw new Error('expected a boxed result even for a falsy value')
			expect(result.result.success).toBe(true)
			if (!result.result.success) throw new Error('expected a Success')
			expect(result.result.value).toBe(value)
		}
	})

	it('skip moves pending → skipped, no boxed outcome', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		task.skip()
		expect(task.status).toBe('skipped')
		expect(task.result).toBeUndefined()
	})

	it('stop moves pending → stopped, no boxed outcome', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		task.stop()
		expect(task.status).toBe('stopped')
		expect(task.result).toBeUndefined()
	})

	it('a running task may be skipped or stopped', () => {
		const skipped = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		skipped.start()
		skipped.skip()
		expect(skipped.status).toBe('skipped')

		const stopped = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		stopped.start()
		stopped.stop()
		expect(stopped.status).toBe('stopped')
	})
})

/** The machine-readable code of a captured {@link isWorkflowError}, else `undefined` — asserted unconditionally. */
function workflowCode(error: unknown): string | undefined {
	return isWorkflowError(error) ? error.code : undefined
}

describe('Task — illegal transitions are rejected (guarded §10)', () => {
	it('completing a non-running (pending) task throws TRANSITION', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		const error = captureError(() => task.complete('x'))
		expect(workflowCode(error)).toBe('TRANSITION')
		expect(isWorkflowError(error) ? error.context : undefined).toMatchObject({
			task: 't',
			from: 'pending',
			to: 'completed',
		})
		// The rejected transition left the task untouched.
		expect(task.status).toBe('pending')
	})

	it('failing a pending task throws TRANSITION', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		expect(workflowCode(captureError(() => task.fail(new Error('x'))))).toBe('TRANSITION')
		expect(task.status).toBe('pending')
	})

	it('starting an already-running task throws TRANSITION', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		expect(workflowCode(captureError(() => task.start()))).toBe('TRANSITION')
		expect(task.status).toBe('running')
	})

	it('a settled task rejects every further transition', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		task.complete('done')
		expect(workflowCode(captureError(() => task.start()))).toBe('TRANSITION')
		expect(workflowCode(captureError(() => task.complete('again')))).toBe('TRANSITION')
		expect(workflowCode(captureError(() => task.fail(new Error('x'))))).toBe('TRANSITION')
		expect(workflowCode(captureError(() => task.skip()))).toBe('TRANSITION')
		expect(workflowCode(captureError(() => task.stop()))).toBe('TRANSITION')
		expect(task.status).toBe('completed')
	})
})

describe('Task — emits (§13) after each transition', () => {
	it('fires start / complete with the result', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		const events = recordEmitterEvents(task.emitter, ['start', 'complete', 'fail', 'skip', 'stop'])
		task.start()
		task.complete('value')
		expect(events.start.calls).toEqual([['t']])
		expect(events.complete.count).toBe(1)
		expect(events.complete.calls[0]?.[0]?.status).toBe('completed')
		expect(events.fail.count).toBe(0)
	})

	it('fires fail with the failure result', () => {
		const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		const events = recordEmitterEvents(task.emitter, ['start', 'fail'])
		task.start()
		task.fail(new Error('nope'))
		expect(events.fail.count).toBe(1)
		expect(events.fail.calls[0]?.[0]?.status).toBe('failed')
	})

	it('fires skip / stop as pure signals', () => {
		const skipped = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		const skipEvents = recordEmitterEvents(skipped.emitter, ['skip'])
		skipped.skip()
		expect(skipEvents.skip.calls).toEqual([[]])

		const stopped = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		const stopEvents = recordEmitterEvents(stopped.emitter, ['stop'])
		stopped.stop()
		expect(stopEvents.stop.calls).toEqual([[]])
	})

	it('wires initial listeners from the on option', () => {
		const events: string[] = []
		const workflow = createWorkflow(buildSingleTaskWorkflow(), {
			phases: { p: { tasks: { t: { on: { start: () => events.push('start') } } } } },
		})
		loneTask(workflow).start()
		expect(events).toEqual(['start'])
	})
})

describe('Task — own event precedes the cascade (cause before effect)', () => {
	it('fires the task’s own complete BEFORE its phase + workflow cascade events', () => {
		// A single-task / single-phase tree: completing the lone task derives the phase AND the
		// workflow to `completed`, so all three emitters fire on the one transition. The order must
		// be cause (the task) then effect (the phase, then the workflow) — the AGENTS §13 precedent.
		const workflow = createWorkflow(buildSingleTaskWorkflow())
		const task = loneTask(workflow)
		const order: string[] = []
		task.emitter.on('complete', () => order.push('task'))
		workflow.phase('p')?.emitter.on('complete', () => order.push('phase'))
		workflow.emitter.on('complete', () => order.push('workflow'))
		task.start()
		task.complete('done')
		expect(order).toEqual(['task', 'phase', 'workflow'])
	})

	it('the workflow’s cascade event has NOT yet fired when the task’s own event fires', () => {
		// The defining symptom the fix corrects: when the task’s own `complete` fires, the cascade
		// has NOT yet propagated, so the workflow’s OWN `complete` event has not fired yet (it fires
		// strictly AFTER). Before the fix the cascade ran first, so a task-`complete` listener
		// already observed the workflow’s `complete` as fired — cause and effect were inverted.
		const workflow = createWorkflow(buildSingleTaskWorkflow())
		const task = loneTask(workflow)
		let workflowCompleteFired = false
		let workflowFiredBeforeTaskEvent = false
		workflow.emitter.on('complete', () => {
			workflowCompleteFired = true
		})
		task.emitter.on('complete', () => {
			// At the moment of the task’s own event, has the workflow already emitted complete?
			workflowFiredBeforeTaskEvent = workflowCompleteFired
		})
		task.start()
		task.complete('done')
		// The workflow had NOT emitted its own complete yet when the task emitted its own…
		expect(workflowFiredBeforeTaskEvent).toBe(false)
		// …and by the time control returns the cascade has run and the workflow has settled.
		expect(workflowCompleteFired).toBe(true)
		expect(workflow.status).toBe('completed')
	})

	it('fires the task’s own fail BEFORE the workflow fail cascade under bail', () => {
		// Under bail a failed leaf cascades all the way to a workflow `fail`; the leaf’s own `fail`
		// must still precede it (the listener sees cause then effect, mirroring `Runner.#settle`).
		const workflow = createWorkflow({
			id: 'wf',
			name: 'WF',
			bail: true,
			phases: [
				{
					id: 'p',
					name: 'P',
					tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'f' } }],
				},
			],
		})
		const task = loneTask(workflow)
		const order: string[] = []
		task.emitter.on('fail', () => order.push('task'))
		workflow.emitter.on('fail', () => order.push('workflow'))
		task.start()
		task.fail(new Error('boom'))
		expect(order).toEqual(['task', 'workflow'])
	})

	it('fires the task’s own stop BEFORE its phase stop cascade', () => {
		// `stop` derives the lone phase to `stopped` (a PhaseEventMap event) — the leaf’s own `stop`
		// must precede the phase’s `stop` (cause before effect), like the other transitions.
		const workflow = createWorkflow(buildSingleTaskWorkflow())
		const task = loneTask(workflow)
		const order: string[] = []
		task.emitter.on('stop', () => order.push('task'))
		workflow.phase('p')?.emitter.on('stop', () => order.push('phase'))
		task.stop()
		expect(order).toEqual(['task', 'phase'])
	})

	it('fires the task’s own skip, then still cascades the derivation to the tree', () => {
		// `skip` emits no phase / workflow event to order against, but its own event must still fire
		// AND the cascade must still run — skipping the lone task derives the whole tree to `skipped`.
		const workflow = createWorkflow(buildSingleTaskWorkflow())
		const task = loneTask(workflow)
		const events = recordEmitterEvents(task.emitter, ['skip'])
		task.skip()
		expect(events.skip.calls).toEqual([[]])
		// The cascade ran after the own event — the derived tree status reflects the skipped leaf.
		expect(workflow.status).toBe('skipped')
		expect(workflow.phase('p')?.status).toBe('skipped')
	})
})

describe('Task — emit-safety (§13)', () => {
	it('isolates a throwing listener, routes it to the error handler, and still transitions', () => {
		const errors = createErrorRecorder()
		const task = loneTask(
			createWorkflow(buildSingleTaskWorkflow(), {
				phases: { p: { tasks: { t: { error: errors.handler } } } },
			}),
		)
		task.emitter.on('start', () => {
			throw new Error('listener boom')
		})
		// The transition completes despite the throwing observer…
		expect(() => task.start()).not.toThrow()
		expect(task.status).toBe('running')
		// …and the throw is routed to the emitter's error handler — (error, event) order.
		expect(errors.count).toBe(1)
		expect(errors.calls[0]?.[0]).toBeInstanceOf(Error)
		expect(errors.calls[0]?.[1]).toBe('start')
	})
})

describe('Task — metadata round-trips through the snapshot', () => {
	it('carries the construction metadata into snapshot()', () => {
		const workflow = createWorkflow(buildSingleTaskWorkflow(), {
			phases: { p: { tasks: { t: { metadata: { owner: 'ada' } } } } },
		})
		expect(loneTask(workflow).snapshot().metadata).toEqual({ owner: 'ada' })
	})
})

describe('Task — the leaf snapshot: status IS the forced-terminal marker (no override field)', () => {
	it('a skipped / stopped leaf encodes its forced terminal in status alone (no override key)', () => {
		// A DERIVED phase / workflow persists an explicit `override` field, but a leaf does NOT — its
		// terminal status (`skipped` / `stopped`) already IS the forced marker, so the snapshot carries
		// no `override` key. Restore reinstates the leaf from `status` directly.
		for (const drive of [
			(task: TaskInterface) => task.skip(),
			(task: TaskInterface) => task.stop(),
		]) {
			const task = loneTask(createWorkflow(buildSingleTaskWorkflow()))
			drive(task)
			const snapshot = task.snapshot()
			expect(snapshot.status).toBe(task.status)
			expect(['skipped', 'stopped']).toContain(snapshot.status)
			expect('override' in snapshot).toBe(false) // the leaf has no override field at all
			expect('result' in snapshot).toBe(false) // skip / stop produced no boxed outcome
		}
	})

	it('a completed leaf snapshots its recorded result, a pending leaf snapshots none', () => {
		const pending = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		expect('result' in pending.snapshot()).toBe(false)
		const completed = loneTask(createWorkflow(buildSingleTaskWorkflow()))
		completed.start()
		completed.complete('payload')
		const snapshot = completed.snapshot()
		expect(snapshot.status).toBe('completed')
		expect(snapshot.result?.result?.success).toBe(true)
	})
})
