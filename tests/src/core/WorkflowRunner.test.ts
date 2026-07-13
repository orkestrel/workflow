import type {
	AgentInterface,
	MessageInterface,
	ProviderDelta,
	ProviderInterface,
	ProviderResult,
} from '@orkestrel/agent'
import type {
	TaskControllerInterface,
	WorkflowAgents,
	WorkflowDefinition,
	WorkflowFunction,
	WorkflowRunnerInterface,
	WorkflowRunnerOptions,
} from '@src/core'
import { createAgent, createTool, createToolManager, ProviderAbortError } from '@orkestrel/agent'
import { createTokenBudget } from '@orkestrel/budget'
import {
	createSchedule,
	createWorkflowRunner,
	isWorkflowError,
	MAX_WORKFLOW_DEPTH,
	WORKFLOW_TOOL_NAME,
} from '@src/core'
import { describe, expect, it, vi } from 'vitest'
import type { TestGateInterface } from '../../../setup.js'
import {
	createGate,
	createRecorder,
	createRecordingSchedule,
	createScriptedProvider,
	waitForDelay,
} from '../../../setup.js'

// The W-c1 WorkflowRunner �€” the thin orchestrator that EXECUTES a live W-b tree by
// COMPOSING the shipped substrate (one Runner/Queue per phase, the bail policy mapped onto
// fail-fast vs settle-all, the abort/timeout/budget fold via AbortSignal.any, the schedule
// pacing). Real data stubs �€” scripted WorkflowFunction handlers + a real ToolManager, NO
// mocks (AGENTS §16). Determinism comes from gates (createGate), not wall-clock races.
//
// SINGLE SOURCE OF TRUTH: `execute(definition, options?)` BUILDS the live tree from the
// definition internally and returns it in `result.workflow` �€” so the live entity tree is read
// from `result.workflow` (after the run settles), never a separately-constructed workflow.
// Mid-flight observation is through the handler controllers (recorders + gates), not by
// peeking at the internal tree.

// A higher per-test timeout for the multi-phase `runner.execute` round-trip below (the P2.1
// compose-all run). The run is a GENUINELY real-async integration round-trip �€” a live W-b tree
// built + driven through the substrate `createRunner`/`Queue` (a cooperative wake-park loop awaiting
// real promises across many microtask turns), the per-task abort fold, the emitter cascade, plus a
// real scripted-agent `generate()` in its third phase. Pacing is already made deterministic by an
// injected `createRecordingSchedule` (no wall-clock `setTimeout`), but the chain itself cannot be
// made instantaneous without MOCKING the unit under test (forbidden, §16.2). Under
// full-`src:core`-project parallel load (~105 test files across the fork pool saturating every CPU),
// that real-async chain �€” sub-millisecond in isolation �€” can be event-loop-starved past vitest's 5s
// default and flake. A generous ceiling (6�— the default) absorbs worst-case starvation while still
// failing fast on a genuine hang (§16.3 �€” a measured setting with a current reason). Scoped to the
// the multi-phase tests; single-phase tests finish in microseconds regardless of the ceiling. Applied
// FILE-WIDE (below) because EVERY multi-phase execute round-trip — not just compose-all — shares the
// same parallel-load CPU-starvation risk; it is the residual flake after the deterministic-schedule
// (pacedRunner) fix removes the setTimeout macrotask-queue starvation. A real hang still fails at 30s.
const ROUND_TRIP_TIMEOUT_MS = 30_000
vi.setConfig({ testTimeout: ROUND_TRIP_TIMEOUT_MS })

// A workflow runner whose inter-phase pacing is DETERMINISTIC (AGENTS §16: clock seams, not
// wall-clock). The runner paces BETWEEN phases through its `schedule` seam; the shipped
// `createSchedule` default does so with a real `setTimeout(0)` macrotask, which under
// full-`src:core`-project parallel load (~105 test files saturating every CPU) can be
// event-loop-starved well past vitest's 5s default — so a MULTI-phase run flakes with an
// intermittent timeout (the failing phase varying run-to-run with scheduling luck). Injecting
// the project's `createRecordingSchedule` (its `yield` resolves immediately, honouring the run
// signal exactly like the shipped one but arming NO timer) removes that lone wall-clock
// dependency WITHOUT mocking the unit under test or weakening any assertion: phases stay
// sequential, tasks stay concurrent, every status / result is verified identically (it is the
// same seam the P2.1 compose-all test and `settleSnapshot` already use). A caller that must
// exercise the REAL shipped schedule passes its own `schedule` — the `??` preserves it (the
// dedicated pacing test does exactly that). For single-/zero-phase runs this is a no-op (`yield`
// is never called), so routing every test through it is uniform and safe.
function pacedRunner(options?: WorkflowRunnerOptions): WorkflowRunnerInterface {
	return createWorkflowRunner({
		...options,
		schedule: options?.schedule ?? createRecordingSchedule(),
	})
}

// �”€�”€ Local scenario builders (definitions + scripted handlers) �”€�”€�”€�”€�”€�”€�”€�”€�”€�”€�”€�”€�”€�”€�”€�”€

/** A function task on phase `phase`, task `id`, dispatched to the registered function `fn`. */
function functionTask(
	id: string,
	fn: string,
): WorkflowDefinition['phases'][number]['tasks'][number] {
	return { id, name: id, run: { via: 'function', name: fn } }
}

/** Build a definition from a compact phase spec �€” each phase its tasks + optional concurrency / bail. */
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
		run: { via: 'function', name: fn },
		...(reliability.retries === undefined ? {} : { retries: reliability.retries }),
		...(reliability.timeout === undefined ? {} : { timeout: reliability.timeout }),
	}
}

// A WorkflowFunction that PARKS on its own attempt signal and never resolves on its own �€” the only
// thing that releases it is its per-attempt deadline aborting the signal (the real gate the timeout
// path needs). On abort it resolves a sentinel so the attempt SETTLES (so the leaf decision runs);
// the resolved value is discarded by the runner as a timed-out attempt. NOT a mock �€” a real handler
// parking on a real AbortSignal it controls nothing of (AGENTS §16).
const parkUntilDeadline: WorkflowFunction = (controller: TaskControllerInterface) =>
	new Promise<string>((resolve) => {
		if (controller.signal.aborted) {
			resolve('timed-out')
			return
		}
		controller.signal.addEventListener('abort', () => resolve('timed-out'), { once: true })
	})

// �”€�”€ W-c2 agent-task helpers (real agents + scripted providers, NO mocks) �”€�”€�”€�”€�”€

/** A single-phase, single-task workflow whose lone task runs the `agent` form `name`. */
function agentDefinition(name: string): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', run: { via: 'agent', name } }] }],
	}
}

// A REAL `ProviderInterface` whose `stream` throws a non-abort error after a (no-op) leading yield
// �€” drives the agent's `generate()` to REJECT (a genuine provider failure, not a cancel), so the
// dispatched agent task `fail`s. A scenario-specific behaviour fixture (kept local per setup.ts's
// note). The leading empty yield is a reachable no-op (the agent emits no content for it); the
// throw on the next pull is what rejects the run.
function throwingProvider(): ProviderInterface {
	async function* stream(): AsyncGenerator<ProviderDelta, ProviderResult> {
		yield { type: 'content', text: '' }
		throw new Error('provider boom')
	}
	return {
		id: 'throwing',
		name: 'throwing',
		stream,
		async generate() {
			throw new Error('provider boom')
		},
	}
}

