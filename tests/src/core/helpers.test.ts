import { RECOVERY_POLICY_CASES, WORKFLOW_BAIL_CASES } from '../../setup.js'
import type {
	PhaseDerivation,
	TaskResult,
	LifecycleStatus,
	WorkflowDefinition,
	WorkflowOptions,
	WorkflowRegistry,
} from '@src/core'
import {
	WorkflowError,
	buildPhaseContext,
	buildTaskContext,
	buildWorkflowContext,
	canTransitionTask,
	captureWorkflowOptions,
	collectResults,
	createWorkflow,
	definitionToSnapshot,
	deriveBoundary,
	derivePhaseStatus,
	deriveWorkflowStatus,
	findFailure,
	insertEntry,
	isTerminalStatus,
	isWorkflowError,
	moveEntry,
	parkSignal,
	phaseDefinitionToSnapshot,
	createRecoveredWorkflow,
	resolveTaskSilence,
	createRestoredWorkflow,
	createHostSchedule,
	taskDefinitionToSnapshot,
	admitDefinition,
	describeWorkflowFaults,
	scanSchemaNode,
	taskDefinitionContract,
	WORKFLOW_REFUSAL_LIMIT,
	MAX_TIMER_MS,
	requireConcurrency,
	requireRunnable,
	requireTimerBound,
	admitPatch,
	phaseUpdateContract,
	scanDuplicateIds,
	taskUpdateContract,
	workflowContract,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { isAbortSignal, linkSignal } from '@orkestrel/abort'
import { FAULT_LIMIT, admitValue, failure, success } from '@orkestrel/contract'
import { captureError, createRecorder, waitForDelay } from '@orkestrel/test'
import {
	createErrorRecorder,
	WorkflowObservation,
	createDurabilityRunner,
	buildPhaseDerivations,
	enumerateStatusOrders,
	buildCompletedResult,
	buildOutcomeResult,
	EVERY_STATUS,
	RECOVERY_DEFINITION,
	VALIDATED_FUNCTIONS,
	RECOVERY_SHIFTED_FUNCTIONS,
	PHASE_STATUS_CASES,
	WORKFLOW_STATUS_CASES,
	WORKFLOW_AGNOSTIC_CASES,
	RECOVERY_MIXED_FUNCTIONS,
	buildHostileWorkflow,
	buildCountedRegistry,
	buildAppendedWorkflow,
	buildMisspeltDefinition,
	buildRepairableDefinition,
	createRecordedContract,
	buildShiftingDefinition,
	INVALID_CONCURRENCIES,
	INVALID_TIMER_BOUNDS,
} from '../../setup.js'

// The lifecycle logic core: the derivation truth tables under BOTH bail modes, the ONE
// terminal predicate, and the task-form `via` guards. Pure functions — real inputs, no
// mocks. The derivation tables are EXHAUSTIVE by equivalence class: every
// branch of `derivePhaseStatus` / `deriveWorkflowStatus` is pinned by a discriminating
// row, so the truth table is provably complete rather than sampled.

// The whole shared lifecycle vocabulary — the six literals every tier draws from. Used to
// prove the ONE terminal predicate covers the entire set (no literal left untested).

describe('captureWorkflowOptions — one-read hostile option ownership', () => {
	it('captures inherited and non-enumerable values once while retaining nested identities', () => {
		const onReads = new WorkflowObservation(0)
		const bailReads = new WorkflowObservation(0)
		const errorReads = new WorkflowObservation(0)
		const phasesReads = new WorkflowObservation(0)
		const functionsReads = new WorkflowObservation(0)
		const silenceReads = new WorkflowObservation(0)
		const on = {}
		const errors = createErrorRecorder()
		const phases = {}
		const functions = {}
		const options: WorkflowOptions = {}
		const prototype = {}
		Object.defineProperties(prototype, {
			on: {
				get: () => {
					onReads.value += 1
					return on
				},
			},
			bail: {
				get: () => {
					bailReads.value += 1
					return true
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
		Object.defineProperties(options, {
			phases: {
				enumerable: false,
				get: () => {
					phasesReads.value += 1
					return phases
				},
			},
			functions: {
				enumerable: false,
				get: () => {
					functionsReads.value += 1
					return functions
				},
			},
			silence: {
				enumerable: false,
				get: () => {
					silenceReads.value += 1
					return 25
				},
			},
		})

		const captured = captureWorkflowOptions(options)

		expect(captured).not.toBe(options)
		expect(captured.on).toBe(on)
		expect(captured.bail).toBe(true)
		expect(captured.error).toBe(errors.handler)
		expect(captured.phases).toBe(phases)
		expect(captured.functions).toBe(functions)
		expect(captured.silence).toBe(25)
		expect([
			onReads.value,
			bailReads.value,
			errorReads.value,
			phasesReads.value,
			functionsReads.value,
			silenceReads.value,
		]).toEqual([1, 1, 1, 1, 1, 1])
	})

	it('stops reading at the first throwing option getter', () => {
		const reads: string[] = []
		const fault = new Error('bail unavailable')
		const options: WorkflowOptions = {}
		Object.defineProperties(options, {
			on: {
				get: () => {
					reads.push('on')
					return {}
				},
			},
			bail: {
				get: () => {
					reads.push('bail')
					throw fault
				},
			},
			error: {
				get: () => {
					reads.push('error')
					return undefined
				},
			},
			phases: {
				get: () => {
					reads.push('phases')
					return {}
				},
			},
			functions: {
				get: () => {
					reads.push('functions')
					return {}
				},
			},
			silence: {
				get: () => {
					reads.push('silence')
					return 25
				},
			},
		})

		expect(captureError(() => captureWorkflowOptions(options))).toBe(fault)
		expect(reads).toEqual(['on', 'bail'])
	})
})

describe('isTerminalStatus — the ONE terminal check across all three tiers', () => {
	it('is true for the four terminal states', () => {
		expect(isTerminalStatus('completed')).toBe(true)
		expect(isTerminalStatus('failed')).toBe(true)
		expect(isTerminalStatus('skipped')).toBe(true)
		expect(isTerminalStatus('stopped')).toBe(true)
	})

	it('is false for the two non-terminal states', () => {
		expect(isTerminalStatus('pending')).toBe(false)
		expect(isTerminalStatus('running')).toBe(false)
	})

	it('classifies every lifecycle literal (exhaustive — terminal ⇔ not pending/running)', () => {
		// One predicate over the shared LifecycleStatus set: a status is terminal exactly when it
		// is neither `pending` nor `running`. Asserting against that independent definition over the
		// WHOLE vocabulary proves no literal is misclassified (and that none was missed).
		for (const status of EVERY_STATUS) {
			expect(isTerminalStatus(status)).toBe(status !== 'pending' && status !== 'running')
		}
	})

	it('rules on a status read from a task, a phase, and a workflow through one predicate', () => {
		// Task, phase, and workflow all carry one LifecycleStatus, so every position feeds the same
		// predicate — this is the consolidation's whole point (no per-tier terminal duplication).
		const fromTask: LifecycleStatus = 'completed'
		const fromPhase: LifecycleStatus = 'running'
		const fromWorkflow: LifecycleStatus = 'failed'
		expect(isTerminalStatus(fromTask)).toBe(true)
		expect(isTerminalStatus(fromPhase)).toBe(false)
		expect(isTerminalStatus(fromWorkflow)).toBe(true)
	})
})

describe('derivePhaseStatus — exhaustive truth table (tasks concurrent)', () => {
	// Every equivalence class of the phase derivation, by branch:
	//   empty → pending · all-pending → pending · not-all-terminal → running ·
	//   then most-severe terminal wins: failed > stopped > completed > skipped.

	for (const [tasks, expected, label] of PHASE_STATUS_CASES) {
		it(`[${tasks.join(', ') || '∅'}] → ${expected} (${label})`, () => {
			expect(derivePhaseStatus(tasks)).toBe(expected)
		})
	}

	it('is order-insensitive — every permutation of a mixed input derives the same status', () => {
		// Tasks are concurrent, so the reduction must not depend on order. Assert it over EVERY
		// permutation of a four-terminal mix (the strongest order-independence claim, not one shuffle).
		const base: readonly LifecycleStatus[] = ['failed', 'completed', 'skipped', 'stopped']
		for (const permutation of enumerateStatusOrders(base)) {
			expect(derivePhaseStatus(permutation)).toBe('failed')
		}
		// And a non-terminal mix whose answer is `running` regardless of order.
		const mixed: readonly LifecycleStatus[] = ['completed', 'running', 'pending']
		for (const permutation of enumerateStatusOrders(mixed)) {
			expect(derivePhaseStatus(permutation)).toBe('running')
		}
	})
})

// Build the PhaseDerivation[] input from a list of statuses, tagging EVERY phase with the SAME
// effective `bail` — the legacy "one scalar bail" the old signature took, carried per phase.
// A uniform bail reproduces the old behavior exactly; the per-phase divergence is exercised by the
// `mixed-bail` rows below (and end-to-end in WorkflowRunner.test.ts).

describe('deriveWorkflowStatus — exhaustive truth table under BOTH bail modes', () => {
	// The workflow derivation differs from the phase only in the FAILED handling, which `bail`
	// gates PER PHASE. Each row pins one equivalence class under a specific (uniform) `bail`; the
	// bail-agnostic classes are asserted under BOTH modes (below) to prove `bail` touches ONLY
	// failure. A trailing MIXED-bail block proves the policy is resolved per phase, not globally.

	for (const { input, bail, expected, label } of WORKFLOW_STATUS_CASES) {
		it(`[${input.join(', ') || '∅'}] @ bail:${bail} → ${expected} (${label})`, () => {
			expect(deriveWorkflowStatus(buildPhaseDerivations(input, bail))).toBe(expected)
		})
	}

	// The bail-AGNOSTIC classes — every branch that does NOT involve a failed phase. Asserted
	// under BOTH modes with the SAME expected value, proving `bail` changes only the failed path.

	for (const [input, expected, label] of WORKFLOW_AGNOSTIC_CASES) {
		for (const bail of WORKFLOW_BAIL_CASES) {
			it(`[${input.join(', ') || '∅'}] @ bail:${bail} → ${expected} (bail-agnostic: ${label})`, () => {
				expect(deriveWorkflowStatus(buildPhaseDerivations(input, bail))).toBe(expected)
			})
		}
	}

	it('bail is the ONLY axis that changes an outcome — same graph, failed differs', () => {
		// A phase graph with exactly one failed phase among terminals: graceful folds it into
		// `completed`, halt propagates `failed`. The two modes diverge ONLY because of the failure.
		const phases: readonly LifecycleStatus[] = ['completed', 'failed', 'completed']
		expect(deriveWorkflowStatus(buildPhaseDerivations(phases, false))).toBe('completed')
		expect(deriveWorkflowStatus(buildPhaseDerivations(phases, true))).toBe('failed')
	})

	it('a failed-free graph is identical under both modes (no divergence without a failure)', () => {
		const graphs: ReadonlyArray<readonly LifecycleStatus[]> = [
			[],
			['running', 'pending'],
			['completed', 'skipped'],
			['stopped', 'completed'],
			['skipped', 'skipped'],
		]
		for (const input of graphs) {
			expect(deriveWorkflowStatus(buildPhaseDerivations(input, false))).toBe(
				deriveWorkflowStatus(buildPhaseDerivations(input, true)),
			)
		}
	})

	it('is order-insensitive under both modes (phases are a settled set here)', () => {
		const base: readonly LifecycleStatus[] = ['failed', 'completed', 'stopped']
		for (const permutation of enumerateStatusOrders(base)) {
			expect(deriveWorkflowStatus(buildPhaseDerivations(permutation, true))).toBe('failed') // failed dominates under halt
			expect(deriveWorkflowStatus(buildPhaseDerivations(permutation, false))).toBe('stopped') // stop beats a folded fail
		}
	})

	// ── PER-PHASE bail (the per-phase override) — the failure outcome is resolved per phase, not globally ──
	describe('per-phase bail — each phase carries its OWN effective policy', () => {
		// Explicit PhaseDerivation rows where the `bail` flags DIVERGE between phases. These can ONLY
		// be expressed with the per-phase signature — they prove the workflow `failed` derivation is
		// per-phase-bail-aware (a strict-bail failed phase halts even beside a graceful one).
		const mixedCases: ReadonlyArray<
			readonly [readonly PhaseDerivation[], LifecycleStatus, string]
		> = [
			[
				[
					{ status: 'failed', bail: true },
					{ status: 'completed', bail: false },
				],
				'failed',
				'a strict-bail failed phase halts even beside a graceful completed phase',
			],
			[
				[
					{ status: 'failed', bail: false },
					{ status: 'completed', bail: false },
				],
				'completed',
				'a graceful-bail failed phase folds into completion',
			],
			[
				[
					{ status: 'failed', bail: false },
					{ status: 'failed', bail: true },
				],
				'failed',
				'ANY strict-bail failed phase halts, even beside a graceful-bail failed one',
			],
		]
		for (const [input, expected, label] of mixedCases) {
			it(`${label} → ${expected}`, () => {
				expect(deriveWorkflowStatus(input)).toBe(expected)
			})
		}

		it('is order-insensitive across a mixed-bail permutation (a strict-bail failed phase always halts)', () => {
			// One graceful failed phase, one strict failed phase, one completed — the strict-bail failure
			// dominates regardless of order, proving the reduction reads each phase's OWN bail, not a position.
			const base: readonly PhaseDerivation[] = [
				{ status: 'failed', bail: false },
				{ status: 'failed', bail: true },
				{ status: 'completed', bail: false },
			]
			for (const permutation of enumerateStatusOrders(base)) {
				expect(deriveWorkflowStatus(permutation)).toBe('failed')
			}
		})
	})
})

// Every permutation of a small status list — the order-independence prover (a real generator,
// not a mock). Kept local: order-permutation is specific to these derivation tests.

describe('canTransitionTask — the legal transition graph', () => {
	it('allows the legal moves off pending and running', () => {
		const pending: readonly LifecycleStatus[] = ['running', 'skipped', 'stopped']
		const running: readonly LifecycleStatus[] = ['completed', 'failed', 'skipped', 'stopped']
		for (const to of pending) {
			expect(canTransitionTask('pending', to)).toBe(true)
		}
		for (const to of running) {
			expect(canTransitionTask('running', to)).toBe(true)
		}
	})

	it('rejects starting / completing the wrong source state', () => {
		expect(canTransitionTask('pending', 'completed')).toBe(false) // must start first
		expect(canTransitionTask('pending', 'failed')).toBe(false) // a pending task can't fail
		expect(canTransitionTask('running', 'running')).toBe(false) // no self-loop
		expect(canTransitionTask('running', 'pending')).toBe(false) // never un-starts
		expect(canTransitionTask('completed', 'pending')).toBe(false)
	})

	it('every terminal status is a dead end', () => {
		const terminal: readonly LifecycleStatus[] = ['completed', 'failed', 'skipped', 'stopped']
		for (const from of terminal) {
			for (const to of EVERY_STATUS) expect(canTransitionTask(from, to)).toBe(false)
		}
	})
})

describe('collectResults — the workflow tier of the result tree', () => {
	it('flattens per-phase result lists in order', () => {
		expect(
			collectResults([
				[buildCompletedResult('a'), buildCompletedResult('b')],
				[],
				[buildCompletedResult('c')],
			]).map((one) => one.task.id),
		).toEqual(['a', 'b', 'c'])
	})

	it('is empty for no results', () => {
		expect(collectResults([[], []])).toEqual([])
		expect(collectResults([])).toEqual([])
	})
})

describe('lineage context builders (the chain UP the tree)', () => {
	it('builds the workflow → phase → task chain with back-references', () => {
		const workflow = buildWorkflowContext({ id: 'w', name: 'W', description: 'desc' })
		const phase = buildPhaseContext(workflow, { id: 'p', name: 'P' })
		const task = buildTaskContext(phase, { id: 't', name: 'T' })
		expect(workflow).toEqual({ id: 'w', name: 'W', description: 'desc' })
		expect(phase.workflow).toEqual(workflow)
		expect(phase.workflow).not.toBe(workflow)
		expect(task.phase).toEqual(phase)
		expect(task.phase).not.toBe(phase)
		expect(task.phase.workflow.id).toBe('w')
		expect(Object.isFrozen(workflow)).toBe(true)
		expect(Object.isFrozen(phase)).toBe(true)
		expect(Object.isFrozen(phase.workflow)).toBe(true)
		expect(Object.isFrozen(task)).toBe(true)
		expect(Object.isFrozen(task.phase)).toBe(true)
		expect(Object.isFrozen(task.phase.workflow)).toBe(true)
	})

	it('omits an absent description rather than storing undefined', () => {
		expect('description' in buildWorkflowContext({ id: 'w', name: 'W' })).toBe(false)
	})
})

describe('definitionToSnapshot — the initial, all-pending construction input', () => {
	const definition: WorkflowDefinition = {
		id: 'w',
		name: 'W',
		description: 'top',
		phases: [
			{
				id: 'p',
				name: 'P',
				concurrency: 2,
				tasks: [
					{
						id: 't',
						name: 'T',
						description: 'leaf',
						behavior: 'x',
						retries: 2,
						timeout: 500,
					},
				],
			},
		],
	}

	it('seeds every node pending, and PERSISTS declarative fields (concurrency, and the task trio behavior/retries/timeout)', () => {
		const snapshot = definitionToSnapshot(definition)
		expect(snapshot.status).toBe('pending')
		expect(snapshot.description).toBe('top')
		expect(snapshot.phases[0]?.status).toBe('pending')
		expect(snapshot.phases[0]?.tasks[0]?.status).toBe('pending')
		expect(snapshot.phases[0]?.tasks[0]?.metadata).toEqual({})
		// Concurrency is declarative phase configuration and persists, like bail.
		expect(snapshot.phases[0]?.concurrency).toBe(2)
		// The declarative task trio PERSISTS in the snapshot (like bail/concurrency) — no longer
		// execution-only.
		expect(snapshot.phases[0]?.tasks[0]?.behavior).toBe('x')
		expect(snapshot.phases[0]?.tasks[0]?.retries).toBe(2)
		expect(snapshot.phases[0]?.tasks[0]?.timeout).toBe(500)
		expect(JSON.stringify(snapshot)).toContain('"behavior"')
	})

	it('is pure JSON and preserves identity + order', () => {
		const snapshot = definitionToSnapshot(definition)
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
		expect(snapshot.phases[0]?.tasks[0]?.description).toBe('leaf')
	})

	it('the per-node converters mirror the whole-tree one', () => {
		// phaseDefinitionToSnapshot takes the inherited workflow bail — it persists the effective
		// per-phase bail (`phase.bail ?? workflowBail`), so the phase declaring none inherits `true` here.
		const phase = phaseDefinitionToSnapshot(
			definition.phases[0] ?? { id: 'x', name: 'X', tasks: [] },
			true,
		)
		expect(phase.status).toBe('pending')
		expect(phase.bail).toBe(true)
		const task = taskDefinitionToSnapshot({
			id: 't',
			name: 'T',
			behavior: 'f',
		})
		expect(task).toEqual({
			id: 't',
			name: 'T',
			status: 'pending',
			metadata: {},
			attempts: 0,
			behavior: 'f',
		})
	})

	it('persists the EFFECTIVE per-phase bail — a phase override wins, else it inherits the workflow', () => {
		// A workflow that is graceful by default but holds one strict-bail phase. Each PhaseSnapshot
		// must carry its effective policy: the override phase `true`, the inheriting phase `false`.
		const mixed: WorkflowDefinition = {
			id: 'w',
			name: 'W',
			bail: false,
			phases: [
				{ id: 'strict', name: 'Strict', bail: true, tasks: [] },
				{ id: 'inherit', name: 'Inherit', tasks: [] },
			],
		}
		const snapshot = definitionToSnapshot(mixed)
		expect(snapshot.bail).toBe(false) // the workflow tier
		expect(snapshot.phases[0]?.bail).toBe(true) // the override
		expect(snapshot.phases[1]?.bail).toBe(false) // inherited from the workflow
	})
})

describe('taskDefinitionToSnapshot — the declarative trio copies verbatim, omits when absent', () => {
	it('copies behavior/retries/timeout when the definition declares them', () => {
		const snapshot = taskDefinitionToSnapshot({
			id: 't',
			name: 'T',
			behavior: 'x',
			retries: 3,
			timeout: 250,
		})
		expect(snapshot.behavior).toBe('x')
		expect(snapshot.retries).toBe(3)
		expect(snapshot.timeout).toBe(250)
	})

	it('omits behavior/retries/timeout when the definition declares none (no undefined keys)', () => {
		const snapshot = taskDefinitionToSnapshot({ id: 't', name: 'T' })
		expect('behavior' in snapshot).toBe(false)
		expect('retries' in snapshot).toBe(false)
		expect('timeout' in snapshot).toBe(false)
	})

	it('accepts retries/timeout of 0 (the boundary is meaningful, not falsy-omitted)', () => {
		const snapshot = taskDefinitionToSnapshot({ id: 't', name: 'T', retries: 0, timeout: 0 })
		expect(snapshot.retries).toBe(0)
		expect(snapshot.timeout).toBe(0)
	})
})

describe('scheduleHost — centralized host settlement lifecycle', () => {
	it('rejects a pre-aborted signal without starting host work', async () => {
		const controller = new AbortController()
		const reason = new Error('already stopped')
		const starts = new WorkflowObservation(0)
		controller.abort(reason)

		await expect(
			createHostSchedule(() => {
				starts.value += 1
				return () => undefined
			}, controller.signal),
		).rejects.toBe(reason)
		expect(starts.value).toBe(0)
	})

	it('rejects an invalid signal before starting host work', async () => {
		const starts = new WorkflowObservation(0)
		const pending: unknown = Reflect.apply(createHostSchedule, undefined, [
			() => {
				starts.value += 1
				return () => undefined
			},
			{},
		])
		if (!(pending instanceof Promise)) throw new Error('expected rejected scheduling promise')

		await expect(pending).rejects.toBeInstanceOf(WorkflowError)
		await expect(pending).rejects.toMatchObject({
			code: 'SCHEDULE',
			context: { signal: 'object' },
		})
		expect(starts.value).toBe(0)
	})

	it('rejects rather than throwing when a proxied caller signal cannot be linked', async () => {
		const starts = createRecorder()
		const trap = new Error('proxy trap must not escape synchronously')
		const hostile = new Proxy(new AbortController().signal, {
			get(target, property) {
				if (property === 'aborted') throw trap
				const member: unknown = Reflect.get(target, property, target)
				return typeof member === 'function' ? member.bind(target) : member
			},
		})

		// Prove this input reaches linking and linking throws on this host.
		expect(isAbortSignal(hostile)).toBe(true)
		expect(() => linkSignal(new AbortController().signal, hostile)).toThrow(Error)
		const pending = createHostSchedule(() => {
			starts.handler()
			return () => undefined
		}, hostile)

		expect(pending).toBeInstanceOf(Promise)
		await expect(pending).rejects.toBeInstanceOf(WorkflowError)
		await expect(pending).rejects.toMatchObject({
			code: 'SCHEDULE',
			message: 'createHostSchedule could not link the caller signal',
			context: { signal: 'object' },
		})
		await expect(pending).rejects.not.toBe(trap)
		expect(starts.calls).toEqual([])
	})

	it('schedules safely when the caller addEventListener method is patched to throw', async () => {
		const controller = new AbortController()
		Object.defineProperty(controller.signal, 'addEventListener', {
			value: () => {
				throw new Error('caller listener method must stay unread')
			},
		})

		await expect(
			createHostSchedule((complete) => {
				const handle = setTimeout(complete, 0)
				return () => clearTimeout(handle)
			}, controller.signal),
		).resolves.toBeUndefined()
	})

	it('cannot hang when the caller removeEventListener method changes after scheduling', async () => {
		const controller = new AbortController()
		const complete = new WorkflowObservation<(() => void) | undefined>(undefined)
		const pending = createHostSchedule((settle) => {
			complete.value = settle
			return () => undefined
		}, controller.signal)
		Object.defineProperty(controller.signal, 'removeEventListener', {
			value: () => {
				throw new Error('caller listener method must stay unread')
			},
		})
		if (complete.value === undefined) throw new Error('expected armed host completion')

		complete.value()

		await expect(pending).resolves.toBeUndefined()
	})

	it('rejects an exact start throw before a cancellation closure exists', async () => {
		const fault = new Error('host setup failed')

		await expect(
			createHostSchedule(() => {
				throw fault
			}),
		).rejects.toBe(fault)
	})

	it('cancels once when completion settles synchronously before start returns', async () => {
		const cancellations = new WorkflowObservation(0)

		await expect(
			createHostSchedule((complete) => {
				complete()
				return () => {
					cancellations.value += 1
				}
			}),
		).resolves.toBeUndefined()
		expect(cancellations.value).toBe(1)
	})

	it('cancels once when host failure settles synchronously before start returns', async () => {
		const fault = new Error('host failed while arming')
		const cancellations = new WorkflowObservation(0)
		const pending = createHostSchedule((_complete, fail) => {
			fail(fault)
			return () => {
				cancellations.value += 1
			}
		})

		await expect(pending).rejects.toBe(fault)
		expect(cancellations.value).toBe(1)
	})

	it('cancels once and preserves the exact reason when the caller aborts during start', async () => {
		const controller = new AbortController()
		const reason = { command: 'stop' }
		const cancellations = new WorkflowObservation(0)

		const pending = createHostSchedule(() => {
			controller.abort(reason)
			return () => {
				cancellations.value += 1
			}
		}, controller.signal)

		await expect(pending).rejects.toBe(reason)
		expect(cancellations.value).toBe(1)
	})

	it('keeps the caller reason when cancellation synchronously reports a host failure', async () => {
		const controller = new AbortController()
		const reason = new Error('caller stopped first')
		const cleanupFailure = new Error('cleanup reported failure')
		const cancellations = new WorkflowObservation(0)
		const pending = createHostSchedule((_complete, fail) => {
			return () => {
				cancellations.value += 1
				fail(cleanupFailure)
			}
		}, controller.signal)

		controller.abort(reason)

		await expect(pending).rejects.toBe(reason)
		expect(cancellations.value).toBe(1)
	})

	it('contains a throwing cancellation closure after an asynchronous caller abort', async () => {
		const controller = new AbortController()
		const reason = new Error('caller stopped')
		const cleanup = new Error('caller cleanup failed')
		const pending = createHostSchedule(
			() => () => {
				throw cleanup
			},
			controller.signal,
		)

		expect(() => controller.abort(reason)).not.toThrow()
		await expect(pending).rejects.toBe(reason)
	})

	it('contains a throwing cancellation closure after an asynchronous host failure', async () => {
		const reason = new Error('host failed')
		const cleanup = new Error('host cleanup failed')
		const pending = createHostSchedule((_complete, fail) => {
			queueMicrotask(() => fail(reason))
			return () => {
				throw cleanup
			}
		})

		await expect(pending).rejects.toBe(reason)
	})

	it('preserves every falsy host failure and cancels each handle once', async () => {
		const reasons: readonly unknown[] = [undefined, null, false, 0, '']

		for (const reason of reasons) {
			const cancellations = new WorkflowObservation(0)
			const pending = createHostSchedule((_complete, fail) => {
				queueMicrotask(() => fail(reason))
				return () => {
					cancellations.value += 1
				}
			})
			const outcome = await pending.then(
				() => success(undefined),
				(error) => failure(error),
			)

			expect(outcome.success).toBe(false)
			if (outcome.success) throw new Error('expected host rejection')
			expect(outcome.error).toBe(reason)
			expect(cancellations.value).toBe(1)
		}
	})

	it('ignores late caller abort and host failure after completion', async () => {
		const controller = new AbortController()
		const complete = new WorkflowObservation<(() => void) | undefined>(undefined)
		const fail = new WorkflowObservation<((error: unknown) => void) | undefined>(undefined)
		const settlements = new WorkflowObservation(0)
		const cancellations = new WorkflowObservation(0)
		const pending = createHostSchedule((settle, reject) => {
			complete.value = settle
			fail.value = reject
			return () => {
				cancellations.value += 1
			}
		}, controller.signal).then(
			() => {
				settlements.value += 1
				return 'resolved'
			},
			() => {
				settlements.value += 1
				return 'rejected'
			},
		)
		if (complete.value === undefined || fail.value === undefined)
			throw new Error('expected armed host')

		complete.value()
		expect(await pending).toBe('resolved')
		controller.abort(new Error('late caller abort'))
		fail.value(new Error('late host failure'))
		complete.value()
		await Promise.resolve()

		expect(settlements.value).toBe(1)
		expect(cancellations.value).toBe(0)
	})

	it('ignores late completion and caller abort after host failure', async () => {
		const controller = new AbortController()
		const reason = new Error('host failed first')
		const complete = new WorkflowObservation<(() => void) | undefined>(undefined)
		const fail = new WorkflowObservation<((error: unknown) => void) | undefined>(undefined)
		const settlements = new WorkflowObservation(0)
		const cancellations = new WorkflowObservation(0)
		const pending = createHostSchedule((settle, reject) => {
			complete.value = settle
			fail.value = reject
			return () => {
				cancellations.value += 1
			}
		}, controller.signal).then(
			() => {
				settlements.value += 1
				return success(undefined)
			},
			(error) => {
				settlements.value += 1
				return failure(error)
			},
		)
		if (complete.value === undefined || fail.value === undefined)
			throw new Error('expected armed host')

		fail.value(reason)
		const outcome = await pending
		expect(outcome.success).toBe(false)
		if (outcome.success) throw new Error('expected host rejection')
		expect(outcome.error).toBe(reason)
		complete.value()
		controller.abort(new Error('late caller abort'))
		await Promise.resolve()

		expect(settlements.value).toBe(1)
		expect(cancellations.value).toBe(1)
	})

	it('ignores late completion and host failure after caller abort', async () => {
		const controller = new AbortController()
		const reason = new Error('caller stopped first')
		const complete = new WorkflowObservation<(() => void) | undefined>(undefined)
		const fail = new WorkflowObservation<((error: unknown) => void) | undefined>(undefined)
		const settlements = new WorkflowObservation(0)
		const cancellations = new WorkflowObservation(0)
		const pending = createHostSchedule((settle, reject) => {
			complete.value = settle
			fail.value = reject
			return () => {
				cancellations.value += 1
			}
		}, controller.signal).then(
			() => {
				settlements.value += 1
				return success(undefined)
			},
			(error) => {
				settlements.value += 1
				return failure(error)
			},
		)
		if (complete.value === undefined || fail.value === undefined)
			throw new Error('expected armed host')

		controller.abort(reason)
		const outcome = await pending
		expect(outcome.success).toBe(false)
		if (outcome.success) throw new Error('expected caller rejection')
		expect(outcome.error).toBe(reason)
		complete.value()
		fail.value(new Error('late host failure'))
		await Promise.resolve()

		expect(settlements.value).toBe(1)
		expect(cancellations.value).toBe(1)
	})
})

describe('parkSignal — a one-shot promise-park on an AbortSignal, never rejects', () => {
	it('resolves immediately when the signal is already aborted', async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(parkSignal(controller.signal)).resolves.toBeUndefined()
	})

	it('resolves after the signal aborts (parks across real macrotasks first)', async () => {
		const controller = new AbortController()
		const settled = new WorkflowObservation(false)
		const parked = parkSignal(controller.signal).then(() => {
			settled.value = true
		})
		await waitForDelay(5)
		expect(settled.value).toBe(false)
		controller.abort()
		await parked
		expect(settled.value).toBe(true)
	})

	it('never rejects, even when the signal aborts with a reason', async () => {
		const controller = new AbortController()
		const parked = parkSignal(controller.signal)
		controller.abort(new Error('boom'))
		await expect(parked).resolves.toBeUndefined()
	})
})

describe('findFailure — the first Failure in a positional result list', () => {
	it('returns undefined for an empty list', () => {
		expect(findFailure([])).toBeUndefined()
	})

	it('returns undefined when no result is a Failure', () => {
		expect(
			findFailure([buildOutcomeResult('a', true), buildOutcomeResult('b', true)]),
		).toBeUndefined()
	})

	it('returns the first Failure among several — order sensitive', () => {
		const results = [
			buildOutcomeResult('a', true),
			buildOutcomeResult('b', false),
			buildOutcomeResult('c', false),
		]
		expect(findFailure(results)?.task.id).toBe('b')
		// Reversing the order changes which is found FIRST — proving it is order-sensitive, not
		// a set search.
		expect(findFailure([...results].reverse())?.task.id).toBe('c')
	})

	it('a result with no boxed outcome at all is not treated as a failure', () => {
		const pending: TaskResult = {
			task: { id: 'p', name: 'p', phase: { id: 'p', name: 'P', workflow: { id: 'w', name: 'W' } } },
			phase: { id: 'p', name: 'P', workflow: { id: 'w', name: 'W' } },
			workflow: { id: 'w', name: 'W' },
			status: 'skipped',
			timestamp: 0,
		}
		expect(findFailure([pending])).toBeUndefined()
	})
})

describe('insertEntry — pure splice-in of one positional entry', () => {
	it('inserts at an interior index without mutating the input', () => {
		const entries: ReadonlyArray<readonly [string, number]> = [
			['a', 1],
			['b', 2],
		]
		const result = insertEntry(entries, 1, 'c', 3)
		expect(result).toEqual([
			['a', 1],
			['c', 3],
			['b', 2],
		])
		// The input array is untouched — a caller-owned input is never mutated.
		expect(entries).toEqual([
			['a', 1],
			['b', 2],
		])
	})

	it('index 0 prepends', () => {
		const entries: ReadonlyArray<readonly [string, number]> = [['a', 1]]
		expect(insertEntry(entries, 0, 'z', 9)).toEqual([
			['z', 9],
			['a', 1],
		])
	})

	it('index === entries.length appends', () => {
		const entries: ReadonlyArray<readonly [string, number]> = [['a', 1]]
		expect(insertEntry(entries, entries.length, 'z', 9)).toEqual([
			['a', 1],
			['z', 9],
		])
	})

	it('inserting into an empty array yields the single entry', () => {
		expect(insertEntry([], 0, 'a', 1)).toEqual([['a', 1]])
	})

	it('preserves the key/value pairing of every existing entry', () => {
		const entries: ReadonlyArray<readonly [string, string]> = [
			['x', 'X'],
			['y', 'Y'],
			['z', 'Z'],
		]
		const result = insertEntry(entries, 1, 'w', 'W')
		expect(Object.fromEntries(result)).toEqual({ x: 'X', w: 'W', y: 'Y', z: 'Z' })
	})
})

describe('moveEntry — pure remove-then-reinsert of one keyed entry', () => {
	it('repositions a key to a new index without mutating the input', () => {
		const entries: ReadonlyArray<readonly [string, number]> = [
			['a', 1],
			['b', 2],
			['c', 3],
		]
		const result = moveEntry(entries, 'a', 2)
		expect(result).toEqual([
			['b', 2],
			['c', 3],
			['a', 1],
		])
		expect(entries).toEqual([
			['a', 1],
			['b', 2],
			['c', 3],
		])
	})

	it('moves to index 0 (front)', () => {
		const entries: ReadonlyArray<readonly [string, number]> = [
			['a', 1],
			['b', 2],
			['c', 3],
		]
		expect(moveEntry(entries, 'c', 0)).toEqual([
			['c', 3],
			['a', 1],
			['b', 2],
		])
	})

	it('moves to the last index (end)', () => {
		const entries: ReadonlyArray<readonly [string, number]> = [
			['a', 1],
			['b', 2],
			['c', 3],
		]
		expect(moveEntry(entries, 'a', 2)).toEqual([
			['b', 2],
			['c', 3],
			['a', 1],
		])
	})

	it('an absent key is a no-op — returns an equal (but new) copy of entries', () => {
		const entries: ReadonlyArray<readonly [string, number]> = [
			['a', 1],
			['b', 2],
		]
		const result = moveEntry(entries, 'missing', 0)
		expect(result).toEqual(entries)
		expect(result).not.toBe(entries) // a new array, not the same reference
	})

	it('preserves the key/value pairing of the moved and surviving entries', () => {
		const entries: ReadonlyArray<readonly [string, string]> = [
			['x', 'X'],
			['y', 'Y'],
			['z', 'Z'],
		]
		const result = moveEntry(entries, 'y', 0)
		expect(Object.fromEntries(result)).toEqual({ x: 'X', y: 'Y', z: 'Z' })
		expect(result[0]).toEqual(['y', 'Y'])
	})
})

describe('deriveBoundary — the index of the first pending status (the pending-suffix boundary)', () => {
	it('is 0 when the list is empty', () => {
		expect(deriveBoundary([])).toBe(0)
	})

	it('is 0 when every status is pending', () => {
		expect(deriveBoundary(['pending', 'pending', 'pending'])).toBe(0)
	})

	it('is the count of non-pending statuses when they form a prefix', () => {
		expect(deriveBoundary(['completed', 'running', 'pending', 'pending'])).toBe(2)
		expect(deriveBoundary(['completed'])).toBe(1)
	})

	it('is the full length when every status is non-pending (terminal or running)', () => {
		expect(deriveBoundary(['completed', 'failed', 'skipped', 'stopped'])).toBe(4)
		expect(deriveBoundary(['running'])).toBe(1)
	})

	it('stops at the FIRST pending — a later non-pending after it does not extend the boundary', () => {
		// Mixed statuses are not expected in practice (a pending prefix-of-suffix invariant is
		// upheld elsewhere), but the helper itself is a pure `findIndex` — pin that behavior.
		expect(deriveBoundary(['completed', 'pending', 'completed'])).toBe(1)
	})
})

describe('resolveTaskSilence — runtime inheritance', () => {
	it('inherits a bounded default and lets a bounded task value override it', () => {
		expect(resolveTaskSilence(undefined, 10)).toBe(10)
		expect(resolveTaskSilence(5, 10)).toBe(5)
		expect(resolveTaskSilence(2_147_483_647, 10)).toBe(2_147_483_647)
		expect(resolveTaskSilence(1, 10)).toBe(1)
	})

	it('holds no window only when both tiers are undefined', () => {
		expect(resolveTaskSilence(undefined, undefined)).toBeUndefined()
	})

	it('refuses a null at either tier, because only undefined means no bound', () => {
		const task = captureError(() => Reflect.apply(resolveTaskSilence, undefined, [null, 10]))
		const inherited = captureError(() =>
			Reflect.apply(resolveTaskSilence, undefined, [undefined, null]),
		)

		expect(isWorkflowError(task) && task.code).toBe('SCHEDULE')
		expect(isWorkflowError(inherited) && inherited.code).toBe('SCHEDULE')
	})

	for (const value of INVALID_TIMER_BOUNDS) {
		it(`refuses a present task value or inherited default of ${value} with SCHEDULE`, () => {
			const task = captureError(() => resolveTaskSilence(value, 10))
			const inherited = captureError(() => resolveTaskSilence(undefined, value))

			expect(isWorkflowError(task) && task.code).toBe('SCHEDULE')
			expect(isWorkflowError(inherited) && inherited.code).toBe('SCHEDULE')
		})
	}
})

describe('requireTimerBound — the one refusal of a timer outside its bound', () => {
	it('returns a bounded value, both ends included', () => {
		expect(requireTimerBound(1, 'timeout')).toBe(1)
		expect(requireTimerBound(MAX_TIMER_MS, 'timeout')).toBe(MAX_TIMER_MS)
	})

	for (const value of INVALID_TIMER_BOUNDS) {
		it(`refuses ${value} with SCHEDULE, naming the option and the remedy`, () => {
			const error = captureError(() => requireTimerBound(value, 'silence'))

			expect(isWorkflowError(error) && error.code).toBe('SCHEDULE')
			expect(isWorkflowError(error) && error.context?.option).toBe('silence')
			expect(isWorkflowError(error) && error.message).toContain('silence')
			expect(isWorkflowError(error) && error.message).toContain(String(MAX_TIMER_MS))
			expect(isWorkflowError(error) && error.message).toContain('omit it')
		})
	}
})

describe('requireConcurrency — the one refusal of a throttle no queue can take', () => {
	it('returns a positive safe integer, both ends included', () => {
		expect(requireConcurrency(1, 'build')).toBe(1)
		expect(requireConcurrency(Number.MAX_SAFE_INTEGER, 'build')).toBe(Number.MAX_SAFE_INTEGER)
	})

	for (const value of INVALID_CONCURRENCIES) {
		it(`refuses ${value} with SCHEDULE, naming the phase and the remedy`, () => {
			const error = captureError(() => requireConcurrency(value, 'build'))

			expect(isWorkflowError(error) && error.code).toBe('SCHEDULE')
			expect(isWorkflowError(error) && error.context?.phase).toBe('build')
			expect(isWorkflowError(error) && error.message).toContain('drop the key')
		})
	}
})

describe('requireRunnable — what refuses a run before it claims the tree', () => {
	it('passes a tree with a task and no bound, and one with every bound in range', () => {
		const definition: WorkflowDefinition = {
			id: 'w',
			name: 'W',
			phases: [
				{
					id: 'p',
					name: 'P',
					concurrency: 1,
					tasks: [{ id: 't', name: 'T', timeout: MAX_TIMER_MS }],
				},
			],
		}

		expect(requireRunnable(createWorkflow(definition), undefined)).toBeUndefined()
		expect(requireRunnable(createWorkflow(definition), MAX_TIMER_MS)).toBeUndefined()
	})

	it('refuses a tree with no task, naming the workflow', () => {
		const error = captureError(() =>
			requireRunnable(createWorkflow({ id: 'w', name: 'W', phases: [] }), undefined),
		)

		expect(isWorkflowError(error) && error.code).toBe('SCHEDULE')
		expect(isWorkflowError(error) && error.context?.workflow).toBe('w')
		expect(isWorkflowError(error) && error.message).toContain('"w"')
	})

	it('refuses a run timeout before reading the tree', () => {
		const error = captureError(() =>
			requireRunnable(createWorkflow({ id: 'w', name: 'W', phases: [] }), 0),
		)

		expect(isWorkflowError(error) && error.context?.option).toBe('timeout')
	})

	for (const concurrency of INVALID_CONCURRENCIES) {
		it(`refuses a pending phase carrying a concurrency of ${concurrency}, naming it`, () => {
			const workflow = buildAppendedWorkflow([
				{ id: 'p', name: 'P', concurrency, tasks: [{ id: 't', name: 'T' }] },
			])
			const error = captureError(() => requireRunnable(workflow, undefined))

			expect(isWorkflowError(error) && error.code).toBe('SCHEDULE')
			expect(isWorkflowError(error) && error.context?.phase).toBe('p')
		})
	}

	for (const timeout of INVALID_TIMER_BOUNDS) {
		it(`refuses a pending task carrying a timeout of ${timeout}, naming it and the remedy`, () => {
			const workflow = buildAppendedWorkflow([
				{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', timeout }] },
			])
			const error = captureError(() => requireRunnable(workflow, undefined))

			expect(isWorkflowError(error) && error.code).toBe('SCHEDULE')
			expect(isWorkflowError(error) && error.context?.task).toBe('t')
			expect(isWorkflowError(error) && error.message).toContain('drop the key')
		})
	}

	it('ignores a settled node, which never runs again', () => {
		const workflow = buildAppendedWorkflow([
			{
				id: 'p',
				name: 'P',
				concurrency: 0,
				tasks: [
					{ id: 't', name: 'T', timeout: 0 },
					{ id: 'u', name: 'U', timeout: 0 },
				],
			},
			{ id: 'q', name: 'Q', tasks: [{ id: 'v', name: 'V' }] },
		])
		workflow.phase('p')?.stop()
		workflow.phase('p')?.task('t')?.skip()
		workflow.phase('p')?.task('u')?.skip()

		expect(requireRunnable(workflow, undefined)).toBeUndefined()
	})
})

describe('admitDefinition — the door a definition enters through', () => {
	it('refuses a meaning-changing hexadecimal timeout repair and preserves a decimal timeout', () => {
		const definition = {
			id: 'w',
			name: 'W',
			phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', timeout: '0x10' }] }],
		}
		const refused = admitDefinition(workflowContract, definition, 'SCHEDULE', 'workflow definition')
		expect(refused.success).toBe(false)
		expect(!refused.success && refused.error.code).toBe('SCHEDULE')
		expect(!refused.success && refused.error.context?.faults).toEqual([
			expect.objectContaining({ reason: 'type', path: ['phases', '0', 'tasks', '0', 'timeout'] }),
		])
		expect(!refused.success && refused.error.message).toContain('phases.0.tasks.0.timeout')
		expect(!refused.success && refused.error.message).toContain('expected integer')
		const admitted = admitDefinition(
			workflowContract,
			{
				...definition,
				phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', timeout: '5' }] }],
			},
			'SCHEDULE',
			'workflow definition',
		)
		expect(admitted.success && admitted.value.phases[0]?.tasks[0]?.timeout).toBe(5)
	})

	it('hands the parsed value on for a clean definition', () => {
		const definition: WorkflowDefinition = { id: 'w', name: 'W', phases: [] }
		const admitted = admitDefinition(
			workflowContract,
			definition,
			'SCHEDULE',
			'workflow definition',
		)

		expect(admitted).toEqual(success(definition))
	})

	it('asks for a report only when the guard refuses, because a valid value has no fault to report', () => {
		const reports = createRecorder<readonly [string]>()
		const contract = createRecordedContract(workflowContract, reports)

		const valid = { id: 'w', name: 'W', phases: [] }
		expect(admitDefinition(contract, valid, 'SCHEDULE', 'workflow definition').success).toBe(true)
		expect(reports.count).toBe(0)

		const misspelt = buildMisspeltDefinition()
		expect(admitDefinition(contract, misspelt, 'SCHEDULE', 'workflow definition').success).toBe(
			false,
		)
		expect(reports.calls.map((call) => call[0])).toEqual(['audit'])
	})

	it('refuses an undeclared key with the code it was given and the extra fault', () => {
		const admitted = admitDefinition(
			workflowContract,
			buildMisspeltDefinition(),
			'MUTATION',
			'workflow definition',
		)

		expect(admitted.success).toBe(false)
		expect(!admitted.success && admitted.error.code).toBe('MUTATION')
		expect(!admitted.success && admitted.error.message).toContain('workflow definition')
		expect(!admitted.success && admitted.error.context?.faults).toEqual([
			{ reason: 'extra', path: ['phases', '0', 'tasks', '0', 'behaviour'] },
		])
	})

	it('reports explain faults, then every undeclared key, in one refusal', () => {
		const admitted = admitDefinition(
			workflowContract,
			{ id: '', name: 'W', phases: [], undeclared: true },
			'SCHEDULE',
			'workflow definition',
		)

		expect(!admitted.success && admitted.error.context?.faults).toEqual([
			expect.objectContaining({ reason: 'constraint', path: ['id'] }),
			{ reason: 'extra', path: ['undeclared'] },
		])
	})

	it('reports a full audit whole when an explain fault joins it, because it can hide a key', () => {
		const admitted = admitDefinition(
			workflowContract,
			{ ...buildRepairableDefinition(FAULT_LIMIT), id: '', undeclared: true },
			'SCHEDULE',
			'workflow definition',
		)

		expect(!admitted.success && admitted.error.context?.faults).toHaveLength(FAULT_LIMIT)
		expect(!admitted.success && admitted.error.message).toContain('the report stops at')
	})

	it('refuses as unreadable when every read throws, which the guard answers and the audit cannot', () => {
		const admitted = admitDefinition(
			workflowContract,
			{
				id: 'w',
				name: 'W',
				get phases(): never {
					throw new Error('unreadable')
				},
			},
			'SCHEDULE',
			'workflow definition',
		)

		expect(admitted.success).toBe(false)
		expect(!admitted.success && admitted.error.code).toBe('SCHEDULE')
		expect(!admitted.success && admitted.error.message).toContain('could not be read')
	})

	it('refuses as unreadable when a read throws, whichever contract call it reaches', () => {
		const admitted = admitDefinition(
			workflowContract,
			buildShiftingDefinition(),
			'MUTATION',
			'workflow definition',
		)

		expect(admitted.success).toBe(false)
		expect(!admitted.success && admitted.error.code).toBe('MUTATION')
		expect(!admitted.success && admitted.error.message).toBe(
			'workflow definition refused: it could not be read; send plain JSON data',
		)
		expect(!admitted.success && admitted.error.context?.faults).toEqual([])
	})

	it('refuses an audit at FAULT_LIMIT and repairs one below it', () => {
		const refused = admitDefinition(
			workflowContract,
			buildRepairableDefinition(FAULT_LIMIT),
			'SCHEDULE',
			'workflow definition',
		)
		const repaired = admitDefinition(
			workflowContract,
			buildRepairableDefinition(FAULT_LIMIT - 1),
			'SCHEDULE',
			'workflow definition',
		)

		expect(!refused.success && refused.error.context?.faults).toHaveLength(FAULT_LIMIT)
		expect(repaired.success && repaired.value.phases[0]?.tasks[0]?.timeout).toBe(5000)
	})
})

describe('admitPatch — the door a patch enters through', () => {
	it('hands on an owned copy of a valid patch', () => {
		const patch = { name: 'Renamed task' }
		const admitted = admitPatch(taskUpdateContract, patch, 'task', 't')

		expect(admitted).toEqual(success(patch))
		expect(admitted.success && admitted.value).not.toBe(patch)
	})

	it('refuses an undeclared key with the faults admitValue reports for the same value', () => {
		const value = { naem: 'changed' }
		const misspelt = admitPatch(taskUpdateContract, value, 'task', 't')
		const reported = admitValue(taskUpdateContract, value)

		expect(!misspelt.success && misspelt.error.code).toBe('MUTATION')
		expect(!misspelt.success && misspelt.error.message).toContain(
			'naem: extra; this key is not declared, remove it',
		)
		expect(!misspelt.success && misspelt.error.context).toEqual({
			id: 't',
			faults: [{ reason: 'extra', path: ['naem'] }],
		})
		expect(!misspelt.success && misspelt.error.context?.faults).toEqual(
			!reported.success && reported.error.faults,
		)
	})

	it('admits a lossless type repair and hands on the repaired value', () => {
		const admitted = admitPatch(phaseUpdateContract, { concurrency: '4' }, 'phase', 'p')

		expect(admitted).toEqual(success({ concurrency: 4 }))
	})

	it('refuses a lossy repair', () => {
		const refused = admitPatch(phaseUpdateContract, { concurrency: '4.5' }, 'phase', 'p')

		expect(!refused.success && refused.error.code).toBe('MUTATION')
		expect(!refused.success && refused.error.context?.id).toBe('p')
		expect(!refused.success && refused.error.context?.faults).not.toEqual([])
	})

	it('refuses an empty patch, naming the keys it can set', () => {
		const empty = admitPatch(taskUpdateContract, {}, 'task', 't')

		expect(!empty.success && empty.error.message).toBe(
			'patch for task "t" changes nothing; set at least one of name, description',
		)
		expect(!empty.success && empty.error.context).toEqual({ id: 't', faults: [] })
	})

	it('refuses as unreadable when a read throws', () => {
		const unreadable = admitPatch(
			taskUpdateContract,
			{
				get name(): string {
					throw new Error('unreadable')
				},
			},
			'task',
			't',
		)

		expect(!unreadable.success && unreadable.error.code).toBe('MUTATION')
		expect(!unreadable.success && unreadable.error.message).toContain('could not be read')
		expect(!unreadable.success && unreadable.error.context?.faults).toEqual([])
	})
})

describe('scanDuplicateIds — what a schema cannot say about a definition', () => {
	it('finds nothing among distinct ids, whatever other phases reuse', () => {
		expect(
			scanDuplicateIds([
				{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T' }] },
				{ id: 'q', name: 'Q', tasks: [{ id: 't', name: 'T' }] },
			]),
		).toBeUndefined()
		expect(scanDuplicateIds([])).toBeUndefined()
	})

	it('refuses a repeated phase id with MUTATION, naming it', () => {
		const repeated = scanDuplicateIds([
			{ id: 'p', name: 'P', tasks: [] },
			{ id: 'p', name: 'Q', tasks: [] },
		])

		expect(repeated?.code).toBe('MUTATION')
		expect(repeated?.message).toBe('duplicate phase id "p"')
		expect(repeated?.context).toEqual({ id: 'p' })
	})

	it('refuses a repeated task id within one phase', () => {
		const repeated = scanDuplicateIds([
			{
				id: 'p',
				name: 'P',
				tasks: [
					{ id: 'a', name: 'A' },
					{ id: 'b', name: 'B' },
					{ id: 'a', name: 'C' },
				],
			},
		])

		expect(repeated?.message).toBe('duplicate task id "a"')
	})
})

describe('scanSchemaNode — the walk a refusal reads the schema through', () => {
	it('walks objects and arrays to the node a path names', () => {
		expect(scanSchemaNode(workflowContract.schema, [])).toBe(workflowContract.schema)
		expect(
			Object.keys(
				scanSchemaNode(workflowContract.schema, ['phases', '0', 'tasks', '0'])?.properties ?? {},
			),
		).toEqual(['id', 'name', 'description', 'behavior', 'retries', 'timeout'])
	})

	it('finds no node once the path leaves the schema', () => {
		expect(scanSchemaNode(taskDefinitionContract.schema, ['id', 'nested'])).toBeUndefined()
	})
})

describe('describeWorkflowFaults — the text a refusal reads', () => {
	it('names the subject and every path with what to send', () => {
		const message = describeWorkflowFaults('task definition', taskDefinitionContract.schema, [
			{ reason: 'extra', path: ['behaviour'] },
			{ reason: 'missing', path: ['id'], expected: 'string' },
			{
				reason: 'constraint',
				path: ['name'],
				expected: 'string',
				constraint: 'min',
				limit: 1,
				received: '""',
			},
			{ reason: 'type', path: 'timeout', expected: 'integer', received: 'NaN' },
		])

		expect(message).toContain('task definition refused; correct each line and send it again:')
		expect(message).toContain('behaviour: extra; this key is not declared, remove it')
		expect(message).toContain('id: missing; expected string')
		expect(message).toContain('name: constraint; expected string; received')
		expect(message).toContain('constraint min; limit 1')
		expect(message).toContain('timeout: type; expected integer; received NaN')
		expect(message).toContain('send {')
	})

	it('names the root when a fault has no path, and says what to send when nothing could be read', () => {
		expect(
			describeWorkflowFaults('workflow definition', workflowContract.schema, [
				{ reason: 'type', path: [], expected: 'object', received: '42' },
			]),
		).toContain('\nvalue: type; expected object; received 42')
		expect(describeWorkflowFaults('patch', workflowContract.schema, [])).toBe(
			'patch refused: it could not be read; send plain JSON data',
		)
	})

	it('adds bounded schema descriptions for optional and required keys', () => {
		const message = describeWorkflowFaults('task definition', taskDefinitionContract.schema, [
			{
				reason: 'constraint',
				path: ['timeout'],
				expected: 'integer',
				constraint: 'min',
				limit: 1,
				received: '0',
			},
			{
				reason: 'constraint',
				path: ['id'],
				expected: 'string',
				constraint: 'min',
				limit: 1,
				received: '""',
			},
		])
		const [, timeout, id] = message.split('\n')

		expect(timeout).toContain('received 0; constraint min; limit 1')
		expect(timeout).toContain('description "Per-attempt deadline')
		expect(id).toContain('id: constraint; expected string; received')
		expect(id).toContain('description "Unique task id')
	})

	it('offers only removal when the schema declares no candidate there', () => {
		expect(
			describeWorkflowFaults('task definition', taskDefinitionContract.schema, [
				{ reason: 'extra', path: ['id', 'nested', 'key'] },
			]),
		).toContain('id.nested.key: extra; this key is not declared, remove it')
	})

	it('encodes and caps a key the caller sent, so it cannot fake a line or balloon the text', () => {
		const message = describeWorkflowFaults('task definition', taskDefinitionContract.schema, [
			{ reason: 'extra', path: ['line\nbreak'] },
			{ reason: 'extra', path: ['x'.repeat(100_000)] },
		])

		expect(message).toContain('"line\\nbreak": extra')
		expect(message.split('\n')).toHaveLength(4)
		expect(message.length).toBeLessThanOrEqual(WORKFLOW_REFUSAL_LIMIT)
	})

	it('stays within the limit by whole lines and says the list stops there', () => {
		const faults = Array.from({ length: FAULT_LIMIT - 1 }, (_unused, index) => ({
			reason: 'type' as const,
			path: ['phases', '0', 'tasks', String(index), 'timeout'],
			expected: 'integer' as const,
			received: '"5000"',
		}))
		const message = describeWorkflowFaults('workflow definition', workflowContract.schema, faults)
		const lines = message.split('\n')

		expect(message.length).toBeLessThanOrEqual(WORKFLOW_REFUSAL_LIMIT)
		expect(lines.length).toBeLessThan(FAULT_LIMIT)
		expect(lines.at(1)).toContain('phases.0.tasks.0.timeout: type')
		expect(lines.at(-2)).toMatch(/and \d+ more faults/u)
		expect(lines.at(-1)).toContain('send {')
	})

	it('closes a report at FAULT_LIMIT even when every line fits', () => {
		const faults = Array.from({ length: FAULT_LIMIT }, () => ({
			reason: 'missing' as const,
			path: ['k'],
			expected: 'string' as const,
		}))
		const fits = describeWorkflowFaults('patch', { type: 'object' }, faults)
		const below = describeWorkflowFaults('patch', { type: 'object' }, faults.slice(1))

		expect(fits.split('\n')).toHaveLength(FAULT_LIMIT + 3)
		expect(fits).toContain('the report stops at')
		expect(below.split('\n')).toHaveLength(FAULT_LIMIT + 1)
		expect(below).not.toContain('the report stops at')
	})
})

// The snapshot-decode leaves: an exact restore of a persisted tree and the recovery projection
// that returns interrupted work to its remaining budget. Real definitions, real snapshots, real
// handler registries throughout.

describe('workflow recovery', () => {
	it('refuses a terminal override at either tier with its own message, naming the workflow', () => {
		const forced = createWorkflow(RECOVERY_DEFINITION, { functions: VALIDATED_FUNCTIONS })
		forced.stop()
		const phased = createWorkflow(RECOVERY_DEFINITION, { functions: VALIDATED_FUNCTIONS })
		phased.phases.phases()[0]?.stop()

		for (const source of [forced, phased]) {
			const error = captureError(() =>
				createRecoveredWorkflow(source.snapshot(), { functions: VALIDATED_FUNCTIONS }),
			)

			expect(isWorkflowError(error) && error.code).toBe('RESTORE')
			expect(isWorkflowError(error) && error.message).toContain('has a terminal override')
			expect(isWorkflowError(error) && error.context).toEqual({ workflow: source.id })
		}
	})

	it('uses the exact once-read functions registry for validation and recovered handlers', () => {
		const source = createWorkflow(RECOVERY_DEFINITION, { functions: VALIDATED_FUNCTIONS })
		const task = source.phase('phase')?.task('task')
		if (task === undefined) throw new Error('expected recoverable task')
		task.start()
		const reads = new WorkflowObservation(0)
		const options: WorkflowOptions = {}
		Object.defineProperty(options, 'functions', {
			get: () => {
				reads.value += 1
				return reads.value === 1 ? VALIDATED_FUNCTIONS : RECOVERY_SHIFTED_FUNCTIONS
			},
		})

		const recovered = createRecoveredWorkflow(source.snapshot(), options)

		expect(reads.value).toBe(1)
		expect(recovered.phase('phase')?.task('task')?.handler).toBe(VALIDATED_FUNCTIONS.work)
	})

	it('captures each unique initial behavior once and retains the registry for later live additions', () => {
		const definition: WorkflowDefinition = {
			id: 'captured-behaviors',
			name: 'Captured behaviors',
			phases: [
				{
					id: 'phase',
					name: 'Phase',
					tasks: [
						{ id: 'first', name: 'First', behavior: 'work' },
						{ id: 'second', name: 'Second', behavior: 'work' },
					],
				},
			],
		}
		const snapshot = createWorkflow(definition, { functions: VALIDATED_FUNCTIONS }).snapshot()
		const reads = new WorkflowObservation(0)
		const functions: WorkflowRegistry = {}
		Object.defineProperty(functions, 'work', {
			get: () => {
				reads.value += 1
				return reads.value === 1 ? VALIDATED_FUNCTIONS.work : RECOVERY_SHIFTED_FUNCTIONS.work
			},
		})

		const recovered = createRecoveredWorkflow(snapshot, { functions })

		expect(reads.value).toBe(1)
		expect(recovered.phase('phase')?.task('first')?.handler).toBe(VALIDATED_FUNCTIONS.work)
		expect(recovered.phase('phase')?.task('second')?.handler).toBe(VALIDATED_FUNCTIONS.work)
		const added = recovered.phase('phase')?.add({ id: 'later', name: 'Later', behavior: 'work' })
		if (added === undefined || !added.success) throw new Error('expected live task addition')
		expect(reads.value).toBe(2)
		expect(added.value.handler).toBe(RECOVERY_SHIFTED_FUNCTIONS.work)
	})

	it('rejects the first unresolved keyed binding without rereading a later valid value', () => {
		const snapshot = createWorkflow(RECOVERY_DEFINITION, {
			functions: VALIDATED_FUNCTIONS,
		}).snapshot()
		const reads = new WorkflowObservation(0)
		const functions: WorkflowRegistry = {}
		Object.defineProperty(functions, 'work', {
			get: () => {
				reads.value += 1
				return reads.value === 1 ? undefined : VALIDATED_FUNCTIONS.work
			},
		})

		const error = captureError(() => createRecoveredWorkflow(snapshot, { functions }))

		expect(reads.value).toBe(1)
		expect(isWorkflowError(error) ? error.code : undefined).toBe('RESTORE')
	})

	it('preserves out-of-order completed siblings and executes only recovered pending work', async () => {
		const definition: WorkflowDefinition = {
			id: 'mixed',
			name: 'Mixed',
			bail: false,
			phases: [
				{
					id: 'phase',
					name: 'Phase',
					tasks: [
						{ id: 'first', name: 'First', behavior: 'first' },
						{ id: 'done', name: 'Done', behavior: 'done' },
						{ id: 'interrupted', name: 'Interrupted', behavior: 'interrupted', retries: 1 },
					],
				},
			],
		}
		const functions = RECOVERY_MIXED_FUNCTIONS
		const source = createWorkflow(definition, { functions })
		const done = source.phase('phase')?.task('done')
		const interrupted = source.phase('phase')?.task('interrupted')
		if (done === undefined || interrupted === undefined) throw new Error('expected mixed tasks')
		done.start()
		done.complete('persisted')
		interrupted.start()

		const exact = createRestoredWorkflow(source.snapshot(), { functions })
		expect(() => createDurabilityRunner().execute(exact)).toThrow(/not drivable/)

		const calls: string[] = []
		const recovered = createRecoveredWorkflow(source.snapshot(), {
			functions: {
				first: () => {
					calls.push('first')
					return 'first'
				},
				done: () => {
					calls.push('done')
					return 'wrong'
				},
				interrupted: () => {
					calls.push('interrupted')
					return 'interrupted'
				},
			},
		})
		const result = await createDurabilityRunner().execute(recovered)

		expect(result.status).toBe('completed')
		expect(calls.sort()).toEqual(['first', 'interrupted'])
		expect(result.workflow.phase('phase')?.task('done')?.result?.result).toEqual({
			success: true,
			value: 'persisted',
		})
	})

	it('resumes an interrupted task at its remaining persisted attempt budget', async () => {
		const source = createWorkflow(RECOVERY_DEFINITION, { functions: { work: () => null } })
		const interrupted = source.phase('phase')?.task('task')
		if (interrupted === undefined) throw new Error('expected task')
		interrupted.start()
		const reported = interrupted.report({ note: 'interrupted attempt' })
		if (!reported.success) throw reported.error
		const stale = reported.value

		const attempts: number[] = []
		const recovered = createRecoveredWorkflow(source.snapshot(), {
			functions: {
				work: (controller) => {
					attempts.push(controller.attempt)
					return 'done'
				},
			},
		})

		expect(recovered.status).toBe('pending')
		expect(recovered.phase('phase')?.task('task')?.status).toBe('pending')
		expect(recovered.phase('phase')?.task('task')?.attempts).toBe(1)
		expect(recovered.phase('phase')?.task('task')?.activity).toBeUndefined()
		expect(recovered.snapshot().phases[0]?.tasks[0]).not.toHaveProperty('activity')

		const result = await createDurabilityRunner().execute(recovered)
		expect(result.status).toBe('completed')
		expect(attempts).toEqual([2])
		expect(result.workflow.phase('phase')?.task('task')?.attempts).toBe(2)
		const started = result.workflow.phase('phase')?.task('task')?.activity
		expect(started).not.toBe(stale)
		expect(started?.note).toBeUndefined()
		expect(started?.operations).toEqual([])
		expect(started?.constraints).toEqual([])
		expect(started?.updated).toBeGreaterThanOrEqual(stale.updated)
	})

	it('never regresses a future persisted workflow stamp during recovery', () => {
		const source = createWorkflow(RECOVERY_DEFINITION, { functions: { work: () => null } })
		const interrupted = source.phase('phase')?.task('task')
		if (interrupted === undefined) throw new Error('expected task')
		interrupted.start()
		const snapshot = source.snapshot()
		const future = Date.now() + 60_000

		const recovered = createRecoveredWorkflow(
			{ ...snapshot, updated: future },
			{ functions: { work: () => null } },
		)

		expect(recovered.snapshot().updated).toBe(future)
	})

	it('converts an exhausted interrupted task into a normalized recovery failure', () => {
		const source = createWorkflow(
			{
				...RECOVERY_DEFINITION,
				phases: [
					{
						id: 'phase',
						name: 'Phase',
						tasks: [{ id: 'task', name: 'Task', behavior: 'work' }],
					},
				],
			},
			{ functions: { work: () => null } },
		)
		const interrupted = source.phase('phase')?.task('task')
		if (interrupted === undefined) throw new Error('expected task')
		interrupted.start()

		const recovered = createRecoveredWorkflow(source.snapshot(), {
			functions: { work: () => null },
		})
		const result = recovered.phase('phase')?.task('task')?.result
		expect(result?.status).toBe('failed')
		expect(result?.result).toEqual({
			success: false,
			error: {
				origin: 'recovery',
				message: 'task "task" exhausted its retry budget during recovery',
			},
		})
	})

	it('never replenishes attempts across repeated crash and recovery projections', () => {
		const source = createWorkflow(
			{
				...RECOVERY_DEFINITION,
				phases: [
					{
						id: 'phase',
						name: 'Phase',
						tasks: [{ id: 'task', name: 'Task', behavior: 'work', retries: 2 }],
					},
				],
			},
			{ functions: { work: () => null } },
		)
		const first = source.phase('phase')?.task('task')
		if (first === undefined) throw new Error('expected first attempt')
		first.start()

		const once = createRecoveredWorkflow(source.snapshot(), { functions: { work: () => null } })
		expect(once.phase('phase')?.task('task')?.attempts).toBe(1)
		once.phase('phase')?.task('task')?.start()

		const twice = createRecoveredWorkflow(once.snapshot(), { functions: { work: () => null } })
		expect(twice.phase('phase')?.task('task')?.attempts).toBe(2)
		twice.phase('phase')?.task('task')?.start()

		const exhausted = createRecoveredWorkflow(twice.snapshot(), { functions: { work: () => null } })
		expect(exhausted.phase('phase')?.task('task')?.attempts).toBe(3)
		expect(exhausted.phase('phase')?.task('task')?.status).toBe('failed')
	})

	it.each(RECOVERY_POLICY_CASES)(
		'applies the whole-phase exhausted recovery policy under bail:$bail',
		({ bail, expected, later }) => {
			const definition: WorkflowDefinition = {
				id: `policy-${String(bail)}`,
				name: 'Policy',
				bail,
				phases: [
					{
						id: 'current',
						name: 'Current',
						tasks: [
							{ id: 'left', name: 'Left', behavior: 'work' },
							{ id: 'exhausted', name: 'Exhausted', behavior: 'work' },
							{ id: 'retryable', name: 'Retryable', behavior: 'work', retries: 1 },
							{ id: 'right', name: 'Right', behavior: 'work' },
						],
					},
					{
						id: 'later',
						name: 'Later',
						tasks: [{ id: 'later', name: 'Later', behavior: 'work' }],
					},
				],
			}
			const source = createWorkflow(definition, { functions: { work: () => null } })
			const exhausted = source.phase('current')?.task('exhausted')
			const retryable = source.phase('current')?.task('retryable')
			if (exhausted === undefined || retryable === undefined) {
				throw new Error('expected recovery policy tasks')
			}
			exhausted.start()
			retryable.start()

			const recovered = createRecoveredWorkflow(source.snapshot(), {
				functions: { work: () => null },
			})
			expect(
				recovered
					.phase('current')
					?.tasks.tasks()
					.map((task) => task.status),
			).toEqual(expected)
			expect(recovered.phase('later')?.task('later')?.status).toBe(later)
		},
	)

	it('treats an existing strict-phase failure as the recovery halt boundary', () => {
		const source = createWorkflow(
			{
				id: 'established-halt',
				name: 'Established halt',
				bail: true,
				phases: [
					{
						id: 'current',
						name: 'Current',
						tasks: [
							{ id: 'failed', name: 'Failed', behavior: 'work' },
							{ id: 'interrupted', name: 'Interrupted', behavior: 'work', retries: 1 },
							{ id: 'pending', name: 'Pending', behavior: 'work' },
						],
					},
					{
						id: 'later',
						name: 'Later',
						tasks: [{ id: 'later', name: 'Later', behavior: 'work' }],
					},
				],
			},
			{ functions: { work: () => null } },
		)
		const failed = source.phase('current')?.task('failed')
		const interrupted = source.phase('current')?.task('interrupted')
		if (failed === undefined || interrupted === undefined) {
			throw new Error('expected strict recovery tasks')
		}
		interrupted.start()
		failed.start()
		failed.fail({ origin: 'handler', message: 'established' })

		const recovered = createRecoveredWorkflow(source.snapshot(), {
			functions: { work: () => null },
		})
		expect(recovered.phase('current')?.task('failed')?.status).toBe('failed')
		expect(recovered.phase('current')?.task('failed')?.result?.result).toEqual({
			success: false,
			error: { origin: 'handler', message: 'established' },
		})
		expect(recovered.phase('current')?.task('interrupted')?.status).toBe('skipped')
		expect(recovered.phase('current')?.task('interrupted')?.attempts).toBe(1)
		expect(recovered.phase('current')?.task('pending')?.status).toBe('skipped')
		expect(recovered.phase('later')?.task('later')?.status).toBe('skipped')
	})

	it('keeps exact restore distinct from recovery and rejects the quiescent running tree', () => {
		const source = createWorkflow(RECOVERY_DEFINITION, { functions: { work: () => null } })
		const interrupted = source.phase('phase')?.task('task')
		if (interrupted === undefined) throw new Error('expected task')
		interrupted.start()
		const restored = createRestoredWorkflow(source.snapshot(), {
			functions: { work: () => null },
		})

		expect(restored.phase('phase')?.task('task')?.status).toBe('running')
		const error = captureError(() => createDurabilityRunner().execute(restored))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('TRANSITION')
	})

	it('keeps unresolved behavior inspectable but rejects its execution and hostile snapshots', () => {
		const snapshot = createWorkflow(RECOVERY_DEFINITION, {
			functions: { work: () => null },
		}).snapshot()
		const restored = createRestoredWorkflow(snapshot)
		expect(restored.phase('phase')?.task('task')?.behavior).toBe('work')
		expect(() => createDurabilityRunner().execute(restored)).toThrow(/not drivable/)

		const hostile = buildHostileWorkflow()
		const error = captureError(() => createRestoredWorkflow(hostile))
		expect(isWorkflowError(error)).toBe(true)
		if (!isWorkflowError(error)) throw new Error('expected WorkflowError')
		expect(error.code).toBe('RESTORE')
		expect(error.message).toContain('not enumerable data')
	})

	it('treats separately restored objects with the same workflow id as separate local claims', async () => {
		const snapshot = createWorkflow(RECOVERY_DEFINITION, {
			functions: { work: () => null },
		}).snapshot()
		const calls = new WorkflowObservation(0)
		const functions = buildCountedRegistry(calls)
		const first = createRestoredWorkflow(snapshot, { functions })
		const second = createRestoredWorkflow(snapshot, { functions })
		expect(first).not.toBe(second)

		const results = await Promise.all([
			createDurabilityRunner().execute(first),
			createDurabilityRunner().execute(second),
		])
		expect(results.map((result) => result.status)).toEqual(['completed', 'completed'])
		expect(calls.value).toBe(2)
	})
})
