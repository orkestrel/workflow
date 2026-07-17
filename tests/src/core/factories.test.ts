import type { ToolResult } from '@orkestrel/agent'
import type {
	TaskContext,
	TaskControllerInterface,
	WorkflowDefinition,
	WorkflowDraft,
	WorkflowFunction,
} from '@src/core'
import { buildToolResult, createAgent, createToolManager, createTool } from '@orkestrel/agent'
import { isRecord } from '@orkestrel/contract'
import {
	assertSnapshot,
	createAgentFunction,
	createScheduler,
	createToolFunction,
	createWorkflow,
	createWorkflowContract,
	createWorkflowDraftContract,
	createWorkflowRunner,
	createWorkflowTool,
	definitionToSnapshot,
	expandSteps,
	isWorkflowError,
	MAX_WORKFLOW_DEPTH,
	restoreWorkflow,
	WORKFLOW_TOOL_FLAT_EXAMPLE,
	WORKFLOW_TOOL_NAME,
	WORKFLOW_TOOL_NESTED_EXAMPLE,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	captureError,
	createRecorder,
	createRecordingScheduler,
	createScriptedProvider,
	waitForDelay,
} from '../../setup.js'
import { createRunner } from '@src/core'

// A workflow runner paced by an INJECTED `createRecordingScheduler` (AGENTS §16 deterministic,
// not a mock of the runner — the unit under test runs in full). Per the redesign, the runner
// itself carries NO `functions` registry — behavior resolution rides `execute`'s options.
function runner(): ReturnType<typeof createWorkflowRunner> {
	return createWorkflowRunner({ scheduler: createRecordingScheduler() })
}

const ROUND_TRIP_TIMEOUT_MS = 30_000

// A one-task definition whose `run` is left UNREGISTERED against any functions passed at
// `execute` time, so the lone task auto-completes ⇒ a `completed` run — the simplest
// definition a `createWorkflowTool` can run.
function simpleDefinition(id = 'nested'): WorkflowDefinition {
	return {
		id,
		name: id,
		phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', run: 'noop' }] }],
	}
}

// A fuller definition (two phases, three tasks, a concurrency throttle, an explicit bail) used by
// the createWorkflow / restoreWorkflow / snapshot-trio tests — the local replacement for
// setup.ts's `buildWorkflowDefinition` (still on the OLD `{ via, name }` task-form shape; see the
// reported shared-file patch). Every `run` is a plain registry-name string per the redesign.
function localDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
	return {
		id: 'wf-1',
		name: 'Release',
		description: 'Ship a release',
		bail: false,
		phases: [
			{
				id: 'phase-build',
				name: 'Build',
				concurrency: 2,
				tasks: [
					{ id: 'task-compile', name: 'Compile', run: 'compile', retries: 2, timeout: 500 },
					{ id: 'task-scan', name: 'Scan', description: 'Security scan', run: 'scan' },
				],
			},
			{
				id: 'phase-review',
				name: 'Review',
				tasks: [{ id: 'task-audit', name: 'Audit', run: 'audit' }],
			},
		],
		...overrides,
	}
}

// Narrow the workflow-tool handler's DIRECT `execute` return (typed `unknown`) to the plain run
// summary through guards (§14, NO `as`).
function readSummary(value: unknown): { status: string; count: number } | undefined {
	if (!isRecord(value) || typeof value.status !== 'string' || typeof value.count !== 'number') {
		return undefined
	}
	return { status: value.status, count: value.count }
}

function executeThroughManager(tool: ReturnType<typeof createWorkflowTool>): Promise<ToolResult> {
	const manager = createToolManager()
	manager.add(tool)
	return manager.execute({
		id: 'call-1',
		name: tool.name,
		arguments: { ...simpleDefinition('via-mgr') },
	})
}

async function rejectionOf(promise: Promise<unknown> | unknown): Promise<unknown> {
	try {
		await promise
		return undefined
	} catch (error) {
		return error
	}
}

