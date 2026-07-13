import type { ToolResult } from '@orkestrel/agent'
import type { WorkflowDefinition, WorkflowDraft } from '@src/core'
import { buildToolResult, createToolManager } from '@orkestrel/agent'
import { isRecord } from '@orkestrel/contract'
import {
	assertSnapshot,
	createSchedule,
	createWorkflow,
	createWorkflowContract,
	createWorkflowDraftContract,
	createWorkflowRunner,
	createWorkflowTool,
	expandSteps,
	isWorkflowError,
	MAX_WORKFLOW_DEPTH,
	restoreWorkflow,
	WORKFLOW_TOOL_FLAT_EXAMPLE,
	WORKFLOW_TOOL_NESTED_EXAMPLE,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	buildWorkflowDefinition,
	captureError,
	createRecordingSchedule,
	waitForDelay,
} from '../../../setup.js'

// A workflow runner paced by an INJECTED `createRecordingSchedule` — the project's real
// `ScheduleInterface` whose `yield` resolves immediately (honouring an abort signal exactly like
// the shipped one, just without arming a real timer), threaded through the production
// `WorkflowRunnerOptions.schedule` seam (NOT a mock of the runner — the unit under test runs in
// full). The runner paces BETWEEN phases, and the default `createSchedule` does so via a real
// `setTimeout(0)` macrotask; for a multi-phase run (an ids-omitted / flat blob expands to two-or-
// more one-task phases) that wall-clock yield is a genuine starvation point under load, so driving
// the clock removes it (AGENTS §16 deterministic) — a behaviour-identical no-op for the single-phase
// cases (they never reach an inter-phase yield). The schedule is NOT the whole story: each
// `tool.execute` still drives a real-async round-trip through the substrate `createRunner`/`Queue`
// (a cooperative wake-park loop over real promises) that the workflow-run tests pair with a higher
// per-test timeout ({@link ROUND_TRIP_TIMEOUT_MS}) so event-loop starvation under full parallel
// load can't flake them.
function runner(): ReturnType<typeof createWorkflowRunner> {
	return createWorkflowRunner({ schedule: createRecordingSchedule() })
}

// A higher per-test timeout for the `tool.execute` workflow-run tests below. Running an authored
// blob is a GENUINELY real-async integration round-trip — the tool parses + validates the args,
// then `runner.execute` builds a live W-b tree and drives it through the substrate
// `createRunner`/`Queue` (a cooperative wake-park loop awaiting real promises across many microtask
// turns), the per-task abort fold, and the emitter cascade. That chain cannot be made instantaneous
// without MOCKING the unit under test (forbidden, §16.2); pacing is already deterministic (the
// injected `runner()` schedule, no wall-clock `setTimeout`). Under full-`src:core`-project parallel
// load (~105 test files across the fork pool saturating every CPU) the round-trip — sub-millisecond
// in isolation — can be event-loop-starved past vitest's 5s default and flake. A generous ceiling
// (6× the default) absorbs worst-case starvation while still failing fast on a genuine hang (§16.3 —
// a measured setting with a current reason).
const ROUND_TRIP_TIMEOUT_MS = 30_000

// A one-task `function` workflow definition (its function unregistered, so the lone task
// auto-completes ⇒ a `completed` run) — the simplest definition a `createWorkflowTool` can run.
function simpleDefinition(id = 'nested'): WorkflowDefinition {
	return {
		id,
		name: id,
		phases: [
			{
				id: 'p',
				name: 'P',
				tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'noop' } }],
			},
		],
	}
}

// Narrow the workflow-tool handler's DIRECT `execute` return (typed `unknown`) to the plain run
// summary through guards (§14, NO `as`): a record whose `status` is a string + `count` a number.
// `undefined` when the shape is off (so a non-summary return / a thrown failure reads as absent).
// The handler now conforms to the universal tool-handler contract — it returns this PLAIN value
// (no `{ id, name, value }` envelope; that wrap is the ToolManager's, proven below), and THROWS on
// failure (asserted via `captureError`).
function readSummary(value: unknown): { status: string; count: number } | undefined {
	if (!isRecord(value) || typeof value.status !== 'string' || typeof value.count !== 'number') {
		return undefined
	}
	return { status: value.status, count: value.count }
}

