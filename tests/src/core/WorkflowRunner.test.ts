import { WORKFLOW_TERMINAL_COMMANDS } from '../../setup.js'
import {
	ROUND_TRIP_TIMEOUT_MS,
	returnWorkflowNull,
	throwWorkflowFault,
	readWorkflowTaskId,
	buildBailDefinition,
	createParkedTask,
	rejectTaskAbort,
	buildRecordedFunctions,
	FaultScheduler,
	buildWorkflowStore,
	createPacedRunner,
	buildFunctionTask,
	buildRunnerDefinition,
	createOrderFunction,
	buildReliableTask,
	createAbortSibling,
	buildParkedPhases,
	parkUntilDeadline,
	WorkflowObservation,
	FaultBudget,
	createRecordingScheduler,
	instrumentSignal,
	TASK_EVENTS,
} from '../../setup.js'
import type {
	TaskControllerInterface,
	TaskEventMap,
	WorkflowDefinition,
	WorkflowOptions,
	WorkflowRegistry,
	WorkflowRunOptions,
	WorkflowSnapshot,
} from '@src/core'
import type { TaskEvent } from '../../setup.js'
import { createTokenBudget } from '@orkestrel/budget'
import {
	createMemoryWorkflowStore,
	createScheduler,
	createWorkflow,
	createWorkflowRunner,
	isWorkflowError,
	MAX_TIMER_MS,
} from '@src/core'
import { describe, expect, it, vi } from 'vitest'
import { createRecorder, createRecorders, waitForDelay } from '@orkestrel/test'

// The W-c1 WorkflowRunner — the thin orchestrator that EXECUTES a live W-b tree by COMPOSING the
// shipped substrate (one Runner/Queue per phase, the bail policy mapped onto fail-fast vs
// settle-all, the abort/timeout/budget fold through AbortSignal.any, the scheduler pacing). Real data
// stubs — scripted WorkflowFunction handlers, NO mocks. Determinism comes from deferred gates
// (`Promise.withResolvers`), not wall-clock races.
//
// PROGRAMMATIC CORE, DECLARATIVE SHELL (this wave's redesign): `TaskDefinition.behavior` is a PLAIN
// STRING resolved ONCE at construction against a `WorkflowOptions.functions` registry into the
// live task's `handler`. The runner itself is a PURE engine — it carries no behavior or provider
// registry; every `execute(...)` call below threads `functions` through the RUN options
// (`WorkflowRunOptions extends WorkflowOptions`), never through `createWorkflowRunner`. This file
// covers the ENGINE's own behavior against plain `WorkflowFunction`s; integration coverage belongs
// at the composing boundary.

vi.setConfig({ testTimeout: ROUND_TRIP_TIMEOUT_MS })

// A workflow runner whose inter-phase pacing is DETERMINISTIC (clock seams, not
// wall-clock) — the shipped `createScheduler` default paces through a real `setTimeout(0)` macrotask,
// which under full-`src:core`-project parallel load can be event-loop-starved past vitest's
// default timeout; injecting `createRecordingScheduler` retains the shipped scheduler's real
// asynchronous turn while making the number of cooperative yields observable.

describe('recording scheduler — production delegation', () => {
	it('counts before a real asynchronous yield and preserves delay abort semantics', async () => {
		const scheduler = createRecordingScheduler()
		const yielded = new WorkflowObservation(false)
		const pending = scheduler.yield().then(() => {
			yielded.value = true
		})
		expect(scheduler.yields).toBe(1)
		await Promise.resolve()
		expect(yielded.value).toBe(false)
		await pending
		expect(yielded.value).toBe(true)

		const abort = new AbortController()
		const reason = new Error('cancel recording delay')
		const delayed = scheduler.delay(50, { signal: abort.signal })
		abort.abort(reason)
		await expect(delayed).rejects.toBe(reason)
	})
})

// ── Local scenario builders (definitions + scripted handlers) ──

/** A function task on task `id`, dispatched by NAME to the registered function `fn`. */

/** Build a definition from a compact phase spec — each phase its tasks + optional concurrency / bail. */

/** A scripted function handler that records the order its tasks start (by `task.id`). */

/** A function task carrying optional per-task reliability overrides (`retries` / `timeout`). */

// A WorkflowFunction that PARKS on its own attempt signal and never resolves on its own — the only
// thing that releases it is its per-attempt deadline aborting the signal (the real gate the timeout
// path needs). On abort it resolves a sentinel so the attempt SETTLES (so the leaf decision runs);
// the resolved value is discarded by the runner as a timed-out attempt. Not a mock — a real handler
// parking on a real AbortSignal it controls nothing of.

describe('WorkflowRunner — phases sequential, tasks concurrent', () => {
	it('snapshots each run-control option once, including inherited and non-enumerable values', async () => {
		const signalReads = new WorkflowObservation(0)
		const timeoutReads = new WorkflowObservation(0)
		const budgetReads = new WorkflowObservation(0)
		const storeReads = new WorkflowObservation(0)
		const abort = new AbortController()
		const budget = createTokenBudget({ max: 10, scope: 'total' })
		const store = createMemoryWorkflowStore()
		const options: WorkflowRunOptions = {}
		const prototype = {}
		Object.defineProperty(prototype, 'signal', {
			get: () => {
				signalReads.value += 1
				return abort.signal
			},
		})
		Object.setPrototypeOf(options, prototype)
		Object.defineProperties(options, {
			timeout: {
				enumerable: false,
				get: () => {
					timeoutReads.value += 1
					return 1_000
				},
			},
			budget: {
				enumerable: false,
				get: () => {
					budgetReads.value += 1
					return budget
				},
			},
			store: {
				enumerable: false,
				get: () => {
					storeReads.value += 1
					return store
				},
			},
		})
		const result = await createPacedRunner().execute(buildRunnerDefinition([]), options)
		expect(result.status).toBe('completed')
		expect(result.durable).toBe(true)
		expect(signalReads.value).toBe(1)
		expect(timeoutReads.value).toBe(1)
		expect(budgetReads.value).toBe(1)
		expect(storeReads.value).toBe(1)
	})

	it('starts every task of a phase before any settles, and phase 2 only after phase 1 settles', async () => {
		const starts = createRecorder<readonly [string]>()
		const gate = Promise.withResolvers<void>()

		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'a'), buildFunctionTask('t1', 'a')] },
			{ id: 'b', tasks: [buildFunctionTask('t2', 'b')] },
		])
		const running = createPacedRunner().execute(definition, {
			functions: {
				a: async (controller) => {
					starts.handler(controller.task.id)
					await gate.promise
					return controller.task.id
				},
				b: (controller) => {
					starts.handler(controller.task.id)
					return controller.task.id
				},
			},
		})

		await waitForDelay()
		expect([...starts.calls].map((c) => c[0]).sort()).toEqual(['t0', 't1'])

		gate.resolve()
		const result = await running
		expect([...starts.calls].map((c) => c[0])).toEqual(['t0', 't1', 't2'])
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('completed')
	})

	it('drives each task start → complete and boxes the returned value as the result', async () => {
		const order: string[] = []
		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'f'), buildFunctionTask('t1', 'f')] },
		])
		const result = await createPacedRunner().execute(definition, {
			functions: { f: createOrderFunction(order) },
		})
		expect(result.status).toBe('completed')
		expect(order.sort()).toEqual(['t0', 't1'])
		const t0 = result.workflow.phase('a')?.task('t0')?.result
		expect(t0?.status).toBe('completed')
		expect(t0?.result).toEqual({ success: true, value: 't0' })
		expect(result.results.map((r) => r.task.id).sort()).toEqual(['t0', 't1'])
	})
})

describe('WorkflowRunner — dispatch by function-registry name', () => {
	it('a task registered through a plain WorkflowFunction runs it and completes', async () => {
		const seen = createRecorder<readonly [Readonly<Record<string, unknown>>]>()
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', behavior: 'scan' }] }],
		}
		const result = await createPacedRunner().execute(definition, {
			functions: {
				scan: (controller) => {
					seen.handler(controller.input)
					return 'scanned'
				},
			},
		})
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t')?.result?.result).toEqual({
			success: true,
			value: 'scanned',
		})
		expect(seen.count).toBe(1)
	})

	it('a failing function fails the leaf', async () => {
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			bail: false,
			phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', behavior: 'boom' }] }],
		}
		const result = await createPacedRunner().execute(definition, {
			functions: {
				boom: () => {
					throw new Error('boom exploded')
				},
			},
		})
		expect(result.status).toBe('completed')
		const recorded = result.workflow.phase('a')?.task('t')?.result
		expect(recorded?.status).toBe('failed')
		expect(recorded?.result?.success).toBe(false)
		const error = recorded?.result?.success === false ? recorded.result.error : undefined
		expect(error).toEqual({ origin: 'handler', message: 'boom exploded' })
	})

	it('an unresolved named task is rejected before execution', () => {
		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t', 'missing')] },
		])
		expect(() => createPacedRunner().execute(definition)).toThrow(/not drivable/)

		const functions: WorkflowRegistry = {}
		Object.defineProperty(functions, 'missing', { value: 'not callable' })
		const workflow = createWorkflow(definition, { functions })
		expect(() => createPacedRunner().execute(workflow)).toThrow(/not drivable/)
	})

	it('a task whose `behavior` is omitted entirely auto-completes', async () => {
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T' }] }],
		}
		const result = await createPacedRunner().execute(definition)
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t')?.result?.result).toEqual({
			success: true,
			value: null,
		})
	})
})

