import type {
	LifecycleStatus,
	PhaseDerivation,
	PhaseStatus,
	TaskForm,
	TaskResult,
	TaskStatus,
	WorkflowDefinition,
	WorkflowDraft,
	WorkflowResult,
	WorkflowSteps,
} from '@src/core'
import {
	agentTag,
	buildPhaseContext,
	buildTaskContext,
	buildWorkflowContext,
	canTransitionTask,
	collectResults,
	completeDraft,
	completePhaseDraft,
	completeTaskDraft,
	createWorkflow,
	createWorkflowContract,
	definitionToSnapshot,
	derivePhaseStatus,
	deriveWorkflowStatus,
	expandSteps,
	isAgentTask,
	isFunctionTask,
	isTerminalStatus,
	isToolTask,
	isWorkflowSnapshot,
	phaseDefinitionToSnapshot,
	stepToForm,
	taskDefinitionToSnapshot,
	workflowTag,
	workflowToolSummary,
} from '@src/core'
import { describe, expect, it } from 'vitest'

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
	for (let index = 0; index < items.length; index += 1) {
		const rest = [...items.slice(0, index), ...items.slice(index + 1)]
		for (const permutation of permutations(rest)) out.push([items[index], ...permutation])
	}
	return out
}

describe('canTransitionTask — the legal §10 transition graph', () => {
	it('allows the legal moves off pending and running', () => {
		for (const to of ['running', 'skipped', 'stopped'] as const) {
			expect(canTransitionTask('pending', to)).toBe(true)
		}
		for (const to of ['completed', 'failed', 'skipped', 'stopped'] as const) {
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
		expect(phase.workflow).toBe(workflow)
		expect(task.phase).toBe(phase)
		expect(task.phase.workflow.id).toBe('w')
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
				tasks: [{ id: 't', name: 'T', description: 'leaf', run: { via: 'tool', name: 'x' } }],
			},
		],
	}

	it('seeds every node pending, drops execution-only fields (run / concurrency)', () => {
		const snapshot = definitionToSnapshot(definition)
		expect(snapshot.status).toBe('pending')
		expect(snapshot.description).toBe('top')
		expect(snapshot.phases[0]?.status).toBe('pending')
		expect(snapshot.phases[0]?.tasks[0]?.status).toBe('pending')
		expect(snapshot.phases[0]?.tasks[0]?.metadata).toEqual({})
		// The snapshot tree carries no execution fields.
		expect(JSON.stringify(snapshot)).not.toContain('concurrency')
		expect(JSON.stringify(snapshot)).not.toContain('"run"')
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
			run: { via: 'function', name: 'f' },
		})
		expect(task).toEqual({ id: 't', name: 'T', status: 'pending', metadata: {} })
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

describe('task-form guards (narrow on the `via` discriminant)', () => {
	const fn: TaskForm = { via: 'function', name: 'compute' }
	const tool: TaskForm = { via: 'tool', name: 'search' }
	const agent: TaskForm = { via: 'agent', name: 'planner' }

	it('isFunctionTask narrows only the function form', () => {
		expect(isFunctionTask(fn)).toBe(true)
		expect(isFunctionTask(tool)).toBe(false)
		expect(isFunctionTask(agent)).toBe(false)
	})

	it('isToolTask narrows only the tool form', () => {
		expect(isToolTask(tool)).toBe(true)
		expect(isToolTask(fn)).toBe(false)
		expect(isToolTask(agent)).toBe(false)
	})

	it('isAgentTask narrows only the agent form', () => {
		expect(isAgentTask(agent)).toBe(true)
		expect(isAgentTask(fn)).toBe(false)
		expect(isAgentTask(tool)).toBe(false)
	})

	it('exactly one guard matches each form (mutually exclusive)', () => {
		for (const form of [fn, tool, agent]) {
			const matches = [isFunctionTask(form), isToolTask(form), isAgentTask(form)].filter(Boolean)
			expect(matches).toHaveLength(1)
		}
	})
})

describe('ancestry tags (W-c2 depth/cycle chain identifiers)', () => {
	it('namespaces a workflow id and an agent name distinctly (no collision)', () => {
		expect(workflowTag('x')).toBe('workflow:x')
		expect(agentTag('x')).toBe('agent:x')
		// Same underlying string, different namespaced tags — so a `workflow` id never reads as an
		// `agent` of the same name in the ancestry set.
		expect(workflowTag('x')).not.toBe(agentTag('x'))
	})
})

describe('workflow-tool result mapping (W-c2 — WorkflowResult → the handler summary)', () => {
	it('workflowToolSummary summarizes a run as the terminal status + the result count', () => {
		// Build a REAL WorkflowResult (no `as`): a live workflow from `createWorkflow`, and real
		// TaskResults from the lineage builders. The summary reads only `status` + the result count.
		const workflowContext = buildWorkflowContext({ id: 'wf-1', name: 'WF' })
		const phaseContext = buildPhaseContext(workflowContext, { id: 'p', name: 'P' })
		const taskResult = (id: string, status: TaskStatus): TaskResult => ({
			task: buildTaskContext(phaseContext, { id, name: id }),
			phase: phaseContext,
			workflow: workflowContext,
			status,
			timestamp: 0,
		})
		const result: WorkflowResult = {
			workflow: createWorkflow({ id: 'wf-1', name: 'WF', phases: [] }),
			status: 'completed',
			results: [taskResult('t0', 'completed'), taskResult('t1', 'failed')],
		}
		// The PLAIN summary value the handler returns directly (NOT a ToolResult — no synthetic
		// id/name): the ToolManager performs the one canonical wrap around it (proven in factories.test.ts).
		expect(workflowToolSummary(result)).toEqual({ status: 'completed', count: 2 })
	})
})

// The draft-completion + flat-steps-expansion helpers (the tool's LENIENT authoring surfaces).
// Pure + deterministic: they auto-fill ONLY omitted identity and converge on a strict
// definition. The factory re-validates the result against the STRICT contract before running.
describe('completeDraft — synthesize omitted ids/names into a strict definition', () => {
	it('fills EVERY missing id positionally + defaults each name to its (resolved) id', () => {
		const draft: WorkflowDraft = {
			phases: [
				{ tasks: [{ run: { via: 'function', name: 'a' } }, { run: { via: 'tool', name: 'b' } }] },
				{ tasks: [{ run: { via: 'agent', name: 'c' } }] },
			],
		}
		const definition = completeDraft(draft)
		// The completed tree satisfies the STRICT contract (the soundness anchor).
		expect(createWorkflowContract().is(definition)).toBe(true)
		// Positional id scheme: wf / phase-<i> / <phaseId>-task-<j>.
		expect(definition.id).toBe('wf')
		expect(definition.name).toBe('wf') // name defaults to the id
		expect(definition.phases.map((phase) => phase.id)).toEqual(['phase-0', 'phase-1'])
		expect(definition.phases[0]?.name).toBe('phase-0')
		expect(definition.phases[0]?.tasks.map((task) => task.id)).toEqual([
			'phase-0-task-0',
			'phase-0-task-1',
		])
		expect(definition.phases[0]?.tasks[0]?.name).toBe('phase-0-task-0')
		expect(definition.phases[1]?.tasks[0]?.id).toBe('phase-1-task-0')
		// `run` carries over verbatim.
		expect(definition.phases[0]?.tasks[0]?.run).toEqual({ via: 'function', name: 'a' })
		expect(definition.phases[1]?.tasks[0]?.run).toEqual({ via: 'agent', name: 'c' })
	})

	it('PRESERVES a provided id/name verbatim and nests synthesized task ids under a provided phase id', () => {
		const definition = completeDraft({
			id: 'mine',
			phases: [
				{ id: 'p', name: 'Phase', tasks: [{ name: 'T', run: { via: 'function', name: 'f' } }] },
			],
		})
		expect(definition.id).toBe('mine')
		expect(definition.name).toBe('mine') // name defaulted to the PROVIDED id
		expect(definition.phases[0]?.id).toBe('p')
		expect(definition.phases[0]?.name).toBe('Phase') // provided name kept
		// The task gave a name but no id → id synthesized UNDER the provided phase id; name kept.
		expect(definition.phases[0]?.tasks[0]?.id).toBe('p-task-0')
		expect(definition.phases[0]?.tasks[0]?.name).toBe('T')
	})

	it('carries over description / concurrency / bail unchanged', () => {
		const definition = completeDraft({
			description: 'desc',
			bail: true,
			phases: [{ description: 'pd', concurrency: 3, tasks: [] }],
		})
		expect(definition.description).toBe('desc')
		expect(definition.bail).toBe(true)
		expect(definition.phases[0]?.description).toBe('pd')
		expect(definition.phases[0]?.concurrency).toBe(3)
	})

	it('is deterministic — the same draft always yields the same definition', () => {
		const draft: WorkflowDraft = { phases: [{ tasks: [{ run: { via: 'function', name: 'x' } }] }] }
		expect(completeDraft(draft)).toEqual(completeDraft(draft))
	})

	it('completePhaseDraft / completeTaskDraft synthesize at their own positional index', () => {
		expect(completePhaseDraft({ tasks: [] }, 2).id).toBe('phase-2')
		expect(completeTaskDraft({ run: { via: 'tool', name: 't' } }, 'phase-2', 5).id).toBe(
			'phase-2-task-5',
		)
	})
})

describe('expandSteps — flatten a steps blob into a one-task-phase-per-step definition', () => {
	it('maps each step to a one-task phase IN ORDER (run.name = name, via default function)', () => {
		const flat: WorkflowSteps = {
			name: 'pipeline',
			steps: [{ name: 'fetch' }, { name: 'scan', via: 'tool' }, { name: 'audit', via: 'agent' }],
		}
		const definition = expandSteps(flat)
		expect(createWorkflowContract().is(definition)).toBe(true)
		expect(definition.name).toBe('pipeline')
		// One phase per step, each holding exactly one task, in order.
		expect(definition.phases).toHaveLength(3)
		expect(definition.phases.map((phase) => phase.tasks.length)).toEqual([1, 1, 1])
		expect(definition.phases.map((phase) => phase.id)).toEqual(['phase-0', 'phase-1', 'phase-2'])
		expect(definition.phases[0]?.tasks[0]?.id).toBe('phase-0-task-0')
		// a step's `name` → the task's run.name; an omitted `via` defaults to 'function'.
		expect(definition.phases[0]?.tasks[0]?.run).toEqual({ via: 'function', name: 'fetch' })
		expect(definition.phases[1]?.tasks[0]?.run).toEqual({ via: 'tool', name: 'scan' })
		expect(definition.phases[2]?.tasks[0]?.run).toEqual({ via: 'agent', name: 'audit' })
	})

	it('defaults the workflow id (and name) when no name is supplied', () => {
		const definition = expandSteps({ steps: [{ name: 'only' }] })
		expect(definition.id).toBe('wf')
		expect(definition.name).toBe('wf')
	})

	it('stepToForm maps name→run.name and defaults via to function', () => {
		expect(stepToForm({ name: 'x' })).toEqual({ via: 'function', name: 'x' })
		expect(stepToForm({ name: 'y', via: 'agent' })).toEqual({ via: 'agent', name: 'y' })
	})
})

describe('isWorkflowSnapshot — the §14 boundary narrow for an opaque snapshot read', () => {
	// A REAL snapshot (createWorkflow(...).snapshot()) — the value DatabaseWorkflowStore reads back
	// from its opaque JSON column. The guard narrows `unknown` → WorkflowSnapshot by shape, total
	// (never throws), so the durable store can impose the type at the storage boundary with no cast.
	const definition: WorkflowDefinition = {
		id: 'release',
		name: 'Release',
		phases: [
			{
				id: 'build',
				name: 'Build',
				tasks: [{ id: 't', name: 'T', run: { via: 'function', name: 'f' } }],
			},
		],
	}
	const snapshot = createWorkflow(definition).snapshot()
	// A JSON round-trip mimics the real storage read (a structured clone / a driver row).
	const revived: unknown = JSON.parse(JSON.stringify(snapshot))

	it('accepts a real WorkflowSnapshot (and its JSON-revived form)', () => {
		expect(isWorkflowSnapshot(snapshot)).toBe(true)
		expect(isWorkflowSnapshot(revived)).toBe(true)
	})

	it('rejects non-snapshots without throwing (totality, AGENTS §14)', () => {
		// Off-shape primitives / structures all return false, never an error.
		for (const value of [undefined, null, 42, 'snapshot', [], {}, { id: 'x' }]) {
			expect(isWorkflowSnapshot(value)).toBe(false)
		}
		// A record missing one required field, or with a wrong-typed field, is rejected.
		expect(isWorkflowSnapshot({ ...snapshot, bail: 'yes' })).toBe(false)
		expect(isWorkflowSnapshot({ ...snapshot, phases: 'none' })).toBe(false)
		const { created: _omit, ...withoutCreated } = snapshot
		expect(isWorkflowSnapshot(withoutCreated)).toBe(false)
	})
})
