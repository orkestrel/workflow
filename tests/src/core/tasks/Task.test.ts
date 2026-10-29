import { INVALID_TASK_FAILURES, FALSY_TASK_VALUES } from '../../../setup.js'
import type { TaskEventMap, TaskOptions } from '@src/core'
import type { TaskEvent } from '../../../setup.js'
import { MAX_TIMER_MS, createWorkflow, isWorkflowError, createRestoredWorkflow } from '@src/core'
import { describe, expect, it } from 'vitest'
import { captureError, createRecorder, createRecorders, waitForDelay } from '@orkestrel/test'
import { Task } from '../../../../src/core/tasks/Task.js'
import {
	buildSingleTaskWorkflow,
	requireWorkflowTask,
	readWorkflowCode,
	buildWorkflowClaim,
	WorkflowObservation,
	createErrorRecorder,
	TASK_EVENTS,
	TASK_FORCED_DRIVERS,
	TASK_TERMINAL_DRIVERS,
	returnWorkflowValue,
} from '../../../setup.js'

// The leaf state machine (W-b): the legal transition graph + each illegal
// transition rejected, the recorded TaskResult (Success on complete, Failure on fail),
// and lineage. Real definition stubs drive a live tree — no mocks.

/** A single-task workflow definition stub — the minimal tree to exercise one leaf in isolation. */

/** Resolve the lone task of a {@link buildSingleTaskWorkflow} tree — a defined leaf for each test. */

describe('Task — direct construction option ownership', () => {
	it('captures inherited and non-enumerable metadata, hooks, errors, and silence once', () => {
		const metadataReads = new WorkflowObservation(0)
		const onReads = new WorkflowObservation(0)
		const errorReads = new WorkflowObservation(0)
		const silenceReads = new WorkflowObservation(0)
		const starts = createRecorder<readonly [string]>()
		const errors = createErrorRecorder()
		const failure = new Error('task listener failed')
		const options: TaskOptions = {}
		const prototype = {}
		Object.defineProperties(prototype, {
			metadata: {
				get: () => {
					metadataReads.value += 1
					return { source: 'captured' }
				},
			},
			on: {
				get: () => {
					onReads.value += 1
					return { start: starts.handler }
				},
			},
			error: {
				get: () => {
					errorReads.value += 1
					return errors.handler
				},
			},
		})
		Object.setPrototypeOf(options, prototype)
		Object.defineProperty(options, 'silence', {
			enumerable: false,
			get: () => {
				silenceReads.value += 1
				return 25
			},
		})
		const source = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		const task = new Task(source.context, source.phase, source.workflow, () => {}, options)
		task.emitter.on('start', () => {
			throw failure
		})

		task.start()

		expect(task.snapshot().metadata).toEqual({ source: 'captured' })
		expect(task.silence).toBe(25)
		expect(starts.calls).toEqual([[task.id]])
		expect(errors.calls).toEqual([[failure, 'start']])
		expect([metadataReads.value, onReads.value, errorReads.value, silenceReads.value]).toEqual([
			1, 1, 1, 1,
		])
	})

	it('normalizes a throwing metadata getter before reading later task options', () => {
		const reads: string[] = []
		const options: TaskOptions = {}
		Object.defineProperties(options, {
			metadata: {
				get: () => {
					reads.push('metadata')
					throw new Error('metadata unavailable')
				},
			},
			on: {
				get: () => {
					reads.push('on')
					return {}
				},
			},
			error: {
				get: () => {
					reads.push('error')
					return undefined
				},
			},
			silence: {
				get: () => {
					reads.push('silence')
					return 25
				},
			},
		})
		const source = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))

		const error = captureError(
			() => new Task(source.context, source.phase, source.workflow, () => {}, options),
		)

		expect(reads).toEqual(['metadata'])
		expect(isWorkflowError(error) ? error.code : undefined).toBe('RESTORE')
		expect(isWorkflowError(error) ? error.message : undefined).toContain(
			"task 't' metadata could not be read safely",
		)
	})
})

