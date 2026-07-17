import type { AgentInterface } from '@orkestrel/agent'
import type {
	TaskControllerInterface,
	WorkflowDefinition,
	WorkflowFunction,
	WorkflowRunnerInterface,
	WorkflowRunnerOptions,
} from '@src/core'
import { createAgent, createTool, createToolManager } from '@orkestrel/agent'
import { createTokenBudget } from '@orkestrel/budget'
import {
	createAgentFunction,
	createScheduler,
	createToolFunction,
	createWorkflow,
	createWorkflowRunner,
	isWorkflowError,
	MAX_WORKFLOW_DEPTH,
} from '@src/core'
import { describe, expect, it, vi } from 'vitest'
import type { TestGateInterface } from '../../setup.js'
import {
	createGate,
	createRecorder,
	createRecordingScheduler,
	createScriptedProvider,
	waitForDelay,
} from '../../setup.js'

// The W-c1 WorkflowRunner — the thin orchestrator that EXECUTES a live W-b tree by COMPOSING the
// shipped substrate (one Runner/Queue per phase, the bail policy mapped onto fail-fast vs
// settle-all, the abort/timeout/budget fold via AbortSignal.any, the scheduler pacing). Real data
// stubs — scripted WorkflowFunction handlers + real ToolManager/agents, NO mocks (AGENTS §16).
// Determinism comes from gates (createGate), not wall-clock races.
//
// PROGRAMMATIC CORE, DECLARATIVE SHELL (this wave's redesign): `TaskDefinition.run` is a PLAIN
// STRING resolved ONCE at construction against a `WorkflowOptions.functions` registry into the
// live task's `handler`. The runner itself is a PURE engine — it carries no `functions` / `tools`
// / `agents` of its own; every `execute(...)` call below threads `functions` through the RUN
// options (`WorkflowRunOptions extends WorkflowOptions`), never through `createWorkflowRunner`.
// `createToolFunction` / `createAgentFunction` (factories.ts) are the OPT-IN adapters a caller
// composes into its OWN `functions` registry — their own dedicated coverage (happy path, error
// paths, the depth/cycle guard, the tool-binding seam) lives in `factories.test.ts`; this file
// keeps to the ENGINE's own behavior (dispatch, concurrency, bail, retries/timeout, abort/pause/
// stop/destroy, live mid-run mutation), touching the adapters only enough to prove they compose.

const ROUND_TRIP_TIMEOUT_MS = 30_000
vi.setConfig({ testTimeout: ROUND_TRIP_TIMEOUT_MS })

// A workflow runner whose inter-phase pacing is DETERMINISTIC (AGENTS §16: clock seams, not
// wall-clock) — the shipped `createScheduler` default paces via a real `setTimeout(0)` macrotask,
// which under full-`src:core`-project parallel load can be event-loop-starved past vitest's
// default timeout; injecting `createRecordingScheduler` (`yield` resolves immediately, honouring
// the run signal exactly like the shipped one) removes that lone wall-clock dependency.
function pacedRunner(options?: WorkflowRunnerOptions): WorkflowRunnerInterface {
	return createWorkflowRunner({
		...options,
		scheduler: options?.scheduler ?? createRecordingScheduler(),
	})
}

// ── Local scenario builders (definitions + scripted handlers) ──

/** A function task on task `id`, dispatched by NAME to the registered function `fn`. */
function functionTask(
	id: string,
	fn: string,
): WorkflowDefinition['phases'][number]['tasks'][number] {
	return { id, name: id, run: fn }
}

/** Build a definition from a compact phase spec — each phase its tasks + optional concurrency / bail. */
function buildDefinition(
	phases: readonly {
		readonly id: string
		readonly tasks: readonly WorkflowDefinition['phases'][number]['tasks'][number][]
		readonly concurrency?: number
		readonly bail?: boolean
	}[],
	bail = false,
): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		bail,
		phases: phases.map((phase) => ({
			id: phase.id,
			name: phase.id,
			...(phase.concurrency === undefined ? {} : { concurrency: phase.concurrency }),
			...(phase.bail === undefined ? {} : { bail: phase.bail }),
			tasks: phase.tasks,
		})),
	}
}

/** A scripted function handler that records the order its tasks start (by `task.id`). */
function recordingFunction(order: string[]): WorkflowFunction {
	return (controller) => {
		order.push(controller.task.id)
		return controller.task.id
	}
}

/** A function task carrying optional per-task reliability overrides (`retries` / `timeout`). */
function reliableTask(
	id: string,
	fn: string,
	reliability: { readonly retries?: number; readonly timeout?: number },
): WorkflowDefinition['phases'][number]['tasks'][number] {
	return {
		id,
		name: id,
		run: fn,
		...(reliability.retries === undefined ? {} : { retries: reliability.retries }),
		...(reliability.timeout === undefined ? {} : { timeout: reliability.timeout }),
	}
}

// A WorkflowFunction that PARKS on its own attempt signal and never resolves on its own — the only
// thing that releases it is its per-attempt deadline aborting the signal (the real gate the timeout
// path needs). On abort it resolves a sentinel so the attempt SETTLES (so the leaf decision runs);
// the resolved value is discarded by the runner as a timed-out attempt. Not a mock — a real handler
// parking on a real AbortSignal it controls nothing of (AGENTS §16).
const parkUntilDeadline: WorkflowFunction = (controller: TaskControllerInterface) =>
	new Promise<string>((resolve) => {
		if (controller.signal.aborted) {
			resolve('timed-out')
			return
		}
		controller.signal.addEventListener('abort', () => resolve('timed-out'), { once: true })
	})

// ── W-c2 agent-task helpers (real agents + scripted providers, wired through `createAgentFunction`) ──

/** A single-phase, single-task workflow whose lone task runs `name` (registered via `functions`). */
function agentDefinition(name: string): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', run: name }] }],
	}
}

// A REAL `ProviderInterface` (via the shared scripted provider, with a `delay` so an abort mid-run
// has a real window to land) whose per-turn content lets `parkedProvider`-style abort tests observe
// the folded signal. Used with `createAgentFunction` for the abort-fold coverage below.
function parkedAgent(onAbort: () => void, delay = 200): AgentInterface {
	const provider = createScriptedProvider([{ content: 'audited' }], { delay })
	const agent = createAgent(provider)
	const original = agent.abort.bind(agent)
	agent.abort = (reason?: unknown) => {
		onAbort()
		original(reason)
	}
	return agent
}