// Run a workflow tool through a REAL ToolManager — the single canonical wrap (`#run`). Returns the
// resulting {@link ToolResult}, so a test can assert it is SINGLE-LEVEL (success → `value` is the
// plain summary, NOT a nested `{ id, name, value }`; failure → a top-level `error`, no `value`).
function executeThroughManager(tool: ReturnType<typeof createWorkflowTool>): Promise<ToolResult> {
	const manager = createToolManager()
	manager.add(tool)
	return manager.execute({
		id: 'call-1',
		name: tool.name,
		arguments: { ...simpleDefinition('via-mgr') },
	})
}

// The async counterpart of `captureError` (which is synchronous-only): await `promise` and return
// the value it REJECTED with, or `undefined` if it resolved — so a throw-site test can assert on the
// captured fault's `code` / `context` unconditionally (the workflow-tool handler's `execute` is async,
// so its §14 failure throw surfaces as a rejection). File-local: capturing a rejection's value (not
// just matching it via `.rejects`) is this file's throw-shape need.
async function rejectionOf(promise: Promise<unknown> | unknown): Promise<unknown> {
	try {
		await promise
		return undefined
	} catch (error) {
		return error
	}
}

// The contract's anti-drift spine: the four-way parity (schema + guard + parser +
// generator). The round-trip `generate → is → parse` must agree, `is` / `parse`
// must accept a valid hand-written `WorkflowDefinition`, and reject malformed input
// into a typed failure (a `false` guard / an `undefined` parse). Real data stubs
// with overrides — no mocks (AGENTS §16). The `buildWorkflowDefinition` stub the
// contract + W-b entity tests share lives in `tests/setup.ts` (AGENTS §16.1).

describe('createWorkflowContract — surface', () => {
	const contract = createWorkflowContract()

	it('exposes a JSON Schema for an object with the definition properties', () => {
		expect(contract.schema.type).toBe('object')
		expect(contract.schema.properties).toBeDefined()
		expect(Object.keys(contract.schema.properties ?? {})).toEqual(
			expect.arrayContaining(['id', 'name', 'phases', 'bail']),
		)
	})
})

describe('createWorkflowContract — accepts valid definitions', () => {
	const contract = createWorkflowContract()

	it('is() accepts a full valid definition', () => {
		expect(contract.is(buildWorkflowDefinition())).toBe(true)
	})

	it('is() accepts a minimal definition (optionals omitted)', () => {
		const minimal: WorkflowDefinition = {
			id: 'wf-min',
			name: 'Minimal',
			phases: [
				{
					id: 'p',
					name: 'P',
					tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'f' } }],
				},
			],
		}
		expect(contract.is(minimal)).toBe(true)
	})

	it('is() accepts an empty-phase and empty-task workflow', () => {
		expect(contract.is(buildWorkflowDefinition({ phases: [] }))).toBe(true)
		expect(
			contract.is(
				buildWorkflowDefinition({
					phases: [{ id: 'p', name: 'P', tasks: [] }],
				}),
			),
		).toBe(true)
	})

	it('is() accepts every task-form variant', () => {
		for (const via of ['function', 'tool', 'agent'] as const) {
			const definition = buildWorkflowDefinition({
				phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', run: { via, name: 'x' } }] }],
			})
			expect(contract.is(definition)).toBe(true)
		}
	})

	it('parse() returns the value unchanged for a valid definition', () => {
		const definition = buildWorkflowDefinition()
		expect(contract.parse(definition)).toEqual(definition)
	})
})