describe('Task — identity + lineage', () => {
	it('mirrors the definition identity and navigates UP its lineage', () => {
		const workflow = createWorkflow({
			id: 'wf',
			name: 'WF',
			phases: [
				{
					id: 'phase-1',
					name: 'Phase One',
					tasks: [{ id: 'task-1', name: 'Task One', behavior: 'x' }],
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
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		expect(task.status).toBe('pending')
		expect(task.result).toBeUndefined()
	})
})

describe('Task — activity, liveness, and cooperative control', () => {
	it('seeds activity on start and atomically replaces determinate and indeterminate frames', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		expect(task.activity).toBeUndefined()
		expect(task.snapshot().activity).toBeUndefined()
		task.start()
		expect(task.activity?.operations).toEqual([])
		expect(task.activity?.constraints).toEqual([])

		const operation = { id: 'build', name: 'Build', started: 1 }
		const determinate = task.report({
			note: 'compiling',
			progress: { progress: 2, total: 4, message: 'files' },
			operations: [operation],
			constraints: [{ id: 'cpu', name: 'CPU quota', started: 2 }],
		})
		expect(determinate.success).toBe(true)
		operation.name = 'changed'
		expect(task.activity?.operations[0]?.name).toBe('Build')
		expect(Object.isFrozen(task.activity)).toBe(true)
		expect(Object.isFrozen(task.activity?.progress)).toBe(true)
		expect(Object.isFrozen(task.activity?.operations)).toBe(true)
		expect(Object.isFrozen(task.activity?.operations[0])).toBe(true)
		expect(Object.isFrozen(task.activity?.constraints)).toBe(true)
		expect(Object.isFrozen(task.activity?.constraints[0])).toBe(true)

		const indeterminate = task.report({ progress: { progress: 5 } })
		expect(indeterminate.success).toBe(true)
		expect(task.activity?.note).toBeUndefined()
		expect(task.activity?.progress).toEqual({ progress: 5 })
		expect(task.activity?.operations).toEqual([])
		expect(task.activity?.constraints).toEqual([])
	})

	it('refuses invalid or out-of-lifecycle reports without changing the prior frame', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		const pending = task.report({ note: 'early' })
		expect(pending.success).toBe(false)
		if (pending.success) throw new Error('expected transition refusal')
		expect(pending.error.code).toBe('TRANSITION')
		task.start()
		const accepted = task.report({ note: 'valid' })
		expect(accepted.success).toBe(true)
		const before = task.activity
		const invalid = task.report({ progress: { progress: 2, total: 1 } })
		expect(invalid.success).toBe(false)
		if (invalid.success) throw new Error('expected mutation refusal')
		expect(invalid.error.code).toBe('MUTATION')
		expect(task.activity).toBe(before)
		task.complete('done')
		expect(task.report({}).success).toBe(false)
		expect(task.pulse()).toBe(false)
		expect(task.snapshot().activity).toBe(before)
	})

	it('contains hostile report getters atomically and captures shifting fields once', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		const accepted = task.report({ note: 'prior' })
		if (!accepted.success) throw accepted.error
		const prior = accepted.value
		const refused = task.report({
			get note(): string {
				throw new Error('hostile')
			},
		})
		expect(refused.success).toBe(false)
		expect(task.activity).toBe(prior)

		const reads = new WorkflowObservation(0)
		const operation = buildWorkflowClaim(reads)
		const shifted = task.report({ operations: [operation] })
		expect(shifted.success).toBe(true)
		expect(reads.value).toBe(1)
		expect(task.activity?.operations[0]?.id).toBe('stable')
	})

	it('pulses liveness without replacing the frame and emits the refreshed frame', async () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		const events = createRecorders<TaskEventMap, TaskEvent>(task.emitter, TASK_EVENTS)
		task.start()
		const reported = task.report({ note: 'quiet work' })
		if (!reported.success) throw reported.error
		const before = reported.value
		await waitForDelay(2)
		expect(task.pulse()).toBe(true)
		expect(task.activity?.note).toBe('quiet work')
		expect(task.activity?.updated).toBeGreaterThanOrEqual(before.updated)
		expect(events.pulse.calls).toEqual([[task.activity]])
	})

	it('never regresses a future restored activity stamp on retry, report, or pulse', () => {
		const source = createWorkflow(
			{
				...buildSingleTaskWorkflow(),
				phases: [
					{
						id: 'p',
						name: 'P',
						tasks: [{ id: 't', name: 'T', behavior: 'f', retries: 1 }],
					},
				],
			},
			{ functions: { f: () => null } },
		)
		const running = requireWorkflowTask(source)
		running.start()
		const snapshot = source.snapshot()
		const phase = snapshot.phases[0]
		const leaf = phase?.tasks[0]
		if (phase === undefined || leaf?.activity === undefined) {
			throw new Error('expected running activity')
		}
		const future = Date.now() + 60_000
		const restored = createRestoredWorkflow(
			{
				...snapshot,
				phases: [
					{
						...phase,
						tasks: [{ ...leaf, activity: { ...leaf.activity, updated: future } }],
					},
				],
			},
			{ functions: { f: () => null } },
		)
		const task = requireWorkflowTask(restored)

		task.start()
		expect(task.activity?.updated).toBe(future)
		expect(task.report({ note: 'still working' }).success).toBe(true)
		expect(task.activity?.updated).toBe(future)
		expect(task.pulse()).toBe(true)
		expect(task.activity?.updated).toBe(future)
	})

	it('rearms a reusable silence deadline after both report and pulse, then clears on terminal', async () => {
		const workflow = createWorkflow(buildSingleTaskWorkflow(), { silence: 15 })
		const task = requireWorkflowTask(workflow)
		const events = createRecorders<TaskEventMap, TaskEvent>(task.emitter, TASK_EVENTS)
		task.start()
		await waitForDelay(25)
		expect(task.silent).toBe(true)
		expect(events.silence.count).toBe(1)

		expect(task.report({ note: 'resumed' }).success).toBe(true)
		expect(task.silent).toBe(false)
		await waitForDelay(25)
		expect(events.silence.count).toBe(2)

		expect(task.pulse()).toBe(true)
		expect(task.silent).toBe(false)
		await waitForDelay(25)
		expect(events.silence.count).toBe(3)
		task.complete('done')
		await waitForDelay(25)
		expect(events.silence.count).toBe(3)
	})

	it('allows a task override to disable inherited silence and releases pause on stop', async () => {
		const workflow = createWorkflow(buildSingleTaskWorkflow(), {
			silence: 10,
			phases: { p: { tasks: { t: { silence: 0 } } } },
		})
		const task = requireWorkflowTask(workflow)
		expect(task.silence).toBeUndefined()
		task.pause()
		const waiting = task.wait()
		expect(task.paused).toBe(true)
		task.stop()
		await waiting
		expect(task.paused).toBe(false)
		expect(task.signal.aborted).toBe(true)

		const skipped = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		skipped.skip()
		expect(skipped.signal.aborted).toBe(true)
	})

	it('accepts the host timer maximum and disables overflow without immediate silence', async () => {
		const maximum = requireWorkflowTask(
			createWorkflow(buildSingleTaskWorkflow(), { silence: MAX_TIMER_MS }),
		)
		const maximumEvents = createRecorders<TaskEventMap, TaskEvent>(maximum.emitter, TASK_EVENTS)
		maximum.start()
		await Promise.resolve()
		expect(maximum.silence).toBe(MAX_TIMER_MS)
		expect(maximum.silent).toBe(false)
		expect(maximumEvents.silence.count).toBe(0)
		maximum.stop()

		const overflow = requireWorkflowTask(
			createWorkflow(buildSingleTaskWorkflow(), { silence: MAX_TIMER_MS + 1 }),
		)
		const overflowEvents = createRecorders<TaskEventMap, TaskEvent>(overflow.emitter, TASK_EVENTS)
		overflow.start()
		await waitForDelay(2)
		expect(overflow.silence).toBeUndefined()
		expect(overflow.silent).toBe(false)
		expect(overflowEvents.silence.count).toBe(0)
		overflow.stop()
	})
})