describe('WorkflowRunner — bail:false records a failure yet completes across phases (P2.2)', () => {
	it('a failing leaf in phase 1 + succeeding leaves in phases 1 and 2 → completed, failure visible, later phases ran', async () => {
		const definition = buildRunnerDefinition(
			[
				{ id: 'a', tasks: [buildFunctionTask('t0', 'fail'), buildFunctionTask('t1', 'ok')] },
				{ id: 'b', tasks: [buildFunctionTask('t2', 'ok')] },
			],
			false,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fail: () => {
					throw new Error('boom')
				},
				ok: (controller) => controller.task.id,
			},
		})
		expect(result.status).toBe('completed')
		const failure = result.results.find((r) => r.task.id === 't0')
		expect(failure?.status).toBe('failed')
		expect(failure?.result?.success).toBe(false)
		const error = failure?.result?.success === false ? failure.result.error : undefined
		expect(error).toEqual({ origin: 'handler', message: 'boom' })
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('completed')
	})
})

describe('WorkflowRunner — per-phase throttle', () => {
	it('runs at most `concurrency` tasks in flight at once', async () => {
		const inFlight = new WorkflowObservation(0)
		const maxInFlight = new WorkflowObservation(0)
		const gates = [
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
		]
		const index = new Map<string, number>([
			['t0', 0],
			['t1', 1],
			['t2', 2],
			['t3', 3],
		])

		const definition = buildRunnerDefinition([
			{
				id: 'a',
				concurrency: 2,
				tasks: [
					buildFunctionTask('t0', 'g'),
					buildFunctionTask('t1', 'g'),
					buildFunctionTask('t2', 'g'),
					buildFunctionTask('t3', 'g'),
				],
			},
		])
		const running = createPacedRunner().execute(definition, {
			functions: {
				g: async (controller) => {
					inFlight.value += 1
					maxInFlight.value = Math.max(maxInFlight.value, inFlight.value)
					const slot = index.get(controller.task.id) ?? 0
					await gates[slot]?.promise
					inFlight.value -= 1
					return controller.task.id
				},
			},
		})
		await waitForDelay()
		expect(maxInFlight.value).toBe(2)
		for (const gate of gates) {
			gate.resolve()
			await waitForDelay()
		}
		const result = await running
		expect(result.status).toBe('completed')
		expect(maxInFlight.value).toBe(2)
	})
})

describe('WorkflowRunner — an executed no-op tree settles completed (F1)', () => {
	it('a zero-phase definition settles completed (not pending)', async () => {
		const definition = buildRunnerDefinition([])
		const result = await createPacedRunner().execute(definition)
		expect(result.status).toBe('completed')
		expect(result.workflow.status).toBe('completed')
		expect(result.results).toEqual([])
	})

	it('a single empty-task phase settles completed', async () => {
		const definition = buildRunnerDefinition([{ id: 'a', tasks: [] }])
		const result = await createPacedRunner().execute(definition)
		expect(result.status).toBe('completed')
		expect(result.workflow.status).toBe('completed')
		expect(result.workflow.phase('a')?.status).toBe('pending')
	})

	it('multiple empty phases settle completed', async () => {
		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [] },
			{ id: 'b', tasks: [] },
		])
		const result = await createPacedRunner().execute(definition)
		expect(result.status).toBe('completed')
		expect(result.workflow.status).toBe('completed')
	})

	it('a normal completed run is unchanged (the gate does not double-force)', async () => {
		const order: string[] = []
		const definition = buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'f')] }])
		const result = await createPacedRunner().execute(definition, {
			functions: { f: createOrderFunction(order) },
		})
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t0'])
	})

	it('a bail:true failing run stays failed (the gate never masks a failure)', async () => {
		const definition = buildRunnerDefinition(
			[{ id: 'a', tasks: [buildFunctionTask('t0', 'fail')] }],
			true,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fail: () => {
					throw new Error('boom')
				},
			},
		})
		expect(result.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
	})

	it('a cancelled empty-ish run settles stopped (the cancel path wins, never completed)', async () => {
		const budget = createTokenBudget({ max: 0 })
		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [] },
			{ id: 'b', tasks: [] },
		])
		const result = await createPacedRunner().execute(definition, { budget })
		expect(result.status).toBe('stopped')
		expect(result.workflow.status).toBe('stopped')
	})

	it('a pre-aborted run settles stopped, never completed (the cancel branch precedes the gate)', async () => {
		const controllerAbort = new AbortController()
		controllerAbort.abort(new Error('pre-cancelled'))
		const ran = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'fn')] }])
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fn: (controller) => {
					ran.handler(controller.task.id)
					return controller.task.id
				},
			},
			signal: controllerAbort.signal,
		})
		expect(ran.count).toBe(0)
		expect(result.status).toBe('stopped')
	})
})

describe('WorkflowRunner — non-positive phase concurrency is clamped (F2)', () => {
	it('a concurrency:0 phase runs every task and completes (clamped to the default)', async () => {
		const ran = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([
			{
				id: 'a',
				concurrency: 0,
				tasks: [
					buildFunctionTask('t0', 'fn'),
					buildFunctionTask('t1', 'fn'),
					buildFunctionTask('t2', 'fn'),
				],
			},
		])
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fn: (controller) => {
					ran.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		expect(result.status).toBe('completed')
		expect([...ran.calls].map((c) => c[0]).sort()).toEqual(['t0', 't1', 't2'])
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t2')?.status).toBe('completed')
	})

	it('a concurrency:-1 phase runs every task and completes (clamped to the default)', async () => {
		const ran = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([
			{
				id: 'a',
				concurrency: -1,
				tasks: [
					buildFunctionTask('t0', 'fn'),
					buildFunctionTask('t1', 'fn'),
					buildFunctionTask('t2', 'fn'),
				],
			},
		])
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fn: (controller) => {
					ran.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		expect(result.status).toBe('completed')
		expect([...ran.calls].map((c) => c[0]).sort()).toEqual(['t0', 't1', 't2'])
	})
})

describe('WorkflowRunner — bail:false records failures while finishing', () => {
	it('a phase with a failing + a succeeding task settles both; the workflow completes', async () => {
		const definition = buildRunnerDefinition(
			[{ id: 'a', tasks: [buildFunctionTask('t0', 'fail'), buildFunctionTask('t1', 'ok')] }],
			false,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fail: () => {
					throw new Error('boom')
				},
				ok: (controller) => controller.task.id,
			},
		})
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		const failure = result.results.find((r) => r.task.id === 't0')
		expect(failure?.result?.success).toBe(false)
	})

	it('continues to the next phase after a failure under graceful mode', async () => {
		const order: string[] = []
		const definition = buildRunnerDefinition(
			[
				{ id: 'a', tasks: [buildFunctionTask('t0', 'fail')] },
				{ id: 'b', tasks: [buildFunctionTask('t1', 'rec')] },
			],
			false,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fail: () => {
					throw new Error('boom')
				},
				rec: createOrderFunction(order),
			},
		})
		expect(order).toEqual(['t1'])
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('completed')
	})
})

describe('WorkflowRunner — bail:true halts on the first failure', () => {
	it('the first failure aborts an in-flight sibling and skips the remaining phases', async () => {
		const aborted = createRecorder<readonly [string]>()

		const sibling = createAbortSibling(aborted)
		const definition = buildRunnerDefinition(
			[
				{ id: 'a', tasks: [buildFunctionTask('t0', 'fail'), buildFunctionTask('t1', 'sibling')] },
				{ id: 'b', tasks: [buildFunctionTask('t2', 'sibling')] },
			],
			true,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fail: () => {
					throw new Error('boom')
				},
				sibling,
			},
		})
		expect(result.status).toBe('failed')
		expect([...aborted.calls].map((c) => c[0])).toContain('t1')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('skipped')
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('skipped')
	})

	it('a single failing task in a single-task phase fails the workflow and skips later phases', async () => {
		const order: string[] = []
		const definition = buildRunnerDefinition(
			[
				{ id: 'a', tasks: [buildFunctionTask('t0', 'fail')] },
				{ id: 'b', tasks: [buildFunctionTask('t1', 'rec')] },
			],
			true,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fail: () => {
					throw new Error('boom')
				},
				rec: createOrderFunction(order),
			},
		})
		expect(result.status).toBe('failed')
		expect(order).toEqual([])
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('skipped')
	})
})

describe('WorkflowRunner — forced future phases', () => {
	it.each(WORKFLOW_TERMINAL_COMMANDS)(
		'does not execute a future phase forced by %s',
		async (command) => {
			const calls: string[] = []
			const workflow = createWorkflow(
				buildRunnerDefinition([
					{ id: 'a', tasks: [buildFunctionTask('t0', 'first')] },
					{ id: 'b', tasks: [buildFunctionTask('t1', 'future')] },
				]),
				{
					functions: {
						first: () => {
							calls.push('first')
							return null
						},
						future: () => {
							calls.push('future')
							return null
						},
					},
				},
			)
			const future = workflow.phase('b')
			if (future === undefined) throw new Error('expected future phase')
			if (command === 'skip') future.skip()
			else future.stop()

			const result = await createPacedRunner().execute(workflow)
			expect(calls).toEqual(['first'])
			expect(result.workflow.phase('b')?.task('t1')?.status).toBe('skipped')
		},
	)
})