describe('createWorkflowContract — rejects malformed input', () => {
	const contract = createWorkflowContract()

	const malformed: ReadonlyArray<readonly [string, unknown]> = [
		['not an object', 42],
		['null', null],
		['missing id', { name: 'X', phases: [] }],
		['empty id (min 1)', { id: '', name: 'X', phases: [] }],
		['missing phases', { id: 'w', name: 'X' }],
		['phases not an array', { id: 'w', name: 'X', phases: 'nope' }],
		['bail is not a boolean', { id: 'w', name: 'X', phases: [], bail: 'true' }],
		[
			'unknown task-form via',
			{
				id: 'w',
				name: 'X',
				phases: [
					{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', run: { via: 'http', name: 'x' } }] },
				],
			},
		],
		[
			'task-form missing name',
			{
				id: 'w',
				name: 'X',
				phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', run: { via: 'function' } }] }],
			},
		],
		[
			'concurrency below 1',
			{
				id: 'w',
				name: 'X',
				phases: [{ id: 'p', name: 'P', tasks: [], concurrency: 0 }],
			},
		],
		[
			'concurrency not an integer',
			{
				id: 'w',
				name: 'X',
				phases: [{ id: 'p', name: 'P', tasks: [], concurrency: 1.5 }],
			},
		],
	]

	for (const [label, value] of malformed) {
		it(`is() rejects ${label}`, () => {
			expect(contract.is(value)).toBe(false)
		})
		it(`parse() returns undefined for ${label}`, () => {
			expect(contract.parse(value)).toBeUndefined()
		})
	}
})

describe('createWorkflowContract — generate / round-trip parity', () => {
	const contract = createWorkflowContract()

	it('generate() produces a value its own guard accepts', () => {
		const generated = contract.generate()
		expect(contract.is(generated)).toBe(true)
	})

	it('generate() output round-trips through parse unchanged', () => {
		const generated = contract.generate()
		expect(contract.parse(generated)).toEqual(generated)
	})

	it('generate() is deterministic for a fixed seed', () => {
		const seed = () => 0.42
		expect(contract.generate(seed)).toEqual(contract.generate(seed))
	})

	it('a guard-valid input is never rejected by the parser (soundness)', () => {
		const definition = buildWorkflowDefinition()
		expect(contract.is(definition)).toBe(true)
		expect(contract.parse(definition)).toEqual(definition)
	})
})

describe('createWorkflow — builds the live tree (the W-b factory)', () => {
	it('brings the definition to life with lineage + the definition bail', () => {
		const workflow = createWorkflow(buildWorkflowDefinition())
		expect(workflow.id).toBe('wf-1')
		expect(workflow.bail).toBe(false)
		expect(workflow.phases.phases().map((phase) => phase.id)).toEqual([
			'phase-build',
			'phase-review',
		])
		expect(
			workflow
				.phase('phase-build')
				?.tasks.tasks()
				.map((task) => task.id),
		).toEqual(['task-compile', 'task-scan'])
		expect(workflow.status).toBe('pending')
	})

	it('resolves bail from options, then the definition, then the graceful default', () => {
		expect(createWorkflow(buildWorkflowDefinition({ bail: true })).bail).toBe(true)
		expect(createWorkflow(buildWorkflowDefinition({ bail: true }), { bail: false }).bail).toBe(
			false,
		)
		const noBail: WorkflowDefinition = { id: 'w', name: 'W', phases: [] }
		expect(createWorkflow(noBail).bail).toBe(false)
	})
})

describe('restoreWorkflow / assertSnapshot — the round-trip inverse', () => {
	it('restoreWorkflow rebuilds an equivalent tree from a snapshot', () => {
		const workflow = createWorkflow(buildWorkflowDefinition({ bail: true }))
		const compile = workflow.phase('phase-build')?.task('task-compile')
		compile?.start()
		compile?.complete('built')
		const restored = restoreWorkflow(workflow.snapshot(), { bail: true })
		expect(restored.snapshot()).toEqual(workflow.snapshot())
		expect(restored.phase('phase-build')?.task('task-compile')?.status).toBe('completed')
	})

	it('assertSnapshot passes a valid snapshot and rejects an invalid status', () => {
		const snapshot = createWorkflow(buildWorkflowDefinition()).snapshot()
		expect(captureError(() => assertSnapshot(snapshot))).toBeUndefined()
		const broken = { ...snapshot, status: 'bogus' }
		const error = captureError(() => assertSnapshot(JSON.parse(JSON.stringify(broken))))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('RESTORE')
	})

	it('assertSnapshot rejects a PhaseSnapshot with a non-boolean bail (naming the phase)', () => {
		// A phase's `bail` is REQUIRED persisted policy (like the workflow's), so a snapshot whose
		// phase carries a non-boolean `bail` is rejected loudly with a RESTORE error naming that phase.
		const snapshot = createWorkflow(buildWorkflowDefinition()).snapshot()
		const firstPhase = snapshot.phases[0]
		if (firstPhase === undefined) throw new Error('expected at least one phase')
		const broken = {
			...snapshot,
			phases: [{ ...firstPhase, bail: 'nope' }, ...snapshot.phases.slice(1)],
		}
		const error = captureError(() => assertSnapshot(JSON.parse(JSON.stringify(broken))))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('RESTORE')
		// The error names the offending phase in its context.
		expect(isWorkflowError(error) ? error.context?.phase : undefined).toBe(firstPhase.id)
	})
})

describe('createWorkflowTool — wrap a definition as an LLM-callable tool (W-c2)', () => {
	it('its parameters advertise the FLAT authoring shape (the simplest surface a small model fills)', () => {
		const tool = createWorkflowTool(simpleDefinition(), runner())
		// The ADVERTISED schema is the flat `{ name?, steps: [{ name, via? }] }` form — NOT the full
		// nested `WorkflowDefinition` (no `id` / `phases` at the top level). The nested form stays
		// accepted by the handler (proven below) but is the documented escape-hatch, not advertised.
		expect(tool.parameters?.type).toBe('object')
		const properties = tool.parameters?.properties
		expect(isRecord(properties) ? Object.keys(properties).sort() : []).toEqual(['name', 'steps'])
		expect(isRecord(properties) ? 'id' in properties : true).toBe(false)
		expect(isRecord(properties) ? 'phases' in properties : true).toBe(false)
		// The `steps` array's items are `{ name, via? }`.
		const steps = isRecord(properties) ? properties.steps : undefined
		const items = isRecord(steps) ? steps.items : undefined
		const stepProps = isRecord(items) ? items.properties : undefined
		expect(isRecord(stepProps) ? Object.keys(stepProps).sort() : []).toEqual(['name', 'via'])
	})

	it('the advertised parameters carry per-field descriptions on the key fields', () => {
		const tool = createWorkflowTool(simpleDefinition(), runner())
		const properties = tool.parameters?.properties
		const steps = isRecord(properties) ? properties.steps : undefined
		const items = isRecord(steps) ? steps.items : undefined
		const stepProps = isRecord(items) ? items.properties : undefined
		const nameField = isRecord(stepProps) ? stepProps.name : undefined
		const viaField = isRecord(stepProps) ? stepProps.via : undefined
		// a step's `name` and `via` (the fields a small model most needs help with) ride a `description`
		// in the advertised JSON Schema — the Rank-1 guidance that compiles straight from the shapers.
		expect(typeof (isRecord(nameField) ? nameField.description : undefined)).toBe('string')
		expect(typeof (isRecord(viaField) ? viaField.description : undefined)).toBe('string')
	})

	it(
		'a valid authored-args blob runs that workflow and RETURNS the plain run summary',
		async () => {
			// The wrapped definition is a throwaway; the authored args (a different valid workflow) are
			// what the handler parses + runs — proving the tool runs the LLM-authored tree, not the wrap.
			// The handler returns the PLAIN summary value DIRECTLY (no `{ id, name, value }` envelope —
			// that wrap is the ToolManager's, asserted in the manager test below).
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			const summary = readSummary(await tool.execute({ ...simpleDefinition('authored') }))
			// The summary reflects the terminal run: a one-task auto-complete workflow → completed, 1 result.
			expect(summary).toEqual({ status: 'completed', count: 1 })
		},
		ROUND_TRIP_TIMEOUT_MS,
	)

	it(
		'no authored args runs the WRAPPED definition (the tool genuinely wraps it)',
		async () => {
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			expect(readSummary(await tool.execute({}))).toEqual({ status: 'completed', count: 1 })
		},
		ROUND_TRIP_TIMEOUT_MS,
	)

	it('a malformed authored blob THROWS a typed TOOL WorkflowError (the §14 handler contract)', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
		// An empty `id` (min 1) and `concurrency: 0` are over-constraint — contract.parse rejects.
		const error = await rejectionOf(
			tool.execute({
				id: '',
				name: 'X',
				phases: [{ id: 'p', name: 'P', tasks: [], concurrency: 0 }],
			}),
		)
		expect(isWorkflowError(error)).toBe(true)
		// A typed `TOOL` code, the message the manager surfaces, and the wrapped id in `context`.
		expect(isWorkflowError(error) ? error.code : undefined).toBe('TOOL')
		expect(isWorkflowError(error) ? error.context?.workflow : undefined).toBe('wrapped')
	})

	it('an over-deep call (depth at the ceiling) THROWS a typed DEPTH WorkflowError without running', async () => {
		// A tool BOUND at the max depth: invoking it would run the nested workflow at depth+1 >
		// MAX_WORKFLOW_DEPTH, so the guard rejects it by throwing a typed DEPTH error (no run).
		const tool = createWorkflowTool(simpleDefinition(), runner(), {
			depth: MAX_WORKFLOW_DEPTH,
		})
		const error = await rejectionOf(tool.execute({ ...simpleDefinition('deep') }))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('DEPTH')
		expect(error instanceof Error ? error.message : '').toContain('max depth')
	})

	it('a cyclic call (target id already an ancestor) THROWS a typed DEPTH WorkflowError', async () => {
		// The ancestry already carries `workflow:loop`; authoring a workflow with the SAME id is a
		// re-entry cycle, rejected by throwing a typed DEPTH error (no run).
		const tool = createWorkflowTool(simpleDefinition(), runner(), {
			ancestry: ['workflow:loop'],
		})
		const error = await rejectionOf(tool.execute({ ...simpleDefinition('loop') }))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('DEPTH')
		expect(error instanceof Error ? error.message : '').toContain('cycle')
	})
})