describe('Task — legal transitions', () => {
	it('start moves pending → running', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		expect(task.status).toBe('running')
		expect(task.result).toBeUndefined()
	})

	it('complete records a Success result with full lineage', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
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

	it('fail records a normalized JSON failure', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		const boom = new Error('boom')
		task.fail({ origin: 'handler', message: boom.message })
		expect(task.status).toBe('failed')
		const result = task.result
		expect(result?.status).toBe('failed')
		if (result?.result === undefined) throw new Error('expected a boxed result')
		expect(result.result.success).toBe(false)
		if (result.result.success) throw new Error('expected a Failure')
		expect(result.result.error).toEqual({ origin: 'handler', message: 'boom' })
	})

	it('fail preserves a normalized failure reason', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		task.fail({ origin: 'recovery', message: 'plain string reason' })
		const result = task.result
		if (result?.result === undefined || result.result.success) {
			throw new Error('expected a Failure')
		}
		expect(result.result.error).toEqual({
			origin: 'recovery',
			message: 'plain string reason',
		})
	})

	it('fail replaces invalid or empty boundary messages with the literal fallback', () => {
		for (const failure of INVALID_TASK_FAILURES) {
			const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
			task.start()
			Reflect.apply(task.fail, task, [failure])
			const result = task.result
			if (result?.result === undefined || result.result.success) {
				throw new Error('expected a normalized Failure')
			}
			expect(result.result.error).toEqual({
				origin: 'handler',
				message: 'unknown failure',
			})
		}
	})

	it('boxes every falsy JSON completion value as a present Success', () => {
		// The boxed `result` is PRESENT for every `completed` leaf — even when the produced value is
		// falsy or `undefined`. A success with no payload must still read as a Success whose `value`
		// is that falsy value, never get mistaken for "no result" (the completed ⇒ boxed rule).
		for (const value of FALSY_TASK_VALUES) {
			const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
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
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		task.skip()
		expect(task.status).toBe('skipped')
		expect(task.result).toBeUndefined()
	})

	it('stop moves pending → stopped, no boxed outcome', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		task.stop()
		expect(task.status).toBe('stopped')
		expect(task.result).toBeUndefined()
	})

	it('a running task may be skipped or stopped', () => {
		const skipped = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		skipped.start()
		skipped.skip()
		expect(skipped.status).toBe('skipped')

		const stopped = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		stopped.start()
		stopped.stop()
		expect(stopped.status).toBe('stopped')
	})
})