describe('WorkflowRunner — phases sequential, tasks concurrent', () => {
	it('starts every task of a phase before any settles, and phase 2 only after phase 1 settles', async () => {
		const starts = createRecorder<readonly [string]>()
		const gate = createGate()
		const a: WorkflowFunction = async (controller) => {
			starts.handler(controller.task.id)
			await gate.promise
			return controller.task.id
		}
		const b: WorkflowFunction = (controller) => {
			starts.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'a'), functionTask('t1', 'a')] },
			{ id: 'b', tasks: [functionTask('t2', 'b')] },
		])
		const running = pacedRunner().execute(definition, { functions: { a, b } })

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
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'f'), functionTask('t1', 'f')] },
		])
		const result = await pacedRunner().execute(definition, {
			functions: { f: recordingFunction(order) },
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
	it('a task registered via createToolFunction invokes the real tool and completes', async () => {
		const tools = createToolManager()
		const seen = createRecorder<readonly [Readonly<Record<string, unknown>>]>()
		tools.add(
			createTool({
				name: 'scan',
				execute: (args) => {
					seen.handler(args)
					return 'scanned'
				},
			}),
		)
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', run: 'scan' }] }],
		}
		const result = await pacedRunner().execute(definition, {
			functions: { scan: createToolFunction(tools, 'scan') },
		})
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t')?.result?.result).toEqual({
			success: true,
			value: 'scanned',
		})
		expect(seen.count).toBe(1)
	})

	it('a failing tool (its result carries an error) fails the leaf', async () => {
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'boom',
				execute: () => {
					throw new Error('tool exploded')
				},
			}),
		)
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			bail: false,
			phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', run: 'boom' }] }],
		}
		const result = await pacedRunner().execute(definition, {
			functions: { boom: createToolFunction(tools, 'boom') },
		})
		expect(result.status).toBe('completed')
		const recorded = result.workflow.phase('a')?.task('t')?.result
		expect(recorded?.status).toBe('failed')
		expect(recorded?.result?.success).toBe(false)
		const error = recorded?.result?.success === false ? recorded.result.error : undefined
		expect(error).toBeInstanceOf(Error)
		expect(error instanceof Error ? error.cause : undefined).toBe('tool exploded')
	})

	it('a no-handler task auto-completes (an unregistered function name)', async () => {
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t', 'missing')] }])
		const result = await pacedRunner().execute(definition)
		expect(result.status).toBe('completed')
		const recorded = result.workflow.phase('a')?.task('t')?.result
		expect(recorded?.status).toBe('completed')
		expect(recorded?.result).toEqual({ success: true, value: undefined })
	})

	it('a task whose `run` is omitted entirely auto-completes', async () => {
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T' }] }],
		}
		const result = await pacedRunner().execute(definition)
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t')?.status).toBe('completed')
	})

	it('an agent task registered via createAgentFunction runs the real agent and boxes its result', async () => {
		const agent = createAgent(createScriptedProvider([{ content: 'audited' }]))
		const result = await pacedRunner().execute(agentDefinition('auditor'), {
			functions: { auditor: createAgentFunction(agent) },
		})
		expect(result.status).toBe('completed')
		const value = result.workflow.phase('a')?.task('t')?.result?.result
		const content =
			value?.success === true &&
			typeof value.value === 'object' &&
			value.value !== null &&
			'content' in value.value
				? value.value.content
				: undefined
		expect(content).toBe('audited')
	})
})

describe('WorkflowRunner — all three dispatch branches compose in one run (P2.1)', () => {
	it('a function + a tool-adapter + an agent-adapter task across 3 phases all complete and each is recorded', async () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'scan', execute: () => 'scanned' }))
		const agent = createAgent(createScriptedProvider([{ content: 'audited' }]))
		const fn: WorkflowFunction = (controller) => `built ${controller.task.id}`
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [
				{ id: 'p1', name: 'P1', tasks: [{ id: 'fn', name: 'Fn', run: 'f' }] },
				{ id: 'p2', name: 'P2', tasks: [{ id: 'tl', name: 'Tl', run: 'scan' }] },
				{ id: 'p3', name: 'P3', tasks: [{ id: 'ag', name: 'Ag', run: 'auditor' }] },
			],
		}
		const result = await pacedRunner().execute(definition, {
			functions: {
				f: fn,
				scan: createToolFunction(tools, 'scan'),
				auditor: createAgentFunction(agent),
			},
		})
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('p1')?.task('fn')?.status).toBe('completed')
		expect(result.workflow.phase('p2')?.task('tl')?.status).toBe('completed')
		expect(result.workflow.phase('p3')?.task('ag')?.status).toBe('completed')
		expect(result.results.map((r) => r.task.id)).toEqual(['fn', 'tl', 'ag'])
		const fnValue = result.workflow.phase('p1')?.task('fn')?.result?.result
		expect(fnValue).toEqual({ success: true, value: 'built fn' })
		expect(result.workflow.phase('p2')?.task('tl')?.result?.result).toEqual({
			success: true,
			value: 'scanned',
		})
		const agValue = result.workflow.phase('p3')?.task('ag')?.result?.result
		const agContent =
			agValue?.success === true &&
			typeof agValue.value === 'object' &&
			agValue.value !== null &&
			'content' in agValue.value
				? agValue.value.content
				: undefined
		expect(agContent).toBe('audited')
	})
})

describe('WorkflowRunner — bail:false records a failure yet completes across phases (P2.2)', () => {
	it('a failing leaf in phase 1 + succeeding leaves in phases 1 and 2 → completed, failure visible, later phases ran', async () => {
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const ok: WorkflowFunction = (controller) => controller.task.id
		const definition = buildDefinition(
			[
				{ id: 'a', tasks: [functionTask('t0', 'fail'), functionTask('t1', 'ok')] },
				{ id: 'b', tasks: [functionTask('t2', 'ok')] },
			],
			false,
		)
		const result = await pacedRunner().execute(definition, { functions: { fail, ok } })
		expect(result.status).toBe('completed')
		const failure = result.results.find((r) => r.task.id === 't0')
		expect(failure?.status).toBe('failed')
		expect(failure?.result?.success).toBe(false)
		const error = failure?.result?.success === false ? failure.result.error : undefined
		expect(error).toBeInstanceOf(Error)
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('completed')
	})
})

describe('WorkflowRunner — per-phase throttle', () => {
	it('runs at most `concurrency` tasks in flight at once', async () => {
		let inFlight = 0
		let maxInFlight = 0
		const gates = [createGate(), createGate(), createGate(), createGate()]
		const index = new Map<string, number>([
			['t0', 0],
			['t1', 1],
			['t2', 2],
			['t3', 3],
		])
		const throttled: WorkflowFunction = async (controller) => {
			inFlight += 1
			maxInFlight = Math.max(maxInFlight, inFlight)
			const slot = index.get(controller.task.id) ?? 0
			await gates[slot]?.promise
			inFlight -= 1
			return controller.task.id
		}
		const definition = buildDefinition([
			{
				id: 'a',
				concurrency: 2,
				tasks: [
					functionTask('t0', 'g'),
					functionTask('t1', 'g'),
					functionTask('t2', 'g'),
					functionTask('t3', 'g'),
				],
			},
		])
		const running = pacedRunner().execute(definition, { functions: { g: throttled } })
		await waitForDelay()
		expect(maxInFlight).toBe(2)
		for (const gate of gates) {
			gate.resolve()
			await waitForDelay()
		}
		const result = await running
		expect(result.status).toBe('completed')
		expect(maxInFlight).toBe(2)
	})
})