// A minimal, hand-built `TaskContext` — pure DATA (no behavior to mock), the lineage shape
// `createAgentFunction` / `createToolFunction` read from `controller.task`. Lets the adapter unit
// tests call the returned `WorkflowFunction` directly, without driving a full runner round-trip.
function fakeTaskContext(workflowId = 'wf', taskId = 't'): TaskContext {
	const workflow = { id: workflowId, name: workflowId }
	const phase = { id: 'p', name: 'P', workflow }
	return { id: taskId, name: taskId, phase }
}

function fakeController(overrides: Partial<TaskControllerInterface> = {}): TaskControllerInterface {
	const controller = new AbortController()
	return {
		signal: controller.signal,
		aborted: controller.signal.aborted,
		input: {},
		task: fakeTaskContext(),
		results: () => [],
		...overrides,
	}
}

// ── createWorkflowContract — the anti-drift spine (four-way parity) ──

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
		expect(contract.is(localDefinition())).toBe(true)
	})

	it('is() accepts a minimal definition (optionals omitted)', () => {
		const minimal: WorkflowDefinition = {
			id: 'wf-min',
			name: 'Minimal',
			phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', run: 'f' }] }],
		}
		expect(contract.is(minimal)).toBe(true)
	})

	it('is() accepts an empty-phase and empty-task workflow', () => {
		expect(contract.is(localDefinition({ phases: [] }))).toBe(true)
		expect(contract.is(localDefinition({ phases: [{ id: 'p', name: 'P', tasks: [] }] }))).toBe(true)
	})

	it('is() accepts a task with an omitted `run` (no behavior reference)', () => {
		const definition = localDefinition({
			phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T' }] }],
		})
		expect(contract.is(definition)).toBe(true)
	})

	it('parse() returns the value unchanged for a valid definition', () => {
		const definition = localDefinition()
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
			'task run is not a string (an object cannot coerce)',
			{
				id: 'w',
				name: 'X',
				phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', run: {} }] }],
			},
		],
		[
			'task run is an empty string',
			{
				id: 'w',
				name: 'X',
				phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', run: '' }] }],
			},
		],
		[
			'concurrency below 1',
			{ id: 'w', name: 'X', phases: [{ id: 'p', name: 'P', tasks: [], concurrency: 0 }] },
		],
		[
			'concurrency not an integer',
			{ id: 'w', name: 'X', phases: [{ id: 'p', name: 'P', tasks: [], concurrency: 1.5 }] },
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
		const definition = localDefinition()
		expect(contract.is(definition)).toBe(true)
		expect(contract.parse(definition)).toEqual(definition)
	})
})

// ── createWorkflow — builds the live tree (the W-b factory) ──

describe('createWorkflow — builds the live tree (the W-b factory)', () => {
	it('brings the definition to life with lineage + the definition bail', () => {
		const workflow = createWorkflow(localDefinition())
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
		expect(createWorkflow(localDefinition({ bail: true })).bail).toBe(true)
		expect(createWorkflow(localDefinition({ bail: true }), { bail: false }).bail).toBe(false)
		const noBail: WorkflowDefinition = { id: 'w', name: 'W', phases: [] }
		expect(createWorkflow(noBail).bail).toBe(false)
	})

	it(
		'PROGRAMMATIC-FIRST: a task whose `run` resolves against `options.functions` runs the real handler at construction time (via a live runner)',
		async () => {
			const seen = createRecorder<readonly [string]>()
			const compile: WorkflowFunction = (controller) => {
				seen.handler(controller.task.id)
				return 'built'
			}
			const workflow = createWorkflow(localDefinition(), {
				functions: { compile, scan: () => 's', audit: () => 'a' },
			})
			expect(workflow.phase('phase-build')?.task('task-compile')?.handler).toBeDefined()
			// The retries/timeout definition fields carried onto the live leaf (V3/V4 persisted fields).
			expect(workflow.phase('phase-build')?.task('task-compile')?.retries).toBe(2)
			expect(workflow.phase('phase-build')?.task('task-compile')?.timeout).toBe(500)
			const result = await runner().execute(workflow)
			expect(result.status).toBe('completed')
			expect([...seen.calls].map((c) => c[0])).toEqual(['task-compile'])
		},
		ROUND_TRIP_TIMEOUT_MS,
	)

	it('a `run` name absent from `functions` (or omitted) resolves to `handler: undefined` (the no-handler rule)', () => {
		const workflow = createWorkflow(localDefinition(), { functions: {} })
		expect(workflow.phase('phase-build')?.task('task-compile')?.handler).toBeUndefined()
	})
})