describe('WorkflowRunner — per-task retries / timeout (Seam A, threaded through the Runner)', () => {
	it('normalizes a non-JSON handler outcome as a retryable handler failure', async () => {
		const attempts = new WorkflowObservation(0)
		const valid = returnWorkflowNull
		const invalid = new Proxy(valid, {
			apply: () => {
				attempts.value += 1
				return attempts.value === 1 ? BigInt(1) : 'recovered'
			},
		})
		const result = await createPacedRunner().execute(
			buildRunnerDefinition([
				{ id: 'a', tasks: [buildReliableTask('t0', 'invalid', { retries: 1 })] },
			]),
			{ functions: { invalid } },
		)

		expect(result.status).toBe('completed')
		expect(attempts.value).toBe(2)
		expect(result.workflow.phase('a')?.task('t0')?.result?.result).toEqual({
			success: true,
			value: 'recovered',
		})
	})

	it('A1 divergent retries: a retried task recovers (3 runs) while a no-retry sibling fails (1 run)', async () => {
		const attempts = new Map<string, number>()

		const definition = buildRunnerDefinition(
			[
				{
					id: 'a',
					tasks: [
						buildReliableTask('t0', 'flaky', { retries: 2 }),
						buildReliableTask('t1', 'flaky', { retries: 0 }),
					],
				},
			],
			false,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: {
				flaky: (controller) => {
					const seen = (attempts.get(controller.task.id) ?? 0) + 1
					attempts.set(controller.task.id, seen)
					if (controller.task.id === 't0' && seen < 3) throw new Error('flaky')
					if (controller.task.id === 't1') throw new Error('always')
					return controller.task.id
				},
			},
		})
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('failed')
		expect(attempts.get('t0')).toBe(3)
		expect(attempts.get('t1')).toBe(1)
	})

	it('A2 bail:false waits for a slow sibling and continues to a later phase after timeout failure', async () => {
		const order = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition(
			[
				{
					id: 'a',
					concurrency: 2,
					tasks: [
						buildReliableTask('t0', 'parkUntilDeadline', { timeout: 20, retries: 0 }),
						buildReliableTask('t1', 'slow', {}),
					],
				},
				{ id: 'b', tasks: [buildReliableTask('t2', 'quick', {})] },
			],
			false,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: {
				parkUntilDeadline,
				quick: (controller) => {
					order.handler(controller.task.id)
					return controller.task.id
				},
				slow: async (controller) => {
					await waitForDelay(40)
					order.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		const t0 = result.workflow.phase('a')?.task('t0')
		expect(t0?.status).toBe('failed')
		expect(t0?.status).not.toBe('skipped')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('completed')
		expect(order.calls.map((call) => call[0])).toEqual(['t1', 't2'])
		expect(result.status).toBe('completed')
		const failure = result.results.find((r) => r.task.id === 't0')
		expect(failure?.status).toBe('failed')
		expect(failure?.result?.success).toBe(false)
	})

	it('A4 retries + timeout RECOVERS: attempt 1 exhausts the deadline, attempt 2 completes → the leaf completes (ran 2×) and the recovered value is recorded', async () => {
		const attempts = new Map<string, number>()

		const definition = buildRunnerDefinition(
			[
				{
					id: 'a',
					tasks: [buildReliableTask('t0', 'recoverAfterTimeout', { timeout: 20, retries: 1 })],
				},
			],
			false,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: {
				recoverAfterTimeout: (controller) => {
					const seen = (attempts.get(controller.task.id) ?? 0) + 1
					attempts.set(controller.task.id, seen)
					if (seen === 1) return parkUntilDeadline(controller)
					return `recovered ${controller.task.id}`
				},
			},
		})
		expect(result.status).toBe('completed')
		const t0 = result.workflow.phase('a')?.task('t0')
		expect(t0?.status).toBe('completed')
		expect(attempts.get('t0')).toBe(2)
		expect(t0?.result?.result).toEqual({ success: true, value: 'recovered t0' })
	})

	it('A3 omission regression: a task with neither field never retries on failure (today’s behavior)', async () => {
		const attempts = new Map<string, number>()

		const definition = buildRunnerDefinition(
			[{ id: 'a', tasks: [buildFunctionTask('t0', 'failOnce')] }],
			false,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: {
				failOnce: (controller) => {
					attempts.set(controller.task.id, (attempts.get(controller.task.id) ?? 0) + 1)
					throw new Error('boom')
				},
			},
		})
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(attempts.get('t0')).toBe(1)
	})
})

describe('WorkflowRunner — a per-task timeout is a FAILURE under bail, and the distinguisher preserves skip-on-fail-fast', () => {
	it('3a bail:true + timeout-only fault: the timed-out task FAILS, the workflow derives failed, and a later phase is skipped (halted)', async () => {
		const definition = buildRunnerDefinition(
			[
				{
					id: 'a',
					tasks: [buildReliableTask('t0', 'parkUntilDeadline', { timeout: 20, retries: 0 })],
				},
				{ id: 'b', tasks: [buildFunctionTask('t1', 'quick')] },
			],
			true,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: { parkUntilDeadline, quick: (controller) => controller.task.id },
		})
		expect(result.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('skipped')
	})

	it('bail:true records one timeout failure when the handler throws on abort', async () => {
		const events: string[] = []
		const throwOnAbort = rejectTaskAbort
		const workflow = createWorkflow(
			buildRunnerDefinition(
				[
					{
						id: 'a',
						tasks: [buildReliableTask('t0', 'throwOnAbort', { timeout: 15 })],
					},
				],
				true,
			),
			{ functions: { throwOnAbort } },
		)
		workflow
			.phase('a')
			?.task('t0')
			?.emitter.on('fail', () => events.push('fail'))

		const result = await createPacedRunner().execute(workflow)
		expect(result.status).toBe('failed')
		expect(events).toEqual(['fail'])
		expect(result.workflow.phase('a')?.task('t0')?.result?.result).toEqual({
			success: false,
			error: { origin: 'timeout', message: "task 't0' timed out" },
		})
	})

	it('sibling-fail-fast regression: under bail a thrown failure still SKIPS a parked sibling (the timeout distinguisher did NOT turn a fail-fast abort into a failure)', async () => {
		const aborted = createRecorder<readonly [string]>()

		const sibling = createAbortSibling(aborted)
		const definition = buildRunnerDefinition(
			[{ id: 'a', tasks: [buildFunctionTask('t0', 'fail'), buildFunctionTask('t1', 'sibling')] }],
			true,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fail: () => {
					throw new Error('boom')
				},
				sibling,
			},
		})
		expect(result.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect([...aborted.calls].map((c) => c[0])).toContain('t1')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('skipped')
	})
})

describe('WorkflowRunner — per-phase bail override (Seam B)', () => {
	it('B1 a strict (bail:true) phase HALTS subsequent phases even under a graceful (bail:false) workflow', async () => {
		const aborted = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([
			{
				id: 'a',
				bail: true,
				tasks: [buildFunctionTask('t0', 'fail'), buildFunctionTask('t1', 'sibling')],
			},
			{ id: 'b', tasks: [buildFunctionTask('t2', 'sibling')] },
		])
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fail: () => {
					throw new Error('boom')
				},
				sibling: createAbortSibling(aborted),
			},
		})
		expect(result.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect([...aborted.calls].map((c) => c[0])).toContain('t1')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('skipped')
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('skipped')
		expect(result.workflow.phase('a')?.bail).toBe(true)
		expect(result.workflow.phase('b')?.bail).toBe(false)
	})

	it('B2 a graceful (bail:false) phase does NOT halt even under a strict (bail:true) workflow', async () => {
		const definition = buildRunnerDefinition(
			[
				{
					id: 'a',
					bail: false,
					tasks: [buildFunctionTask('t0', 'fail'), buildFunctionTask('t1', 'ok')],
				},
				{ id: 'b', tasks: [buildFunctionTask('t2', 'ok')] },
			],
			true,
		)
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fail: () => {
					throw new Error('boom')
				},
				ok: (controller) => controller.task.id,
			},
		})
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.bail).toBe(false)
		expect(result.workflow.phase('b')?.bail).toBe(true)
	})

	it('B3 inheritance: a no-bail phase halts under a bail:true workflow and does NOT under bail:false', async () => {
		const makeDefinition = buildBailDefinition
		const fail = throwWorkflowFault
		const ok = readWorkflowTaskId

		const strict = await createPacedRunner().execute(makeDefinition(true), {
			functions: { fail, ok },
		})
		expect(strict.status).toBe('failed')
		expect(strict.workflow.phase('a')?.bail).toBe(true)
		expect(strict.workflow.phase('b')?.task('t1')?.status).toBe('skipped')

		const graceful = await createPacedRunner().execute(makeDefinition(false), {
			functions: { fail, ok },
		})
		expect(graceful.status).toBe('completed')
		expect(graceful.workflow.phase('a')?.bail).toBe(false)
		expect(graceful.workflow.phase('b')?.task('t1')?.status).toBe('completed')
	})
})