describe('WorkflowRunner — an executed no-op tree settles completed (F1)', () => {
	it('a zero-phase definition settles completed (not pending)', async () => {
		const definition = buildDefinition([])
		const result = await pacedRunner().execute(definition)
		expect(result.status).toBe('completed')
		expect(result.workflow.status).toBe('completed')
		expect(result.results).toEqual([])
	})

	it('a single empty-task phase settles completed', async () => {
		const definition = buildDefinition([{ id: 'a', tasks: [] }])
		const result = await pacedRunner().execute(definition)
		expect(result.status).toBe('completed')
		expect(result.workflow.status).toBe('completed')
		expect(result.workflow.phase('a')?.status).toBe('pending')
	})

	it('multiple empty phases settle completed', async () => {
		const definition = buildDefinition([
			{ id: 'a', tasks: [] },
			{ id: 'b', tasks: [] },
		])
		const result = await pacedRunner().execute(definition)
		expect(result.status).toBe('completed')
		expect(result.workflow.status).toBe('completed')
	})

	it('a normal completed run is unchanged (the gate does not double-force)', async () => {
		const order: string[] = []
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'f')] }])
		const result = await pacedRunner().execute(definition, {
			functions: { f: recordingFunction(order) },
		})
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t0'])
	})

	it('a bail:true failing run stays failed (the gate never masks a failure)', async () => {
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'fail')] }], true)
		const result = await pacedRunner().execute(definition, { functions: { fail } })
		expect(result.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
	})

	it('a cancelled empty-ish run settles stopped (the cancel path wins, never completed)', async () => {
		const budget = createTokenBudget({ max: 0 })
		const definition = buildDefinition([
			{ id: 'a', tasks: [] },
			{ id: 'b', tasks: [] },
		])
		const result = await pacedRunner().execute(definition, { budget })
		expect(result.status).toBe('stopped')
		expect(result.workflow.status).toBe('stopped')
	})

	it('a pre-aborted run settles stopped, never completed (the cancel branch precedes the gate)', async () => {
		const controllerAbort = new AbortController()
		controllerAbort.abort(new Error('pre-cancelled'))
		const ran = createRecorder<readonly [string]>()
		const fn: WorkflowFunction = (controller) => {
			ran.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'fn')] }])
		const result = await pacedRunner().execute(definition, {
			functions: { fn },
			signal: controllerAbort.signal,
		})
		expect(ran.count).toBe(0)
		expect(result.status).toBe('stopped')
	})
})

