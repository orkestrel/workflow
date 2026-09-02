import type {
	TaskEventMap,
	WorkflowDefinition,
	WorkflowFunction,
	WorkflowOptions,
	WorkflowSnapshot,
} from '@src/core'
import {
	cloneWorkflowSnapshot,
	createMemoryWorkflowStore,
	createScheduler,
	createWorkflow,
	createWorkflowContract,
	createWorkflowRunner,
	createWorkflowTree,
	captureWorkflowOptions,
	definitionToSnapshot,
	isWorkflowError,
	MAX_TIMER_MS,
	createRestoredWorkflow,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { captureError, createRecorder, createRecorders, waitForDelay } from '@orkestrel/test'
import type { TaskEvent } from '../../setup.js'
import { createRecordingScheduler, omitTaskActivity, TASK_EVENTS } from '../../setup.js'
import { createRunner } from '@src/core'

// A workflow runner paced by an INJECTED `createRecordingScheduler` (AGENTS §16 deterministic,
// not a mock of the runner — the unit under test runs in full). Per the redesign, the runner
// itself carries NO `functions` registry — behavior resolution rides `execute`'s options.
function runner(): ReturnType<typeof createWorkflowRunner> {
	return createWorkflowRunner({ scheduler: createRecordingScheduler() })
}

const ROUND_TRIP_TIMEOUT_MS = 30_000

// A fuller definition (two phases, three tasks, a concurrency throttle, an explicit bail) used by
// the createWorkflow / createRestoredWorkflow / snapshot-trio tests. Every `behavior` is a plain registry-name
// string resolved through the construction-time registry.
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
					{ id: 'task-compile', name: 'Compile', behavior: 'compile', retries: 2, timeout: 500 },
					{ id: 'task-scan', name: 'Scan', description: 'Security scan', behavior: 'scan' },
				],
			},
			{
				id: 'phase-review',
				name: 'Review',
				tasks: [{ id: 'task-audit', name: 'Audit', behavior: 'audit' }],
			},
		],
		...overrides,
	}
}

const RESTORE_FUNCTIONS = {
	compile: () => null,
	scan: () => null,
	audit: () => null,
}

