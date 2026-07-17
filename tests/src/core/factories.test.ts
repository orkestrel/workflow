import type { WorkflowDefinition, WorkflowFunction } from '@src/core'
import {
	assertSnapshot,
	createScheduler,
	createWorkflow,
	createWorkflowContract,
	createWorkflowRunner,
	definitionToSnapshot,
	isWorkflowError,
	restoreWorkflow,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	captureError,
	createRecorder,
	createRecordingScheduler,
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