describe('WorkflowRunner — abort cascade', () => {
	it('an external signal abort mid-run stops in-flight tasks and settles the run as stopped', async () => {
		const controllerAbort = new AbortController()
		const started = createRecorder<readonly [string]>()
		const aborted = createRecorder<readonly [string]>()
		const parked = createParkedTask(aborted, started)
		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'parked'), buildFunctionTask('t1', 'parked')] },
			{ id: 'b', tasks: [buildFunctionTask('t2', 'parked')] },
		])
		const running = createPacedRunner().execute(definition, {
			functions: { parked },
			signal: controllerAbort.signal,
		})
		await waitForDelay()
		expect([...started.calls].map((c) => c[0]).sort()).toEqual(['t0', 't1'])
		controllerAbort.abort(new Error('cancelled'))
		const result = await running
		expect(result.status).toBe('stopped')
		expect([...aborted.calls].map((c) => c[0]).sort()).toEqual(['t0', 't1'])
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('skipped')
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('skipped')
	})
})

describe('WorkflowRunner — scheduler infrastructure faults', () => {
	it('stops and sweeps the live tree, persists the final state, then rethrows', async () => {
		const fault = new Error('scheduler unavailable')
		const scheduler = new FaultScheduler(fault)
		const snapshots: WorkflowSnapshot[] = []
		const store = buildWorkflowStore({
			set: (snapshot) => {
				snapshots.push(snapshot)
				return Promise.resolve()
			},
		})
		const workflow = createWorkflow(
			buildRunnerDefinition([
				{ id: 'a', tasks: [buildFunctionTask('t0', 'work')] },
				{ id: 'b', tasks: [buildFunctionTask('t1', 'work')] },
			]),
			{ functions: { work: () => null } },
		)
		const listeners = instrumentSignal(workflow.signal)

		await expect(createWorkflowRunner({ scheduler }).execute(workflow, { store })).rejects.toBe(
			fault,
		)
		expect(workflow.status).toBe('stopped')
		expect(workflow.phase('b')?.task('t1')?.status).toBe('skipped')
		expect(snapshots.at(-1)?.status).toBe('stopped')
		expect(listeners.added.calls).toEqual([['abort']])
		expect(listeners.removed.calls).toEqual([['abort']])
	})
})

describe('WorkflowRunner — budget / timeout fold', () => {
	it('preserves a setup failure while clearing its long deadline and retaining caller budget state', async () => {
		const failure = new Error('budget signal unavailable')
		const budget = new FaultBudget(failure)
		const writes = createRecorder<readonly [WorkflowSnapshot]>()
		const store = buildWorkflowStore({
			set: (snapshot) => {
				writes.handler(snapshot)
				return Promise.resolve()
			},
		})
		const workflow = createWorkflow(buildRunnerDefinition([]))
		const before = process
			.getActiveResourcesInfo()
			.filter((resource) => resource === 'Timeout').length

		await expect(
			createPacedRunner().execute(workflow, { budget, store, timeout: 60_000 }),
		).rejects.toBe(failure)

		const after = process
			.getActiveResourcesInfo()
			.filter((resource) => resource === 'Timeout').length
		expect(after).toBe(before)
		expect(budget.starts).toBe(1)
		expect(budget.clears).toBe(0)
		expect(budget.consumed).toBe(7)
		expect(writes.count).toBe(0)
	})

	it('a pre-exhausted budget halts the run (no task runs) and stops the workflow', async () => {
		const ran = createRecorder<readonly [string]>()

		const budget = createTokenBudget({ max: 0 })
		const definition = buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'fn')] }])
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fn: (controller) => {
					ran.handler(controller.task.id)
					return controller.task.id
				},
			},
			budget,
		})
		expect(result.status).toBe('stopped')
		expect(ran.count).toBe(0)
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('skipped')
	})

	it('a timeout firing mid-phase aborts the running task and stops the workflow', async () => {
		const aborted = createRecorder<readonly [string]>()
		const parked = createParkedTask(aborted)
		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'parked')] },
		])
		const result = await createPacedRunner().execute(definition, {
			functions: { parked },
			timeout: 20,
		})
		expect(result.status).toBe('stopped')
		expect([...aborted.calls].map((c) => c[0])).toEqual(['t0'])
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('skipped')
	})

	it('a non-positive timeout (0) arms NO deadline — the run completes normally', async () => {
		const order: string[] = []
		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'f')] },
			{ id: 'b', tasks: [buildFunctionTask('t1', 'f')] },
		])
		const result = await createPacedRunner().execute(definition, {
			functions: { f: createOrderFunction(order) },
			timeout: 0,
		})
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t0', 't1'])
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('completed')
	})

	it('an over-max run timeout is disabled instead of overflowing into immediate cancellation', async () => {
		const completed = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'delayed')] },
		])
		const result = await createPacedRunner().execute(definition, {
			functions: {
				delayed: async (controller) => {
					await waitForDelay(10)
					completed.handler(controller.task.id)
					return controller.task.id
				},
			},
			timeout: MAX_TIMER_MS + 1,
		})
		expect(result.status).toBe('completed')
		expect(completed.calls.map((call) => call[0])).toEqual(['t0'])
	})
})

describe('WorkflowRunner — construction options', () => {
	it('captures shifting bail and functions once for a definition run', async () => {
		const bailReads = new WorkflowObservation(0)
		const functionsReads = new WorkflowObservation(0)
		const first = createRecorder<readonly [string]>()
		const shifted = createRecorder<readonly [string]>()
		const firstFunctions = buildRecordedFunctions(first)
		const shiftedFunctions = buildRecordedFunctions(shifted)
		const options: WorkflowRunOptions = {}
		const prototype = {}
		Object.defineProperty(prototype, 'bail', {
			get: () => {
				bailReads.value += 1
				return bailReads.value === 1
			},
		})
		Object.setPrototypeOf(options, prototype)
		Object.defineProperty(options, 'functions', {
			enumerable: false,
			get: () => {
				functionsReads.value += 1
				return functionsReads.value === 1 ? firstFunctions : shiftedFunctions
			},
		})
		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'work')] },
			{ id: 'b', tasks: [buildFunctionTask('t1', 'work')] },
		])

		const result = await createPacedRunner().execute(definition, options)

		expect(bailReads.value).toBe(1)
		expect(functionsReads.value).toBe(1)
		expect(result.workflow.bail).toBe(true)
		expect(result.workflow.phases.phases().map((phase) => phase.bail)).toEqual([true, true])
		expect(result.workflow.phase('a')?.task('t0')?.handler).toBe(firstFunctions.work)
		expect(result.workflow.phase('b')?.task('t1')?.handler).toBe(firstFunctions.work)
		expect(first.calls.map((call) => call[0])).toEqual(['t0', 't1'])
		expect(shifted.count).toBe(0)
	})

	it('reads only run-control keys when executing an existing live workflow', async () => {
		const signalReads = new WorkflowObservation(0)
		const abort = new AbortController()
		const failure = new Error('construction option was read')
		const workflow = createWorkflow(
			buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'work')] }]),
			{ functions: { work: (controller) => controller.task.id } },
		)
		const options: Omit<WorkflowRunOptions, keyof WorkflowOptions> = {}
		Object.defineProperties(options, {
			signal: {
				get: () => {
					signalReads.value += 1
					return abort.signal
				},
			},
			on: {
				get: () => {
					throw failure
				},
			},
			bail: {
				get: () => {
					throw failure
				},
			},
			error: {
				get: () => {
					throw failure
				},
			},
			phases: {
				get: () => {
					throw failure
				},
			},
			functions: {
				get: () => {
					throw failure
				},
			},
			silence: {
				get: () => {
					throw failure
				},
			},
		})

		const result = await createPacedRunner().execute(workflow, options)

		expect(result.status).toBe('completed')
		expect(signalReads.value).toBe(1)
	})

	it('forwards the WorkflowOptions half (bail override + on listeners) to the built tree', async () => {
		const failures = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'fail')] },
			{ id: 'b', tasks: [buildFunctionTask('t1', 'fail')] },
		])
		const result = await createPacedRunner().execute(definition, {
			functions: {
				fail: () => {
					throw new Error('boom')
				},
			},
			bail: true,
			on: { fail: (taskResult) => failures.handler(taskResult.task.id) },
		})
		expect(result.status).toBe('failed')
		expect(result.workflow.bail).toBe(true)
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('skipped')
		expect([...failures.calls].map((c) => c[0])).toContain('t0')
	})
})

describe('WorkflowRunner — controller reads earlier results', () => {
	it('a phase-2 function can read phase-1 task results through controller.results()', async () => {
		const seen = createRecorder<readonly [number]>()

		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'produce'), buildFunctionTask('t1', 'produce')] },
			{ id: 'b', tasks: [buildFunctionTask('t2', 'consume')] },
		])
		await createPacedRunner().execute(definition, {
			functions: {
				produce: (controller) => controller.task.id,
				consume: (controller) => {
					seen.handler(controller.results().length)
					return controller.task.id
				},
			},
		})
		expect(seen.calls[0]?.[0]).toBe(2)
	})

	it('a phase-3 task reads an EARLIER phase-1 task’s recorded OUTCOME through controller.results() (P3.2)', async () => {
		const sawPhase1Value = createRecorder<readonly [unknown]>()
		const sawPhase1Status = createRecorder<readonly [string]>()

		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [
				{ id: 'a', name: 'A', tasks: [{ id: 'p1', name: 'P1', behavior: 'produce' }] },
				{ id: 'b', name: 'B', tasks: [{ id: 'p2', name: 'P2', behavior: 'spacer' }] },
				{ id: 'c', name: 'C', tasks: [{ id: 'p3', name: 'P3', behavior: 'reader' }] },
			],
		}
		const result = await createPacedRunner().execute(definition, {
			functions: {
				produce: () => 'phase-1-output',
				spacer: (controller) => controller.task.id,
				reader: (controller) => {
					const earlier = controller.results().find((r) => r.task.id === 'p1')
					sawPhase1Status.handler(earlier?.status ?? 'absent')
					const value = earlier?.result?.success === true ? earlier.result.value : undefined
					sawPhase1Value.handler(value)
					return controller.task.id
				},
			},
		})
		expect(result.status).toBe('completed')
		expect(sawPhase1Status.calls[0]?.[0]).toBe('completed')
		expect(sawPhase1Value.calls[0]?.[0]).toBe('phase-1-output')
	})
})