// A REAL `ProviderInterface` that PARKS until its `signal` aborts, recording the abort, then
// throws a `ProviderAbortError` (the live-provider cancel contract) so the agent commits a PARTIAL.
// Proves the agent's run SEES the folded workflow signal: `onAbort` fires only when the workflow
// cancel reaches the agent (via `agent.abort`) and folds into the provider call's signal. The
// leading empty yield is a reachable no-op; the park + throw on abort is the observed behaviour.
function parkedProvider(onAbort: () => void): ProviderInterface {
	async function* stream(
		_messages: readonly MessageInterface[],
		signal: AbortSignal,
	): AsyncGenerator<ProviderDelta, ProviderResult> {
		yield { type: 'content', text: '' }
		await new Promise<void>((resolve) => {
			if (signal.aborted) {
				resolve()
				return
			}
			signal.addEventListener('abort', () => resolve(), { once: true })
		})
		onAbort()
		throw new ProviderAbortError({ content: '' })
	}
	return {
		id: 'parked',
		name: 'parked',
		stream,
		async generate(messages, signal) {
			const generator = stream(messages, signal)
			let step = await generator.next()
			while (!step.done) step = await generator.next()
			return step.value
		},
	}
}

// A WorkflowAgents resolver that mints a FRESH agent per call (required �€” a phase's agent tasks
// resolve concurrently and the runner binds a workflow tool onto each agent's context). `make`
// builds the per-resolution provider/options; an unmatched name resolves to `undefined`.
function agentResolver(name: string, make: () => AgentInterface): WorkflowAgents {
	return (requested) => (requested === name ? make() : undefined)
}

// A shared in-flight tracker for the concurrent-agent edge cases (P2.5 / P3.5): a REAL
// `ProviderInterface` factory whose every `stream` call (one per dispatched agent) bumps a
// SHARED `inFlight` / `maxInFlight` pair on entry, parks on a per-call gate, then drops it on
// release. Because all agents share these counters, `maxInFlight` is the genuine cross-agent
// high-water mark a per-phase throttle must bound �€” the agent analogue of the function-throttle
// test's counter (NOT a mock; a real provider parking on a test-controlled gate, AGENTS §16).
interface ConcurrencyTrackerInterface {
	readonly maxInFlight: number
	readonly started: number
	readonly provider: () => ProviderInterface
	release(): void
}

function createAgentConcurrencyTracker(): ConcurrencyTrackerInterface {
	let inFlight = 0
	let maxInFlight = 0
	let started = 0
	const gates: TestGateInterface<void>[] = []
	return {
		get maxInFlight() {
			return maxInFlight
		},
		get started() {
			return started
		},
		release() {
			for (const gate of gates) gate.resolve()
		},
		provider() {
			async function* stream(): AsyncGenerator<ProviderDelta, ProviderResult> {
				started += 1
				inFlight += 1
				maxInFlight = Math.max(maxInFlight, inFlight)
				const gate = createGate()
				gates.push(gate)
				yield { type: 'content', text: '' } // a reachable no-op delta (the agent emits no content for it) �€” satisfies the generator
				await gate.promise
				inFlight -= 1
				return { content: 'done' }
			}
			return {
				id: 'tracked',
				name: 'tracked',
				stream,
				async generate() {
					const generator = stream()
					let step = await generator.next()
					while (!step.done) step = await generator.next()
					return step.value
				},
			}
		},
	}
}

describe('WorkflowRunner �€” phases sequential, tasks concurrent', () => {
	it('starts every task of a phase before any settles, and phase 2 only after phase 1 settles', async () => {
		// Phase a: t0/t1 both GATED �€” they start (recording their ids) but park until released,
		// proving overlap. Phase b: t2 records when it starts. Phase b must not start until a
		// settles, so t2's start order trails both a-tasks. The `starts` recorder is the
		// mid-flight witness (the internal tree is only readable from result.workflow at settle).
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
		const runner = pacedRunner({ functions: { a, b } })
		const running = runner.execute(definition)

		// Let the phase-a handlers run up to their gate. BOTH a-tasks have started (concurrent),
		// but t2 (phase b) has NOT �€” phase b hasn't begun (a stronger overlap proof than status).
		await waitForDelay()
		expect([...starts.calls].map((c) => c[0]).sort()).toEqual(['t0', 't1'])

		// Release phase a �†’ it settles �†’ phase b runs.
		gate.resolve()
		const result = await running
		expect([...starts.calls].map((c) => c[0])).toEqual(['t0', 't1', 't2'])
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('completed')
	})

	it('drives each task start �†’ complete and boxes the returned value as the result', async () => {
		const order: string[] = []
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'f'), functionTask('t1', 'f')] },
		])
		const runner = pacedRunner({ functions: { f: recordingFunction(order) } })
		const result = await runner.execute(definition)
		expect(result.status).toBe('completed')
		expect(order.sort()).toEqual(['t0', 't1'])
		// The returned value boxes into each leaf's Success result (read from result.workflow).
		const t0 = result.workflow.phase('a')?.task('t0')?.result
		expect(t0?.status).toBe('completed')
		expect(t0?.result).toEqual({ success: true, value: 't0' })
		// The workflow-tier result tree carries both.
		expect(result.results.map((r) => r.task.id).sort()).toEqual(['t0', 't1'])
	})
})

describe('WorkflowRunner �€” dispatch by name', () => {
	it('a tool task invokes the registered tool with the task input and completes', async () => {
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
			phases: [
				{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', run: { via: 'tool', name: 'scan' } }] },
			],
		}
		const result = await pacedRunner({ tools }).execute(definition)
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
			phases: [
				{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', run: { via: 'tool', name: 'boom' } }] },
			],
		}
		const result = await pacedRunner({ tools }).execute(definition)
		// bail:false �†’ the workflow completes, the failure recorded in the tree.
		expect(result.status).toBe('completed')
		const recorded = result.workflow.phase('a')?.task('t')?.result
		expect(recorded?.status).toBe('failed')
		expect(recorded?.result?.success).toBe(false)
	})

	it('a no-handler task auto-completes (an unregistered function name)', async () => {
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t', 'missing')] }])
		// No `functions` registered at all.
		const result = await pacedRunner().execute(definition)
		expect(result.status).toBe('completed')
		const recorded = result.workflow.phase('a')?.task('t')?.result
		expect(recorded?.status).toBe('completed')
		expect(recorded?.result).toEqual({ success: true, value: undefined })
	})

	it('an agent task with no `agents` resolver auto-completes via the no-handler path', async () => {
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [
				{
					id: 'a',
					name: 'A',
					tasks: [{ id: 't', name: 'T', run: { via: 'agent', name: 'auditor' } }],
				},
			],
		}
		// No `agents` resolver supplied �†’ the agent form is the no-handler case, exactly like an
		// unregistered function / tool.
		const result = await pacedRunner().execute(definition)
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t')?.status).toBe('completed')
	})

	it('an agent task whose name the resolver does not know auto-completes', async () => {
		const definition = agentDefinition('auditor')
		// A resolver present, but it returns `undefined` for this name �†’ no-handler auto-complete.
		const result = await pacedRunner({ agents: () => undefined }).execute(definition)
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t')?.status).toBe('completed')
	})
})