// ── restoreWorkflow / assertSnapshot — the round-trip inverse ──

describe('restoreWorkflow / assertSnapshot — the round-trip inverse', () => {
	it('restoreWorkflow rebuilds an equivalent tree from a snapshot', () => {
		const workflow = createWorkflow(localDefinition({ bail: true }))
		const compile = workflow.phase('phase-build')?.task('task-compile')
		compile?.start()
		compile?.complete('built')
		const restored = restoreWorkflow(workflow.snapshot(), { bail: true })
		expect(restored.snapshot()).toEqual(workflow.snapshot())
		expect(restored.phase('phase-build')?.task('task-compile')?.status).toBe('completed')
	})

	it(
		'RESTORE-THEN-RESUME runs REAL WORK: a restored snapshot + functions actually executes the handler and completes (the headline)',
		async () => {
			const ran = createRecorder<readonly [string]>()
			const workflow = createWorkflow(
				localDefinition({
					phases: [localDefinition().phases[0] ?? { id: 'p', name: 'P', tasks: [] }],
				}),
			)
			const snapshot = workflow.snapshot()
			const compile: WorkflowFunction = (controller) => {
				ran.handler(controller.task.id)
				return 'built-again'
			}
			const restored = restoreWorkflow(snapshot, { functions: { compile, scan: () => 's' } })
			expect(restored.phase('phase-build')?.task('task-compile')?.handler).toBeDefined()
			const result = await runner().execute(restored)
			expect(result.status).toBe('completed')
			expect([...ran.calls].map((c) => c[0])).toEqual(['task-compile'])
			expect(restored.phase('phase-build')?.task('task-compile')?.result?.result).toEqual({
				success: true,
				value: 'built-again',
			})
		},
		ROUND_TRIP_TIMEOUT_MS,
	)

	it(
		'restoreWorkflow WITHOUT `functions` auto-completes every task (documented declarative replay)',
		async () => {
			const workflow = createWorkflow(localDefinition())
			const snapshot = workflow.snapshot()
			const restored = restoreWorkflow(snapshot)
			expect(restored.phase('phase-build')?.task('task-compile')?.handler).toBeUndefined()
			const result = await runner().execute(restored)
			expect(result.status).toBe('completed')
			expect(restored.phase('phase-build')?.task('task-compile')?.status).toBe('completed')
			expect(restored.phase('phase-build')?.task('task-compile')?.result?.result).toEqual({
				success: true,
				value: undefined,
			})
		},
		ROUND_TRIP_TIMEOUT_MS,
	)

	it("SNAPSHOT TRIO round-trip: a definition's run/retries/timeout survive definitionToSnapshot → live tree → snapshot() → restore", () => {
		const definition = localDefinition()
		const snapshot = definitionToSnapshot(definition, false)
		const compileSnap = snapshot.phases[0]?.tasks[0]
		expect(compileSnap?.run).toBe('compile')
		expect(compileSnap?.retries).toBe(2)
		expect(compileSnap?.timeout).toBe(500)

		const workflow = createWorkflow(definition)
		const liveSnapshot = workflow.snapshot()
		const liveCompile = liveSnapshot.phases[0]?.tasks[0]
		expect(liveCompile?.run).toBe('compile')
		expect(liveCompile?.retries).toBe(2)
		expect(liveCompile?.timeout).toBe(500)

		const restored = restoreWorkflow(liveSnapshot)
		const restoredCompile = restored.phase('phase-build')?.task('task-compile')
		expect(restoredCompile?.run).toBe('compile')
		expect(restoredCompile?.retries).toBe(2)
		expect(restoredCompile?.timeout).toBe(500)
	})

	it('assertSnapshot passes a valid snapshot and rejects an invalid status', () => {
		const snapshot = createWorkflow(localDefinition()).snapshot()
		expect(captureError(() => assertSnapshot(snapshot))).toBeUndefined()
		const broken = { ...snapshot, status: 'bogus' }
		const error = captureError(() => assertSnapshot(JSON.parse(JSON.stringify(broken))))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('RESTORE')
	})

	it('assertSnapshot rejects a PhaseSnapshot with a non-boolean bail (naming the phase)', () => {
		const snapshot = createWorkflow(localDefinition()).snapshot()
		const firstPhase = snapshot.phases[0]
		if (firstPhase === undefined) throw new Error('expected at least one phase')
		const broken = {
			...snapshot,
			phases: [{ ...firstPhase, bail: 'nope' }, ...snapshot.phases.slice(1)],
		}
		const error = captureError(() => assertSnapshot(JSON.parse(JSON.stringify(broken))))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('RESTORE')
		expect(isWorkflowError(error) ? error.context?.phase : undefined).toBe(firstPhase.id)
	})

	it('assertSnapshot rejects a TaskSnapshot with an empty `run`, a negative `retries`, or a fractional `timeout` (naming the task)', () => {
		const snapshot = createWorkflow(localDefinition()).snapshot()
		const firstTask = snapshot.phases[0]?.tasks[0]
		if (firstTask === undefined) throw new Error('expected at least one task')

		const badRun = {
			...snapshot,
			phases: [
				{
					...snapshot.phases[0],
					tasks: [{ ...firstTask, run: '' }, ...(snapshot.phases[0]?.tasks.slice(1) ?? [])],
				},
				...snapshot.phases.slice(1),
			],
		}
		const runError = captureError(() => assertSnapshot(JSON.parse(JSON.stringify(badRun))))
		expect(isWorkflowError(runError) ? runError.code : undefined).toBe('RESTORE')

		const badRetries = {
			...snapshot,
			phases: [
				{
					...snapshot.phases[0],
					tasks: [{ ...firstTask, retries: -1 }, ...(snapshot.phases[0]?.tasks.slice(1) ?? [])],
				},
				...snapshot.phases.slice(1),
			],
		}
		const retriesError = captureError(() => assertSnapshot(JSON.parse(JSON.stringify(badRetries))))
		expect(isWorkflowError(retriesError) ? retriesError.code : undefined).toBe('RESTORE')
		expect(isWorkflowError(retriesError) ? retriesError.context?.task : undefined).toBe(
			firstTask.id,
		)

		const badTimeout = {
			...snapshot,
			phases: [
				{
					...snapshot.phases[0],
					tasks: [{ ...firstTask, timeout: 1.5 }, ...(snapshot.phases[0]?.tasks.slice(1) ?? [])],
				},
				...snapshot.phases.slice(1),
			],
		}
		const timeoutError = captureError(() => assertSnapshot(JSON.parse(JSON.stringify(badTimeout))))
		expect(isWorkflowError(timeoutError) ? timeoutError.code : undefined).toBe('RESTORE')
	})
})