/** The machine-readable code of a captured {@link isWorkflowError}, else `undefined` — asserted unconditionally. */

describe('Task — illegal transitions are rejected (guarded)', () => {
	it('completing a non-running (pending) task throws TRANSITION', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		const error = captureError(() => task.complete('x'))
		expect(readWorkflowCode(error)).toBe('TRANSITION')
		expect(isWorkflowError(error) ? error.context : undefined).toMatchObject({
			task: 't',
			from: 'pending',
			to: 'completed',
		})
		// The rejected transition left the task untouched.
		expect(task.status).toBe('pending')
	})

	it('failing a pending task throws TRANSITION', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		expect(
			readWorkflowCode(captureError(() => task.fail({ origin: 'handler', message: 'x' }))),
		).toBe('TRANSITION')
		expect(task.status).toBe('pending')
	})

	it('starting an already-running task throws TRANSITION', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		expect(readWorkflowCode(captureError(() => task.start()))).toBe('TRANSITION')
		expect(task.status).toBe('running')
	})

	it('a settled task rejects every further transition', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		task.complete('done')
		expect(readWorkflowCode(captureError(() => task.start()))).toBe('TRANSITION')
		expect(readWorkflowCode(captureError(() => task.complete('again')))).toBe('TRANSITION')
		expect(
			readWorkflowCode(captureError(() => task.fail({ origin: 'handler', message: 'x' }))),
		).toBe('TRANSITION')
		expect(readWorkflowCode(captureError(() => task.skip()))).toBe('TRANSITION')
		expect(readWorkflowCode(captureError(() => task.stop()))).toBe('TRANSITION')
		expect(task.status).toBe('completed')
	})
})