describe('WorkflowRunner �€” all three dispatch branches compose in one run (P2.1)', () => {
	it(
		'a function + a tool + an agent task across 3 phases all complete and each is recorded',
		async () => {
			// One workflow exercising EVERY dispatch branch in a single run: phase 1 a `function` task
			// (the WorkflowFunctions registry), phase 2 a `tool` task (a real ToolManager), phase 3 an
			// `agent` task (the WorkflowAgents resolver over a real scripted-provider agent). The whole
			// tree must complete AND the result tree must record each leaf's outcome �€” proving the three
			// branches compose, not just that each works alone.
			const tools = createToolManager()
			tools.add(createTool({ name: 'scan', execute: () => 'scanned' }))
			const agents = agentResolver('auditor', () =>
				createAgent(createScriptedProvider([{ content: 'audited' }])),
			)
			const fn: WorkflowFunction = (controller) => `built ${controller.task.id}`
			const definition: WorkflowDefinition = {
				id: 'wf',
				name: 'WF',
				phases: [
					{
						id: 'p1',
						name: 'P1',
						tasks: [{ id: 'fn', name: 'Fn', run: { via: 'function', name: 'f' } }],
					},
					{
						id: 'p2',
						name: 'P2',
						tasks: [{ id: 'tl', name: 'Tl', run: { via: 'tool', name: 'scan' } }],
					},
					{
						id: 'p3',
						name: 'P3',
						tasks: [{ id: 'ag', name: 'Ag', run: { via: 'agent', name: 'auditor' } }],
					},
				],
			}
			// Pace with an INJECTED `createRecordingSchedule` (the project's real `ScheduleInterface`
			// whose `yield` resolves immediately, honoring its signal exactly like the shipped one but
			// without arming a real timer) through the production `WorkflowRunnerOptions.schedule` seam �€”
			// NOT a mock of the runner (the unit under test composes all three branches in full). This is a
			// THREE-phase run, so the runner paces TWICE between phases, and the default `createSchedule`
			// would do so via real `setTimeout(0)` macrotasks �€” which, under full-`src:core`-project
			// parallel load, can be starved past the 5s default test timeout. Driving the clock makes this
			// compose-all round-trip deterministic (AGENTS §16) with identical assertions.
			const result = await pacedRunner({
				functions: { f: fn },
				tools,
				agents,
				schedule: createRecordingSchedule(),
			}).execute(definition)
			expect(result.status).toBe('completed')
			// Each branch reached `completed` on its own leaf.
			expect(result.workflow.phase('p1')?.task('fn')?.status).toBe('completed')
			expect(result.workflow.phase('p2')?.task('tl')?.status).toBe('completed')
			expect(result.workflow.phase('p3')?.task('ag')?.status).toBe('completed')
			// The result tree records ALL THREE, in positional (phase) order.
			expect(result.results.map((r) => r.task.id)).toEqual(['fn', 'tl', 'ag'])
			// And each boxed the form-appropriate value: the function's string, the tool's value, the
			// agent's AgentResult (narrowed through guards, §14 �€” no `as`).
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
		},
		ROUND_TRIP_TIMEOUT_MS,
	)
})

describe('WorkflowRunner �€” bail:false records a failure yet completes across phases (P2.2)', () => {
	it('a failing leaf in phase 1 + succeeding leaves in phases 1 and 2 �†’ completed, failure visible, later phases ran', async () => {
		// Phase 1 holds a FAILING leaf beside a SUCCEEDING one; phase 2 holds a succeeding leaf. Under
		// bail:false the failure is RECORDED as data, the workflow still reaches `completed`, AND the
		// later phase still runs �€” the graceful-mode contract end-to-end across a phase boundary.
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
		const result = await pacedRunner({ functions: { fail, ok } }).execute(definition)
		expect(result.status).toBe('completed')
		// The failure is visible in result.results as a genuine Failure (boxed error).
		const failure = result.results.find((r) => r.task.id === 't0')
		expect(failure?.status).toBe('failed')
		expect(failure?.result?.success).toBe(false)
		const error = failure?.result?.success === false ? failure.result.error : undefined
		expect(error).toBeInstanceOf(Error)
		// The succeeding phase-1 sibling and the LATER phase both completed (later phases still ran).
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('completed')
	})
})

describe('WorkflowRunner �€” per-phase throttle', () => {
	it('runs at most `concurrency` tasks in flight at once', async () => {
		// Four tasks, concurrency 2. A counter handler tracks the high-water mark of concurrent
		// in-flight handlers �€” it must never exceed 2. Each handler parks on a shared gate so the
		// first batch stays in flight; release in waves.
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
		const running = pacedRunner({ functions: { g: throttled } }).execute(definition)
		// Only 2 may be in flight; release them one at a time so a slot frees for the next.
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

describe('WorkflowRunner �€” an executed no-op tree settles completed (F1)', () => {
	it('a zero-phase definition settles completed (not pending)', async () => {
		// A childless tree derives `pending` (deriveWorkflowStatus([], bail) �†’ pending), but it WAS
		// executed and recorded no work �‡’ vacuously done. The runner force-completes it via the
		// entity's complete(), so the live tree / result / status all agree on `completed`.
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
		expect(result.workflow.phase('a')?.status).toBe('pending') // the phase itself derives pending
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
		// REGRESSION: a genuinely-completed run is already `completed`, not `pending`, so the
		// `=== pending` gate leaves it alone �€” no spurious re-emit or override.
		const order: string[] = []
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'f')] }])
		const result = await pacedRunner({
			functions: { f: recordingFunction(order) },
		}).execute(definition)
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t0'])
	})

	it('a bail:true failing run stays failed (the gate never masks a failure)', async () => {
		// REGRESSION: under bail:true a real failure derives `failed`, NOT `pending`, so #completable
		// returns false and the failure is preserved.
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'fail')] }], true)
		const result = await pacedRunner({ functions: { fail } }).execute(definition)
		expect(result.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
	})

	it('a cancelled empty-ish run settles stopped (the cancel path wins, never completed)', async () => {
		// REGRESSION: a run-level cancel force-`stop`s in the mutually-exclusive `if cancelled` branch,
		// so the `else if completable` can NEVER fire �€” a cancelled run is `stopped`, not `completed`,
		// even with empty / no-op phases. A pre-exhausted budget cancels at run entry (no task runs).
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
		// REGRESSION: an already-aborted external signal halts the run before any task �€” every task is
		// skipped and the workflow force-`stop`s in the `if cancelled` branch, so the mutually-exclusive
		// `else if completable` can never fire. The result is `stopped` (never `completed`), and no
		// handler ran. (A genuinely-derived `skipped` workflow is unreachable from a NATURAL execute
		// finish �€” the runner only force-skips tasks on the cancel/halt path, which always then
		// force-`stop`s �€” and the `=== pending` gate would leave such a `skipped` untouched regardless.)
		const controllerAbort = new AbortController()
		controllerAbort.abort(new Error('pre-cancelled'))
		const ran = createRecorder<readonly [string]>()
		const fn: WorkflowFunction = (controller) => {
			ran.handler(controller.task.id)
			return controller.task.id
		}
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'fn')] }])
		const result = await pacedRunner({ functions: { fn } }).execute(definition, {
			signal: controllerAbort.signal,
		})
		expect(ran.count).toBe(0)
		expect(result.status).toBe('stopped')
	})
})

describe('WorkflowRunner �€” non-positive phase concurrency is clamped (F2)', () => {
	it('a concurrency:0 phase runs every task and completes (clamped to the default)', async () => {
		// A hand-built definition (NOT validated by the contract, which enforces concurrency >= 1)
		// carries concurrency: 0. createRunner requires a positive integer (it floors at 1, which would
		// silently SERIALIZE), so the runner clamps a non-positive value to DEFAULT_PHASE_CONCURRENCY
		// ("run them all"). All tasks must still run and the workflow complete.
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
		const result = await pacedRunner({ functions: { fn } }).execute(definition)
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
		const result = await pacedRunner({ functions: { fn } }).execute(definition)
		expect(result.status).toBe('completed')
		expect([...ran.calls].map((c) => c[0]).sort()).toEqual(['t0', 't1', 't2'])
	})
})