// Rank 1 — the embedded worked examples (in the tool's description) can NEVER drift: each
// must satisfy its contract. The nested example is a valid strict definition; the flat
// example expands to a valid tree. The description interpolates these very constants, so a
// green test here pins the doc examples to real, contract-valid data (AGENTS §22).
describe('createWorkflowTool — the embedded doc examples satisfy their contracts (Rank 1 parity)', () => {
	it('the NESTED example is accepted by the STRICT contract', () => {
		expect(createWorkflowContract().is(WORKFLOW_TOOL_NESTED_EXAMPLE)).toBe(true)
	})

	it('the FLAT example expands to a tree the STRICT contract accepts', () => {
		expect(createWorkflowContract().is(expandSteps(WORKFLOW_TOOL_FLAT_EXAMPLE))).toBe(true)
	})
})

// Rank 2 — the lenient DRAFT contract + the ids-omitted tool path. A small model can omit
// every id/name; the tool completes the draft positionally and re-validates against the
// STRICT contract before running. (The pure completeDraft synthesis is unit-tested in
// helpers.test.ts; here we cover the CONTRACT + the end-to-end tool run.)
describe('createWorkflowDraftContract + the ids-omitted tool path (Rank 2)', () => {
	it('the draft contract ACCEPTS an ids-omitted blob but REJECTS an explicitly-empty id', () => {
		const draft = createWorkflowDraftContract()
		// Every id/name omitted at all three levels — accepted (the tool completes them).
		const omitted: WorkflowDraft = {
			phases: [{ tasks: [{ run: { via: 'function', name: 'a' } }] }],
		}
		expect(draft.is(omitted)).toBe(true)
		// A provided-but-empty id fails the draft contract's minLength:1 — garbage ≠ omitted.
		expect(draft.parse({ id: '', phases: [] })).toBeUndefined()
		expect(draft.is({ id: '', phases: [] })).toBe(false)
	})

	it(
		'the tool runs an ids-OMITTED nested blob end-to-end → completed with the right result count',
		async () => {
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			// Author with NO ids/names anywhere — the tool completes the draft, validates, and runs it.
			const summary = readSummary(
				await tool.execute({
					phases: [
						{ tasks: [{ run: { via: 'function', name: 'x' } }] },
						{ tasks: [{ run: { via: 'function', name: 'y' } }] },
					],
				}),
			)
			// Two one-task auto-complete phases → completed, 2 settled results.
			expect(summary).toEqual({ status: 'completed', count: 2 })
		},
		ROUND_TRIP_TIMEOUT_MS,
	)

	it(
		'the tool still accepts the FULL nested form as the escape-hatch (ids provided)',
		async () => {
			// The advanced form remains reachable: a full nested definition runs unchanged.
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			expect(readSummary(await tool.execute({ ...simpleDefinition('explicit') }))).toEqual({
				status: 'completed',
				count: 1,
			})
		},
		ROUND_TRIP_TIMEOUT_MS,
	)
})