describe('WorkflowRunner — non-positive phase concurrency is clamped (F2)', () => {
	it('a concurrency:0 phase runs every task and completes (clamped to the default)', async () => {
		const ran = createRecorder<readonly [string]>()
		const fn: WorkflowFunction = (controller) => {
			ran.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([
			{
				id: 'a',
				concurrency: 0,
				tasks: [functionTask('t0', 'fn'), functionTask('t1', 'fn'), functionTask('t2', 'fn')],
			},
		])
		const result = await pacedRunner().execute(definition, { functions: { fn } })
		expect(result.status).toBe('completed')
		expect([...ran.calls].map((c) => c[0]).sort()).toEqual(['t0', 't1', 't2'])
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t2')?.status).toBe('completed')
	})

	it('a concurrency:-1 phase runs every task and completes (clamped to the default)', async () => {
		const ran = createRecorder<readonly [string]>()
		const fn: WorkflowFunction = (controller) => {
			ran.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([
			{
				id: 'a',
				concurrency: -1,
				tasks: [functionTask('t0', 'fn'), functionTask('t1', 'fn'), functionTask('t2', 'fn')],
			},
		])
		const result = await pacedRunner().execute(definition, { functions: { fn } })
		expect(result.status).toBe('completed')
		expect([...ran.calls].map((c) => c[0]).sort()).toEqual(['t0', 't1', 't2'])
	})
})

describe('WorkflowRunner — bail:false records failures while finishing', () => {
	it('a phase with a failing + a succeeding task settles both; the workflow completes', async () => {
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const ok: WorkflowFunction = (controller) => controller.task.id
		const definition = buildDefinition(
			[{ id: 'a', tasks: [functionTask('t0', 'fail'), functionTask('t1', 'ok')] }],
			false,
		)
		const result = await pacedRunner().execute(definition, { functions: { fail, ok } })
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		const failure = result.results.find((r) => r.task.id === 't0')
		expect(failure?.result?.success).toBe(false)
	})

	it('continues to the next phase after a failure under graceful mode', async () => {
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const order: string[] = []
		const definition = buildDefinition(
			[
				{ id: 'a', tasks: [functionTask('t0', 'fail')] },
				{ id: 'b', tasks: [functionTask('t1', 'rec')] },
			],
			false,
		)
		const result = await pacedRunner().execute(definition, {
			functions: { fail, rec: recordingFunction(order) },
		})
		expect(order).toEqual(['t1'])
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('completed')
	})
})

describe('WorkflowRunner — bail:true halts on the first failure', () => {
	it('the first failure aborts an in-flight sibling and skips the remaining phases', async () => {
		const aborted = createRecorder<readonly [string]>()
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const sibling: WorkflowFunction = (controller: TaskControllerInterface) =>
			new Promise<string>((resolve) => {
				if (controller.signal.aborted) {
					aborted.handler(controller.task.id)
					resolve('aborted')
					return
				}
				controller.signal.addEventListener(
					'abort',
					() => {
						aborted.handler(controller.task.id)
						resolve('aborted')
					},
					{ once: true },
				)
			})
		const definition = buildDefinition(
			[
				{ id: 'a', tasks: [functionTask('t0', 'fail'), functionTask('t1', 'sibling')] },
				{ id: 'b', tasks: [functionTask('t2', 'sibling')] },
			],
			true,
		)
		const result = await pacedRunner().execute(definition, { functions: { fail, sibling } })
		expect(result.status).toBe('failed')
		expect([...aborted.calls].map((c) => c[0])).toContain('t1')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('skipped')
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('skipped')
	})

	it('a single failing task in a single-task phase fails the workflow and skips later phases', async () => {
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const order: string[] = []
		const definition = buildDefinition(
			[
				{ id: 'a', tasks: [functionTask('t0', 'fail')] },
				{ id: 'b', tasks: [functionTask('t1', 'rec')] },
			],
			true,
		)
		const result = await pacedRunner().execute(definition, {
			functions: { fail, rec: recordingFunction(order) },
		})
		expect(result.status).toBe('failed')
		expect(order).toEqual([])
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('skipped')
	})
})

describe('WorkflowRunner — per-task retries / timeout (Seam A, threaded via the Runner)', () => {
	it('A1 divergent retries: a retried task recovers (3 runs) while a no-retry sibling fails (1 run)', async () => {
		const attempts = new Map<string, number>()
		const flaky: WorkflowFunction = (controller) => {
			const seen = (attempts.get(controller.task.id) ?? 0) + 1
			attempts.set(controller.task.id, seen)
			if (controller.task.id === 't0' && seen < 3) throw new Error('flaky')
			if (controller.task.id === 't1') throw new Error('always')
			return controller.task.id
		}
		const definition = buildDefinition(
			[
				{
					id: 'a',
					tasks: [
						reliableTask('t0', 'flaky', { retries: 2 }),
						reliableTask('t1', 'flaky', { retries: 0 }),
					],
				},
			],
			false,
		)
		const result = await pacedRunner().execute(definition, { functions: { flaky } })
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('failed')
		expect(attempts.get('t0')).toBe(3)
		expect(attempts.get('t1')).toBe(1)
	})

	it('A2 per-task timeout FAILS the leaf (not skipped): a parked task that exhausts its deadline ends failed while a no-timeout sibling completes (bail:false records the failure)', async () => {
		const quick: WorkflowFunction = (controller) => controller.task.id
		const definition = buildDefinition(
			[
				{
					id: 'a',
					tasks: [
						reliableTask('t0', 'parkUntilDeadline', { timeout: 20, retries: 0 }),
						reliableTask('t1', 'quick', {}),
					],
				},
			],
			false,
		)
		const result = await pacedRunner().execute(definition, {
			functions: { parkUntilDeadline, quick },
		})
		const t0 = result.workflow.phase('a')?.task('t0')
		expect(t0?.status).toBe('failed')
		expect(t0?.status).not.toBe('skipped')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(result.status).toBe('completed')
		const failure = result.results.find((r) => r.task.id === 't0')
		expect(failure?.status).toBe('failed')
		expect(failure?.result?.success).toBe(false)
	})

	it('A4 retries + timeout RECOVERS: attempt 1 exhausts the deadline, attempt 2 completes → the leaf completes (ran 2×) and the recovered value is recorded', async () => {
		const attempts = new Map<string, number>()
		const recoverAfterTimeout: WorkflowFunction = (controller) => {
			const seen = (attempts.get(controller.task.id) ?? 0) + 1
			attempts.set(controller.task.id, seen)
			if (seen === 1) return parkUntilDeadline(controller)
			return `recovered ${controller.task.id}`
		}
		const definition = buildDefinition(
			[
				{
					id: 'a',
					tasks: [reliableTask('t0', 'recoverAfterTimeout', { timeout: 20, retries: 1 })],
				},
			],
			false,
		)
		const result = await pacedRunner().execute(definition, {
			functions: { recoverAfterTimeout },
		})
		expect(result.status).toBe('completed')
		const t0 = result.workflow.phase('a')?.task('t0')
		expect(t0?.status).toBe('completed')
		expect(attempts.get('t0')).toBe(2)
		expect(t0?.result?.result).toEqual({ success: true, value: 'recovered t0' })
	})

	it('A3 omission regression: a task with neither field never retries on failure (today’s behavior)', async () => {
		const attempts = new Map<string, number>()
		const failOnce: WorkflowFunction = (controller) => {
			attempts.set(controller.task.id, (attempts.get(controller.task.id) ?? 0) + 1)
			throw new Error('boom')
		}
		const definition = buildDefinition(
			[{ id: 'a', tasks: [functionTask('t0', 'failOnce')] }],
			false,
		)
		const result = await pacedRunner().execute(definition, { functions: { failOnce } })
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(attempts.get('t0')).toBe(1)
	})
})

describe('WorkflowRunner — a per-task timeout is a FAILURE under bail, and the distinguisher preserves skip-on-fail-fast', () => {
	it('3a bail:true + timeout-only fault: the timed-out task FAILS, the workflow derives failed, and a later phase is skipped (halted)', async () => {
		const quick: WorkflowFunction = (controller) => controller.task.id
		const definition = buildDefinition(
			[
				{ id: 'a', tasks: [reliableTask('t0', 'parkUntilDeadline', { timeout: 20, retries: 0 })] },
				{ id: 'b', tasks: [functionTask('t1', 'quick')] },
			],
			true,
		)
		const result = await pacedRunner().execute(definition, {
			functions: { parkUntilDeadline, quick },
		})
		expect(result.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('skipped')
	})

	it('sibling-fail-fast regression: under bail a thrown failure still SKIPS a parked sibling (the timeout distinguisher did NOT turn a fail-fast abort into a failure)', async () => {
		const aborted = createRecorder<readonly [string]>()
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const sibling: WorkflowFunction = (controller: TaskControllerInterface) =>
			new Promise<string>((resolve) => {
				if (controller.signal.aborted) {
					aborted.handler(controller.task.id)
					resolve('aborted')
					return
				}
				controller.signal.addEventListener(
					'abort',
					() => {
						aborted.handler(controller.task.id)
						resolve('aborted')
					},
					{ once: true },
				)
			})
		const definition = buildDefinition(
			[{ id: 'a', tasks: [functionTask('t0', 'fail'), functionTask('t1', 'sibling')] }],
			true,
		)
		const result = await pacedRunner().execute(definition, { functions: { fail, sibling } })
		expect(result.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect([...aborted.calls].map((c) => c[0])).toContain('t1')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('skipped')
	})
})

describe('WorkflowRunner — per-phase bail override (Seam B)', () => {
	function parkingSibling(aborted: { handler: (id: string) => void }): WorkflowFunction {
		return (controller: TaskControllerInterface) =>
			new Promise<string>((resolve) => {
				if (controller.signal.aborted) {
					aborted.handler(controller.task.id)
					resolve('aborted')
					return
				}
				controller.signal.addEventListener(
					'abort',
					() => {
						aborted.handler(controller.task.id)
						resolve('aborted')
					},
					{ once: true },
				)
			})
	}

	it('B1 a strict (bail:true) phase HALTS subsequent phases even under a graceful (bail:false) workflow', async () => {
		const aborted = createRecorder<readonly [string]>()
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const definition = buildDefinition([
			{ id: 'a', bail: true, tasks: [functionTask('t0', 'fail'), functionTask('t1', 'sibling')] },
			{ id: 'b', tasks: [functionTask('t2', 'sibling')] },
		])
		const result = await pacedRunner().execute(definition, {
			functions: { fail, sibling: parkingSibling(aborted) },
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
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const ok: WorkflowFunction = (controller) => controller.task.id
		const definition = buildDefinition(
			[
				{ id: 'a', bail: false, tasks: [functionTask('t0', 'fail'), functionTask('t1', 'ok')] },
				{ id: 'b', tasks: [functionTask('t2', 'ok')] },
			],
			true,
		)
		const result = await pacedRunner().execute(definition, { functions: { fail, ok } })
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.bail).toBe(false)
		expect(result.workflow.phase('b')?.bail).toBe(true)
	})

	it('B3 inheritance: a no-bail phase halts under a bail:true workflow and does NOT under bail:false', async () => {
		const makeDefinition = (workflowBail: boolean): WorkflowDefinition =>
			buildDefinition(
				[
					{ id: 'a', tasks: [functionTask('t0', 'fail')] },
					{ id: 'b', tasks: [functionTask('t1', 'ok')] },
				],
				workflowBail,
			)
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const ok: WorkflowFunction = (controller) => controller.task.id

		const strict = await pacedRunner().execute(makeDefinition(true), { functions: { fail, ok } })
		expect(strict.status).toBe('failed')
		expect(strict.workflow.phase('a')?.bail).toBe(true)
		expect(strict.workflow.phase('b')?.task('t1')?.status).toBe('skipped')

		const graceful = await pacedRunner().execute(makeDefinition(false), { functions: { fail, ok } })
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
		const parked: WorkflowFunction = (controller: TaskControllerInterface) =>
			new Promise<string>((resolve) => {
				started.handler(controller.task.id)
				controller.signal.addEventListener(
					'abort',
					() => {
						aborted.handler(controller.task.id)
						resolve('aborted')
					},
					{ once: true },
				)
			})
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'parked'), functionTask('t1', 'parked')] },
			{ id: 'b', tasks: [functionTask('t2', 'parked')] },
		])
		const running = pacedRunner().execute(definition, {
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

describe('WorkflowRunner — budget / timeout fold', () => {
	it('a pre-exhausted budget halts the run (no task runs) and stops the workflow', async () => {
		const ran = createRecorder<readonly [string]>()
		const fn: WorkflowFunction = (controller) => {
			ran.handler(controller.task.id)
			return controller.task.id
		}
		const budget = createTokenBudget({ max: 0 })
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'fn')] }])
		const result = await pacedRunner().execute(definition, { functions: { fn }, budget })
		expect(result.status).toBe('stopped')
		expect(ran.count).toBe(0)
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('skipped')
	})

	it('a timeout firing mid-phase aborts the running task and stops the workflow', async () => {
		const aborted = createRecorder<readonly [string]>()
		const parked: WorkflowFunction = (controller: TaskControllerInterface) =>
			new Promise<string>((resolve) => {
				controller.signal.addEventListener(
					'abort',
					() => {
						aborted.handler(controller.task.id)
						resolve('aborted')
					},
					{ once: true },
				)
			})
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'parked')] }])
		const result = await pacedRunner().execute(definition, { functions: { parked }, timeout: 20 })
		expect(result.status).toBe('stopped')
		expect([...aborted.calls].map((c) => c[0])).toEqual(['t0'])
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('skipped')
	})

	it('a non-positive timeout (0) arms NO deadline — the run completes normally', async () => {
		const order: string[] = []
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'f')] },
			{ id: 'b', tasks: [functionTask('t1', 'f')] },
		])
		const result = await pacedRunner().execute(definition, {
			functions: { f: recordingFunction(order) },
			timeout: 0,
		})
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t0', 't1'])
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('completed')
	})
})