describe('WorkflowRunner �€” bail:false records failures while finishing', () => {
	it('a phase with a failing + a succeeding task settles both; the workflow completes', async () => {
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const ok: WorkflowFunction = (controller) => controller.task.id
		const definition = buildDefinition(
			[{ id: 'a', tasks: [functionTask('t0', 'fail'), functionTask('t1', 'ok')] }],
			false,
		)
		const result = await pacedRunner({ functions: { fail, ok } }).execute(definition)
		// Both settle; the workflow reaches `completed` (graceful folds the failed phase).
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		// The failure is recorded in the result tree.
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
		const result = await pacedRunner({
			functions: { fail, rec: recordingFunction(order) },
		}).execute(definition)
		// Phase b still ran despite phase a's failure.
		expect(order).toEqual(['t1'])
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('completed')
	})
})

describe('WorkflowRunner �€” bail:true halts on the first failure', () => {
	it('the first failure aborts an in-flight sibling and skips the remaining phases', async () => {
		// Phase a: t0 fails IMMEDIATELY; t1 is mid-flight, parked on its OWN signal. The fail
		// fail-fasts �†’ the runner aborts t1's signal �†’ t1's park resolves �†’ t1 is SKIPPED. Phase b
		// never runs (skipped). The workflow ends `failed`.
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
		const result = await pacedRunner({ functions: { fail, sibling } }).execute(definition)
		expect(result.status).toBe('failed')
		// The mid-flight sibling received the abort signal.
		expect([...aborted.calls].map((c) => c[0])).toContain('t1')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('skipped')
		// Phase b was skipped entirely (never started).
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
		const result = await pacedRunner({
			functions: { fail, rec: recordingFunction(order) },
		}).execute(definition)
		expect(result.status).toBe('failed')
		// Phase b never ran.
		expect(order).toEqual([])
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('skipped')
	})
})