describe('Task — emits after each transition', () => {
	it('emits pause and resume once after each real runtime-gate change', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		const states: boolean[] = []
		const events = createRecorders<TaskEventMap, TaskEvent>(task.emitter, TASK_EVENTS)
		task.emitter.on('pause', () => states.push(task.paused))
		task.emitter.on('resume', () => states.push(task.paused))

		task.pause()
		task.pause()
		task.resume()
		task.resume()

		expect(events.pause.calls).toEqual([[]])
		expect(events.resume.calls).toEqual([[]])
		expect(states).toEqual([true, false])
		expect(task.snapshot()).not.toHaveProperty('paused')
	})

	it('does not emit resume when terminal cleanup releases a paused task', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		const events = createRecorders<TaskEventMap, TaskEvent>(task.emitter, TASK_EVENTS)
		task.pause()
		task.stop()
		task.pause()
		task.resume()

		expect(task.paused).toBe(false)
		expect(events.pause.calls).toEqual([[]])
		expect(events.resume.count).toBe(0)
	})

	it('fires start / complete with the result', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		const events = createRecorders<TaskEventMap, TaskEvent>(task.emitter, TASK_EVENTS)
		task.start()
		task.complete('value')
		expect(events.start.calls).toEqual([['t']])
		expect(events.complete.count).toBe(1)
		expect(events.complete.calls[0]?.[0]?.status).toBe('completed')
		expect(events.fail.count).toBe(0)
	})

	it('fires fail with the failure result', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		const events = createRecorders<TaskEventMap, TaskEvent>(task.emitter, TASK_EVENTS)
		task.start()
		task.fail({ origin: 'handler', message: 'nope' })
		expect(events.fail.count).toBe(1)
		expect(events.fail.calls[0]?.[0]?.status).toBe('failed')
	})

	it('fires skip / stop as pure signals', () => {
		const skipped = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		const skipEvents = createRecorders<TaskEventMap, TaskEvent>(skipped.emitter, TASK_EVENTS)
		skipped.skip()
		expect(skipEvents.skip.calls).toEqual([[]])

		const stopped = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		const stopEvents = createRecorders<TaskEventMap, TaskEvent>(stopped.emitter, TASK_EVENTS)
		stopped.stop()
		expect(stopEvents.stop.calls).toEqual([[]])
	})

	it('wires initial listeners from the on option', () => {
		const events: string[] = []
		const workflow = createWorkflow(buildSingleTaskWorkflow(), {
			phases: { p: { tasks: { t: { on: { start: () => events.push('start') } } } } },
		})
		requireWorkflowTask(workflow).start()
		expect(events).toEqual(['start'])
	})
})

describe('Task — own event precedes the cascade (cause before effect)', () => {
	it('fires the task’s own complete BEFORE its phase + workflow cascade events', () => {
		// A single-task / single-phase tree: completing the lone task derives the phase AND the
		// workflow to `completed`, so all three emitters fire on the one transition. The order must
		// be cause (the task) then effect (the phase, then the workflow) — the emitter precedent.
		const workflow = createWorkflow(buildSingleTaskWorkflow())
		const task = requireWorkflowTask(workflow)
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
		const task = requireWorkflowTask(workflow)
		const workflowCompleteFired = new WorkflowObservation(false)
		const workflowFiredBeforeTaskEvent = new WorkflowObservation(false)
		workflow.emitter.on('complete', () => {
			workflowCompleteFired.value = true
		})
		task.emitter.on('complete', () => {
			// At the moment of the task’s own event, has the workflow already emitted complete?
			workflowFiredBeforeTaskEvent.value = workflowCompleteFired.value
		})
		task.start()
		task.complete('done')
		// The workflow had NOT emitted its own complete yet when the task emitted its own…
		expect(workflowFiredBeforeTaskEvent.value).toBe(false)
		// …and by the time control returns the cascade has run and the workflow has settled.
		expect(workflowCompleteFired.value).toBe(true)
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
					tasks: [{ id: 't', name: 'T', behavior: 'f' }],
				},
			],
		})
		const task = requireWorkflowTask(workflow)
		const order: string[] = []
		task.emitter.on('fail', () => order.push('task'))
		workflow.emitter.on('fail', () => order.push('workflow'))
		task.start()
		task.fail({ origin: 'handler', message: 'boom' })
		expect(order).toEqual(['task', 'workflow'])
	})

	it('fires the task’s own stop BEFORE its phase stop cascade', () => {
		// `stop` derives the lone phase to `stopped` (a PhaseEventMap event) — the leaf’s own `stop`
		// must precede the phase’s `stop` (cause before effect), like the other transitions.
		const workflow = createWorkflow(buildSingleTaskWorkflow())
		const task = requireWorkflowTask(workflow)
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
		const task = requireWorkflowTask(workflow)
		const events = createRecorders<TaskEventMap, TaskEvent>(task.emitter, TASK_EVENTS)
		task.skip()
		expect(events.skip.calls).toEqual([[]])
		// The cascade ran after the own event — the derived tree status reflects the skipped leaf.
		expect(workflow.status).toBe('skipped')
		expect(workflow.phase('p')?.status).toBe('skipped')
	})
})