describe('WorkflowRunner — construction options', () => {
	it('forwards the WorkflowOptions half (bail override + on listeners) to the built tree', async () => {
		const failures = createRecorder<readonly [string]>()
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'fail')] },
			{ id: 'b', tasks: [functionTask('t1', 'fail')] },
		])
		const result = await pacedRunner().execute(definition, {
			functions: { fail },
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
	it('a phase-2 function can read phase-1 task results via controller.results()', async () => {
		const seen = createRecorder<readonly [number]>()
		const produce: WorkflowFunction = (controller) => controller.task.id
		const consume: WorkflowFunction = (controller) => {
			seen.handler(controller.results().length)
			return controller.task.id
		}
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'produce'), functionTask('t1', 'produce')] },
			{ id: 'b', tasks: [functionTask('t2', 'consume')] },
		])
		await pacedRunner().execute(definition, { functions: { produce, consume } })
		expect(seen.calls[0]?.[0]).toBe(2)
	})

	it('a phase-3 task reads an EARLIER phase-1 task’s recorded OUTCOME via controller.results() (P3.2)', async () => {
		const sawPhase1Value = createRecorder<readonly [unknown]>()
		const sawPhase1Status = createRecorder<readonly [string]>()
		const produce: WorkflowFunction = () => 'phase-1-output'
		const spacer: WorkflowFunction = (controller) => controller.task.id
		const reader: WorkflowFunction = (controller) => {
			const earlier = controller.results().find((r) => r.task.id === 'p1')
			sawPhase1Status.handler(earlier?.status ?? 'absent')
			const value = earlier?.result?.success === true ? earlier.result.value : undefined
			sawPhase1Value.handler(value)
			return controller.task.id
		}
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [
				{ id: 'a', name: 'A', tasks: [{ id: 'p1', name: 'P1', run: 'produce' }] },
				{ id: 'b', name: 'B', tasks: [{ id: 'p2', name: 'P2', run: 'spacer' }] },
				{ id: 'c', name: 'C', tasks: [{ id: 'p3', name: 'P3', run: 'reader' }] },
			],
		}
		const result = await pacedRunner().execute(definition, {
			functions: { produce, spacer, reader },
		})
		expect(result.status).toBe('completed')
		expect(sawPhase1Status.calls[0]?.[0]).toBe('completed')
		expect(sawPhase1Value.calls[0]?.[0]).toBe('phase-1-output')
	})
})

describe('WorkflowRunner — pacing', () => {
	it('uses the shipped scheduler by default and accepts a custom one without error', async () => {
		const order: string[] = []
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'f')] },
			{ id: 'b', tasks: [functionTask('t1', 'f')] },
		])
		const result = await pacedRunner({ scheduler: createScheduler() }).execute(definition, {
			functions: { f: recordingFunction(order) },
		})
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t0', 't1'])
	})
})