// ── createWorkflowTool — wrap a definition as an LLM-callable tool ──

describe('createWorkflowTool — wrap a definition as an LLM-callable tool (W-c2)', () => {
	it('its parameters advertise the FLAT authoring shape (the simplest surface a small model fills)', () => {
		const tool = createWorkflowTool(simpleDefinition(), runner())
		expect(tool.parameters?.type).toBe('object')
		const properties = tool.parameters?.properties
		expect(isRecord(properties) ? Object.keys(properties).sort() : []).toEqual(['name', 'steps'])
		expect(isRecord(properties) ? 'id' in properties : true).toBe(false)
		expect(isRecord(properties) ? 'phases' in properties : true).toBe(false)
		// The `steps` array's items are now `{ name }` ONLY — TaskForm/`via` was deleted.
		const steps = isRecord(properties) ? properties.steps : undefined
		const items = isRecord(steps) ? steps.items : undefined
		const stepProps = isRecord(items) ? items.properties : undefined
		expect(isRecord(stepProps) ? Object.keys(stepProps).sort() : []).toEqual(['name'])
	})

	it('the advertised parameters carry a `description` on the step `name` field', () => {
		const tool = createWorkflowTool(simpleDefinition(), runner())
		const properties = tool.parameters?.properties
		const steps = isRecord(properties) ? properties.steps : undefined
		const items = isRecord(steps) ? steps.items : undefined
		const stepProps = isRecord(items) ? items.properties : undefined
		const nameField = isRecord(stepProps) ? stepProps.name : undefined
		expect(typeof (isRecord(nameField) ? nameField.description : undefined)).toBe('string')
	})

	it(
		'a valid authored-args blob runs that workflow and RETURNS the plain run summary',
		async () => {
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			const summary = readSummary(await tool.execute({ ...simpleDefinition('authored') }))
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
		const error = await rejectionOf(
			tool.execute({
				id: '',
				name: 'X',
				phases: [{ id: 'p', name: 'P', tasks: [], concurrency: 0 }],
			}),
		)
		expect(isWorkflowError(error)).toBe(true)
		expect(isWorkflowError(error) ? error.code : undefined).toBe('TOOL')
		expect(isWorkflowError(error) ? error.context?.workflow : undefined).toBe('wrapped')
	})

	it('an over-deep call (depth at the ceiling) THROWS a typed DEPTH WorkflowError without running', async () => {
		const tool = createWorkflowTool(simpleDefinition(), runner(), { depth: MAX_WORKFLOW_DEPTH })
		const error = await rejectionOf(tool.execute({ ...simpleDefinition('deep') }))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('DEPTH')
		expect(error instanceof Error ? error.message : '').toContain('max depth')
	})

	it('a cyclic call (target id already an ancestor) THROWS a typed DEPTH WorkflowError', async () => {
		const tool = createWorkflowTool(simpleDefinition(), runner(), { ancestry: ['workflow:loop'] })
		const error = await rejectionOf(tool.execute({ ...simpleDefinition('loop') }))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('DEPTH')
		expect(error instanceof Error ? error.message : '').toContain('cycle')
	})
})

