import type {
	LifecycleStatus,
	PhaseDerivation,
	PhaseStatus,
	TaskResult,
	TaskStatus,
	WorkflowDefinition,
	WorkflowOptions,
} from '@src/core'
import { ContractError } from '@orkestrel/contract'
import {
	buildPhaseContext,
	buildTaskContext,
	buildWorkflowContext,
	canTransitionTask,
	captureWorkflowOptions,
	collectResults,
	definitionToSnapshot,
	deriveBoundary,
	derivePhaseStatus,
	deriveWorkflowStatus,
	errorToMessage,
	failure,
	findFailure,
	insertEntry,
	isTerminalStatus,
	moveEntry,
	parkSignal,
	phaseDefinitionToSnapshot,
	resolveTaskSilence,
	scheduleHost,
	success,
	taskDefinitionToSnapshot,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { captureError, createErrorRecorder } from '../../setup.js'

// The §10/§14 logic core: the derivation truth tables under BOTH bail modes, the ONE
// terminal predicate, and the task-form `via` guards. Pure functions — real inputs, no
// mocks (AGENTS §16). The derivation tables are EXHAUSTIVE by equivalence class: every
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

	it('accepts a value typed at each tier (task / phase / workflow) through one predicate', () => {
		// The three tiers alias one LifecycleStatus, so a value typed at any tier flows into the one
		// predicate — this is the consolidation's whole point (no per-tier terminal duplication).
		const taskStatus: TaskStatus = 'completed'
		const phaseStatus: PhaseStatus = 'running'
		const workflowStatus: LifecycleStatus = 'failed'
		expect(isTerminalStatus(taskStatus)).toBe(true)
		expect(isTerminalStatus(phaseStatus)).toBe(false)
		expect(isTerminalStatus(workflowStatus)).toBe(true)
	})
})

describe('derivePhaseStatus — exhaustive truth table (tasks concurrent)', () => {
	// Every equivalence class of the phase derivation, by branch:
	//   empty → pending · all-pending → pending · not-all-terminal → running ·
	//   then most-severe terminal wins: failed > stopped > completed > skipped.
	const cases: ReadonlyArray<readonly [readonly TaskStatus[], PhaseStatus, string]> = [
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
		const base: readonly TaskStatus[] = ['failed', 'completed', 'skipped', 'stopped']
		for (const permutation of permutations(base)) {
			expect(derivePhaseStatus(permutation)).toBe('failed')
		}
		// And a non-terminal mix whose answer is `running` regardless of order.
		const mixed: readonly TaskStatus[] = ['completed', 'running', 'pending']
		for (const permutation of permutations(mixed)) {
			expect(derivePhaseStatus(permutation)).toBe('running')
		}
	})
})

// Build the PhaseDerivation[] input from a list of statuses, tagging EVERY phase with the SAME
// effective `bail` — the legacy "one scalar bail" the old signature took, now carried per phase.
// A uniform bail reproduces the old behavior exactly; the per-phase divergence is exercised by the
// `mixed-bail` rows below (and end-to-end in WorkflowRunner.test.ts).
function derivations(statuses: readonly PhaseStatus[], bail: boolean): readonly PhaseDerivation[] {
	return statuses.map((status) => ({ status, bail }))
}