describe('WorkflowRunner — agent-adapter task dispatch composes for real (W-c2)', () => {
	it('fails the task when the agent throws (a genuine provider error)', async () => {
		// A REAL `ProviderInterface` whose `stream` yields a reachable no-op delta then throws a
		// non-abort error — drives `agent.generate()` to REJECT (a genuine provider failure, not a
		// cancel), so the dispatched agent task `fail`s.
		async function* stream(): AsyncGenerator<{ type: 'content'; text: string }, never> {
			yield { type: 'content', text: '' }
			throw new Error('provider boom')
		}
		const agent = createAgent({
			id: 'throwing',
			name: 'throwing',
			stream,
			async generate() {
				throw new Error('provider boom')
			},
		})
		const result = await pacedRunner().execute(agentDefinition('auditor'), {
			functions: { auditor: createAgentFunction(agent) },
		})
		expect(result.status).toBe('completed')
		const recorded = result.workflow.phase('a')?.task('t')?.result
		expect(recorded?.status).toBe('failed')
		expect(recorded?.result?.success).toBe(false)
	})

	it('a workflow cancel aborts the in-flight agent (the agent run sees the folded signal)', async () => {
		const sawAbort = createRecorder<readonly []>()
		const controllerAbort = new AbortController()
		const agent = parkedAgent(() => sawAbort.handler())
		const running = pacedRunner().execute(agentDefinition('auditor'), {
			functions: { auditor: createAgentFunction(agent) },
			signal: controllerAbort.signal,
		})
		await waitForDelay(20)
		controllerAbort.abort(new Error('cancelled'))
		const result = await running
		expect(sawAbort.count).toBe(1)
		expect(result.status).toBe('stopped')
		expect(result.workflow.phase('a')?.task('t')?.status).toBe('skipped')
	})

	it('a task registered against an over-deep createAgentFunction fails with a typed DEPTH error (the guard lives in the adapter, not the engine)', async () => {
		const provider = createScriptedProvider([{ content: 'x' }])
		const agent = createAgent(provider)
		const result = await pacedRunner().execute(agentDefinition('auditor'), {
			functions: { auditor: createAgentFunction(agent, { depth: MAX_WORKFLOW_DEPTH }) },
		})
		const recorded = result.workflow.phase('a')?.task('t')?.result
		expect(recorded?.status).toBe('failed')
		const error = recorded?.result?.success === false ? recorded.result.error : undefined
		expect(isWorkflowError(error) ? error.code : undefined).toBe('DEPTH')
		expect(provider.started).toBe(0)
	})
})

// NOTE on coverage reallocation (deviation-free, reasoned): the OLD suite's "fresh agent per
// dispatch" (P2.5) and "throttle bounds many concurrent agent tasks" (P3.5) tests relied on a
// per-call `WorkflowAgents` RESOLVER the engine invoked freshly on EVERY dispatch — that registry
// was deleted with the redesign (a task's handler resolves ONCE at construction against
// `WorkflowOptions.functions`), so "a fresh agent per task" is now simply "register a distinct
// `createAgentFunction(agent)` per task id" — an authoring concern, not an engine behavior worth
// a dedicated engine-level test. The engine-level depth/cycle-guard exhaustive matrix (off-by-one,
// cycle-vs-depth context divergence, cross-boundary propagation through a bound workflow tool) now
// lives with the adapter it belongs to — `createAgentFunction` / `createWorkflowTool` coverage in
// `factories.test.ts` — rather than duplicated here against the pure engine.

describe('WorkflowRunner — execute(workflow) parity with execute(definition)', () => {
	it('drives the caller-owned entity with the same WorkflowResult semantics; status transitions are observable live and snapshot() mid-run shows running states', async () => {
		const gate = createGate()
		const started = createRecorder<readonly [string]>()
		const parked: WorkflowFunction = async (controller) => {
			started.handler(controller.task.id)
			await gate.promise
			return controller.task.id
		}
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'parked')] }])
		const workflow = createWorkflow(definition, { functions: { parked } })
		expect(workflow.status).toBe('pending')
		const running = pacedRunner().execute(workflow)
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
	it('throws TRANSITION synchronously on a second concurrent call to an already-running workflow', async () => {
		const gate = createGate()
		const parked: WorkflowFunction = async (controller) => {
			await gate.promise
			return controller.task.id
		}
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'parked')] }])
		const workflow = createWorkflow(definition, { functions: { parked } })
		const runner = pacedRunner()
		const running = runner.execute(workflow)
		await waitForDelay(30)
		expect(workflow.status).toBe('running')
		let caught: unknown
		try {
			runner.execute(workflow)
		} catch (error) {
			caught = error
		}
		expect(isWorkflowError(caught)).toBe(true)
		expect(isWorkflowError(caught) ? caught.code : undefined).toBe('TRANSITION')
		gate.resolve()
		await running
	})

	it('throws TRANSITION synchronously on an already-settled (completed) workflow', async () => {
		const f: WorkflowFunction = (controller) => controller.task.id
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'f')] }])
		const workflow = createWorkflow(definition, { functions: { f } })
		const runner = pacedRunner()
		await runner.execute(workflow)
		expect(workflow.status).toBe('completed')
		let caught: unknown
		try {
			runner.execute(workflow)
		} catch (error) {
			caught = error
		}
		expect(isWorkflowError(caught)).toBe(true)
		expect(isWorkflowError(caught) ? caught.code : undefined).toBe('TRANSITION')
	})

	it('throws TRANSITION synchronously on a destroyed workflow', () => {
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'f')] }])
		const workflow = createWorkflow(definition)
		workflow.destroy()
		expect(workflow.destroyed).toBe(true)
		const runner = pacedRunner()
		let caught: unknown
		try {
			runner.execute(workflow)
		} catch (error) {
			caught = error
		}
		expect(isWorkflowError(caught)).toBe(true)
		expect(isWorkflowError(caught) ? caught.code : undefined).toBe('TRANSITION')
	})
})