describe('createWorkflowTool — the embedded doc examples satisfy their contracts (Rank 1 parity)', () => {
	it('the NESTED example is accepted by the STRICT contract', () => {
		expect(createWorkflowContract().is(WORKFLOW_TOOL_NESTED_EXAMPLE)).toBe(true)
	})

	it('the FLAT example expands to a tree the STRICT contract accepts', () => {
		expect(createWorkflowContract().is(expandSteps(WORKFLOW_TOOL_FLAT_EXAMPLE))).toBe(true)
	})
})

describe('createWorkflowDraftContract + the ids-omitted tool path (Rank 2)', () => {
	it('the draft contract ACCEPTS an ids-omitted blob but REJECTS an explicitly-empty id', () => {
		const draft = createWorkflowDraftContract()
		const omitted: WorkflowDraft = { phases: [{ tasks: [{ run: 'a' }] }] }
		expect(draft.is(omitted)).toBe(true)
		expect(draft.parse({ id: '', phases: [] })).toBeUndefined()
		expect(draft.is({ id: '', phases: [] })).toBe(false)
	})

	it(
		'the tool runs an ids-OMITTED nested blob end-to-end → completed with the right result count',
		async () => {
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			const summary = readSummary(
				await tool.execute({
					phases: [{ tasks: [{ run: 'x' }] }, { tasks: [{ run: 'y' }] }],
				}),
			)
			expect(summary).toEqual({ status: 'completed', count: 2 })
		},
		ROUND_TRIP_TIMEOUT_MS,
	)

	it(
		'the tool still accepts the FULL nested form as the escape-hatch (ids provided)',
		async () => {
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			expect(readSummary(await tool.execute({ ...simpleDefinition('explicit') }))).toEqual({
				status: 'completed',
				count: 1,
			})
		},
		ROUND_TRIP_TIMEOUT_MS,
	)
})