const SHIFTED_FUNCTIONS = {
	compile: () => 'shifted compile',
	scan: () => 'shifted scan',
	audit: () => 'shifted audit',
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
			phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', behavior: 'f' }] }],
		}
		expect(contract.is(minimal)).toBe(true)
	})

	it('is() accepts an empty-phase and empty-task workflow', () => {
		expect(contract.is(localDefinition({ phases: [] }))).toBe(true)
		expect(contract.is(localDefinition({ phases: [{ id: 'p', name: 'P', tasks: [] }] }))).toBe(true)
	})

	it('is() accepts a task with an omitted `behavior` (no behavior reference)', () => {
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
			'task behavior is not a string (an object cannot coerce)',
			{
				id: 'w',
				name: 'X',
				phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', behavior: {} }] }],
			},
		],
		[
			'task behavior is an empty string',
			{
				id: 'w',
				name: 'X',
				phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', behavior: '' }] }],
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
		[
			'task timeout exceeds the host timer bound',
			{
				id: 'w',
				name: 'X',
				phases: [
					{
						id: 'p',
						name: 'P',
						tasks: [{ id: 't', name: 'T', timeout: MAX_TIMER_MS + 1 }],
					},
				],
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
		const definition = localDefinition()
		expect(contract.is(definition)).toBe(true)
		expect(contract.parse(definition)).toEqual(definition)
	})
})

// ── createWorkflow — builds the live tree (the W-b factory) ──

describe('createWorkflowTree — the shared construction path', () => {
	it('builds the same tree createWorkflow builds from the same definition and bag', () => {
		const definition = localDefinition()
		const captured = captureWorkflowOptions({ functions: RESTORE_FUNCTIONS })

		const direct = createWorkflowTree(definition, captured.bail, captured)
		const through = createWorkflow(definition, { functions: RESTORE_FUNCTIONS })

		// The `created` / `updated` stamps are wall-clock, so the structural payload is what the two
		// paths must agree on.
		expect(direct.snapshot().phases).toEqual(through.snapshot().phases)
		expect([direct.id, direct.name, direct.description, direct.bail]).toEqual([
			through.id,
			through.name,
			through.description,
			through.bail,
		])
	})

	it('takes the definition policy when the override is undefined', () => {
		const captured = captureWorkflowOptions({})

		const graceful = createWorkflowTree(localDefinition({ bail: false }), captured.bail, captured)
		const halting = createWorkflowTree(localDefinition({ bail: true }), captured.bail, captured)

		expect(graceful.bail).toBe(false)
		expect(halting.bail).toBe(true)
	})

	it('seeds the override onto the workflow and every inheriting phase', () => {
		const captured = captureWorkflowOptions({ bail: true })

		const workflow = createWorkflowTree(localDefinition({ bail: false }), captured.bail, captured)

		expect(workflow.bail).toBe(true)
		expect(workflow.phases.phases().map((phase) => phase.bail)).toEqual([true, true])
	})

	it('leaves a phase declaring its own policy alone', () => {
		const captured = captureWorkflowOptions({})
		const definition = localDefinition({
			bail: false,
			phases: [
				{ id: 'strict', name: 'Strict', bail: true, tasks: [] },
				{ id: 'lenient', name: 'Lenient', tasks: [] },
			],
		})

		const workflow = createWorkflowTree(definition, captured.bail, captured)

		expect(workflow.phases.phases().map((phase) => phase.bail)).toEqual([true, false])
	})

	it('resolves each task handler from the bag it is handed', () => {
		const captured = captureWorkflowOptions({ functions: RESTORE_FUNCTIONS })

		const workflow = createWorkflowTree(localDefinition(), captured.bail, captured)

		expect(workflow.phase('phase-build')?.task('task-compile')?.handler).toBe(
			RESTORE_FUNCTIONS.compile,
		)
	})
})

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

	it('captures a shifting bail accessor once so root and inherited phase policy agree', () => {
		let reads = 0
		const options: WorkflowOptions = {}
		Object.defineProperty(options, 'bail', {
			get: () => {
				reads += 1
				return reads === 1
			},
		})

		const workflow = createWorkflow(localDefinition({ bail: false }), options)

		expect(reads).toBe(1)
		expect(workflow.bail).toBe(true)
		expect(workflow.phases.phases().map((phase) => phase.bail)).toEqual([true, true])
	})

	it('captures a shifting functions registry once and resolves every fresh handler from it', () => {
		let reads = 0
		const options: WorkflowOptions = {}
		Object.defineProperty(options, 'functions', {
			get: () => {
				reads += 1
				return reads === 1 ? RESTORE_FUNCTIONS : SHIFTED_FUNCTIONS
			},
		})

		const workflow = createWorkflow(localDefinition(), options)

		expect(reads).toBe(1)
		expect(workflow.phase('phase-build')?.task('task-compile')?.handler).toBe(
			RESTORE_FUNCTIONS.compile,
		)
		expect(workflow.phase('phase-build')?.task('task-scan')?.handler).toBe(RESTORE_FUNCTIONS.scan)
		expect(workflow.phase('phase-review')?.task('task-audit')?.handler).toBe(
			RESTORE_FUNCTIONS.audit,
		)
	})

	it(
		'PROGRAMMATIC-FIRST: a task whose `behavior` resolves against `options.functions` runs the real handler at construction time (via a live runner)',
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

	it('an absent or unresolved `behavior` has no handler, with execution distinguishing the two', () => {
		const workflow = createWorkflow(localDefinition(), { functions: {} })
		expect(workflow.phase('phase-build')?.task('task-compile')?.handler).toBeUndefined()
	})
})

// ── createRestoredWorkflow / cloneWorkflowSnapshot — the round-trip inverse ──