describe('WorkflowRunner — live task append during a running phase (mid-run mutation, resolves real handlers)', () => {
	it('LIVE TASK APPEND executes real work: the appended task runs, completes, and the phase/result reflect it', async () => {
		const gate = createGate()
		const started = createRecorder<readonly [string]>()
		const t0: WorkflowFunction = async (controller) => {
			started.handler(controller.task.id)
			await gate.promise
			return controller.task.id
		}
		const extraRan = createRecorder<readonly [string]>()
		const extra: WorkflowFunction = (controller) => {
			extraRan.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 't0')] }])
		const workflow = createWorkflow(definition, { functions: { t0, extra } })
		const running = pacedRunner().execute(workflow)
		await waitForDelay(30)
		expect(workflow.phase('a')?.status).toBe('running')
		const added = workflow.phase('a')?.add(functionTask('t1', 'extra'))
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

	it('an appended task naming an UNREGISTERED function auto-completes (the no-handler rule applies to live-appended tasks too)', async () => {
		const gate = createGate()
		const t0: WorkflowFunction = async (controller) => {
			await gate.promise
			return controller.task.id
		}
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 't0')] }])
		const workflow = createWorkflow(definition, { functions: { t0 } })
		const running = pacedRunner().execute(workflow)
		await waitForDelay(30)
		const added = workflow.phase('a')?.add(functionTask('t1', 'missing-handler'))
		if (added === undefined || !added.success) throw new Error('expected the append to succeed')
		expect(added.value.handler).toBeUndefined()
		gate.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		const recorded = workflow.phase('a')?.task('t1')?.result
		expect(recorded?.status).toBe('completed')
		expect(recorded?.result).toEqual({ success: true, value: undefined })
	})

	it('GRACEFUL REJECTION: appending to an already-COMPLETED phase fails MUTATION; the run continues to completion unaffected', async () => {
		const f: WorkflowFunction = (controller) => controller.task.id
		const gateB = createGate()
		const b: WorkflowFunction = async (controller) => {
			await gateB.promise
			return controller.task.id
		}
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'f')] },
			{ id: 'b', tasks: [functionTask('t1', 'b')] },
		])
		const workflow = createWorkflow(definition, { functions: { f, b } })
		const running = pacedRunner().execute(workflow)
		await waitForDelay(30)
		expect(workflow.phase('a')?.status).toBe('completed')
		const rejected = workflow.phase('a')?.add(functionTask('extra', 'f'))
		if (rejected === undefined || rejected.success) throw new Error('expected the append to fail')
		expect(rejected.error.code).toBe('MUTATION')
		gateB.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(workflow.phase('b')?.task('t1')?.status).toBe('completed')
	})

	it('LIVE PHASE APPEND: mid-run workflow.add mints a phase that runs in the same run; add after the workflow settles fails MUTATION', async () => {
		const gateA = createGate()
		const a: WorkflowFunction = async (controller) => {
			await gateA.promise
			return controller.task.id
		}
		const extraRan = createRecorder<readonly [string]>()
		const extra: WorkflowFunction = (controller) => {
			extraRan.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'a')] }])
		const workflow = createWorkflow(definition, { functions: { a, extra } })
		const running = pacedRunner().execute(workflow)
		await waitForDelay(30)
		const added = workflow.add({
			id: 'c',
			name: 'C',
			tasks: [{ id: 'tc', name: 'TC', run: 'extra' }],
		})
		if (!added.success) throw new Error('expected workflow.add to succeed')
		gateA.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(extraRan.count).toBe(1)
		expect(workflow.phase('c')?.task('tc')?.status).toBe('completed')
		const rejected = workflow.add({ id: 'd', name: 'D', tasks: [] })
		if (rejected.success) throw new Error('expected workflow.add to fail once settled')
		expect(rejected.error.code).toBe('MUTATION')
	})
})

describe('WorkflowRunner — pending-suffix mid-run mutation (add/remove/move/update honored while phase a runs)', () => {
	function threePhaseParkedDefinition(): WorkflowDefinition {
		return buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'a')] },
			{ id: 'b', tasks: [functionTask('t1', 'rec')] },
			{ id: 'c', tasks: [functionTask('t2', 'rec')] },
		])
	}

	it('insertion at index 0 fails MUTATION while phase a runs (before the pending-suffix boundary)', async () => {
		const gate = createGate()
		const a: WorkflowFunction = async (controller) => {
			await gate.promise
			return controller.task.id
		}
		const order: string[] = []
		const workflow = createWorkflow(threePhaseParkedDefinition(), {
			functions: { a, rec: recordingFunction(order) },
		})
		const running = pacedRunner().execute(workflow)
		await waitForDelay(30)
		const rejected = workflow.add({ id: 'z', name: 'Z', tasks: [] }, 0)
		if (rejected.success) throw new Error('expected the insert at index 0 to fail')
		expect(rejected.error.code).toBe('MUTATION')
		gate.resolve()
		await running
	})

	it('move of a pending phase mid-run is honored (its new order is observed by execution)', async () => {
		const gate = createGate()
		const a: WorkflowFunction = async (controller) => {
			await gate.promise
			return controller.task.id
		}
		const order: string[] = []
		const workflow = createWorkflow(threePhaseParkedDefinition(), {
			functions: { a, rec: recordingFunction(order) },
		})
		const running = pacedRunner().execute(workflow)
		await waitForDelay(30)
		const moved = workflow.move('c', 1)
		if (!moved.success) throw new Error('expected the move to succeed')
		gate.resolve()
		const result = await running
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t2', 't1'])
	})

	it('remove of a pending phase mid-run is honored (the removed phase never runs)', async () => {
		const gate = createGate()
		const a: WorkflowFunction = async (controller) => {
			await gate.promise
			return controller.task.id
		}
		const order: string[] = []
		const workflow = createWorkflow(threePhaseParkedDefinition(), {
			functions: { a, rec: recordingFunction(order) },
		})
		const running = pacedRunner().execute(workflow)
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
		const gate = createGate()
		const a: WorkflowFunction = async (controller) => {
			await gate.promise
			return controller.task.id
		}
		const order: string[] = []
		const workflow = createWorkflow(threePhaseParkedDefinition(), {
			functions: { a, rec: recordingFunction(order) },
		})
		const running = pacedRunner().execute(workflow)
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
		const t0: WorkflowFunction = (controller) => {
			started.handler(controller.task.id)
			return controller.task.id
		}
		const t1: WorkflowFunction = (controller) => {
			started.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([
			{ id: 'a', concurrency: 1, tasks: [functionTask('t0', 't0'), functionTask('t1', 't1')] },
		])
		const workflow = createWorkflow(definition, { functions: { t0, t1 } })
		workflow
			.phase('a')
			?.task('t0')
			?.emitter.on('complete', () => workflow.pause())
		const running = pacedRunner().execute(workflow)
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
		const a: WorkflowFunction = (controller) => {
			started.handler(controller.task.id)
			return controller.task.id
		}
		const b: WorkflowFunction = (controller) => {
			started.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'a')] },
			{ id: 'b', tasks: [functionTask('t1', 'b')] },
		])
		const workflow = createWorkflow(definition, { functions: { a, b } })
		workflow
			.phase('a')
			?.task('t0')
			?.emitter.on('complete', () => workflow.pause())
		const running = pacedRunner().execute(workflow)
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
		const fn: WorkflowFunction = (controller) => {
			started.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([
			{ id: 'a', concurrency: 1, tasks: [functionTask('t0', 'fn'), functionTask('t1', 'fn')] },
		])
		const workflow = createWorkflow(definition, { functions: { fn } })
		workflow
			.phase('a')
			?.task('t0')
			?.emitter.on('complete', () => workflow.phase('a')?.pause())
		const running = pacedRunner().execute(workflow)
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
		const gate = createGate()
		const t0: WorkflowFunction = async (controller) => {
			started.handler(controller.task.id)
			await gate.promise
			return controller.task.id
		}
		const extra: WorkflowFunction = (controller) => {
			started.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([
			{ id: 'a', concurrency: 1, tasks: [functionTask('t0', 't0')] },
		])
		const workflow = createWorkflow(definition, { functions: { t0, extra } })
		const running = pacedRunner().execute(workflow)
		await waitForDelay(30)
		expect(workflow.phase('a')?.status).toBe('running')
		workflow.pause()
		const added = workflow.phase('a')?.add(functionTask('t1', 'extra'))
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
		const gate = createGate()
		const t0: WorkflowFunction = async (controller) => {
			await gate.promise
			return controller.task.id
		}
		const t1: WorkflowFunction = (controller) => controller.task.id
		const definition = buildDefinition([
			{ id: 'a', concurrency: 1, tasks: [functionTask('t0', 't0'), functionTask('t1', 't1')] },
		])
		const workflow = createWorkflow(definition, { functions: { t0, t1 } })
		const running = pacedRunner().execute(workflow)
		await waitForDelay(30)
		workflow.stop()
		gate.resolve()
		const result = await running
		expect(result.status).toBe('stopped')
		expect(workflow.phase('a')?.task('t0')?.status).toBe('completed')
		expect(workflow.phase('a')?.task('t1')?.status).toBe('skipped')
	})
})