describe('the flat steps form — the advertised tool path (Rank 3)', () => {
	it(
		'the tool runs a minimal FLAT blob end-to-end → { status: completed, count: N } (P3.3)',
		async () => {
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			const summary = readSummary(
				await tool.execute({ name: 'build', steps: [{ name: 'compile' }, { name: 'publish' }] }),
			)
			expect(summary).toEqual({ status: 'completed', count: 2 })
		},
		ROUND_TRIP_TIMEOUT_MS,
	)

	it('a flat blob that cannot expand (a step missing `name`) THROWS a typed TOOL WorkflowError', async () => {
		const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
		const error = await rejectionOf(tool.execute({ steps: [{}] }))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('TOOL')
	})

	it(
		'a blob carrying BOTH `steps` and `phases` takes the FLAT branch (expands steps, IGNORES phases) — chunk-C precedence lock-in',
		async () => {
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			const summary = readSummary(
				await tool.execute({
					name: 'precedence',
					steps: [{ name: 'a' }, { name: 'b' }],
					phases: [
						{ id: 'x', name: 'X', tasks: [{ id: 'x0', name: 'X0', run: 'p' }] },
						{ id: 'y', name: 'Y', tasks: [{ id: 'y0', name: 'Y0', run: 'q' }] },
						{ id: 'z', name: 'Z', tasks: [{ id: 'z0', name: 'Z0', run: 'r' }] },
					],
				}),
			)
			expect(summary).toEqual({ status: 'completed', count: 2 })
		},
		ROUND_TRIP_TIMEOUT_MS,
	)
})

describe('createWorkflowTool — single canonical wrap over the ToolManager + MCP (F2-WRAP)', () => {
	it(
		'a SUCCESS maps to a SINGLE-LEVEL ToolResult — value IS the plain summary, no nested envelope',
		async () => {
			const tool = createWorkflowTool(simpleDefinition('wrapped'), runner())
			const result = await executeThroughManager(tool)
			expect(result.value).toEqual({ status: 'completed', count: 1 })
			expect(isRecord(result.value) && 'value' in result.value).toBe(false)
			expect(result.error).toBeUndefined()
			expect(result.id).toBe('call-1')
			expect(result.name).toBe('workflow')
		},
		ROUND_TRIP_TIMEOUT_MS,
	)

	it('a FAILURE maps to a SINGLE-LEVEL ToolResult — a TOP-LEVEL error, no value', async () => {
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
			const failing = createWorkflowTool(simpleDefinition('wrapped'), runner(), {
				depth: MAX_WORKFLOW_DEPTH,
			})
			const failure = buildToolResult(await executeThroughManager(failing))
			expect(failure.isError).toBe(true)
			expect(failure.content[0]?.text).toContain('max depth')

			const ok = createWorkflowTool(simpleDefinition('wrapped'), runner())
			const success = buildToolResult(await executeThroughManager(ok))
			expect(success.isError).toBeUndefined()
			expect(success.content[0]?.text).toBe(JSON.stringify({ status: 'completed', count: 1 }))
		},
		ROUND_TRIP_TIMEOUT_MS,
	)
})

// ── Adapter factories — createToolFunction / createAgentFunction ──