describe('Task — emit-safety', () => {
	it('isolates a throwing listener, routes it to the error handler, and still transitions', () => {
		const errors = createErrorRecorder()
		const task = requireWorkflowTask(
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
	it('owns construction metadata before carrying it into snapshot()', () => {
		const details = { owner: 'ada' }
		const workflow = createWorkflow(buildSingleTaskWorkflow(), {
			phases: { p: { tasks: { t: { metadata: { details } } } } },
		})
		details.owner = 'grace'
		const metadata = requireWorkflowTask(workflow).snapshot().metadata
		expect(metadata).toEqual({ details: { owner: 'ada' } })
		expect(Object.isFrozen(metadata)).toBe(true)
		expect(Object.isFrozen(metadata.details)).toBe(true)
	})

	it('translates hostile metadata failures to RESTORE', () => {
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()
		const error = captureError(() =>
			createWorkflow(buildSingleTaskWorkflow(), {
				phases: { p: { tasks: { t: { metadata: revoked.proxy } } } },
			}),
		)

		expect(isWorkflowError(error)).toBe(true)
		if (!isWorkflowError(error)) throw new Error('expected WorkflowError')
		expect(error.code).toBe('RESTORE')
		expect(error.message).toContain('plain record')
	})

	it('leaves a running task unchanged when result ownership fails', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()
		const error = captureError(() => Reflect.apply(task.complete, task, [revoked.proxy]))

		expect(isWorkflowError(error)).toBe(true)
		if (!isWorkflowError(error)) throw new Error('expected WorkflowError')
		expect(error.code).toBe('RESTORE')
		expect(error.message).toContain('could not be inspected')
		expect(task.status).toBe('running')
		expect(task.result).toBeUndefined()
	})
})

describe('Task — the leaf snapshot: status IS the forced-terminal marker (no override field)', () => {
	it('a skipped / stopped leaf encodes its forced terminal in status alone (no override key)', () => {
		// A DERIVED phase / workflow persists an explicit `override` field, but a leaf does NOT — its
		// terminal status (`skipped` / `stopped`) already IS the forced marker, so the snapshot carries
		// no `override` key. Restore reinstates the leaf from `status` directly.
		for (const drive of TASK_FORCED_DRIVERS) {
			const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
			drive(task)
			const snapshot = task.snapshot()
			expect(snapshot.status).toBe(task.status)
			expect(['skipped', 'stopped']).toContain(snapshot.status)
			expect('override' in snapshot).toBe(false) // the leaf has no override field at all
			expect('result' in snapshot).toBe(false) // skip / stop produced no boxed outcome
		}
	})

	it('a completed leaf snapshots its recorded result, a pending leaf snapshots none', () => {
		const pending = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		expect('result' in pending.snapshot()).toBe(false)
		const completed = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		completed.start()
		completed.complete('payload')
		const snapshot = completed.snapshot()
		expect(snapshot.status).toBe('completed')
		expect(snapshot.result?.result?.success).toBe(true)
	})
})

describe('Task — declarative behavior/retries/timeout PERSIST, handler is runtime-only', () => {
	it('seeds behavior/retries/timeout from the definition when built through createWorkflow', () => {
		const workflow = createWorkflow({
			id: 'wf',
			name: 'WF',
			phases: [
				{
					id: 'p',
					name: 'P',
					tasks: [
						{
							id: 't',
							name: 'T',
							behavior: 'x',
							retries: 3,
							timeout: 500,
						},
					],
				},
			],
		})
		const task = requireWorkflowTask(workflow)
		expect(task.behavior).toBe('x')
		expect(task.retries).toBe(3)
		expect(task.timeout).toBe(500)
	})

	it('leaves retries/timeout undefined when the definition omits them', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		expect(task.behavior).toBe('f')
		expect(task.retries).toBeUndefined()
		expect(task.timeout).toBeUndefined()
	})

	it('behavior/retries/timeout SURVIVE the restore path — they are declarative config, persisted like bail/concurrency', () => {
		// Unlike the old execution-only fields, behavior/retries/timeout are PERSISTED on the
		// TaskSnapshot (like a phase's bail/concurrency), so a restore reinstates them verbatim.
		const original = createWorkflow({
			id: 'wf',
			name: 'WF',
			phases: [
				{
					id: 'p',
					name: 'P',
					tasks: [{ id: 't', name: 'T', behavior: 'x', retries: 2, timeout: 100 }],
				},
			],
		})
		const restored = createRestoredWorkflow(original.snapshot(), { functions: { x: () => null } })
		const task = requireWorkflowTask(restored)
		expect(task.behavior).toBe('x')
		expect(task.retries).toBe(2)
		expect(task.timeout).toBe(100)
	})

	it('behavior/retries/timeout DO appear in the leaf snapshot when the definition declares them', () => {
		const task = requireWorkflowTask(
			createWorkflow({
				id: 'wf',
				name: 'WF',
				phases: [
					{
						id: 'p',
						name: 'P',
						tasks: [{ id: 't', name: 'T', behavior: 'x', retries: 1, timeout: 10 }],
					},
				],
			}),
		)
		const snapshot = task.snapshot()
		expect(snapshot.behavior).toBe('x')
		expect(snapshot.retries).toBe(1)
		expect(snapshot.timeout).toBe(10)
	})

	it('behavior/retries/timeout are OMITTED from the snapshot when the definition declares none', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		const snapshot = task.snapshot()
		expect('retries' in snapshot).toBe(false)
		expect('timeout' in snapshot).toBe(false)
	})

	it('handler is the RUNTIME-ONLY resolution of run against WorkflowOptions.functions — never persisted', () => {
		const workflow = createWorkflow(buildSingleTaskWorkflow(), {
			functions: { f: returnWorkflowValue },
		})
		const task = requireWorkflowTask(workflow)
		expect(task.handler).toBe(returnWorkflowValue)
		expect(JSON.stringify(task.snapshot())).not.toContain('handler')
	})

	it('handler is undefined when run is unregistered or omitted', () => {
		const noRegistry = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		expect(noRegistry.handler).toBeUndefined()
		const unregistered = requireWorkflowTask(
			createWorkflow(buildSingleTaskWorkflow(), { functions: { other: () => 'x' } }),
		)
		expect(unregistered.handler).toBeUndefined()
	})

	it('restore keeps unresolved behavior inspectable while a supplied registry re-resolves it', () => {
		const original = createWorkflow(buildSingleTaskWorkflow(), {
			functions: { f: returnWorkflowValue },
		})
		const inspected = createRestoredWorkflow(original.snapshot())
		expect(requireWorkflowTask(inspected).behavior).toBe('f')
		expect(requireWorkflowTask(inspected).handler).toBeUndefined()
		const reResolved = createRestoredWorkflow(original.snapshot(), {
			functions: { f: returnWorkflowValue },
		})
		expect(requireWorkflowTask(reResolved).handler).toBe(returnWorkflowValue)
	})
})