describe('WorkflowRunner �€” per-task retries / timeout (Seam A, threaded via the Runner)', () => {
	it('A1 divergent retries: a retried task recovers (3 runs) while a no-retry sibling fails (1 run)', async () => {
		// One phase, two tasks. t0 has retries:2 and fails its first two attempts then succeeds (3 runs);
		// t1 has retries:0 and always fails (1 run). bail:false, so both settle and the workflow finishes.
		// The per-task counts prove the divergence �€” the Runner threaded each task's own retries.
		const attempts = new Map<string, number>()
		const flaky: WorkflowFunction = (controller) => {
			const seen = (attempts.get(controller.task.id) ?? 0) + 1
			attempts.set(controller.task.id, seen)
			// t0 recovers on its 3rd attempt (retries:2); t1 always throws (retries:0).
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
		const result = await pacedRunner({ functions: { flaky } }).execute(definition)
		expect(result.status).toBe('completed') // graceful �€” both settle, the run finishes
		// t0 recovered on its retry (completed, ran 3�—); t1 exhausted its single attempt (failed, ran 1�—).
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('failed')
		expect(attempts.get('t0')).toBe(3)
		expect(attempts.get('t1')).toBe(1)
	})

	it('A2 per-task timeout FAILS the leaf (not skipped): a parked task that exhausts its deadline ends failed while a no-timeout sibling completes (bail:false records the failure)', async () => {
		// A per-task `timeout` is a RETRYABLE FAILURE of the attempt, NOT a skip. t0 carries timeout:20
		// with NO retries and parks past its deadline (its only release is the deadline aborting its
		// signal), so its single attempt times out �‡’ the leaf must end `failed` (visible to bail +
		// deriveWorkflowStatus), NOT `skipped`. t1 has no timeout and completes before t0's deadline.
		// Under bail:false the workflow folds the graceful failure into `completed` and the Failure is
		// PRESENT in the result tree �€” the load-bearing fix (timeout = fail, never skip).
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
		// The run settles in REAL time (no hang) �€” the parked task's own deadline bounded it.
		const result = await pacedRunner({
			functions: { parkUntilDeadline, quick },
		}).execute(definition)
		// THE FIX: the timed-out leaf is `failed` (a recorded fault), NEVER `skipped` (which would hide it).
		const t0 = result.workflow.phase('a')?.task('t0')
		expect(t0?.status).toBe('failed')
		expect(t0?.status).not.toBe('skipped')
		// The no-timeout sibling completed normally (it settled before t0's deadline).
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		// Under bail:false the workflow completes AND the failure is recorded in the result tree.
		expect(result.status).toBe('completed')
		const failure = result.results.find((r) => r.task.id === 't0')
		expect(failure?.status).toBe('failed')
		expect(failure?.result?.success).toBe(false)
	})

	it('A4 retries + timeout RECOVERS: attempt 1 exhausts the deadline, attempt 2 completes �†’ the leaf completes (ran 2�—) and the recovered value is recorded', async () => {
		// The blocker fix: with retries, a NON-final timed-out attempt must DRIVE the retry leaving the
		// leaf `running` (not skip it before attempt 2 runs). t0 carries timeout:20 and retries:1: its
		// FIRST attempt parks past the deadline (times out), its SECOND attempt returns immediately
		// (completes). The leaf must end `completed`, have run EXACTLY 2�—, and box the recovered value �€”
		// proving the recovered result is NOT discarded.
		const attempts = new Map<string, number>()
		const recoverAfterTimeout: WorkflowFunction = (controller) => {
			const seen = (attempts.get(controller.task.id) ?? 0) + 1
			attempts.set(controller.task.id, seen)
			// Attempt 1 parks until its deadline aborts the signal (times out); attempt 2 completes.
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
		const result = await pacedRunner({
			functions: { recoverAfterTimeout },
		}).execute(definition)
		// The leaf RECOVERED on its second attempt �€” completed, ran exactly twice, recovered value boxed.
		expect(result.status).toBe('completed')
		const t0 = result.workflow.phase('a')?.task('t0')
		expect(t0?.status).toBe('completed')
		expect(attempts.get('t0')).toBe(2)
		expect(t0?.result?.result).toEqual({ success: true, value: 'recovered t0' })
	})

	it('A3 omission regression: a task with neither field never retries on failure (today�€™s behavior)', async () => {
		// Guard that the Seam-A wiring did NOT shift defaults: a task declaring NEITHER retries nor
		// timeout behaves exactly as before �€” a single attempt, no retry on failure (the phase Runner's
		// default of 0 retries). It runs once and the leaf fails.
		const attempts = new Map<string, number>()
		const failOnce: WorkflowFunction = (controller) => {
			attempts.set(controller.task.id, (attempts.get(controller.task.id) ?? 0) + 1)
			throw new Error('boom')
		}
		const definition = buildDefinition(
			[{ id: 'a', tasks: [functionTask('t0', 'failOnce')] }],
			false,
		)
		const result = await pacedRunner({ functions: { failOnce } }).execute(definition)
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		// Exactly one attempt �€” no extra retry was introduced by the Seam-A change.
		expect(attempts.get('t0')).toBe(1)
	})
})

describe('WorkflowRunner �€” a per-task timeout is a FAILURE under bail, and the distinguisher preserves skip-on-fail-fast', () => {
	it('3a bail:true + timeout-only fault: the timed-out task FAILS, the workflow derives failed, and a later phase is skipped (halted)', async () => {
		// A per-task timeout under bail:true must be a genuine FAILURE that HALTS the run �€” NOT a skip
		// (a skip would be invisible to bail and the workflow would derive `skipped`, never `failed`).
		// Phase a's ONLY fault is t0 exhausting its per-attempt deadline (no thrown error anywhere);
		// phase b follows. The timed-out leaf ends `failed` �‡’ phase a is `failed` under bail:true �‡’ the
		// workflow derives `failed` and phase b is skipped (the run halted on the timeout).
		const quick: WorkflowFunction = (controller) => controller.task.id
		const definition = buildDefinition(
			[
				{ id: 'a', tasks: [reliableTask('t0', 'parkUntilDeadline', { timeout: 20, retries: 0 })] },
				{ id: 'b', tasks: [functionTask('t1', 'quick')] },
			],
			true, // bail:true �€” a single failure (a timeout counts) halts the workflow
		)
		const result = await pacedRunner({
			functions: { parkUntilDeadline, quick },
		}).execute(definition)
		// The timeout-only fault derived `failed` (NOT `skipped`) �€” the headline of 3a.
		expect(result.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		// The run halted on the timeout: the later phase never ran.
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('skipped')
	})

	it('sibling-fail-fast regression: under bail a thrown failure still SKIPS a parked sibling (the timeout distinguisher did NOT turn a fail-fast abort into a failure)', async () => {
		// The trap the timeout distinguisher must not spring: a SIBLING fail-fast abort (the unit `Abort`
		// firing when one task fails under bail) must STILL skip the parked sibling �€” it must NOT be
		// mistaken for a per-attempt timeout (which would `fail` it). t0 throws (no timeout); t1 is a
		// parked sibling with NO timeout, released only by the fail-fast abort. t1 must end `skipped`,
		// proving `#skipping` (controller.aborted) still catches a sibling-fail-fast abort.
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
			true, // bail:true �€” t0's failure fail-fasts, aborting the parked sibling t1
		)
		const result = await pacedRunner({ functions: { fail, sibling } }).execute(definition)
		expect(result.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		// The fail-fast abort SKIPPED the parked sibling (NOT failed it) �€” the distinguisher held.
		expect([...aborted.calls].map((c) => c[0])).toContain('t1')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('skipped')
	})
})

describe('WorkflowRunner �€” per-phase bail override (Seam B)', () => {
	// A function that parks on its OWN signal and resolves on abort �€” the mid-flight sibling a
	// fail-fast cancels (the same shape the bail:true halt test uses), recording the aborted ids.
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
		// Workflow bail:false; phase a is bail:true with a failing task + a parked sibling; phase b after.
		// The strict phase fail-fasts: the failing task �†’ failed, the mid-flight sibling �†’ skipped, AND
		// phase b is skipped (the run halts) �€” all under a graceful WORKFLOW default. result.status === 'failed'.
		const aborted = createRecorder<readonly [string]>()
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const definition = buildDefinition([
			{ id: 'a', bail: true, tasks: [functionTask('t0', 'fail'), functionTask('t1', 'sibling')] },
			{ id: 'b', tasks: [functionTask('t2', 'sibling')] },
		])
		const result = await pacedRunner({
			functions: { fail, sibling: parkingSibling(aborted) },
		}).execute(definition)
		// The strict phase a halted the run even though the WORKFLOW default is graceful (bail:false).
		expect(result.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		// The mid-flight sibling saw its signal abort (in-phase fail-fast) and was skipped.
		expect([...aborted.calls].map((c) => c[0])).toContain('t1')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('skipped')
		// Phase b never ran (the strict phase halted the workflow).
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('skipped')
		// The effective per-phase bail is exposed on the live tree.
		expect(result.workflow.phase('a')?.bail).toBe(true)
		expect(result.workflow.phase('b')?.bail).toBe(false)
	})

	it('B2 a graceful (bail:false) phase does NOT halt even under a strict (bail:true) workflow', async () => {
		// Workflow bail:true; phase a is bail:false with a failing + a succeeding task; phase b after.
		// The graceful phase a does NOT fail-fast (the sibling completes), the failure is recorded as
		// data, AND phase b still runs �€” the per-phase graceful override wins over the strict workflow.
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const ok: WorkflowFunction = (controller) => controller.task.id
		const definition = buildDefinition(
			[
				{ id: 'a', bail: false, tasks: [functionTask('t0', 'fail'), functionTask('t1', 'ok')] },
				{ id: 'b', tasks: [functionTask('t2', 'ok')] },
			],
			true, // the WORKFLOW default is strict�€�
		)
		const result = await pacedRunner({ functions: { fail, ok } }).execute(definition)
		// �€�but phase a's graceful override means it settles-all and the run continues to completion.
		expect(result.status).toBe('completed')
		// Phase a was NOT fail-fast �€” the sibling t1 completed (it was not aborted / skipped).
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('failed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		// Phase b RAN (the graceful phase did not halt the strict workflow).
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.bail).toBe(false)
		expect(result.workflow.phase('b')?.bail).toBe(true) // inherits the strict workflow default
	})

	it('B3 inheritance: a no-bail phase halts under a bail:true workflow and does NOT under bail:false', async () => {
		// The side-by-side pair pinning `effectiveBail = phase.bail ?? workflow.bail`. The SAME no-bail
		// phase (a failing task + a later phase b) behaves oppositely purely from the workflow default:
		// under bail:true it halts (b skipped, workflow failed); under bail:false it settles-all (b runs,
		// workflow completed).
		const makeDefinition = (workflowBail: boolean): WorkflowDefinition =>
			buildDefinition(
				[
					{ id: 'a', tasks: [functionTask('t0', 'fail')] }, // NO per-phase bail �€” inherits
					{ id: 'b', tasks: [functionTask('t1', 'ok')] },
				],
				workflowBail,
			)
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const ok: WorkflowFunction = (controller) => controller.task.id

		// Under a STRICT workflow: the inheriting phase halts �†’ b skipped, workflow failed.
		const strict = await pacedRunner({ functions: { fail, ok } }).execute(makeDefinition(true))
		expect(strict.status).toBe('failed')
		expect(strict.workflow.phase('a')?.bail).toBe(true) // inherited true
		expect(strict.workflow.phase('b')?.task('t1')?.status).toBe('skipped')

		// Under a GRACEFUL workflow: the SAME inheriting phase settles-all �†’ b runs, workflow completed.
		const graceful = await pacedRunner({ functions: { fail, ok } }).execute(makeDefinition(false))
		expect(graceful.status).toBe('completed')
		expect(graceful.workflow.phase('a')?.bail).toBe(false) // inherited false
		expect(graceful.workflow.phase('b')?.task('t1')?.status).toBe('completed')
	})
})

describe('WorkflowRunner �€” abort cascade', () => {
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
		const running = pacedRunner({ functions: { parked } }).execute(definition, {
			signal: controllerAbort.signal,
		})
		await waitForDelay()
		// Both phase-a tasks are in flight (parked, witnessed by the `started` recorder); abort mid-run.
		expect([...started.calls].map((c) => c[0]).sort()).toEqual(['t0', 't1'])
		controllerAbort.abort(new Error('cancelled'))
		const result = await running
		expect(result.status).toBe('stopped')
		// The in-flight tasks received the abort signal and were skipped (halted, not completed).
		expect([...aborted.calls].map((c) => c[0]).sort()).toEqual(['t0', 't1'])
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('skipped')
		// Phase b never ran.
		expect(result.workflow.phase('b')?.task('t2')?.status).toBe('skipped')
	})
})