describe('WorkflowRunner — pacing', () => {
	it('uses the shipped scheduler by default and accepts a custom one without error', async () => {
		const order: string[] = []
		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'f')] },
			{ id: 'b', tasks: [buildFunctionTask('t1', 'f')] },
		])
		const result = await createPacedRunner({ scheduler: createScheduler() }).execute(definition, {
			functions: { f: createOrderFunction(order) },
		})
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t0', 't1'])
	})
})

// This engine-level suite covers WorkflowRunner orchestration (sequencing, concurrency, retries,
// destruction, and live mid-run mutation) against a plain WorkflowRegistry. Provider/protocol
// composition is outside this package's runtime and test surface.

describe('WorkflowRunner — execute(workflow) parity with execute(definition)', () => {
	it('drives the caller-owned entity with the same WorkflowResult semantics; status transitions are observable live and snapshot() mid-run shows running states', async () => {
		const gate = Promise.withResolvers<void>()
		const started = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'parked')] },
		])
		const workflow = createWorkflow(definition, {
			functions: {
				parked: async (controller) => {
					started.handler(controller.task.id)
					await gate.promise
					return controller.task.id
				},
			},
		})
		expect(workflow.status).toBe('pending')
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		expect(workflow.status).toBe('running')
		expect(workflow.phase('a')?.status).toBe('running')
		const midSnapshot = workflow.snapshot()
		expect(midSnapshot.status).toBe('running')
		expect(midSnapshot.phases[0]?.tasks[0]?.status).toBe('running')
		gate.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(result.workflow).toBe(workflow)
		expect(workflow.status).toBe('completed')
		expect([...started.calls].map((c) => c[0])).toEqual(['t0'])
	})
})

describe('WorkflowRunner — execute(workflow) TRANSITION guard (synchronous)', () => {
	it('claims a pending workflow synchronously across runner instances before dispatch', async () => {
		const ran = createRecorder<readonly [string]>()

		const workflow = createWorkflow(
			buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'record')] }]),
			{
				functions: {
					record: (controller) => {
						ran.handler(controller.task.id)
						return controller.task.id
					},
				},
			},
		)
		workflow.pause()
		const first = createPacedRunner().execute(workflow)
		const caught = new WorkflowObservation<unknown>(undefined)
		try {
			void createPacedRunner().execute(workflow)
		} catch (error) {
			caught.value = error
		}
		expect(workflow.status).toBe('pending')
		expect(isWorkflowError(caught.value) ? caught.value.code : undefined).toBe('TRANSITION')
		workflow.resume()
		await first
		expect(ran.calls.map((call) => call[0])).toEqual(['t0'])
	})

	it('throws TRANSITION synchronously on a second concurrent call to an already-running workflow', async () => {
		const gate = Promise.withResolvers<void>()

		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'parked')] },
		])
		const workflow = createWorkflow(definition, {
			functions: {
				parked: async (controller) => {
					await gate.promise
					return controller.task.id
				},
			},
		})
		const runner = createPacedRunner()
		const running = runner.execute(workflow)
		await waitForDelay(30)
		expect(workflow.status).toBe('running')
		const caught = new WorkflowObservation<unknown>(undefined)
		try {
			void runner.execute(workflow)
		} catch (error) {
			caught.value = error
		}
		expect(isWorkflowError(caught.value)).toBe(true)
		expect(isWorkflowError(caught.value) ? caught.value.code : undefined).toBe('TRANSITION')
		gate.resolve()
		await running
	})

	it('throws TRANSITION synchronously on an already-settled (completed) workflow', async () => {
		const definition = buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'f')] }])
		const workflow = createWorkflow(definition, {
			functions: { f: (controller) => controller.task.id },
		})
		const runner = createPacedRunner()
		await runner.execute(workflow)
		expect(workflow.status).toBe('completed')
		const caught = new WorkflowObservation<unknown>(undefined)
		try {
			void runner.execute(workflow)
		} catch (error) {
			caught.value = error
		}
		expect(isWorkflowError(caught.value)).toBe(true)
		expect(isWorkflowError(caught.value) ? caught.value.code : undefined).toBe('TRANSITION')
	})

	it('throws TRANSITION synchronously on a destroyed workflow', () => {
		const definition = buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'f')] }])
		const workflow = createWorkflow(definition)
		workflow.destroy()
		expect(workflow.destroyed).toBe(true)
		const runner = createPacedRunner()
		const caught = new WorkflowObservation<unknown>(undefined)
		try {
			void runner.execute(workflow)
		} catch (error) {
			caught.value = error
		}
		expect(isWorkflowError(caught.value)).toBe(true)
		expect(isWorkflowError(caught.value) ? caught.value.code : undefined).toBe('TRANSITION')
	})
})

describe('WorkflowRunner — live task append during a running phase (mid-run mutation, resolves real handlers)', () => {
	it('LIVE TASK APPEND executes real work: the appended task runs, completes, and the phase/result reflect it', async () => {
		const gate = Promise.withResolvers<void>()
		const started = createRecorder<readonly [string]>()

		const extraRan = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 't0')] }])
		const workflow = createWorkflow(definition, {
			functions: {
				t0: async (controller) => {
					started.handler(controller.task.id)
					await gate.promise
					return controller.task.id
				},
				extra: (controller) => {
					extraRan.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		expect(workflow.phase('a')?.status).toBe('running')
		const added = workflow.phase('a')?.add(buildFunctionTask('t1', 'extra'))
		if (added === undefined || !added.success) throw new Error('expected the append to succeed')
		// The live-appended task resolves its handler AGAINST THE SAME `functions` registry the tree
		// was built with — proving `add` mints (and resolves) exactly like a fresh build/restore.
		expect(added.value.handler).toBeDefined()
		gate.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(extraRan.count).toBe(1)
		expect(workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(workflow.phase('a')?.status).toBe('completed')
		expect(result.results.map((r) => r.task.id).sort()).toEqual(['t0', 't1'])
	})

	it('an appended task naming an unregistered function records a normalized failure', async () => {
		const gate = Promise.withResolvers<void>()

		const definition = buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 't0')] }])
		const workflow = createWorkflow(definition, {
			functions: {
				t0: async (controller) => {
					await gate.promise
					return controller.task.id
				},
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		const added = workflow.phase('a')?.add(buildFunctionTask('t1', 'missing-handler'))
		if (added === undefined || !added.success) throw new Error('expected the append to succeed')
		expect(added.value.handler).toBeUndefined()
		gate.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		const recorded = workflow.phase('a')?.task('t1')?.result
		expect(recorded?.status).toBe('failed')
		expect(recorded?.result).toEqual({
			success: false,
			error: {
				origin: 'handler',
				message: "task 't1' has an unresolved behavior 'missing-handler'",
			},
		})
	})

	it('GRACEFUL REJECTION: appending to an already-COMPLETED phase fails MUTATION; the run continues to completion unaffected', async () => {
		const gateB = Promise.withResolvers<void>()

		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'f')] },
			{ id: 'b', tasks: [buildFunctionTask('t1', 'b')] },
		])
		const workflow = createWorkflow(definition, {
			functions: {
				f: (controller) => controller.task.id,
				b: async (controller) => {
					await gateB.promise
					return controller.task.id
				},
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		expect(workflow.phase('a')?.status).toBe('completed')
		const rejected = workflow.phase('a')?.add(buildFunctionTask('extra', 'f'))
		if (rejected === undefined || rejected.success) throw new Error('expected the append to fail')
		expect(rejected.error.code).toBe('MUTATION')
		gateB.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(workflow.phase('b')?.task('t1')?.status).toBe('completed')
	})

	it('LIVE PHASE APPEND: mid-run workflow.add mints a phase that runs in the same run; add after the workflow settles fails MUTATION', async () => {
		const gateA = Promise.withResolvers<void>()

		const extraRan = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'a')] }])
		const workflow = createWorkflow(definition, {
			functions: {
				a: async (controller) => {
					await gateA.promise
					return controller.task.id
				},
				extra: (controller) => {
					extraRan.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		const added = workflow.add({
			id: 'c',
			name: 'C',
			tasks: [{ id: 'tc', name: 'TC', behavior: 'extra' }],
		})
		if (!added.success) throw new Error('expected workflow.add to succeed')
		gateA.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(extraRan.count).toBe(1)
		expect(workflow.phase('c')?.task('tc')?.status).toBe('completed')
		const rejected = workflow.add({ id: 'd', name: 'D', tasks: [] })
		if (rejected.success) throw new Error('expected workflow.add to fail after settlement')
		expect(rejected.error.code).toBe('MUTATION')
	})
})