describe('Task — description membership', () => {
	it('reports the member present whether or not the definition declared prose', () => {
		const described = requireWorkflowTask(
			createWorkflow({
				id: 'wf',
				name: 'WF',
				phases: [
					{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', description: 'leaf prose' }] },
				],
			}),
		)
		const bare = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))

		// The getter lives on the prototype, so a reader probing membership gets the same answer
		// either way and reads absence off the value alone.
		expect('description' in described).toBe(true)
		expect('description' in bare).toBe(true)
		expect(described.description).toBe('leaf prose')
		expect(bare.description).toBeUndefined()
		// An omitted description stays omitted in the pure-JSON payload rather than serializing null.
		expect('description' in bare.snapshot()).toBe(false)
	})
})

describe('Task — patch (pending-only)', () => {
	it('applies name/description while pending', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		task.patch({ name: 'Renamed', description: 'new desc' })
		expect(task.name).toBe('Renamed')
		expect(task.snapshot().description).toBe('new desc')
	})

	it('an omitted field is left unchanged', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		const before = task.name
		task.patch({ description: 'only desc' })
		expect(task.name).toBe(before)
		expect(task.snapshot().description).toBe('only desc')
	})

	it('throws MUTATION when patched while running', () => {
		const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
		task.start()
		const error = captureError(() => task.patch({ name: 'x' }))
		expect(readWorkflowCode(error)).toBe('MUTATION')
		expect(task.name).not.toBe('x')
	})

	it('throws MUTATION when patched after settling (each terminal status)', () => {
		for (const drive of TASK_TERMINAL_DRIVERS) {
			const task = requireWorkflowTask(createWorkflow(buildSingleTaskWorkflow()))
			drive(task)
			const error = captureError(() => task.patch({ name: 'x' }))
			expect(readWorkflowCode(error)).toBe('MUTATION')
		}
	})
})
