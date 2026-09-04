import type {
	LifecycleStatus,
	PhaseDerivation,
	TaskResult,
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
	createWorkflowRunner,
	definitionToSnapshot,
	deriveBoundary,
	derivePhaseStatus,
	deriveWorkflowStatus,
	errorToMessage,
	failure,
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
	scheduleHost,
	success,
	taskDefinitionToSnapshot,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { captureError, waitForDelay } from '@orkestrel/test'
import { createErrorRecorder, createRecordingScheduler } from '../../setup.js'

// The lifecycle logic core: the derivation truth tables under BOTH bail modes, the ONE
// terminal predicate, and the task-form `via` guards. Pure functions — real inputs, no
// mocks. The derivation tables are EXHAUSTIVE by equivalence class: every
// branch of `derivePhaseStatus` / `deriveWorkflowStatus` is pinned by a discriminating
// row, so the truth table is provably complete rather than sampled.

// The whole shared lifecycle vocabulary — the six literals every tier draws from. Used to
// prove the ONE terminal predicate covers the entire set (no literal left untested).
const EVERY_STATUS: readonly LifecycleStatus[] = [
	'pending',
	'running',
	'completed',
	'failed',
	'skipped',
	'stopped',
]

describe('captureWorkflowOptions — one-read hostile option ownership', () => {
	it('captures inherited and non-enumerable values once while retaining nested identities', () => {
		let onReads = 0
		let bailReads = 0
		let errorReads = 0
		let phasesReads = 0
		let functionsReads = 0
		let silenceReads = 0
		const on = {}
		const errors = createErrorRecorder()
		const phases = {}
		const functions = {}
		const options: WorkflowOptions = {}
		const prototype = {}
		Object.defineProperties(prototype, {
			on: {
				get: () => {
					onReads += 1
					return on
				},
			},
			bail: {
				get: () => {
					bailReads += 1
					return true
				},
			},
			error: {
				get: () => {
					errorReads += 1
					return errors.handler
				},
			},
		})
		Object.setPrototypeOf(options, prototype)
		Object.defineProperties(options, {
			phases: {
				enumerable: false,
				get: () => {
					phasesReads += 1
					return phases
				},
			},
			functions: {
				enumerable: false,
				get: () => {
					functionsReads += 1
					return functions
				},
			},
			silence: {
				enumerable: false,
				get: () => {
					silenceReads += 1
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
		expect([onReads, bailReads, errorReads, phasesReads, functionsReads, silenceReads]).toEqual([
			1, 1, 1, 1, 1, 1,
		])
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
	const cases: ReadonlyArray<readonly [readonly LifecycleStatus[], LifecycleStatus, string]> = [
		// — empty + all-pending (→ pending)
		[[], 'pending', 'no tasks'],
		[['pending'], 'pending', 'single pending'],
		[['pending', 'pending'], 'pending', 'all pending'],
		// — any non-terminal among the set (→ running): a started-but-unsettled phase
		[['running'], 'running', 'single running'],
		[['running', 'pending'], 'running', 'running + pending'],
		[['running', 'running'], 'running', 'all running'],
		[['completed', 'pending'], 'running', 'terminal + pending (not all settled)'],
		[['failed', 'pending'], 'running', 'failed + pending (still not all settled)'],
		[['skipped', 'pending'], 'running', 'skipped + pending'],
		[['stopped', 'pending'], 'running', 'stopped + pending'],
		[['completed', 'running'], 'running', 'completed + running'],
		[['failed', 'running'], 'running', 'failed + running (failed does NOT settle the phase)'],
		[['failed', 'completed', 'pending'], 'running', 'two terminals + a straggler pending'],
		// — all-terminal: single child of each terminal kind
		[['completed'], 'completed', 'single completed'],
		[['failed'], 'failed', 'single failed'],
		[['skipped'], 'skipped', 'single skipped'],
		[['stopped'], 'stopped', 'single stopped'],
		// — all-terminal severity ordering, discriminating ADJACENT pairs
		[['failed', 'stopped'], 'failed', 'failed > stopped'],
		[['stopped', 'completed'], 'stopped', 'stopped > completed'],
		[['completed', 'skipped'], 'completed', 'completed > skipped (skips never fail a phase)'],
		// — all-terminal severity ordering, NON-adjacent pairs (the relation is transitive)
		[['failed', 'completed'], 'failed', 'failed > completed'],
		[['failed', 'skipped'], 'failed', 'failed > skipped'],
		[['stopped', 'skipped'], 'stopped', 'stopped > skipped'],
		// — all-terminal homogeneous (the lowest-severity all-same cases)
		[['completed', 'completed'], 'completed', 'all completed'],
		[['skipped', 'skipped'], 'skipped', 'all skipped'],
		[['stopped', 'stopped'], 'stopped', 'all stopped'],
		[['failed', 'failed'], 'failed', 'all failed'],
		// — the full mix (every terminal present → the most severe, failed)
		[['failed', 'skipped', 'stopped', 'completed'], 'failed', 'all four terminals'],
		[['stopped', 'completed', 'skipped'], 'stopped', 'three terminals, no failure → stopped'],
		[['completed', 'skipped', 'completed'], 'completed', 'completes + skips → completed'],
	]

	for (const [tasks, expected, label] of cases) {
		it(`[${tasks.join(', ') || '∅'}] → ${expected} (${label})`, () => {
			expect(derivePhaseStatus(tasks)).toBe(expected)
		})
	}

	it('is order-insensitive — every permutation of a mixed input derives the same status', () => {
		// Tasks are concurrent, so the reduction must not depend on order. Assert it over EVERY
		// permutation of a four-terminal mix (the strongest order-independence claim, not one shuffle).
		const base: readonly LifecycleStatus[] = ['failed', 'completed', 'skipped', 'stopped']
		for (const permutation of permutations(base)) {
			expect(derivePhaseStatus(permutation)).toBe('failed')
		}
		// And a non-terminal mix whose answer is `running` regardless of order.
		const mixed: readonly LifecycleStatus[] = ['completed', 'running', 'pending']
		for (const permutation of permutations(mixed)) {
			expect(derivePhaseStatus(permutation)).toBe('running')
		}
	})
})

// Build the PhaseDerivation[] input from a list of statuses, tagging EVERY phase with the SAME
// effective `bail` — the legacy "one scalar bail" the old signature took, carried per phase.
// A uniform bail reproduces the old behavior exactly; the per-phase divergence is exercised by the
// `mixed-bail` rows below (and end-to-end in WorkflowRunner.test.ts).
function derivations(
	statuses: readonly LifecycleStatus[],
	bail: boolean,
): readonly PhaseDerivation[] {
	return statuses.map((status) => ({ status, bail }))
}

describe('deriveWorkflowStatus — exhaustive truth table under BOTH bail modes', () => {
	// The workflow derivation differs from the phase only in the FAILED handling, which `bail`
	// gates PER PHASE. Each row pins one equivalence class under a specific (uniform) `bail`; the
	// bail-agnostic classes are asserted under BOTH modes (below) to prove `bail` touches ONLY
	// failure. A trailing MIXED-bail block proves the policy is resolved per phase, not globally.
	const cases: ReadonlyArray<{
		readonly input: readonly LifecycleStatus[]
		readonly bail: boolean
		readonly expected: LifecycleStatus
		readonly label: string
	}> = [
		// ── bail: true (halt) — a failed phase short-circuits to `failed`, even mid-flight ──
		{ input: ['failed'], bail: true, expected: 'failed', label: 'single failed halts' },
		{
			input: ['completed', 'failed'],
			bail: true,
			expected: 'failed',
			label: 'a failure among completes halts',
		},
		{
			input: ['failed', 'pending'],
			bail: true,
			expected: 'failed',
			label: 'failed + pending: halts BEFORE the all-pending check',
		},
		{
			input: ['failed', 'running'],
			bail: true,
			expected: 'failed',
			label: 'failed + running: the failed short-circuit fires BEFORE the running check',
		},
		{
			input: ['failed', 'stopped'],
			bail: true,
			expected: 'failed',
			label: 'failed beats stopped under halt',
		},
		{ input: ['failed', 'failed'], bail: true, expected: 'failed', label: 'all failed halts' },
		{
			input: ['failed', 'skipped'],
			bail: true,
			expected: 'failed',
			label: 'failed beats skipped under halt',
		},
		// ── bail: false (graceful) — a failed phase is DATA; the workflow NEVER derives `failed` ──
		{
			input: ['failed'],
			bail: false,
			expected: 'completed',
			label: 'single failed folds into completed',
		},
		{
			input: ['completed', 'failed'],
			bail: false,
			expected: 'completed',
			label: 'failure folded into completion',
		},
		{
			input: ['failed', 'pending'],
			bail: false,
			expected: 'running',
			label: 'failed + pending: NOT all terminal ⇒ running (failed does not short-circuit)',
		},
		{
			input: ['failed', 'running'],
			bail: false,
			expected: 'running',
			label: 'failed + running: NOT all terminal ⇒ running (THE graceful→running case)',
		},
		{
			input: ['failed', 'stopped'],
			bail: false,
			expected: 'stopped',
			label: 'a stop still beats a folded failure',
		},
		{
			input: ['failed', 'failed'],
			bail: false,
			expected: 'completed',
			label: 'all failed still completes gracefully',
		},
		{
			input: ['failed', 'skipped'],
			bail: false,
			expected: 'completed',
			label: 'failed folds to completed even with only skips beside it',
		},
	]

	for (const { input, bail, expected, label } of cases) {
		it(`[${input.join(', ') || '∅'}] @ bail:${bail} → ${expected} (${label})`, () => {
			expect(deriveWorkflowStatus(derivations(input, bail))).toBe(expected)
		})
	}

	// The bail-AGNOSTIC classes — every branch that does NOT involve a failed phase. Asserted
	// under BOTH modes with the SAME expected value, proving `bail` changes only the failed path.
	const agnostic: ReadonlyArray<readonly [readonly LifecycleStatus[], LifecycleStatus, string]> = [
		[[], 'pending', 'no phases'],
		[['pending'], 'pending', 'single pending'],
		[['pending', 'pending'], 'pending', 'all pending'],
		[['running'], 'running', 'single running'],
		[['running', 'pending'], 'running', 'running + pending'],
		[['completed', 'pending'], 'running', 'terminal + pending (started, not all settled)'],
		[['completed', 'running'], 'running', 'terminal + running (started, not all settled)'],
		[['completed'], 'completed', 'single completed'],
		[['completed', 'completed'], 'completed', 'all completed'],
		[['completed', 'skipped'], 'completed', 'completes + skips → completed'],
		[['skipped'], 'skipped', 'single skipped'],
		[['skipped', 'skipped'], 'skipped', 'all skipped'],
		[['stopped'], 'stopped', 'single stopped'],
		[['stopped', 'stopped'], 'stopped', 'all stopped'],
		[['stopped', 'completed'], 'stopped', 'stopped beats completed'],
		[['stopped', 'skipped'], 'stopped', 'stopped beats skipped'],
	]

	for (const [input, expected, label] of agnostic) {
		for (const bail of [false, true]) {
			it(`[${input.join(', ') || '∅'}] @ bail:${bail} → ${expected} (bail-agnostic: ${label})`, () => {
				expect(deriveWorkflowStatus(derivations(input, bail))).toBe(expected)
			})
		}
	}

	it('bail is the ONLY axis that changes an outcome — same graph, failed differs', () => {
		// A phase graph with exactly one failed phase among terminals: graceful folds it into
		// `completed`, halt propagates `failed`. The two modes diverge ONLY because of the failure.
		const phases: readonly LifecycleStatus[] = ['completed', 'failed', 'completed']
		expect(deriveWorkflowStatus(derivations(phases, false))).toBe('completed')
		expect(deriveWorkflowStatus(derivations(phases, true))).toBe('failed')
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
			expect(deriveWorkflowStatus(derivations(input, false))).toBe(
				deriveWorkflowStatus(derivations(input, true)),
			)
		}
	})

	it('is order-insensitive under both modes (phases are a settled set here)', () => {
		const base: readonly LifecycleStatus[] = ['failed', 'completed', 'stopped']
		for (const permutation of permutations(base)) {
			expect(deriveWorkflowStatus(derivations(permutation, true))).toBe('failed') // failed dominates under halt
			expect(deriveWorkflowStatus(derivations(permutation, false))).toBe('stopped') // stop beats a folded fail
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
			for (const permutation of permutations(base)) {
				expect(deriveWorkflowStatus(permutation)).toBe('failed')
			}
		})
	})
})

// Every permutation of a small status list — the order-independence prover (a real generator,
// not a mock). Kept local: order-permutation is specific to these derivation tests.
function permutations<T>(items: readonly T[]): ReadonlyArray<readonly T[]> {
	if (items.length <= 1) return [items]
	const out: T[][] = []
	for (const [index, item] of items.entries()) {
		const rest = [...items.slice(0, index), ...items.slice(index + 1)]
		for (const permutation of permutations(rest)) out.push([item, ...permutation])
	}
	return out
}

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
	const result = (id: string): TaskResult => ({
		task: { id, name: id, phase: { id: 'p', name: 'P', workflow: { id: 'w', name: 'W' } } },
		phase: { id: 'p', name: 'P', workflow: { id: 'w', name: 'W' } },
		workflow: { id: 'w', name: 'W' },
		status: 'completed',
		timestamp: 0,
	})

	it('flattens per-phase result lists in order', () => {
		expect(
			collectResults([[result('a'), result('b')], [], [result('c')]]).map((one) => one.task.id),
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
		let starts = 0
		controller.abort(reason)

		await expect(
			scheduleHost(() => {
				starts += 1
				return () => undefined
			}, controller.signal),
		).rejects.toBe(reason)
		expect(starts).toBe(0)
	})

	it('rejects an invalid signal before starting host work', async () => {
		let starts = 0
		const pending: unknown = Reflect.apply(scheduleHost, undefined, [
			() => {
				starts += 1
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
		expect(starts).toBe(0)
	})

	it('rejects rather than throwing when a proxied signal traps during linking', async () => {
		// A Proxy over a NATIVE signal passes `isAbortSignal`, so the pre-guard cannot catch it, and
		// the trap then fires inside linking. Without containment that escape is SYNCHRONOUS — the
		// one shape no scheduler backend expects, because each returns the call directly to a caller
		// that only awaits. Setup must present one failure shape regardless of how hostile the input.
		//
		// The trap is on `aborted` because that is a member linking actually reads. A
		// `getPrototypeOf` trap also passes `isAbortSignal`, but nothing in linking asks for
		// the prototype, so it never fires and this test measured a schedule that
		// never settled rather than the containment it names.
		let starts = 0
		let sprung = 0
		const trap = new Error('proxy trap must not escape synchronously')
		const hostile = new Proxy(new AbortController().signal, {
			get(target, property) {
				if (property === 'aborted') {
					sprung += 1
					throw trap
				}
				const member: unknown = Reflect.get(target, property, target)
				return typeof member === 'function' ? member.bind(target) : member
			},
		})

		let pending: unknown
		expect(() => {
			pending = scheduleHost(() => {
				starts += 1
				return () => undefined
			}, hostile)
		}).not.toThrow()
		if (!(pending instanceof Promise)) throw new Error('expected rejected scheduling promise')

		await expect(pending).rejects.toBeInstanceOf(WorkflowError)
		await expect(pending).rejects.toMatchObject({
			code: 'SCHEDULE',
			context: { signal: 'object' },
		})
		await expect(pending).rejects.not.toBe(trap)
		expect(starts).toBe(0)
		// The instrument reports on itself: a trap that never springs means linking
		// stopped reading the member this vector attacks, and the assertions above
		// would then be measuring a schedule that never settled rather than the
		// containment they name.
		expect(sprung).toBeGreaterThan(0)
	})

	it('schedules safely when the caller addEventListener method is patched to throw', async () => {
		const controller = new AbortController()
		Object.defineProperty(controller.signal, 'addEventListener', {
			value: () => {
				throw new Error('caller listener method must stay unread')
			},
		})

		await expect(
			scheduleHost((complete) => {
				const handle = setTimeout(complete, 0)
				return () => clearTimeout(handle)
			}, controller.signal),
		).resolves.toBeUndefined()
	})

	it('cannot hang when the caller removeEventListener method changes after scheduling', async () => {
		const controller = new AbortController()
		let complete: (() => void) | undefined
		const pending = scheduleHost((settle) => {
			complete = settle
			return () => undefined
		}, controller.signal)
		Object.defineProperty(controller.signal, 'removeEventListener', {
			value: () => {
				throw new Error('caller listener method must stay unread')
			},
		})
		if (complete === undefined) throw new Error('expected armed host completion')

		complete()

		await expect(pending).resolves.toBeUndefined()
	})

	it('rejects an exact start throw before a cancellation closure exists', async () => {
		const fault = new Error('host setup failed')

		await expect(
			scheduleHost(() => {
				throw fault
			}),
		).rejects.toBe(fault)
	})

	it('cancels once when completion settles synchronously before start returns', async () => {
		let cancellations = 0

		await expect(
			scheduleHost((complete) => {
				complete()
				return () => {
					cancellations += 1
				}
			}),
		).resolves.toBeUndefined()
		expect(cancellations).toBe(1)
	})

	it('cancels once when host failure settles synchronously before start returns', async () => {
		const fault = new Error('host failed while arming')
		let cancellations = 0
		const pending = scheduleHost((_complete, fail) => {
			fail(fault)
			return () => {
				cancellations += 1
			}
		})

		await expect(pending).rejects.toBe(fault)
		expect(cancellations).toBe(1)
	})

	it('cancels once and preserves the exact reason when the caller aborts during start', async () => {
		const controller = new AbortController()
		const reason = { command: 'stop' }
		let cancellations = 0

		const pending = scheduleHost(() => {
			controller.abort(reason)
			return () => {
				cancellations += 1
			}
		}, controller.signal)

		await expect(pending).rejects.toBe(reason)
		expect(cancellations).toBe(1)
	})

	it('keeps the caller reason when cancellation synchronously reports a host failure', async () => {
		const controller = new AbortController()
		const reason = new Error('caller stopped first')
		const cleanupFailure = new Error('cleanup reported failure')
		let cancellations = 0
		const pending = scheduleHost((_complete, fail) => {
			return () => {
				cancellations += 1
				fail(cleanupFailure)
			}
		}, controller.signal)

		controller.abort(reason)

		await expect(pending).rejects.toBe(reason)
		expect(cancellations).toBe(1)
	})

	it('contains a throwing cancellation closure after an asynchronous caller abort', async () => {
		const controller = new AbortController()
		const reason = new Error('caller stopped')
		const cleanup = new Error('caller cleanup failed')
		const pending = scheduleHost(
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
		const pending = scheduleHost((_complete, fail) => {
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
			let cancellations = 0
			const pending = scheduleHost((_complete, fail) => {
				queueMicrotask(() => fail(reason))
				return () => {
					cancellations += 1
				}
			})
			const outcome = await pending.then(
				() => success(undefined),
				(error) => failure(error),
			)

			expect(outcome.success).toBe(false)
			if (outcome.success) throw new Error('expected host rejection')
			expect(outcome.error).toBe(reason)
			expect(cancellations).toBe(1)
		}
	})

	it('ignores late caller abort and host failure after completion', async () => {
		const controller = new AbortController()
		let complete: (() => void) | undefined
		let fail: ((error: unknown) => void) | undefined
		let settlements = 0
		let cancellations = 0
		const pending = scheduleHost((settle, reject) => {
			complete = settle
			fail = reject
			return () => {
				cancellations += 1
			}
		}, controller.signal).then(
			() => {
				settlements += 1
				return 'resolved'
			},
			() => {
				settlements += 1
				return 'rejected'
			},
		)
		if (complete === undefined || fail === undefined) throw new Error('expected armed host')

		complete()
		expect(await pending).toBe('resolved')
		controller.abort(new Error('late caller abort'))
		fail(new Error('late host failure'))
		complete()
		await Promise.resolve()

		expect(settlements).toBe(1)
		expect(cancellations).toBe(0)
	})

	it('ignores late completion and caller abort after host failure', async () => {
		const controller = new AbortController()
		const reason = new Error('host failed first')
		let complete: (() => void) | undefined
		let fail: ((error: unknown) => void) | undefined
		let settlements = 0
		let cancellations = 0
		const pending = scheduleHost((settle, reject) => {
			complete = settle
			fail = reject
			return () => {
				cancellations += 1
			}
		}, controller.signal).then(
			() => {
				settlements += 1
				return success(undefined)
			},
			(error) => {
				settlements += 1
				return failure(error)
			},
		)
		if (complete === undefined || fail === undefined) throw new Error('expected armed host')

		fail(reason)
		const outcome = await pending
		expect(outcome.success).toBe(false)
		if (outcome.success) throw new Error('expected host rejection')
		expect(outcome.error).toBe(reason)
		complete()
		controller.abort(new Error('late caller abort'))
		await Promise.resolve()

		expect(settlements).toBe(1)
		expect(cancellations).toBe(1)
	})

	it('ignores late completion and host failure after caller abort', async () => {
		const controller = new AbortController()
		const reason = new Error('caller stopped first')
		let complete: (() => void) | undefined
		let fail: ((error: unknown) => void) | undefined
		let settlements = 0
		let cancellations = 0
		const pending = scheduleHost((settle, reject) => {
			complete = settle
			fail = reject
			return () => {
				cancellations += 1
			}
		}, controller.signal).then(
			() => {
				settlements += 1
				return success(undefined)
			},
			(error) => {
				settlements += 1
				return failure(error)
			},
		)
		if (complete === undefined || fail === undefined) throw new Error('expected armed host')

		controller.abort(reason)
		const outcome = await pending
		expect(outcome.success).toBe(false)
		if (outcome.success) throw new Error('expected caller rejection')
		expect(outcome.error).toBe(reason)
		complete()
		fail(new Error('late host failure'))
		await Promise.resolve()

		expect(settlements).toBe(1)
		expect(cancellations).toBe(1)
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
		let settled = false
		const parked = parkSignal(controller.signal).then(() => {
			settled = true
		})
		await waitForDelay(5)
		expect(settled).toBe(false)
		controller.abort()
		await parked
		expect(settled).toBe(true)
	})

	it('never rejects, even when the signal aborts with a reason', async () => {
		const controller = new AbortController()
		const parked = parkSignal(controller.signal)
		controller.abort(new Error('boom'))
		await expect(parked).resolves.toBeUndefined()
	})
})

describe('success / failure — the Result constructors', () => {
	it('success boxes a value as { success: true, value }', () => {
		expect(success(42)).toEqual({ success: true, value: 42 })
		expect(success('x')).toEqual({ success: true, value: 'x' })
		expect(success(undefined)).toEqual({ success: true, value: undefined })
	})

	it('failure boxes an error as { success: false, error }', () => {
		const error = new Error('boom')
		expect(failure(error)).toEqual({ success: false, error })
		expect(failure('plain reason')).toEqual({ success: false, error: 'plain reason' })
	})
})

describe('errorToMessage', () => {
	it('normalizes empty and hostile values without throwing', () => {
		const hostileMessage = Object.create(Error.prototype)
		Object.defineProperty(hostileMessage, 'message', {
			get: () => {
				throw new Error('hostile message')
			},
		})
		const hostileString = {
			toString: () => {
				throw new Error('hostile string')
			},
		}

		expect(errorToMessage(new Error('boom'))).toBe('boom')
		expect(errorToMessage('plain')).toBe('plain')
		expect(errorToMessage('')).toBe('unknown failure')
		expect(errorToMessage(hostileMessage)).toBe('unknown failure')
		expect(errorToMessage(hostileString)).toBe('unknown failure')
		expect(errorToMessage(Symbol('reason'))).toBe('Symbol(reason)')
	})
})

describe('findFailure — the first Failure in a positional result list', () => {
	const outcome = (id: string, ok: boolean): TaskResult => ({
		task: { id, name: id, phase: { id: 'p', name: 'P', workflow: { id: 'w', name: 'W' } } },
		phase: { id: 'p', name: 'P', workflow: { id: 'w', name: 'W' } },
		workflow: { id: 'w', name: 'W' },
		status: ok ? 'completed' : 'failed',
		result: ok ? success('v') : failure({ origin: 'handler', message: `${id} failed` }),
		timestamp: 0,
	})

	it('returns undefined for an empty list', () => {
		expect(findFailure([])).toBeUndefined()
	})

	it('returns undefined when no result is a Failure', () => {
		expect(findFailure([outcome('a', true), outcome('b', true)])).toBeUndefined()
	})

	it('returns the first Failure among several — order sensitive', () => {
		const results = [outcome('a', true), outcome('b', false), outcome('c', false)]
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
	it('inherits only a finite positive default and lets any present invalid task value disable it', () => {
		expect(resolveTaskSilence(undefined, 10)).toBe(10)
		expect(resolveTaskSilence(5, 10)).toBe(5)
		expect(resolveTaskSilence(0, 10)).toBeUndefined()
		expect(resolveTaskSilence(-1, 10)).toBeUndefined()
		expect(resolveTaskSilence(Number.NaN, 10)).toBeUndefined()
		expect(resolveTaskSilence(Number.POSITIVE_INFINITY, 10)).toBeUndefined()
		expect(resolveTaskSilence(undefined, Number.NaN)).toBeUndefined()
		expect(resolveTaskSilence(2_147_483_647, 10)).toBe(2_147_483_647)
		expect(resolveTaskSilence(2_147_483_648, 10)).toBeUndefined()
		expect(resolveTaskSilence(undefined, 2_147_483_648)).toBeUndefined()
	})
})

// The snapshot-decode leaves: an exact restore of a persisted tree and the recovery projection
// that returns interrupted work to its remaining budget. Real definitions, real snapshots, real
// handler registries throughout.

const RECOVERY_DEFINITION: WorkflowDefinition = {
	id: 'durable',
	name: 'Durable',
	bail: false,
	phases: [
		{
			id: 'phase',
			name: 'Phase',
			tasks: [{ id: 'task', name: 'Task', behavior: 'work', retries: 1 }],
		},
	],
}

const VALIDATED_FUNCTIONS = { work: () => 'validated' }
const SHIFTED_FUNCTIONS = { work: () => 'shifted' }

function recoveryRunner(): ReturnType<typeof createWorkflowRunner> {
	return createWorkflowRunner({ scheduler: createRecordingScheduler() })
}

describe('workflow recovery', () => {
	it('uses the exact once-read functions registry for validation and recovered handlers', () => {
		const source = createWorkflow(RECOVERY_DEFINITION, { functions: VALIDATED_FUNCTIONS })
		const task = source.phase('phase')?.task('task')
		if (task === undefined) throw new Error('expected recoverable task')
		task.start()
		let reads = 0
		const options: WorkflowOptions = {}
		Object.defineProperty(options, 'functions', {
			get: () => {
				reads += 1
				return reads === 1 ? VALIDATED_FUNCTIONS : SHIFTED_FUNCTIONS
			},
		})

		const recovered = createRecoveredWorkflow(source.snapshot(), options)

		expect(reads).toBe(1)
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
		let reads = 0
		const functions: WorkflowRegistry = {}
		Object.defineProperty(functions, 'work', {
			get: () => {
				reads += 1
				return reads === 1 ? VALIDATED_FUNCTIONS.work : SHIFTED_FUNCTIONS.work
			},
		})

		const recovered = createRecoveredWorkflow(snapshot, { functions })

		expect(reads).toBe(1)
		expect(recovered.phase('phase')?.task('first')?.handler).toBe(VALIDATED_FUNCTIONS.work)
		expect(recovered.phase('phase')?.task('second')?.handler).toBe(VALIDATED_FUNCTIONS.work)
		const added = recovered.phase('phase')?.add({ id: 'later', name: 'Later', behavior: 'work' })
		if (added === undefined || !added.success) throw new Error('expected live task addition')
		expect(reads).toBe(2)
		expect(added.value.handler).toBe(SHIFTED_FUNCTIONS.work)
	})

	it('rejects the first unresolved keyed binding without rereading a later valid value', () => {
		const snapshot = createWorkflow(RECOVERY_DEFINITION, {
			functions: VALIDATED_FUNCTIONS,
		}).snapshot()
		let reads = 0
		const functions: WorkflowRegistry = {}
		Object.defineProperty(functions, 'work', {
			get: () => {
				reads += 1
				return reads === 1 ? undefined : VALIDATED_FUNCTIONS.work
			},
		})

		const error = captureError(() => createRecoveredWorkflow(snapshot, { functions }))

		expect(reads).toBe(1)
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
		const functions = {
			first: () => 'first',
			done: () => 'done',
			interrupted: () => 'interrupted',
		}
		const source = createWorkflow(definition, { functions })
		const done = source.phase('phase')?.task('done')
		const interrupted = source.phase('phase')?.task('interrupted')
		if (done === undefined || interrupted === undefined) throw new Error('expected mixed tasks')
		done.start()
		done.complete('persisted')
		interrupted.start()

		const exact = createRestoredWorkflow(source.snapshot(), { functions })
		expect(() => recoveryRunner().execute(exact)).toThrow(/not drivable/)

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
		const result = await recoveryRunner().execute(recovered)

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

		const result = await recoveryRunner().execute(recovered)
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
				message: "task 'task' exhausted its retry budget during recovery",
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

	it.each([
		{
			bail: true,
			expected: ['skipped', 'failed', 'skipped', 'skipped'],
			later: 'skipped',
		},
		{
			bail: false,
			expected: ['pending', 'failed', 'pending', 'pending'],
			later: 'pending',
		},
	])(
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
		const error = captureError(() => recoveryRunner().execute(restored))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('TRANSITION')
	})

	it('keeps unresolved behavior inspectable but rejects its execution and hostile snapshots', () => {
		const snapshot = createWorkflow(RECOVERY_DEFINITION, {
			functions: { work: () => null },
		}).snapshot()
		const restored = createRestoredWorkflow(snapshot)
		expect(restored.phase('phase')?.task('task')?.behavior).toBe('work')
		expect(() => recoveryRunner().execute(restored)).toThrow(/not drivable/)

		const hostile = {
			get id(): string {
				throw new Error('accessor must not run')
			},
		}
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
		let calls = 0
		const functions = {
			work: () => {
				calls += 1
				return null
			},
		}
		const first = createRestoredWorkflow(snapshot, { functions })
		const second = createRestoredWorkflow(snapshot, { functions })
		expect(first).not.toBe(second)

		const results = await Promise.all([
			recoveryRunner().execute(first),
			recoveryRunner().execute(second),
		])
		expect(results.map((result) => result.status)).toEqual(['completed', 'completed'])
		expect(calls).toBe(2)
	})
})