describe('deriveWorkflowStatus — exhaustive truth table under BOTH bail modes', () => {
	// The workflow derivation differs from the phase only in the FAILED handling, which `bail`
	// gates PER PHASE. Each row pins one equivalence class under a specific (uniform) `bail`; the
	// bail-agnostic classes are asserted under BOTH modes (below) to prove `bail` touches ONLY
	// failure. A trailing MIXED-bail block proves the policy is now resolved per phase, not globally.
	const cases: ReadonlyArray<{
		readonly input: readonly PhaseStatus[]
		readonly bail: boolean
		readonly expected: PhaseStatus
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
	const agnostic: ReadonlyArray<readonly [readonly PhaseStatus[], PhaseStatus, string]> = [
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
		const phases: readonly PhaseStatus[] = ['completed', 'failed', 'completed']
		expect(deriveWorkflowStatus(derivations(phases, false))).toBe('completed')
		expect(deriveWorkflowStatus(derivations(phases, true))).toBe('failed')
	})

	it('a failed-free graph is identical under both modes (no divergence without a failure)', () => {
		const graphs: readonly (readonly PhaseStatus[])[] = [
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
		const base: readonly PhaseStatus[] = ['failed', 'completed', 'stopped']
		for (const permutation of permutations(base)) {
			expect(deriveWorkflowStatus(derivations(permutation, true))).toBe('failed') // failed dominates under halt
			expect(deriveWorkflowStatus(derivations(permutation, false))).toBe('stopped') // stop beats a folded fail
		}
	})

	// ── PER-PHASE bail (the new override) — the failure outcome is resolved per phase, not globally ──
	describe('per-phase bail — each phase carries its OWN effective policy', () => {
		// Explicit PhaseDerivation rows where the `bail` flags DIVERGE between phases. These can ONLY
		// be expressed with the per-phase signature — they prove the workflow `failed` derivation is
		// per-phase-bail-aware (a strict-bail failed phase halts even beside a graceful one).
		const mixedCases: ReadonlyArray<readonly [readonly PhaseDerivation[], PhaseStatus, string]> = [
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
function permutations<T>(items: readonly T[]): readonly (readonly T[])[] {
	if (items.length <= 1) return [items]
	const out: T[][] = []
	for (const [index, item] of items.entries()) {
		const rest = [...items.slice(0, index), ...items.slice(index + 1)]
		for (const permutation of permutations(rest)) out.push([item, ...permutation])
	}
	return out
}

describe('canTransitionTask — the legal §10 transition graph', () => {
	it('allows the legal moves off pending and running', () => {
		const pending: readonly TaskStatus[] = ['running', 'skipped', 'stopped']
		const running: readonly TaskStatus[] = ['completed', 'failed', 'skipped', 'stopped']
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
		const terminal: readonly TaskStatus[] = ['completed', 'failed', 'skipped', 'stopped']
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
						run: 'x',
						retries: 2,
						timeout: 500,
					},
				],
			},
		],
	}

	it('seeds every node pending, and PERSISTS declarative fields (concurrency, and the task trio run/retries/timeout)', () => {
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
		expect(snapshot.phases[0]?.tasks[0]?.run).toBe('x')
		expect(snapshot.phases[0]?.tasks[0]?.retries).toBe(2)
		expect(snapshot.phases[0]?.tasks[0]?.timeout).toBe(500)
		expect(JSON.stringify(snapshot)).toContain('"run"')
	})

	it('is pure JSON and preserves identity + order', () => {
		const snapshot = definitionToSnapshot(definition)
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
		expect(snapshot.phases[0]?.tasks[0]?.description).toBe('leaf')
	})

	it('the per-node converters mirror the whole-tree one', () => {
		// phaseDefinitionToSnapshot now takes the inherited workflow bail — it persists the effective
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
			run: 'f',
		})
		expect(task).toEqual({
			id: 't',
			name: 'T',
			status: 'pending',
			metadata: {},
			attempts: 0,
			run: 'f',
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
	it('copies run/retries/timeout when the definition declares them', () => {
		const snapshot = taskDefinitionToSnapshot({
			id: 't',
			name: 'T',
			run: 'x',
			retries: 3,
			timeout: 250,
		})
		expect(snapshot.run).toBe('x')
		expect(snapshot.retries).toBe(3)
		expect(snapshot.timeout).toBe(250)
	})

	it('omits run/retries/timeout when the definition declares none (no undefined keys)', () => {
		const snapshot = taskDefinitionToSnapshot({ id: 't', name: 'T' })
		expect('run' in snapshot).toBe(false)
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

		await expect(pending).rejects.toBeInstanceOf(ContractError)
		await expect(pending).rejects.toMatchObject({
			code: 'placement',
			context: {
				path: ['parent'],
				limit: 'native AbortSignal or undefined',
				received: 'object',
			},
		})
		expect(starts).toBe(0)
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

	it('resolves once the signal aborts (parks across real macrotasks first)', async () => {
		const controller = new AbortController()
		let settled = false
		const parked = parkSignal(controller.signal).then(() => {
			settled = true
		})
		await new Promise((resolve) => setTimeout(resolve, 5))
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

describe('success / failure — the Result constructors (AGENTS §12)', () => {
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
		// The input array is untouched (immutability, AGENTS §11).
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