describe('WorkflowRunner — pending-suffix mid-run mutation (add/remove/move/update honored while phase a runs)', () => {
	it('insertion at index 0 fails MUTATION while phase a runs (before the pending-suffix boundary)', async () => {
		const gate = Promise.withResolvers<void>()

		const order: string[] = []
		const workflow = createWorkflow(buildParkedPhases(), {
			functions: {
				a: async (controller) => {
					await gate.promise
					return controller.task.id
				},
				rec: createOrderFunction(order),
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		const rejected = workflow.add({ id: 'z', name: 'Z', tasks: [] }, 0)
		if (rejected.success) throw new Error('expected the insert at index 0 to fail')
		expect(rejected.error.code).toBe('MUTATION')
		gate.resolve()
		await running
	})

	it('move of a pending phase mid-run is honored (its new order is observed by execution)', async () => {
		const gate = Promise.withResolvers<void>()

		const order: string[] = []
		const workflow = createWorkflow(buildParkedPhases(), {
			functions: {
				a: async (controller) => {
					await gate.promise
					return controller.task.id
				},
				rec: createOrderFunction(order),
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		const moved = workflow.move('c', 1)
		if (!moved.success) throw new Error('expected the move to succeed')
		gate.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t2', 't1'])
	})

	it('remove of a pending phase mid-run is honored (the removed phase never runs)', async () => {
		const gate = Promise.withResolvers<void>()

		const order: string[] = []
		const workflow = createWorkflow(buildParkedPhases(), {
			functions: {
				a: async (controller) => {
					await gate.promise
					return controller.task.id
				},
				rec: createOrderFunction(order),
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		const removed = workflow.remove('c')
		if (!removed.success) throw new Error('expected the remove to succeed')
		gate.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t1'])
		expect(workflow.phase('c')).toBeUndefined()
	})

	it('update of a pending phase mid-run is honored (its patched fields apply)', async () => {
		const gate = Promise.withResolvers<void>()

		const order: string[] = []
		const workflow = createWorkflow(buildParkedPhases(), {
			functions: {
				a: async (controller) => {
					await gate.promise
					return controller.task.id
				},
				rec: createOrderFunction(order),
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		const updated = workflow.update('b', { name: 'B renamed' })
		if (!updated.success) throw new Error('expected the update to succeed')
		expect(workflow.phase('b')?.name).toBe('B renamed')
		gate.resolve()
		await running
		expect(workflow.phase('b')?.name).toBe('B renamed')
	})
})

describe('WorkflowRunner — workflow-level pause/resume gates the run', () => {
	it('pausing after task1 completes parks task2 (concurrency 1); resume lets it proceed, nothing skipped or duplicated', async () => {
		const started = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([
			{
				id: 'a',
				concurrency: 1,
				tasks: [buildFunctionTask('t0', 't0'), buildFunctionTask('t1', 't1')],
			},
		])
		const workflow = createWorkflow(definition, {
			functions: {
				t0: (controller) => {
					started.handler(controller.task.id)
					return controller.task.id
				},
				t1: (controller) => {
					started.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		workflow
			.phase('a')
			?.task('t0')
			?.emitter.on('complete', () => workflow.pause())
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		expect([...started.calls].map((c) => c[0])).toEqual(['t0'])
		expect(workflow.paused).toBe(true)
		workflow.resume()
		const result = await running
		expect(result.status).toBe('completed')
		expect([...started.calls].map((c) => c[0])).toEqual(['t0', 't1'])
		expect(workflow.phase('a')?.task('t0')?.status).toBe('completed')
		expect(workflow.phase('a')?.task('t1')?.status).toBe('completed')
	})

	it('pausing during the last task of phase a holds phase b at the boundary until resume', async () => {
		const started = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'a')] },
			{ id: 'b', tasks: [buildFunctionTask('t1', 'b')] },
		])
		const workflow = createWorkflow(definition, {
			functions: {
				a: (controller) => {
					started.handler(controller.task.id)
					return controller.task.id
				},
				b: (controller) => {
					started.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		workflow
			.phase('a')
			?.task('t0')
			?.emitter.on('complete', () => workflow.pause())
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		expect([...started.calls].map((c) => c[0])).toEqual(['t0'])
		expect(workflow.status).toBe('running')
		workflow.resume()
		const result = await running
		expect(result.status).toBe('completed')
		expect([...started.calls].map((c) => c[0])).toEqual(['t0', 't1'])
	})
})

describe('WorkflowRunner — phase-scoped pause/resume gates only that phase', () => {
	it("phase.pause() parks only that phase's next dispatch; the workflow itself stays unpaused", async () => {
		const started = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([
			{
				id: 'a',
				concurrency: 1,
				tasks: [buildFunctionTask('t0', 'fn'), buildFunctionTask('t1', 'fn')],
			},
		])
		const workflow = createWorkflow(definition, {
			functions: {
				fn: (controller) => {
					started.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		workflow
			.phase('a')
			?.task('t0')
			?.emitter.on('complete', () => workflow.phase('a')?.pause())
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		expect([...started.calls].map((c) => c[0])).toEqual(['t0'])
		expect(workflow.paused).toBe(false)
		expect(workflow.phase('a')?.paused).toBe(true)
		workflow.phase('a')?.resume()
		const result = await running
		expect(result.status).toBe('completed')
		expect([...started.calls].map((c) => c[0])).toEqual(['t0', 't1'])
	})
})

describe('WorkflowRunner — append while paused', () => {
	it('phase.add succeeds on a running, paused phase; the appended task parks until resume, then runs', async () => {
		const started = createRecorder<readonly [string]>()
		const gate = Promise.withResolvers<void>()

		const definition = buildRunnerDefinition([
			{ id: 'a', concurrency: 1, tasks: [buildFunctionTask('t0', 't0')] },
		])
		const workflow = createWorkflow(definition, {
			functions: {
				t0: async (controller) => {
					started.handler(controller.task.id)
					await gate.promise
					return controller.task.id
				},
				extra: (controller) => {
					started.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		expect(workflow.phase('a')?.status).toBe('running')
		workflow.pause()
		const added = workflow.phase('a')?.add(buildFunctionTask('t1', 'extra'))
		if (added === undefined || !added.success) throw new Error('expected the append to succeed')
		await waitForDelay(30)
		expect([...started.calls].map((c) => c[0])).toEqual(['t0'])
		gate.resolve()
		await waitForDelay(30)
		expect([...started.calls].map((c) => c[0])).toEqual(['t0'])
		workflow.resume()
		const result = await running
		expect(result.status).toBe('completed')
		expect([...started.calls].map((c) => c[0]).sort()).toEqual(['t0', 't1'])
	})
})

describe('WorkflowRunner — graceful stop mid-run', () => {
	it('workflow.stop(): in-flight task1 finishes, queued task2 is skipped, status stopped, execute resolves', async () => {
		const gate = Promise.withResolvers<void>()

		const definition = buildRunnerDefinition([
			{
				id: 'a',
				concurrency: 1,
				tasks: [buildFunctionTask('t0', 't0'), buildFunctionTask('t1', 't1')],
			},
		])
		const workflow = createWorkflow(definition, {
			functions: {
				t0: async (controller) => {
					await gate.promise
					return controller.task.id
				},
				t1: (controller) => controller.task.id,
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		workflow.stop()
		gate.resolve()
		const result = await running
		expect(result.status).toBe('stopped')
		expect(workflow.phase('a')?.task('t0')?.status).toBe('completed')
		expect(workflow.phase('a')?.task('t1')?.status).toBe('skipped')
	})

	it('workflow stop releases a task parked behind a paused phase before dispatch', async () => {
		const started = createRecorder<readonly [string]>()

		const workflow = createWorkflow(
			buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'fn')] }]),
			{
				functions: {
					fn: (controller) => {
						started.handler(controller.task.id)
						return controller.task.id
					},
				},
			},
		)
		workflow.phase('a')?.pause()
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(20)
		workflow.stop()
		const result = await running
		expect(result.status).toBe('stopped')
		expect(started.count).toBe(0)
		expect(workflow.phase('a')?.task('t0')?.status).toBe('skipped')
	})

	it('workflow stop releases a task parked behind its own gate before dispatch', async () => {
		const started = createRecorder<readonly [string]>()

		const workflow = createWorkflow(
			buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'fn')] }]),
			{
				functions: {
					fn: (controller) => {
						started.handler(controller.task.id)
						return controller.task.id
					},
				},
			},
		)
		workflow.phase('a')?.task('t0')?.pause()
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(20)
		workflow.stop()
		const result = await running
		expect(result.status).toBe('stopped')
		expect(started.count).toBe(0)
		expect(workflow.phase('a')?.task('t0')?.status).toBe('skipped')
	})

	it('phase stop releases a task parked behind its own gate before dispatch', async () => {
		const started = createRecorder<readonly [string]>()

		const workflow = createWorkflow(
			buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'fn')] }]),
			{
				functions: {
					fn: (controller) => {
						started.handler(controller.task.id)
						return controller.task.id
					},
				},
			},
		)
		workflow.phase('a')?.task('t0')?.pause()
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(20)
		workflow.phase('a')?.stop()
		const result = await running
		expect(started.count).toBe(0)
		expect(result.workflow.phase('a')?.status).toBe('stopped')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('skipped')
	})

	it('lets an already-dispatched handler leave controller wait after graceful workflow stop', async () => {
		const entered = Promise.withResolvers<void>()

		const workflow = createWorkflow(
			buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'fn')] }]),
			{
				functions: {
					fn: async (controller) => {
						workflow.phase('a')?.task('t0')?.pause()
						entered.resolve()
						await controller.wait()
						return 'finished'
					},
				},
			},
		)
		const running = createPacedRunner().execute(workflow)
		await entered.promise
		workflow.stop()
		const result = await running
		expect(result.status).toBe('stopped')
		expect(workflow.phase('a')?.task('t0')?.status).toBe('completed')
		expect(workflow.phase('a')?.task('t0')?.result?.result).toEqual({
			success: true,
			value: 'finished',
		})
	})
})

describe('WorkflowRunner — hard destroy mid-run', () => {
	it('workflow.destroy(): the in-flight task is aborted promptly, all nodes settle terminal, destroyed is idempotent', async () => {
		const aborted = createRecorder<readonly [string]>()
		const parked = createParkedTask(aborted)
		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'parked')] },
		])
		const workflow = createWorkflow(definition, { functions: { parked } })
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		workflow.destroy()
		const result = await running
		expect([...aborted.calls].map((c) => c[0])).toEqual(['t0'])
		expect(result.status).toBe('stopped')
		expect(workflow.destroyed).toBe(true)
		expect(workflow.phase('a')?.task('t0')?.status).toBe('stopped')
		expect(() => workflow.destroy()).not.toThrow()
		expect(workflow.destroyed).toBe(true)
	})
})

describe('WorkflowRunner — a run-level timeout still settles a paused run', () => {
	it('TIMEOUT WHILE PAUSED: a paused, un-resumed run settles through the timeout raced against the paused gate', async () => {
		const started = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'fn')] }])
		const workflow = createWorkflow(definition, {
			functions: {
				fn: (controller) => {
					started.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		workflow.pause()
		const result = await createPacedRunner().execute(workflow, { timeout: 20 })
		expect(result.status).toBe('stopped')
		expect(started.count).toBe(0)
		expect(workflow.phase('a')?.task('t0')?.status).toBe('skipped')
	})
})