describe('WorkflowRunner �€” budget / timeout fold', () => {
	it('a pre-exhausted budget halts the run (no task runs) and stops the workflow', async () => {
		const ran = createRecorder<readonly [string]>()
		const fn: WorkflowFunction = (controller) => {
			ran.handler(controller.task.id)
			return controller.task.id
		}
		// max:0 �†’ the budget is exhausted the moment it is `start()`ed (at run entry), so the run
		// is cancelled before any phase begins. A token budget (the runner's `WorkflowRunOptions.budget`
		// type) �€” its ceiling is reached from the first `start()`.
		const budget = createTokenBudget({ max: 0 })
		const definition = buildDefinition([{ id: 'a', tasks: [functionTask('t0', 'fn')] }])
		const result = await pacedRunner({ functions: { fn } }).execute(definition, {
			budget,
		})
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
		// A short real timeout �€” the parked task never resolves on its own, so the deadline fires.
		const result = await pacedRunner({ functions: { parked } }).execute(definition, {
			timeout: 20,
		})
		expect(result.status).toBe('stopped')
		expect([...aborted.calls].map((c) => c[0])).toEqual(['t0'])
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('skipped')
	})

	it('a non-positive timeout (0) arms NO deadline �€” the run completes normally', async () => {
		// `timeout: 0` must mean "no deadline" (the WorkflowRunOptions.timeout contract), NOT a
		// next-tick cancel. A real-completing handler settles normally under it.
		const order: string[] = []
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'f')] },
			{ id: 'b', tasks: [functionTask('t1', 'f')] },
		])
		const result = await pacedRunner({
			functions: { f: recordingFunction(order) },
		}).execute(definition, { timeout: 0 })
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t0', 't1'])
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('completed')
	})
})

describe('WorkflowRunner �€” construction options', () => {
	it('forwards the WorkflowOptions half (bail override + on listeners) to the built tree', async () => {
		// The definition is graceful (bail omitted �‡’ false); an `options.bail = true` override must
		// flip the BUILT tree to halt, AND the forwarded `on.fail` listener must fire �€” proving the
		// WorkflowOptions half reaches createWorkflow.
		const failures = createRecorder<readonly [string]>()
		const fail: WorkflowFunction = () => {
			throw new Error('boom')
		}
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'fail')] },
			{ id: 'b', tasks: [functionTask('t1', 'fail')] },
		])
		const result = await pacedRunner({ functions: { fail } }).execute(definition, {
			bail: true,
			on: { fail: (taskResult) => failures.handler(taskResult.task.id) },
		})
		// The override took effect: halt on the first failure, phase b skipped, workflow failed.
		expect(result.status).toBe('failed')
		expect(result.workflow.bail).toBe(true)
		expect(result.workflow.phase('b')?.task('t1')?.status).toBe('skipped')
		// The forwarded on.fail listener observed the failing task.
		expect([...failures.calls].map((c) => c[0])).toContain('t0')
	})
})

describe('WorkflowRunner �€” controller reads earlier results', () => {
	it('a phase-2 function can read phase-1 task results via controller.results()', async () => {
		const seen = createRecorder<readonly [number]>()
		const produce: WorkflowFunction = (controller) => controller.task.id
		const consume: WorkflowFunction = (controller) => {
			// By phase 2, phase-1 results are settled and visible.
			seen.handler(controller.results().length)
			return controller.task.id
		}
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'produce'), functionTask('t1', 'produce')] },
			{ id: 'b', tasks: [functionTask('t2', 'consume')] },
		])
		await pacedRunner({ functions: { produce, consume } }).execute(definition)
		// The consume task saw both phase-1 results.
		expect(seen.calls[0]?.[0]).toBe(2)
	})

	it('a phase-3 task reads an EARLIER phase-1 task�€™s recorded OUTCOME via controller.results() (P3.2)', async () => {
		// Up-lineage across 3+ phases: phase 1 produces a known value, phase 2 is an inert spacer, and
		// a phase-3 `function` reads the result tree and locates phase 1's recorded OUTCOME (status +
		// boxed value), proving the read reaches back PAST the intervening phase �€” not just the
		// immediately-prior one (and that it returns the earlier OUTCOME, not merely a count).
		const sawPhase1Value = createRecorder<readonly [unknown]>()
		const sawPhase1Status = createRecorder<readonly [string]>()
		const produce: WorkflowFunction = () => 'phase-1-output'
		const spacer: WorkflowFunction = (controller) => controller.task.id
		const reader: WorkflowFunction = (controller) => {
			// Find the EARLIEST phase's task (`p1`) in the up-lineage result tree and read its outcome.
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
				{
					id: 'a',
					name: 'A',
					tasks: [{ id: 'p1', name: 'P1', run: { via: 'function', name: 'produce' } }],
				},
				{
					id: 'b',
					name: 'B',
					tasks: [{ id: 'p2', name: 'P2', run: { via: 'function', name: 'spacer' } }],
				},
				{
					id: 'c',
					name: 'C',
					tasks: [{ id: 'p3', name: 'P3', run: { via: 'function', name: 'reader' } }],
				},
			],
		}
		const result = await pacedRunner({
			functions: { produce, spacer, reader },
		}).execute(definition)
		expect(result.status).toBe('completed')
		// The phase-3 reader saw phase 1's recorded outcome (its status AND its boxed value), reaching
		// back two phases through the result tree.
		expect(sawPhase1Status.calls[0]?.[0]).toBe('completed')
		expect(sawPhase1Value.calls[0]?.[0]).toBe('phase-1-output')
	})
})

describe('WorkflowRunner �€” pacing', () => {
	it('uses the shipped schedule by default and accepts a custom one without error', async () => {
		const order: string[] = []
		const definition = buildDefinition([
			{ id: 'a', tasks: [functionTask('t0', 'f')] },
			{ id: 'b', tasks: [functionTask('t1', 'f')] },
		])
		// An explicit schedule instance (the shipped cross-environment default) paces between phases.
		const result = await pacedRunner({
			functions: { f: recordingFunction(order) },
			schedule: createSchedule(),
		}).execute(definition)
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t0', 't1'])
	})
})

describe('WorkflowRunner �€” agent task dispatch (W-c2)', () => {
	it('runs a registered agent and boxes its result as the task value', async () => {
		// A REAL agent over a scripted provider �€” its single turn returns content `audited`, no tools,
		// so `generate()` resolves `{ content: 'audited', partial: false }`, boxed as the task value.
		const agents = agentResolver('auditor', () =>
			createAgent(createScriptedProvider([{ content: 'audited' }])),
		)
		const result = await pacedRunner({ agents }).execute(agentDefinition('auditor'))
		expect(result.status).toBe('completed')
		const recorded = result.workflow.phase('a')?.task('t')?.result
		expect(recorded?.status).toBe('completed')
		// The boxed Success value is the AgentResult �€” narrow it through guards (§14, no `as`).
		const value = recorded?.result?.success === true ? recorded.result.value : undefined
		const content =
			typeof value === 'object' && value !== null && 'content' in value ? value.content : undefined
		expect(content).toBe('audited')
	})

	it('fails the task when the agent throws (a genuine provider error)', async () => {
		const agents = agentResolver('auditor', () => createAgent(throwingProvider()))
		// bail:false (default) �†’ the failure is recorded and the workflow still completes.
		const result = await pacedRunner({ agents }).execute(agentDefinition('auditor'))
		expect(result.status).toBe('completed')
		const recorded = result.workflow.phase('a')?.task('t')?.result
		expect(recorded?.status).toBe('failed')
		expect(recorded?.result?.success).toBe(false)
	})

	it('a workflow cancel aborts the in-flight agent (the agent run sees the folded signal)', async () => {
		const sawAbort = createRecorder<readonly []>()
		const controllerAbort = new AbortController()
		const agents = agentResolver('auditor', () =>
			createAgent(parkedProvider(() => sawAbort.handler())),
		)
		const running = pacedRunner({ agents }).execute(agentDefinition('auditor'), {
			signal: controllerAbort.signal,
		})
		// The agent is parked inside its provider; cancel the whole workflow mid-flight.
		await waitForDelay()
		controllerAbort.abort(new Error('cancelled'))
		const result = await running
		// The provider's signal fired �€” the workflow cancel folded into the agent's run (the
		// load-bearing fact: the subagent SEES the folded signal) �€” the workflow settles `stopped`,
		// and the runner's cancel sweep leaves the halted agent task `skipped` (never a misleading
		// `completed`), deterministically in the returned tree.
		expect(sawAbort.count).toBe(1)
		expect(result.status).toBe('stopped')
		expect(result.workflow.phase('a')?.task('t')?.status).toBe('skipped')
	})
})