describe('createToolFunction — wraps a registered tool as a WorkflowFunction', () => {
	it('happy path: executes the named tool with controller.input and returns its value', async () => {
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
		const fn = createToolFunction(tools, 'scan')
		const value = await fn(fakeController({ input: { path: '/repo' } }))
		expect(value).toBe('scanned')
		expect(seen.calls[0]?.[0]).toEqual({ path: '/repo' })
	})

	it('error-to-cause: a tool whose result carries an error throws an Error carrying it as `cause`', async () => {
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'boom',
				execute: () => {
					throw new Error('tool exploded')
				},
			}),
		)
		const fn = createToolFunction(tools, 'boom')
		const error = await rejectionOf(fn(fakeController()))
		expect(error).toBeInstanceOf(Error)
		expect(error instanceof Error ? error.cause : undefined).toBe('tool exploded')
	})

	it('an UNREGISTERED tool name throws a typed TOOL WorkflowError', async () => {
		const tools = createToolManager()
		const fn = createToolFunction(tools, 'missing')
		const error = await rejectionOf(fn(fakeController()))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('TOOL')
		expect(isWorkflowError(error) ? error.context?.tool : undefined).toBe('missing')
	})

	it('composed into a real runner: a task whose `run` maps to a createToolFunction entry dispatches the tool for real', async () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'scan', execute: () => 'scanned' }))
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', run: 'scan' }] }],
		}
		const result = await runner().execute(definition, {
			functions: { scan: createToolFunction(tools, 'scan') },
		})
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t')?.result?.result).toEqual({
			success: true,
			value: 'scanned',
		})
	})
})

describe('createAgentFunction — wraps a live AgentInterface as a WorkflowFunction', () => {
	it('run: resolves the agent to its settled result, boxed as the task value', async () => {
		const agent = createAgent(createScriptedProvider([{ content: 'audited' }]))
		const fn = createAgentFunction(agent)
		const value = await fn(fakeController())
		const content = isRecord(value) ? value.content : undefined
		expect(content).toBe('audited')
	})

	it('abort fold: a mid-generate controller-signal abort cancels the agent (a partial resolves, never rejects)', async () => {
		// A real scripted provider that PARKS after its leading delta (via a slow per-turn delay) long
		// enough for the abort to fire mid-stream — proving the task controller's signal genuinely
		// folds into the agent's own generate() call (not a pre-check the provider never observes).
		const provider = createScriptedProvider([{ content: 'partial-content' }], { delay: 200 })
		const agent = createAgent(provider)
		const controller = new AbortController()
		const fn = createAgentFunction(agent)
		const running = fn(fakeController({ signal: controller.signal }))
		await waitForDelay(20)
		controller.abort(new Error('cancelled mid-generate'))
		const value = await running
		expect(isRecord(value) ? value.partial : undefined).toBe(true)
	})

	it('DEPTH on depth exceed: `depth + 1 > MAX_WORKFLOW_DEPTH` throws a typed DEPTH WorkflowError and never runs the agent', async () => {
		const provider = createScriptedProvider([{ content: 'x' }])
		const agent = createAgent(provider)
		const fn = createAgentFunction(agent, { depth: MAX_WORKFLOW_DEPTH })
		const error = await rejectionOf(fn(fakeController()))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('DEPTH')
		expect(provider.started).toBe(0)
	})

	it('DEPTH on ancestry cycle: an agent already present in the ancestry throws a typed DEPTH WorkflowError and never runs', async () => {
		const provider = createScriptedProvider([{ content: 'x' }])
		const agent = createAgent(provider)
		const fn = createAgentFunction(agent, { ancestry: [`agent:${agent.id}`] })
		const error = await rejectionOf(fn(fakeController()))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('DEPTH')
		expect(provider.started).toBe(0)
	})

	it('tool binding when `runner` is supplied: the agent context gains exactly one workflow tool under WORKFLOW_TOOL_NAME', async () => {
		const agent = createAgent(createScriptedProvider([{ content: 'audited' }]))
		expect(agent.context.tools.count).toBe(0)
		const fn = createAgentFunction(agent, { runner: runner() })
		await fn(fakeController())
		expect(agent.context.tools.count).toBe(1)
		expect(agent.context.tools.tool(WORKFLOW_TOOL_NAME)).toBeDefined()
	})

	it('composed into a real runner: a task whose `run` maps to a createAgentFunction entry dispatches the agent for real', async () => {
		const agent = createAgent(createScriptedProvider([{ content: 'audited' }]))
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', run: 'auditor' }] }],
		}
		const result = await runner().execute(definition, {
			functions: { auditor: createAgentFunction(agent) },
		})
		expect(result.status).toBe('completed')
		const value = result.workflow.phase('a')?.task('t')?.result?.result
		const content =
			value?.success === true && isRecord(value.value) ? value.value.content : undefined
		expect(content).toBe('audited')
	})
})