describe('WorkflowRunner — hard destroy mid-run', () => {
	it('workflow.destroy(): the in-flight task is aborted promptly, all nodes settle terminal, destroyed is idempotent', async () => {
		const aborted = createRecorder<readonly [string]>()
		const parked: WorkflowFunction = (controller: TaskControllerInterface) =>
			new Promise<string>((resolve) => {
				controller.signal.addEventListener(
					'abort',
					() => {
						aborted.handler(controller.task.id)
						resolve('aborted')
					},
					{ once: true },
				)
			})
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'parked')] }])
		const workflow = createWorkflow(definition, { functions: { parked } })
		const running = pacedRunner().execute(workflow)
		await waitForDelay(30)
		workflow.destroy()
		const result = await running
		expect([...aborted.calls].map((c) => c[0])).toEqual(['t0'])
		expect(result.status).toBe('stopped')
		expect(workflow.destroyed).toBe(true)
		expect(workflow.phase('a')?.task('t0')?.status).toBe('skipped')
		expect(() => workflow.destroy()).not.toThrow()
		expect(workflow.destroyed).toBe(true)
	})
})

describe('WorkflowRunner — a run-level timeout still settles a paused run', () => {
	it('TIMEOUT WHILE PAUSED: a paused, un-resumed run settles via the timeout raced against the paused gate', async () => {
		const started = createRecorder<readonly [string]>()
		const fn: WorkflowFunction = (controller) => {
			started.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'fn')] }])
		const workflow = createWorkflow(definition, { functions: { fn } })
		workflow.pause()
		const result = await pacedRunner().execute(workflow, { timeout: 20 })
		expect(result.status).toBe('stopped')
		expect(started.count).toBe(0)
		expect(workflow.phase('a')?.task('t0')?.status).toBe('skipped')
	})
})

describe('WorkflowRunner — stop / destroy settle a paused run promptly without resume', () => {
	it('workflow.stop() settles a paused run promptly', async () => {
		const started = createRecorder<readonly [string]>()
		const fn: WorkflowFunction = (controller) => {
			started.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'fn')] }])
		const workflow = createWorkflow(definition, { functions: { fn } })
		workflow.pause()
		const running = pacedRunner().execute(workflow)
		await waitForDelay(30)
		expect(started.count).toBe(0)
		workflow.stop()
		const result = await running
		expect(result.status).toBe('stopped')
		expect(started.count).toBe(0)
	})

	it('workflow.destroy() settles a paused run promptly', async () => {
		const started = createRecorder<readonly [string]>()
		const fn: WorkflowFunction = (controller) => {
			started.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'fn')] }])
		const workflow = createWorkflow(definition, { functions: { fn } })
		workflow.pause()
		const running = pacedRunner().execute(workflow)
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
		const gateA = createGate()
		const a: WorkflowFunction = async (controller) => {
			await gateA.promise
			return controller.task.id
		}
		const started = createRecorder<readonly [string]>()
		const gateMap = new Map<string, TestGateInterface<void>>([
			['t1', createGate()],
			['t2', createGate()],
		])
		const b: WorkflowFunction = async (controller) => {
			started.handler(controller.task.id)
			const taskGate = gateMap.get(controller.task.id)
			if (taskGate !== undefined) await taskGate.promise
			return controller.task.id
		}
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'a')] },
			{ id: 'b', concurrency: 1, tasks: [functionTask('t1', 'b'), functionTask('t2', 'b')] },
		])
		const workflow = createWorkflow(definition, { functions: { a, b } })
		const running = pacedRunner().execute(workflow)
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
		const gateA = createGate()
		const a: WorkflowFunction = async (controller) => {
			await gateA.promise
			return controller.task.id
		}
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const gateB = createGate()
		const parkedOk: WorkflowFunction = async (controller) => {
			await gateB.promise
			return controller.task.id
		}
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'a')] },
			{ id: 'b', bail: true, tasks: [functionTask('t1', 'fail'), functionTask('t2', 'parkedOk')] },
		])
		const workflow = createWorkflow(definition, { functions: { a, fail, parkedOk } })
		const running = pacedRunner().execute(workflow)
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
		const gate = createGate()
		const t0: WorkflowFunction = async (controller) => {
			await gate.promise
			return controller.task.id
		}
		const t1: WorkflowFunction = (controller) => controller.task.id
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 't0')] }])
		const workflow = createWorkflow(definition, { functions: { t0, t1 } })
		workflow.emitter.on('start', () => order.push('workflow:start'))
		workflow.emitter.on('complete', () => order.push('workflow:complete'))
		const phaseA = workflow.phase('a')
		phaseA?.emitter.on('start', () => order.push('phase:start'))
		phaseA?.emitter.on('complete', () => order.push('phase:complete'))
		phaseA?.emitter.on('add', (task) => order.push(`phase:add:${task.id}`))
		const task0 = phaseA?.task('t0')
		task0?.emitter.on('start', (id) => order.push(`task:${id}:start`))
		task0?.emitter.on('complete', () => order.push('task:t0:complete'))
		const running = pacedRunner().execute(workflow)
		await waitForDelay(30)
		const added = phaseA?.add(functionTask('t1', 't1'))
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