// Rank 3 — the FLAT steps form (the advertised surface). The tool runs a flat blob
// end-to-end, converging on the strict gate. (expandSteps' pure mapping is unit-tested in
// helpers.test.ts; here we cover the END-TO-END tool run + the can't-expand failure.)
describe('the flat steps form — the advertised tool path (Rank 3)', () => {
	it(
		'the tool runs a minimal FLAT blob end-to-end → { status: completed, count: N } (P3.3)',
		async () => {
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			// The simplest thing a small model can emit: a flat list of steps.
			const summary = readSummary(
				await tool.execute({
					name: 'build',
					steps: [{ name: 'compile' }, { name: 'publish', via: 'tool' }],
				}),
			)
			// Two steps → two one-task auto-complete phases → completed, 2 results.
			expect(summary).toEqual({ status: 'completed', count: 2 })
		},
		ROUND_TRIP_TIMEOUT_MS,
	)

	it('a flat blob that cannot expand (a step missing `name`) THROWS a typed TOOL WorkflowError', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
		// `steps` is an array (so the flat branch is taken) but a step lacks `name` → the steps parse
		// fails → the strict gate is never reached → throw TOOL (no run).
		const error = await rejectionOf(tool.execute({ steps: [{ via: 'function' }] }))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('TOOL')
	})

	it(
		'a blob carrying BOTH `steps` and `phases` takes the FLAT branch (expands steps, IGNORES phases) — chunk-C precedence lock-in',
		async () => {
			// The handler branches on the args' SHAPE: `Array.isArray(args.steps)` is checked BEFORE the
			// nested-draft branch, so a blob carrying BOTH takes the FLAT branch — it expands `steps` and
			// completely IGNORES `phases`. Lock that documented precedence: TWO steps + a DIFFERENT-sized
			// (THREE-phase) `phases` array. If the flat branch wins, the run is two one-task phases ⇒ 2
			// results; if `phases` were honored instead it would be 3. The distinct counts discriminate the
			// branch unambiguously. (The steps shape is a CLOSED object, so its parse silently DROPS the
			// extra `phases` key rather than rejecting — the flat expansion never sees it.)
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			const summary = readSummary(
				await tool.execute({
					name: 'precedence',
					steps: [{ name: 'a' }, { name: 'b' }],
					phases: [
						{
							id: 'x',
							name: 'X',
							tasks: [{ id: 'x0', name: 'X0', run: { via: 'function', name: 'p' } }],
						},
						{
							id: 'y',
							name: 'Y',
							tasks: [{ id: 'y0', name: 'Y0', run: { via: 'function', name: 'q' } }],
						},
						{
							id: 'z',
							name: 'Z',
							tasks: [{ id: 'z0', name: 'Z0', run: { via: 'function', name: 'r' } }],
						},
					],
				}),
			)
			// 2 results = the 2 STEPS expanded (FLAT branch), NOT the 3 phases — `phases` was ignored.
			expect(summary).toEqual({ status: 'completed', count: 2 })
		},
		ROUND_TRIP_TIMEOUT_MS,
	)
})