describe('createRestoredWorkflow / cloneWorkflowSnapshot — the round-trip inverse', () => {
	it('captures a shifting functions registry once for every restored handler', () => {
		let reads = 0
		const options: WorkflowOptions = {}
		Object.defineProperty(options, 'functions', {
			get: () => {
				reads += 1
				return reads === 1 ? RESTORE_FUNCTIONS : SHIFTED_FUNCTIONS
			},
		})
		const snapshot = createWorkflow(localDefinition()).snapshot()

		const restored = createRestoredWorkflow(snapshot, options)

		expect(reads).toBe(1)
		expect(restored.phase('phase-build')?.task('task-compile')?.handler).toBe(
			RESTORE_FUNCTIONS.compile,
		)
		expect(restored.phase('phase-build')?.task('task-scan')?.handler).toBe(RESTORE_FUNCTIONS.scan)
		expect(restored.phase('phase-review')?.task('task-audit')?.handler).toBe(
			RESTORE_FUNCTIONS.audit,
		)
	})

	it('createRestoredWorkflow rebuilds an equivalent tree from a snapshot', () => {
		const workflow = createWorkflow(localDefinition({ bail: true }))
		const compile = workflow.phase('phase-build')?.task('task-compile')
		compile?.start()
		compile?.complete('built')
		const restored = createRestoredWorkflow(workflow.snapshot(), {
			bail: true,
			functions: RESTORE_FUNCTIONS,
		})
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
			const restored = createRestoredWorkflow(snapshot, { functions: { compile, scan: () => 's' } })
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

	it('createRestoredWorkflow preserves an unresolved behavior reference for inspection', () => {
		const snapshot = createWorkflow(localDefinition()).snapshot()
		const restored = createRestoredWorkflow(snapshot)
		expect(restored.phase('phase-build')?.task('task-compile')?.behavior).toBe('compile')
		expect(restored.phase('phase-build')?.task('task-compile')?.handler).toBeUndefined()
		expect(() => runner().execute(restored)).toThrow(/not drivable/)
	})

	it("SNAPSHOT TRIO round-trip: a definition's behavior/retries/timeout survive definitionToSnapshot → live tree → snapshot() → restore", () => {
		const definition = localDefinition()
		const snapshot = definitionToSnapshot(definition, false)
		const compileSnap = snapshot.phases[0]?.tasks[0]
		expect(compileSnap?.behavior).toBe('compile')
		expect(compileSnap?.retries).toBe(2)
		expect(compileSnap?.timeout).toBe(500)

		const workflow = createWorkflow(definition)
		const liveSnapshot = workflow.snapshot()
		const liveCompile = liveSnapshot.phases[0]?.tasks[0]
		expect(liveCompile?.behavior).toBe('compile')
		expect(liveCompile?.retries).toBe(2)
		expect(liveCompile?.timeout).toBe(500)

		const restored = createRestoredWorkflow(liveSnapshot, { functions: RESTORE_FUNCTIONS })
		const restoredCompile = restored.phase('phase-build')?.task('task-compile')
		expect(restoredCompile?.behavior).toBe('compile')
		expect(restoredCompile?.retries).toBe(2)
		expect(restoredCompile?.timeout).toBe(500)
	})

	it('cloneWorkflowSnapshot passes a valid snapshot and rejects an invalid status', () => {
		const snapshot = createWorkflow(localDefinition()).snapshot()
		expect(captureError(() => cloneWorkflowSnapshot(snapshot))).toBeUndefined()
		const broken = { ...snapshot, status: 'bogus' }
		const error = captureError(() => cloneWorkflowSnapshot(JSON.parse(JSON.stringify(broken))))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('RESTORE')
	})

	it('accepts concurrent task completion order and forced gaps in the phase frontier', () => {
		const concurrent = createWorkflow({
			id: 'concurrent',
			name: 'Concurrent',
			phases: [
				{
					id: 'phase',
					name: 'Phase',
					tasks: [
						{ id: 'pending', name: 'Pending' },
						{ id: 'completed', name: 'Completed' },
					],
				},
			],
		})
		const completed = concurrent.phase('phase')?.task('completed')
		if (completed === undefined) throw new Error('expected completed task')
		completed.start()
		completed.complete(null)
		expect(captureError(() => cloneWorkflowSnapshot(concurrent.snapshot()))).toBeUndefined()

		const phases = createWorkflow({
			id: 'frontier',
			name: 'Frontier',
			phases: [
				{ id: 'first', name: 'First', tasks: [{ id: 'a', name: 'A' }] },
				{ id: 'forced', name: 'Forced', tasks: [{ id: 'b', name: 'B' }] },
				{ id: 'later', name: 'Later', tasks: [{ id: 'c', name: 'C' }] },
			],
		})
		phases.phase('forced')?.skip()
		expect(captureError(() => cloneWorkflowSnapshot(phases.snapshot()))).toBeUndefined()
		phases.phase('first')?.task('a')?.start()
		expect(captureError(() => cloneWorkflowSnapshot(phases.snapshot()))).toBeUndefined()
	})

	it('rejects a genuinely started later phase beyond the sequential frontier', () => {
		const workflow = createWorkflow({
			id: 'invalid-frontier',
			name: 'Invalid frontier',
			phases: [
				{ id: 'pending', name: 'Pending', tasks: [{ id: 'a', name: 'A' }] },
				{ id: 'later', name: 'Later', tasks: [{ id: 'b', name: 'B' }] },
			],
		})
		workflow.phase('later')?.task('b')?.start()
		expect(isWorkflowError(captureError(() => workflow.snapshot()))).toBe(true)
	})

	it('round-trips the completed override used by an executed no-op workflow', async () => {
		const store = createMemoryWorkflowStore()
		const result = await runner().execute(
			{
				id: 'empty',
				name: 'Empty',
				phases: [{ id: 'phase', name: 'Phase', tasks: [] }],
			},
			{ store },
		)
		expect(result.status).toBe('completed')
		expect(result.durable).toBe(true)
		const snapshot = result.workflow.snapshot()
		expect(snapshot.override).toBe('completed')
		const persisted = await store.get('empty')
		expect(persisted).toEqual(snapshot)
		expect(createRestoredWorkflow(persisted).status).toBe('completed')
	})

	it('rejects a hostile completed override on work or a non-pending derived tree', () => {
		const pending = createWorkflow(localDefinition()).snapshot()
		expect(
			isWorkflowError(
				captureError(() =>
					cloneWorkflowSnapshot({ ...pending, status: 'completed', override: 'completed' }),
				),
			),
		).toBe(true)

		const skipped = createWorkflow({
			id: 'skipped-empty',
			name: 'Skipped empty',
			phases: [{ id: 'phase', name: 'Phase', tasks: [] }],
		})
		skipped.phase('phase')?.skip()
		const skippedSnapshot = skipped.snapshot()
		expect(
			isWorkflowError(
				captureError(() =>
					cloneWorkflowSnapshot({
						...skippedSnapshot,
						status: 'completed',
						override: 'completed',
					}),
				),
			),
		).toBe(true)
	})

	it('enforces pending/running/terminal activity consistency and restores without an armed silence timer', async () => {
		const workflow = createWorkflow(localDefinition())
		const pending = workflow.snapshot()
		const pendingPhase = pending.phases[0]
		if (pendingPhase === undefined) throw new Error('expected pending phase snapshot')
		const pendingTask = pendingPhase.tasks[0]
		if (pendingTask === undefined) throw new Error('expected pending task snapshot')
		const invalidPending: WorkflowSnapshot = {
			...pending,
			phases: [
				{
					...pendingPhase,
					tasks: [
						{
							...pendingTask,
							activity: { operations: [], constraints: [], updated: 0 },
						},
					],
				},
			],
		}
		expect(isWorkflowError(captureError(() => cloneWorkflowSnapshot(invalidPending)))).toBe(true)

		const liveTask = workflow.phase('phase-build')?.task('task-compile')
		if (liveTask === undefined) throw new Error('expected live task')
		liveTask.start()
		const running = workflow.snapshot()
		expect(captureError(() => cloneWorkflowSnapshot(running))).toBeUndefined()
		const runningPhase = running.phases[0]
		if (runningPhase === undefined) throw new Error('expected running phase snapshot')
		const runningTask = runningPhase.tasks[0]
		if (runningTask === undefined) throw new Error('expected running task snapshot')
		const invalidRunning: WorkflowSnapshot = {
			...running,
			phases: [
				{
					...runningPhase,
					tasks: [omitTaskActivity(runningTask)],
				},
			],
		}
		expect(isWorkflowError(captureError(() => cloneWorkflowSnapshot(invalidRunning)))).toBe(true)

		const restored = createRestoredWorkflow(running, {
			silence: 10,
			functions: RESTORE_FUNCTIONS,
		})
		const restoredTask = restored.phase('phase-build')?.task('task-compile')
		if (restoredTask === undefined) throw new Error('expected restored task')
		const events = createRecorders<TaskEventMap, TaskEvent>(restoredTask.emitter, TASK_EVENTS)
		await waitForDelay(20)
		expect(events.silence.count).toBe(0)

		liveTask.complete('done')
		const terminal = workflow.snapshot()
		expect(captureError(() => cloneWorkflowSnapshot(terminal))).toBeUndefined()
		const terminalPhase = terminal.phases[0]
		if (terminalPhase === undefined) throw new Error('expected terminal phase snapshot')
		const terminalTask = terminalPhase.tasks[0]
		if (terminalTask === undefined) throw new Error('expected terminal task snapshot')
		const terminalWithoutActivity: WorkflowSnapshot = {
			...terminal,
			phases: [
				{
					...terminalPhase,
					tasks: [omitTaskActivity(terminalTask), ...terminalPhase.tasks.slice(1)],
				},
				...terminal.phases.slice(1),
			],
		}
		expect(
			isWorkflowError(captureError(() => cloneWorkflowSnapshot(terminalWithoutActivity))),
		).toBe(true)

		const failedWorkflow = createWorkflow(localDefinition())
		const failedTask = failedWorkflow.phase('phase-build')?.task('task-compile')
		if (failedTask === undefined) throw new Error('expected failed task')
		failedTask.start()
		failedTask.fail({ origin: 'handler', message: 'failed' })
		const failed = failedWorkflow.snapshot()
		const failedPhase = failed.phases[0]
		if (failedPhase === undefined) throw new Error('expected failed phase snapshot')
		const failedSnapshot = failedPhase.tasks[0]
		if (failedSnapshot === undefined) throw new Error('expected failed snapshot')
		const failedWithoutActivity: WorkflowSnapshot = {
			...failed,
			phases: [
				{
					...failedPhase,
					tasks: [omitTaskActivity(failedSnapshot), ...failedPhase.tasks.slice(1)],
				},
				...failed.phases.slice(1),
			],
		}
		expect(isWorkflowError(captureError(() => cloneWorkflowSnapshot(failedWithoutActivity)))).toBe(
			true,
		)
	})

	it('cloneWorkflowSnapshot rejects a PhaseSnapshot with a non-boolean bail (naming the phase)', () => {
		const snapshot = createWorkflow(localDefinition()).snapshot()
		const firstPhase = snapshot.phases[0]
		if (firstPhase === undefined) throw new Error('expected at least one phase')
		const broken = {
			...snapshot,
			phases: [{ ...firstPhase, bail: 'nope' }, ...snapshot.phases.slice(1)],
		}
		const error = captureError(() => cloneWorkflowSnapshot(JSON.parse(JSON.stringify(broken))))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('RESTORE')
		expect(isWorkflowError(error) ? error.context?.phase : undefined).toBe(firstPhase.id)
	})

	it('cloneWorkflowSnapshot rejects a TaskSnapshot with an empty `behavior`, a negative `retries`, or a fractional `timeout` (naming the task)', () => {
		const snapshot = createWorkflow(localDefinition()).snapshot()
		const firstPhase = snapshot.phases[0]
		if (firstPhase === undefined) throw new Error('expected at least one phase')
		const firstTask = firstPhase.tasks[0]
		if (firstTask === undefined) throw new Error('expected at least one task')

		const badRun = {
			...snapshot,
			phases: [
				{
					...firstPhase,
					tasks: [{ ...firstTask, behavior: '' }, ...firstPhase.tasks.slice(1)],
				},
				...snapshot.phases.slice(1),
			],
		}
		const runError = captureError(() => cloneWorkflowSnapshot(JSON.parse(JSON.stringify(badRun))))
		expect(isWorkflowError(runError) ? runError.code : undefined).toBe('RESTORE')

		const badRetries = {
			...snapshot,
			phases: [
				{
					...firstPhase,
					tasks: [{ ...firstTask, retries: -1 }, ...firstPhase.tasks.slice(1)],
				},
				...snapshot.phases.slice(1),
			],
		}
		const retriesError = captureError(() =>
			cloneWorkflowSnapshot(JSON.parse(JSON.stringify(badRetries))),
		)
		expect(isWorkflowError(retriesError) ? retriesError.code : undefined).toBe('RESTORE')
		expect(isWorkflowError(retriesError) ? retriesError.context?.task : undefined).toBe(
			firstTask.id,
		)

		const badTimeout = {
			...snapshot,
			phases: [
				{
					...firstPhase,
					tasks: [{ ...firstTask, timeout: 1.5 }, ...firstPhase.tasks.slice(1)],
				},
				...snapshot.phases.slice(1),
			],
		}
		const timeoutError = captureError(() =>
			cloneWorkflowSnapshot(JSON.parse(JSON.stringify(badTimeout))),
		)
		expect(isWorkflowError(timeoutError) ? timeoutError.code : undefined).toBe('RESTORE')

		const overmaxTimeout = {
			...snapshot,
			phases: [
				{
					...firstPhase,
					tasks: [{ ...firstTask, timeout: MAX_TIMER_MS + 1 }, ...firstPhase.tasks.slice(1)],
				},
				...snapshot.phases.slice(1),
			],
		}
		const overmaxError = captureError(() =>
			cloneWorkflowSnapshot(JSON.parse(JSON.stringify(overmaxTimeout))),
		)
		expect(isWorkflowError(overmaxError) ? overmaxError.code : undefined).toBe('RESTORE')
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
	it('uses an INJECTED scheduler when supplied and records multi-phase pacing', async () => {
		const recording = createRecordingScheduler()
		const built = createWorkflowRunner({ scheduler: recording })
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [
				{ id: 'a', name: 'A', tasks: [{ id: 't0', name: 'T0', behavior: 'f' }] },
				{ id: 'b', name: 'B', tasks: [{ id: 't1', name: 'T1', behavior: 'f' }] },
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

	it('rejects a named task when execute has no functions registry', () => {
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			phases: [{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', behavior: 'unregistered' }] }],
		}
		expect(() => createWorkflowRunner().execute(definition)).toThrow(/not drivable/)
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