describe('WorkflowRunner — stop / destroy settle a paused run promptly without resume', () => {
	it('workflow.stop() settles a paused run promptly', async () => {
		const started = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'fn')] }])
		const workflow = createWorkflow(definition, {
			functions: {
				fn: (controller) => {
					started.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		workflow.pause()
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		expect(started.count).toBe(0)
		workflow.stop()
		const result = await running
		expect(result.status).toBe('stopped')
		expect(started.count).toBe(0)
	})

	it('workflow.destroy() settles a paused run promptly', async () => {
		const started = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'fn')] }])
		const workflow = createWorkflow(definition, {
			functions: {
				fn: (controller) => {
					started.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		workflow.pause()
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		workflow.destroy()
		const result = await running
		expect(result.status).toBe('stopped')
		expect(workflow.destroyed).toBe(true)
		expect(started.count).toBe(0)
	})
})

describe('WorkflowRunner — live config: a pending phase patched mid-run governs its own execution', () => {
	it("patching a pending phase's concurrency (1 → 2) mid-run lets both its tasks start before either resolves", async () => {
		const gateA = Promise.withResolvers<void>()

		const started = createRecorder<readonly [string]>()
		const gateMap = new Map<string, PromiseWithResolvers<void>>([
			['t1', Promise.withResolvers<void>()],
			['t2', Promise.withResolvers<void>()],
		])

		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'a')] },
			{
				id: 'b',
				concurrency: 1,
				tasks: [buildFunctionTask('t1', 'b'), buildFunctionTask('t2', 'b')],
			},
		])
		const workflow = createWorkflow(definition, {
			functions: {
				a: async (controller) => {
					await gateA.promise
					return controller.task.id
				},
				b: async (controller) => {
					started.handler(controller.task.id)
					const taskGate = gateMap.get(controller.task.id)
					if (taskGate !== undefined) await taskGate.promise
					return controller.task.id
				},
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		const patched = workflow.update('b', { concurrency: 2 })
		if (!patched.success) throw new Error('expected the patch to succeed')
		gateA.resolve()
		await waitForDelay(30)
		expect([...started.calls].map((c) => c[0]).sort()).toEqual(['t1', 't2'])
		for (const taskGate of gateMap.values()) taskGate.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(workflow.phase('b')?.concurrency).toBe(2)
	})

	it("patching a pending phase's bail mid-run flips its failure semantics (fail-fast → graceful)", async () => {
		const gateA = Promise.withResolvers<void>()

		const gateB = Promise.withResolvers<void>()

		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildFunctionTask('t0', 'a')] },
			{
				id: 'b',
				bail: true,
				tasks: [buildFunctionTask('t1', 'fail'), buildFunctionTask('t2', 'parkedOk')],
			},
		])
		const workflow = createWorkflow(definition, {
			functions: {
				a: async (controller) => {
					await gateA.promise
					return controller.task.id
				},
				fail: () => {
					throw new Error('boom')
				},
				parkedOk: async (controller) => {
					await gateB.promise
					return controller.task.id
				},
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		const patched = workflow.update('b', { bail: false })
		if (!patched.success) throw new Error('expected the patch to succeed')
		gateA.resolve()
		await waitForDelay(30)
		gateB.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(workflow.phase('b')?.task('t1')?.status).toBe('failed')
		expect(workflow.phase('b')?.task('t2')?.status).toBe('completed')
		expect(workflow.phase('b')?.bail).toBe(false)
	})
})

describe('WorkflowRunner — event-order sample: cause-before-effect cascades and add-before-start', () => {
	it("task events precede their phase cascade, which precedes the workflow cascade; a live add fires before the appended task's own start", async () => {
		const order: string[] = []
		const gate = Promise.withResolvers<void>()

		const definition = buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 't0')] }])
		const workflow = createWorkflow(definition, {
			functions: {
				t0: async (controller) => {
					await gate.promise
					return controller.task.id
				},
				t1: (controller) => controller.task.id,
			},
		})
		workflow.emitter.on('start', () => order.push('workflow:start'))
		workflow.emitter.on('complete', () => order.push('workflow:complete'))
		const phaseA = workflow.phase('a')
		phaseA?.emitter.on('start', () => order.push('phase:start'))
		phaseA?.emitter.on('complete', () => order.push('phase:complete'))
		phaseA?.emitter.on('add', (task) => order.push(`phase:add:${task.id}`))
		const task0 = phaseA?.task('t0')
		task0?.emitter.on('start', (id) => order.push(`task:${id}:start`))
		task0?.emitter.on('complete', () => order.push('task:t0:complete'))
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(30)
		const added = phaseA?.add(buildFunctionTask('t1', 't1'))
		if (added === undefined || !added.success) throw new Error('expected the append to succeed')
		added.value.emitter.on('start', (id) => order.push(`task:${id}:start`))
		added.value.emitter.on('complete', () => order.push('task:t1:complete'))
		gate.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(order.indexOf('task:t0:start')).toBeGreaterThanOrEqual(0)
		expect(order.indexOf('task:t0:start')).toBeLessThan(order.indexOf('phase:start'))
		expect(order.indexOf('phase:start')).toBeLessThan(order.indexOf('workflow:start'))
		expect(order.indexOf('phase:add:t1')).toBeGreaterThanOrEqual(0)
		expect(order.indexOf('phase:add:t1')).toBeLessThan(order.indexOf('task:t1:start'))
		expect(order.indexOf('task:t0:complete')).toBeLessThan(order.indexOf('phase:complete'))
		expect(order.indexOf('task:t1:complete')).toBeLessThan(order.indexOf('phase:complete'))
		expect(order.indexOf('phase:complete')).toBeLessThan(order.indexOf('workflow:complete'))
	})
})