// The load-bearing F2-WRAP proof: the workflow-tool outcome appears EXACTLY ONCE, canonically, on
// BOTH the agent-loop ToolManager and MCP — never the old doubly-nested `{ id, name, value: {...} }`
// envelope, and a FAILURE is signalled at the TOP-LEVEL `error` (so MCP maps it to `isError: true`).
describe('createWorkflowTool — single canonical wrap over the ToolManager + MCP (F2-WRAP)', () => {
	it(
		'a SUCCESS maps to a SINGLE-LEVEL ToolResult — value IS the plain summary, no nested envelope',
		async () => {
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			const result = await executeThroughManager(tool)
			// The manager performs the ONE canonical wrap: `value` deep-equals the plain summary the
			// handler returned — NOT a `{ id, name, value }` re-wrap of it.
			expect(result.value).toEqual({ status: 'completed', count: 1 })
			expect(isRecord(result.value) && 'value' in result.value).toBe(false)
			expect(result.error).toBeUndefined()
			// The canonical envelope's identity is the manager's (the call id + the tool name) — the
			// handler contributed no id/name of its own.
			expect(result.id).toBe('call-1')
			expect(result.name).toBe('workflow')
		},
		ROUND_TRIP_TIMEOUT_MS,
	)

	it('a FAILURE maps to a SINGLE-LEVEL ToolResult — a TOP-LEVEL error, no value', async () => {
		// A tool bound at the max depth: the handler throws DEPTH, the manager ISOLATES it into the
		// canonical top-level `error` (the failure appears once, at the same place every tool error does).
		const tool = createWorkflowTool(simpleDefinition('wrapped'), runner(), {
			depth: MAX_WORKFLOW_DEPTH,
		})
		const result = await executeThroughManager(tool)
		expect(result.value).toBeUndefined()
		expect(result.error).toContain('max depth')
		expect(result.id).toBe('call-1')
	})

	it(
		'the manager FAILURE ToolResult maps to MCP isError:true; SUCCESS to the plain summary text',
		async () => {
			// The MCP win: buildToolResult routes a top-level `error` → isError:true (so a workflow
			// failure is a tool error the model reacts to, not a silently-OK result). Before F2-WRAP the
			// failure reason sat at `value.error` (inner) and MCP mis-signalled isError:false.
			const failing = createWorkflowTool(simpleDefinition('wrapped'), runner(), {
				depth: MAX_WORKFLOW_DEPTH,
			})
			const failure = buildToolResult(await executeThroughManager(failing))
			expect(failure.isError).toBe(true)
			expect(failure.content[0]?.text).toContain('max depth')

			// A success has no top-level error → no isError, and the text is the plain summary JSON.
			const ok = createWorkflowTool(simpleDefinition('wrapped'), runner())
			const success = buildToolResult(await executeThroughManager(ok))
			expect(success.isError).toBeUndefined()
			expect(success.content[0]?.text).toBe(JSON.stringify({ status: 'completed', count: 1 }))
		},
		ROUND_TRIP_TIMEOUT_MS,
	)
})