// ── createScheduler ──

describe('createScheduler', () => {
	it('returns a scheduler whose yield and delay round-trip', async () => {
		const scheduler = createScheduler()
		await expect(scheduler.yield()).resolves.toBeUndefined()
		const start = Date.now()
		await scheduler.delay(20)
		expect(Date.now() - start).toBeGreaterThanOrEqual(15)
	})

	it('its delay is abort-aware — a pre-aborted signal rejects with the reason', async () => {
		const scheduler = createScheduler()
		const controller = new AbortController()
		const reason = new Error('cancelled')
		controller.abort(reason)
		await expect(scheduler.delay(20, { signal: controller.signal })).rejects.toBe(reason)
		await waitForDelay(0)
		await expect(scheduler.yield()).resolves.toBeUndefined()
	})

	it('returns independent, stateless instances — aborting one does not affect another', async () => {
		const first = createScheduler()
		const second = createScheduler()
		const controller = new AbortController()
		const reason = new Error('only the first')
		controller.abort(reason)
		await expect(first.delay(20, { signal: controller.signal })).rejects.toBe(reason)
		await expect(second.yield()).resolves.toBeUndefined()
		await expect(second.delay(10)).resolves.toBeUndefined()
		await expect(first.yield()).resolves.toBeUndefined()
	})
})

// ── createWorkflowRunner — the injected-scheduler pattern ──

describe('createWorkflowRunner', () => {
	it('uses an INJECTED scheduler when supplied — no wall-clock pacing for a multi-phase run', async () => {
		const recording = createRecordingScheduler()
		const built = createWorkflowRunner({ scheduler: recording })
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [
				{ id: 'a', name: 'A', tasks: [{ id: 't0', name: 'T0', run: 'f' }] },
				{ id: 'b', name: 'B', tasks: [{ id: 't1', name: 'T1', run: 'f' }] },
			],
		}
		const order: string[] = []
		const result = await built.execute(definition, {
			functions: { f: (controller) => order.push(controller.task.id) },
		})
		expect(result.status).toBe('completed')
		expect(order).toEqual(['t0', 't1'])
		expect(recording.yields).toBeGreaterThanOrEqual(1)
	})

	it('carries NO functions/tools/agents registry of its own — a task with no `execute`-level functions auto-completes', async () => {
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', run: 'unregistered' }] }],
		}
		const result = await createWorkflowRunner().execute(definition)
		expect(result.status).toBe('completed')
		expect(result.workflow.phase('a')?.task('t')?.status).toBe('completed')
	})
})

describe('createRunner', () => {
	it('returns a working runner — fan-out via spawn with ordered results', async () => {
		const created = createRunner<number, number>({
			concurrency: 4,
			handler: (controller) => {
				if (controller.input < 10) controller.spawn(controller.input + 100)
				return controller.input
			},
		})
		const results = await created.execute([1, 2, 3])
		expect(results).toEqual([1, 2, 3, 101, 102, 103])
	})

	it('honours concurrency / retries options end to end', async () => {
		let attempts = 0
		const created = createRunner<string, string>({
			concurrency: 2,
			retries: 1,
			handler: (controller) => {
				if (controller.input === 'flaky') {
					attempts += 1
					if (attempts < 2) throw new Error('once')
				}
				return controller.input.toUpperCase()
			},
		})
		expect(await created.execute(['a', 'flaky', 'b'])).toEqual(['A', 'FLAKY', 'B'])
		expect(attempts).toBe(2)
	})
})