describe('WorkflowRunner — activity ownership across attempts', () => {
	it('does not claim an attempt superseded by a reentrant start listener', async () => {
		const calls = new WorkflowObservation(0)
		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildReliableTask('t0', 'record', { retries: 1 })] },
		])
		const workflow = createWorkflow(definition, {
			functions: {
				record: () => {
					calls.value += 1
					return 'late'
				},
			},
		})
		const task = workflow.phase('a')?.task('t0')
		if (task === undefined) throw new Error('expected task')
		task.emitter.on('start', () => {
			if (task.attempts === 1) task.start()
		})

		const result = await createPacedRunner().execute(workflow)
		expect(calls.value).toBe(0)
		expect(task.attempts).toBe(2)
		expect(task.status).toBe('skipped')
		expect(task.result).toBeUndefined()
		expect(result.status).toBe('skipped')
	})

	it('invalidates a live controller when a public start supersedes its attempt', async () => {
		const report = new WorkflowObservation<
			ReturnType<TaskControllerInterface['report']> | undefined
		>(undefined)
		const pulse = new WorkflowObservation<boolean | undefined>(undefined)
		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildReliableTask('t0', 'record', { retries: 1 })] },
		])
		const task = new WorkflowObservation(createWorkflow(definition).phase('a')?.task('t0'))
		if (task.value === undefined) throw new Error('expected seed task')
		const workflow = createWorkflow(definition, {
			functions: {
				record: (controller) => {
					const current = task.value
					if (current === undefined) throw new Error('expected task')
					current.start()
					report.value = controller.report({ note: 'stale' })
					pulse.value = controller.pulse()
					return 'late'
				},
			},
		})
		task.value = workflow.phase('a')?.task('t0')
		if (task.value === undefined) throw new Error('expected task')

		const result = await createPacedRunner().execute(workflow)
		expect(report.value?.success).toBe(false)
		expect(pulse.value).toBe(false)
		expect(task.value.attempts).toBe(2)
		expect(task.value.activity?.note).toBeUndefined()
		expect(task.value.status).toBe('skipped')
		expect(task.value.result).toBeUndefined()
		expect(result.status).toBe('skipped')
	})

	it('refuses report and pulse synchronously from the attempt abort callback', async () => {
		const report = new WorkflowObservation<
			ReturnType<TaskControllerInterface['report']> | undefined
		>(undefined)
		const pulse = new WorkflowObservation<boolean | undefined>(undefined)
		const parked = Promise.withResolvers<void>()

		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildReliableTask('t0', 'record', { timeout: 15 })] },
		])
		const workflow = createWorkflow(definition, {
			functions: {
				record: async (controller) => {
					controller.signal.addEventListener(
						'abort',
						() => {
							report.value = controller.report({ note: 'after abort' })
							pulse.value = controller.pulse()
						},
						{ once: true },
					)
					await parked.promise
					return null
				},
			},
		})
		const task = workflow.phase('a')?.task('t0')
		if (task === undefined) throw new Error('expected task')
		const events = createRecorders<TaskEventMap, TaskEvent>(task.emitter, TASK_EVENTS)
		const result = await createPacedRunner().execute(workflow)
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(report.value?.success).toBe(false)
		if (report.value === undefined || report.value.success)
			throw new Error('expected transition refusal')
		expect(report.value.error.code).toBe('TRANSITION')
		expect(pulse.value).toBe(false)
		expect(events.report.count).toBe(0)
		expect(events.pulse.count).toBe(0)
		expect(task.activity?.note).toBeUndefined()
		parked.resolve()
	})

	it('resets activity at retry entry and rejects a timed-out orphan controller after ownership moves', async () => {
		const attempts = createRecorder<readonly [TaskControllerInterface]>()
		const orphan = Promise.withResolvers<void>()

		const definition = buildRunnerDefinition([
			{ id: 'a', tasks: [buildReliableTask('t0', 'record', { timeout: 15, retries: 1 })] },
		])
		const workflow = createWorkflow(definition, {
			functions: {
				record: async (controller) => {
					attempts.handler(controller)
					if (attempts.count === 1) {
						controller.report({ note: 'old attempt' })
						await orphan.promise
						return 'late'
					}
					controller.report({ note: 'current attempt' })
					return 'recovered'
				},
			},
		})
		const task = workflow.phase('a')?.task('t0')
		if (task === undefined) throw new Error('expected task')
		const events = createRecorders<TaskEventMap, TaskEvent>(task.emitter, TASK_EVENTS)
		const result = await createPacedRunner().execute(workflow)
		expect(result.status).toBe('completed')
		expect(attempts.count).toBe(2)
		expect(events.report.calls.map((call) => call[0].note)).toEqual([
			'old attempt',
			'current attempt',
		])
		const old = attempts.calls[0]?.[0]
		if (old === undefined) throw new Error('expected orphan controller')
		const late = old.report({ note: 'late overwrite' })
		expect(late.success).toBe(false)
		if (late.success) throw new Error('expected stale attempt refusal')
		expect(late.error.code).toBe('TRANSITION')
		expect(old.pulse()).toBe(false)
		expect(task.activity?.note).toBe('current attempt')
		orphan.resolve()
	})
})

describe('WorkflowRunner — task stop and cooperative task gates', () => {
	it('settles a stopped uncooperative handler without failing or cancelling a running sibling', async () => {
		const ignored = Promise.withResolvers<void>()
		const sibling = Promise.withResolvers<void>()

		const definition = buildRunnerDefinition([
			{
				id: 'a',
				concurrency: 2,
				tasks: [buildFunctionTask('t0', 't0'), buildFunctionTask('t1', 't1')],
			},
		])
		const workflow = createWorkflow(definition, {
			functions: {
				t0: async () => {
					await ignored.promise
					return 'ignored'
				},
				t1: async () => {
					await sibling.promise
					return 'sibling'
				},
			},
		})
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(20)
		workflow.phase('a')?.task('t0')?.stop()
		sibling.resolve()
		const result = await running
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('stopped')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t1')?.result?.result).toEqual({
			success: true,
			value: 'sibling',
		})
		ignored.resolve()
	})

	it('balances removable attempt listeners on success, failure, stop, and timeout', async () => {
		const successCounts = new WorkflowObservation<ReturnType<typeof instrumentSignal> | undefined>(
			undefined,
		)

		await createPacedRunner().execute(
			buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'success')] }]),
			{
				functions: {
					success: async (controller) => {
						successCounts.value = instrumentSignal(controller.signal)
						await Promise.resolve()
						return 'ok'
					},
				},
			},
		)
		if (successCounts.value === undefined) throw new Error('expected success signal counts')
		expect(successCounts.value.added.count).toBeGreaterThan(0)
		expect(successCounts.value.added.count).toBe(successCounts.value.removed.count)

		const failureCounts = new WorkflowObservation<ReturnType<typeof instrumentSignal> | undefined>(
			undefined,
		)

		await createPacedRunner().execute(
			buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'failure')] }]),
			{
				functions: {
					failure: async (controller) => {
						failureCounts.value = instrumentSignal(controller.signal)
						await Promise.resolve()
						throw new Error('failed')
					},
				},
			},
		)
		if (failureCounts.value === undefined) throw new Error('expected failure signal counts')
		expect(failureCounts.value.added.count).toBeGreaterThan(0)
		expect(failureCounts.value.added.count).toBe(failureCounts.value.removed.count)

		const stoppedGate = Promise.withResolvers<void>()
		const stoppedCounts = new WorkflowObservation<ReturnType<typeof instrumentSignal> | undefined>(
			undefined,
		)

		const stoppedWorkflow = createWorkflow(
			buildRunnerDefinition([{ id: 'a', tasks: [buildFunctionTask('t0', 'stopped')] }]),
			{
				functions: {
					stopped: async (controller) => {
						stoppedCounts.value = instrumentSignal(controller.signal)
						await stoppedGate.promise
						return null
					},
				},
			},
		)
		const stoppedRun = createPacedRunner().execute(stoppedWorkflow)
		await waitForDelay(5)
		stoppedWorkflow.phase('a')?.task('t0')?.stop()
		await stoppedRun
		if (stoppedCounts.value === undefined) throw new Error('expected stop signal counts')
		expect(stoppedCounts.value.added.count).toBeGreaterThan(0)
		expect(stoppedCounts.value.added.count).toBe(stoppedCounts.value.removed.count)
		stoppedGate.resolve()

		const timeoutGate = Promise.withResolvers<void>()
		const timeoutCounts = new WorkflowObservation<ReturnType<typeof instrumentSignal> | undefined>(
			undefined,
		)

		await createPacedRunner().execute(
			buildRunnerDefinition([
				{ id: 'a', tasks: [buildReliableTask('t0', 'timeout', { timeout: 15 })] },
			]),
			{
				functions: {
					timeout: async (controller) => {
						timeoutCounts.value = instrumentSignal(controller.signal)
						await timeoutGate.promise
						return null
					},
				},
			},
		)
		await Promise.resolve()
		if (timeoutCounts.value === undefined) throw new Error('expected timeout signal counts')
		expect(timeoutCounts.value.added.count).toBeGreaterThan(0)
		expect(timeoutCounts.value.added.count).toBe(timeoutCounts.value.removed.count)
		timeoutGate.resolve()
	})

	it('a paused task occupies its acquired concurrency slot until resume', async () => {
		const started = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([
			{
				id: 'a',
				concurrency: 1,
				tasks: [buildFunctionTask('t0', 'record'), buildFunctionTask('t1', 'record')],
			},
		])
		const workflow = createWorkflow(definition, {
			functions: {
				record: (controller) => {
					started.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		const paused = workflow.phase('a')?.task('t0')
		if (paused === undefined) throw new Error('expected paused task')
		paused.pause()
		const running = createPacedRunner().execute(workflow)
		await waitForDelay(20)
		expect(started.count).toBe(0)
		expect(workflow.phase('a')?.task('t1')?.status).toBe('pending')
		paused.resume()
		const result = await running
		expect(result.status).toBe('completed')
		expect(started.calls.map((call) => call[0])).toEqual(['t0', 't1'])
	})

	it('paused attempts exhaust retries without dispatch and an old gate cannot dispatch after resume', async () => {
		const started = createRecorder<readonly [string]>()

		const definition = buildRunnerDefinition([
			{
				id: 'a',
				concurrency: 1,
				tasks: [buildReliableTask('t0', 'record', { timeout: 15, retries: 1 })],
			},
		])
		const workflow = createWorkflow(definition, {
			functions: {
				record: (controller) => {
					started.handler(controller.task.id)
					return controller.task.id
				},
			},
		})
		const paused = workflow.phase('a')?.task('t0')
		if (paused === undefined) throw new Error('expected paused task')
		const reports = createRecorders<TaskEventMap, TaskEvent>(paused.emitter, TASK_EVENTS)
		paused.pause()
		const result = await createPacedRunner().execute(workflow)
		expect(started.count).toBe(0)
		expect(reports.report.count).toBe(0)
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		paused.resume()
		await waitForDelay(5)
		expect(started.count).toBe(0)
	})
})