describe('WorkflowRunner �€” concurrent agent tasks resolve a FRESH agent each (P2.5)', () => {
	it('two agent tasks in one phase each get a fresh agent �€” the resolver is called once per task, no shared instance', async () => {
		// Two `agent` tasks in ONE phase run concurrently. The runner BINDS a depth/cycle-aware
		// workflow tool onto each resolved agent's `context.tools`, so a SHARED instance would receive
		// BOTH binds (its tool count would climb to 2) �€” cross-contamination. The resolver must mint a
		// FRESH agent per call: assert it was called exactly once per task (2 total) AND that each
		// distinct minted agent independently carries exactly its OWN one runner-bound tool (count 1) �€”
		// the bound tool lists are independent, proving no shared instance.
		const resolved = createRecorder<readonly [string]>()
		const agents: WorkflowAgents = (name) => {
			if (name !== 'auditor') return undefined
			resolved.handler(name)
			// A FRESH agent over a FRESH scripted provider per call (mirrors AgentRegistry.build).
			return createAgent(createScriptedProvider([{ content: 'audited' }]))
		}
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [
				{
					id: 'a',
					name: 'A',
					tasks: [
						{ id: 't0', name: 'T0', run: { via: 'agent', name: 'auditor' } },
						{ id: 't1', name: 'T1', run: { via: 'agent', name: 'auditor' } },
					],
				},
			],
		}
		const result = await pacedRunner({ agents }).execute(definition)
		// Both agent tasks completed�€�
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t0')?.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t1')?.status).toBe('completed')
		// �€�and the resolver was invoked exactly ONCE PER TASK (a fresh agent each), never reusing one.
		expect(resolved.count).toBe(2)
	})

	it('each freshly-resolved agent carries its OWN runner-bound workflow tool (independent tool lists, no cross-contamination)', async () => {
		// The structural proof of the fresh-resolve contract: capture every agent the resolver mints,
		// then after the run assert each one independently received exactly ONE tool �€” the runner-bound
		// workflow tool �€” under WORKFLOW_TOOL_NAME. A shared instance would show count 2 (both binds on
		// the same context); distinct agents each at count 1 is the no-contamination guarantee.
		const minted: AgentInterface[] = []
		const agents: WorkflowAgents = (name) => {
			if (name !== 'auditor') return undefined
			const agent = createAgent(createScriptedProvider([{ content: 'audited' }]))
			minted.push(agent)
			return agent
		}
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [
				{
					id: 'a',
					name: 'A',
					tasks: [
						{ id: 't0', name: 'T0', run: { via: 'agent', name: 'auditor' } },
						{ id: 't1', name: 'T1', run: { via: 'agent', name: 'auditor' } },
					],
				},
			],
		}
		await pacedRunner({ agents }).execute(definition)
		// Two DISTINCT agents were minted (fresh per task), and each independently holds exactly the one
		// runner-bound workflow tool �€” the bound lists never crossed.
		expect(minted).toHaveLength(2)
		expect(minted[0]).not.toBe(minted[1])
		for (const agent of minted) {
			expect(agent.context.tools.count).toBe(1)
			expect(agent.context.tools.tool(WORKFLOW_TOOL_NAME)).toBeDefined()
		}
	})
})

describe('WorkflowRunner �€” per-phase throttle bounds many concurrent AGENT tasks (P3.5)', () => {
	it('a phase of many agent tasks at concurrency 2 never exceeds 2 in flight, each freshly resolved', async () => {
		// The agent analogue of the function-throttle test: a phase with FIVE `agent` tasks and
		// concurrency 2. A SHARED in-flight tracker (across all agents' provider calls) must never read
		// above 2, AND the resolver must be called once per task (a fresh agent each). Release the gates
		// in waves so each freed slot admits the next, proving the bound holds throughout the drain.
		const tracker = createAgentConcurrencyTracker()
		const resolved = createRecorder<readonly [string]>()
		const agents: WorkflowAgents = (name) => {
			if (name !== 'worker') return undefined
			resolved.handler(name)
			return createAgent(tracker.provider())
		}
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [
				{
					id: 'a',
					name: 'A',
					concurrency: 2,
					tasks: Array.from({ length: 5 }, (_unused, index) => ({
						id: `t${index}`,
						name: `T${index}`,
						run: { via: 'agent' as const, name: 'worker' },
					})),
				},
			],
		}
		const running = pacedRunner({ agents }).execute(definition)
		// Let the first wave reach the gate �€” only 2 may be in flight.
		await waitForDelay()
		expect(tracker.maxInFlight).toBe(2)
		// Drain in waves: each release frees a slot for the next, never lifting the in-flight count > 2.
		for (let wave = 0; wave < 5; wave += 1) {
			tracker.release()
			await waitForDelay()
		}
		const result = await running
		expect(result.status).toBe('completed')
		// The high-water mark never exceeded the throttle�€�
		expect(tracker.maxInFlight).toBe(2)
		// �€�all five agent providers ran (every task dispatched its agent)�€�
		expect(tracker.started).toBe(5)
		// �€�and each was a FRESH resolve (once per task, no shared instance under the throttle).
		expect(resolved.count).toBe(5)
		for (const task of result.workflow.phase('a')?.tasks.tasks() ?? []) {
			expect(task.status).toBe('completed')
		}
	})
})