// createSchedule — returns a working cross-environment ScheduleInterface.

describe('createSchedule', () => {
	it('returns a schedule whose yield and delay round-trip', async () => {
		const schedule = createSchedule()

		await expect(schedule.yield()).resolves.toBeUndefined()

		const start = Date.now()
		await schedule.delay(20)
		// Real timing with tolerance — delay waited at least roughly its interval.
		expect(Date.now() - start).toBeGreaterThanOrEqual(15)
	})

	it('its delay is abort-aware — a pre-aborted signal rejects with the reason', async () => {
		const schedule = createSchedule()
		const controller = new AbortController()
		const reason = new Error('cancelled')
		controller.abort(reason)

		await expect(schedule.delay(20, { signal: controller.signal })).rejects.toBe(reason)
		// A subsequent unguarded yield still works.
		await waitForDelay(0)
		await expect(schedule.yield()).resolves.toBeUndefined()
	})

	it('returns independent, stateless instances — aborting one does not affect another', async () => {
		const first = createSchedule()
		const second = createSchedule()
		const controller = new AbortController()
		const reason = new Error('only the first')
		controller.abort(reason)

		// The first call is bound to an already-aborted signal and rejects; the second
		// schedule shares no state with it, so its own unguarded calls round-trip fine.
		await expect(first.delay(20, { signal: controller.signal })).rejects.toBe(reason)
		await expect(second.yield()).resolves.toBeUndefined()
		await expect(second.delay(10)).resolves.toBeUndefined()
		// And the first schedule is itself unbroken for a fresh, unguarded call.
		await expect(first.yield()).resolves.toBeUndefined()
	})
})