describe('WorkflowRunner �€” depth + cycle guard (W-c2)', () => {
	// Read the typed error code a failed task recorded (the boxed Failure's `error`), through a guard.
	function failureCode(error: unknown): string | undefined {
		return isWorkflowError(error) ? error.code : undefined
	}

	it('rejects an over-deep agent task into a typed DEPTH failure (and never runs the agent)', async () => {
		const provider = createScriptedProvider([{ content: 'audited' }])
		const agents = agentResolver('auditor', () => createAgent(provider))
		// Run AT the ceiling: dispatching the agent would run a nested workflow at depth+1 > MAX, so
		// the guard rejects the task before the agent runs. Driving `execute` at `depth: MAX` is the
		// boundary of a chain that climbed to MAX_WORKFLOW_DEPTH.
		const result = await pacedRunner({ agents }).execute(agentDefinition('auditor'), {
			depth: MAX_WORKFLOW_DEPTH,
		})
		const recorded = result.workflow.phase('a')?.task('t')?.result
		expect(recorded?.status).toBe('failed')
		const error = recorded?.result?.success === false ? recorded.result.error : undefined
		expect(failureCode(error)).toBe('DEPTH')
		// The agent NEVER ran �€” the guard rejected before dispatch (no provider call).
		expect(provider.started).toBe(0)
	})

	it('rejects re-entering an agent already in the ancestry (a cycle) into a typed DEPTH failure', async () => {
		const provider = createScriptedProvider([{ content: 'audited' }])
		const agents = agentResolver('auditor', () => createAgent(provider))
		// `agent:auditor` is already an ancestor �†’ dispatching it again is a re-entry cycle.
		const result = await pacedRunner({ agents }).execute(agentDefinition('auditor'), {
			ancestry: ['agent:auditor'],
		})
		const recorded = result.workflow.phase('a')?.task('t')?.result
		expect(recorded?.status).toBe('failed')
		const error = recorded?.result?.success === false ? recorded.result.error : undefined
		expect(failureCode(error)).toBe('DEPTH')
		expect(provider.started).toBe(0)
	})

	it('propagates depth across execute �†’ agent �†’ workflow tool �†’ nested execute (one level, lands at the boundary)', async () => {
		// PROPAGATION across the agent�†”tool boundary, observed at the depth boundary with ONE nested
		// level (deep self-referential nesting of REAL agents is too heavy for the deterministic
		// harness). Run the TOP workflow at depth MAX-1: its `caller` agent (allowed, since
		// (MAX-1)+1 = MAX is not > MAX) calls its runner-BOUND workflow tool authoring an inner
		// workflow. The tool �€” closed over depth MAX-1 �€” runs that inner workflow at depth MAX (the +1
		// increment). The inner workflow has a `function` task (a witness it RAN) and an `inner` agent
		// task: at depth MAX the agent guard rejects `inner` (MAX+1 > MAX) BEFORE it runs. So:
		//  �€� `caller` ran (its provider started), and
		//  �€� the inner `function` ran (the nested workflow executed), but
		//  �€� `inner` NEVER ran (`innerProvider.started === 0`) �€” which can ONLY happen if the nested
		//    workflow ran at depth MAX, i.e. the depth propagated MAX-1 �†’ MAX across the boundary
		//    (were propagation broken and the nested ran at depth 0, `inner` would run).
		const innerRan = createRecorder<readonly []>()
		const innerProvider = createScriptedProvider([{ content: 'inner' }])
		const callerProvider = createScriptedProvider([
			{
				content: '',
				tools: [
					{
						id: 'c',
						name: WORKFLOW_TOOL_NAME,
						arguments: {
							id: 'inner-wf',
							name: 'Inner',
							bail: true,
							phases: [
								{
									id: 'p',
									name: 'P',
									tasks: [
										{ id: 'mark', name: 'Mark', run: { via: 'function', name: 'mark' } },
										{ id: 'sub', name: 'Sub', run: { via: 'agent', name: 'inner' } },
									],
								},
							],
						},
					},
				],
			},
			{ content: 'done' },
		])
		const agents: WorkflowAgents = (name) => {
			if (name === 'caller') return createAgent(callerProvider)
			if (name === 'inner') return createAgent(innerProvider)
			return undefined
		}
		const result = await pacedRunner({
			agents,
			functions: { mark: () => innerRan.handler() },
		}).execute(agentDefinition('caller'), { depth: MAX_WORKFLOW_DEPTH - 1 })
		expect(result.status).toBe('completed')
		// `caller` ran at depth MAX-1; the nested workflow's `function` task ran at depth MAX (the
		// tool incremented the depth); but the inner AGENT was depth-rejected at MAX and never ran.
		expect(callerProvider.started).toBeGreaterThanOrEqual(1)
		expect(innerRan.count).toBe(1)
		expect(innerProvider.started).toBe(0)
	})

	it('the depth boundary is EXACTLY at MAX (off-by-one), side by side: MAX-1 runs, MAX is rejected (P2.6)', async () => {
		// The off-by-one boundary, proven side by side at the runner's OWN agent-task guard (no nested
		// tool needed �€” the guard fires on `depth + 1 > MAX`):
		//  �€� at `depth: MAX-1`, dispatching the agent would nest at MAX (not > MAX) �‡’ it RUNS and
		//    completes (the just-under-MAX agent DID run �€” its provider started);
		//  �€� at `depth: MAX`, dispatching would nest at MAX+1 (> MAX) �‡’ it is depth-REJECTED with a
		//    typed DEPTH failure BEFORE running, so its subagent never started.
		// Same agent, same definition, only the depth differs �€” pinning the boundary to exactly MAX.
		const underProvider = createScriptedProvider([{ content: 'audited' }])
		const under = await pacedRunner({
			agents: agentResolver('auditor', () => createAgent(underProvider)),
		}).execute(agentDefinition('auditor'), { depth: MAX_WORKFLOW_DEPTH - 1 })
		// Just under the ceiling: the agent RAN to completion (its provider started �‰� 1).
		expect(under.status).toBe('completed')
		expect(under.workflow.phase('a')?.task('t')?.status).toBe('completed')
		expect(underProvider.started).toBeGreaterThanOrEqual(1)

		const atProvider = createScriptedProvider([{ content: 'audited' }])
		const at = await pacedRunner({
			agents: agentResolver('auditor', () => createAgent(atProvider)),
		}).execute(agentDefinition('auditor'), { depth: MAX_WORKFLOW_DEPTH })
		// At the ceiling: the agent task is rejected with a DEPTH failure and never ran.
		const recorded = at.workflow.phase('a')?.task('t')?.result
		expect(recorded?.status).toBe('failed')
		const error = recorded?.result?.success === false ? recorded.result.error : undefined
		expect(failureCode(error)).toBe('DEPTH')
		expect(atProvider.started).toBe(0)
	})

	it('a cycle and an over-depth rejection share code DEPTH but carry DISTINCT context + messages (P2.7)', async () => {
		// Both guards reject with `code === 'DEPTH'`, but they are DIFFERENT faults and must be
		// distinguishable from the error metadata alone (not just the shared code):
		//  �€� over-depth �†’ context names the offending agent + the depth + the max ({ agent, depth, max }),
		//    message mentions exceeding max depth;
		//  �€� cycle      �†’ context names the offending agent + the ancestry ({ agent, ancestry }) and
		//    carries NO depth/max, message mentions a cycle.
		// Capture BOTH typed errors from real runner dispatches and assert the metadata diverges.
		const depthResult = await pacedRunner({
			agents: agentResolver('auditor', () =>
				createAgent(createScriptedProvider([{ content: 'x' }])),
			),
		}).execute(agentDefinition('auditor'), { depth: MAX_WORKFLOW_DEPTH })
		const cycleResult = await pacedRunner({
			agents: agentResolver('auditor', () =>
				createAgent(createScriptedProvider([{ content: 'x' }])),
			),
		}).execute(agentDefinition('auditor'), { ancestry: ['agent:auditor'] })

		const depthError = depthResult.workflow.phase('a')?.task('t')?.result
		const cycleError = cycleResult.workflow.phase('a')?.task('t')?.result
		const depthBoxed = depthError?.result?.success === false ? depthError.result.error : undefined
		const cycleBoxed = cycleError?.result?.success === false ? cycleError.result.error : undefined
		if (!isWorkflowError(depthBoxed) || !isWorkflowError(cycleBoxed)) {
			throw new Error('expected both leaves to box a typed WorkflowError')
		}
		// Same code�€�
		expect(depthBoxed.code).toBe('DEPTH')
		expect(cycleBoxed.code).toBe('DEPTH')
		// �€�but DISTINCT context shapes: depth carries depth + max (and no ancestry); cycle carries
		// ancestry (and no depth/max). Both name the offending agent.
		expect(depthBoxed.context?.agent).toBe('auditor')
		expect(depthBoxed.context?.depth).toBe(MAX_WORKFLOW_DEPTH)
		expect(depthBoxed.context?.max).toBe(MAX_WORKFLOW_DEPTH)
		expect('ancestry' in (depthBoxed.context ?? {})).toBe(false)
		expect(cycleBoxed.context?.agent).toBe('auditor')
		// The cycle context carries the ancestry that triggered it �€” `agent:auditor` (the re-entered
		// agent) is present (alongside the run's own `workflow:wf` tag the runner appends at entry).
		const cycleAncestry = cycleBoxed.context?.ancestry
		expect(Array.isArray(cycleAncestry) ? cycleAncestry : []).toContain('agent:auditor')
		expect('depth' in (cycleBoxed.context ?? {})).toBe(false)
		expect('max' in (cycleBoxed.context ?? {})).toBe(false)
		// �€�and DISTINCT messages (not the same string behind one code).
		expect(depthBoxed.message).toContain('max workflow depth')
		expect(cycleBoxed.message).toContain('cycle')
		expect(depthBoxed.message).not.toBe(cycleBoxed.message)
	})
})
