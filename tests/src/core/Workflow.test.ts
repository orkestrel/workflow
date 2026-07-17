import type { WorkflowDefinition, WorkflowInterface } from '@src/core'
import { createWorkflow, isWorkflowError, restoreWorkflow } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	buildWorkflowDefinition,
	captureError,
	createErrorRecorder,
	createRecorder,
	recordEmitterEvents,
} from '../../setup.js'

// The DERIVED workflow state machine (W-b) — the cascade's top tier under BOTH bail
// modes, the override, the workflow-tier result tree, and the snapshot → restore
// round-trip (status + results + positional order + override). Real stubs — no mocks.

/** A two-phase definition (`a`: t0/t1, `b`: t2) with the given `bail`, for cascade tests. */
function buildTwoPhaseWorkflow(bail: boolean): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		bail,
		phases: [
			{
				id: 'a',
				name: 'A',
				tasks: [
					{ id: 't0', name: 'T0', run: { via: 'function', name: 'f' } },
					{ id: 't1', name: 'T1', run: { via: 'function', name: 'f' } },
				],
			},
			{
				id: 'b',
				name: 'B',
				tasks: [{ id: 't2', name: 'T2', run: { via: 'function', name: 'f' } }],
			},
		],
	}
}

/** Drive a leaf to `completed` through its legal transitions. */
function completeTask(workflow: WorkflowInterface, phase: string, task: string): void {
	const leaf = workflow.phase(phase)?.task(task)
	leaf?.start()
	leaf?.complete('ok')
}

describe('Workflow — construction from a definition', () => {
	it('builds the whole live tree with lineage + bail from the definition', () => {
		const workflow = createWorkflow(buildWorkflowDefinition())
		expect(workflow.id).toBe('wf-1')
		expect(workflow.bail).toBe(false)
		expect(workflow.phases.count).toBe(2)
		expect(workflow.phase('phase-build')?.tasks.count).toBe(2)
		// Lineage navigates both ways.
		const task = workflow.phase('phase-build')?.task('task-compile')
		expect(task?.workflow.id).toBe('wf-1')
		expect(workflow.phase('phase-build')?.workflow).toBe(workflow)
	})

	it('starts pending and defaults bail to graceful when the definition omits it', () => {
		const workflow = createWorkflow({
			id: 'w',
			name: 'W',
			phases: [{ id: 'p', name: 'P', tasks: [] }],
		})
		expect(workflow.status).toBe('pending')
		expect(workflow.bail).toBe(false)
	})

	it('an options.bail overrides the definition bail', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false), { bail: true })
		expect(workflow.bail).toBe(true)
	})
})

describe('Workflow — degenerate trees (zero phases, empty round-trip)', () => {
	/** A workflow definition with NO phases — the most degenerate tree. */
	function buildEmptyWorkflow(bail: boolean): WorkflowDefinition {
		return { id: 'wf', name: 'WF', bail, phases: [] }
	}

	it('a zero-phase workflow derives pending and has no results', () => {
		const workflow = createWorkflow(buildEmptyWorkflow(false))
		expect(workflow.phases.count).toBe(0)
		expect(workflow.status).toBe('pending')
		expect(workflow.results()).toEqual([])
	})

	it('a zero-phase workflow snapshot → restore round-trips deep-equal (incl. bail)', () => {
		const workflow = createWorkflow(buildEmptyWorkflow(true))
		const snapshot = workflow.snapshot()
		expect(snapshot.phases).toEqual([])
		expect(snapshot.bail).toBe(true)
		const restored = restoreWorkflow(snapshot) // bail comes from the snapshot, no options
		expect(restored.bail).toBe(true)
		expect(restored.status).toBe('pending')
		expect(restored.snapshot()).toEqual(snapshot)
	})

	it('a zero-phase workflow can still be force-skipped / force-stopped and round-trips the override', () => {
		const workflow = createWorkflow(buildEmptyWorkflow(false))
		workflow.stop()
		expect(workflow.status).toBe('stopped')
		const restored = restoreWorkflow(workflow.snapshot())
		expect(restored.status).toBe('stopped')
		expect(restored.snapshot().override).toBe('stopped')
	})

	it('a phase with zero tasks derives pending and a workflow over only empty phases is pending', () => {
		const workflow = createWorkflow({
			id: 'wf',
			name: 'WF',
			phases: [
				{ id: 'a', name: 'A', tasks: [] },
				{ id: 'b', name: 'B', tasks: [] },
			],
		})
		expect(workflow.phase('a')?.status).toBe('pending')
		expect(workflow.status).toBe('pending')
		// And it round-trips.
		const restored = restoreWorkflow(workflow.snapshot())
		expect(restored.snapshot()).toEqual(workflow.snapshot())
	})
})

describe('Workflow — multi-phase cascade (sequential phases, reactive re-derive)', () => {
	it('is running while phase 1 is fully terminal but phase 2 is still pending', () => {
		// Phase a fully settles (both tasks complete) while phase b never starts. The workflow is NOT
		// done — a later phase is still pending — so the derived status is running, not completed.
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		completeTask(workflow, 'a', 't0')
		completeTask(workflow, 'a', 't1')
		expect(workflow.phase('a')?.status).toBe('completed')
		expect(workflow.phase('b')?.status).toBe('pending')
		expect(workflow.status).toBe('running')
	})

	it('a transition in a LATER phase re-derives the workflow through the cascade', () => {
		// Settle phase a, then drive phase b's task. The workflow must re-derive to completed off the
		// later phase's change — the cascade reaches the root from any phase, not just the first.
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		completeTask(workflow, 'a', 't0')
		completeTask(workflow, 'a', 't1')
		expect(workflow.status).toBe('running')
		completeTask(workflow, 'b', 't2')
		expect(workflow.status).toBe('completed')
	})

	it('emits each derived-status change EXACTLY once across a multi-step drive (diff-only)', () => {
		// Driving the whole tree task-by-task crosses pending → running → completed. The workflow must
		// emit `start` once (the first transition off pending) and `complete` once (the last settle) —
		// never re-emitting on the intermediate task transitions that don't change the workflow status.
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		const events = recordEmitterEvents(workflow.emitter, ['start', 'complete', 'fail', 'stop'])
		completeTask(workflow, 'a', 't0') // running (start fires once)
		expect(events.start.count).toBe(1)
		completeTask(workflow, 'a', 't1') // still running — phase a done, b pending: NO new emit
		expect(events.start.count).toBe(1)
		expect(events.complete.count).toBe(0)
		completeTask(workflow, 'b', 't2') // completed (complete fires once)
		expect(events.complete.count).toBe(1)
		// One start, one complete, nothing else — no spurious re-emits across the drive.
		expect(events.start.count).toBe(1)
		expect(events.fail.count).toBe(0)
		expect(events.stop.count).toBe(0)
	})
})

describe('Workflow — the cascade under bail: false (graceful)', () => {
	it('a failed task folds into a completed workflow', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		const events = recordEmitterEvents(workflow.emitter, ['start', 'complete', 'fail', 'stop'])
		// Phase a: one task completes, one fails (the phase derives failed)…
		completeTask(workflow, 'a', 't0')
		const t1 = workflow.phase('a')?.task('t1')
		t1?.start()
		t1?.fail(new Error('boom'))
		// …but under graceful mode the phase failure is DATA — finish phase b…
		completeTask(workflow, 'b', 't2')
		// …and the whole workflow COMPLETES (never failed under bail: false).
		expect(workflow.status).toBe('completed')
		expect(events.complete.count).toBe(1)
		expect(events.fail.count).toBe(0)
	})
})

describe('Workflow — the cascade under bail: true (halt)', () => {
	it('a single failed task propagates failed to the workflow', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(true))
		const events = recordEmitterEvents(workflow.emitter, ['start', 'complete', 'fail', 'stop'])
		completeTask(workflow, 'a', 't0')
		const t1 = workflow.phase('a')?.task('t1')
		t1?.start()
		t1?.fail(new Error('halt'))
		// Under halt mode the failed phase propagates — the workflow is failed.
		expect(workflow.status).toBe('failed')
		expect(events.fail.count).toBe(1)
		expect(events.fail.calls[0]?.[0]?.task.id).toBe('t1')
		expect(events.complete.count).toBe(0)
	})

	it('the same task graph yields completed (bail:false) vs failed (bail:true)', () => {
		for (const bail of [false, true]) {
			const workflow = createWorkflow(buildTwoPhaseWorkflow(bail))
			completeTask(workflow, 'a', 't0')
			const t1 = workflow.phase('a')?.task('t1')
			t1?.start()
			t1?.fail(new Error('x'))
			completeTask(workflow, 'b', 't2')
			expect(workflow.status).toBe(bail ? 'failed' : 'completed')
		}
	})
})

describe('Workflow — the #override (skip / stop the whole workflow)', () => {
	it('skip forces skipped, overriding the derived value', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		completeTask(workflow, 'a', 't0') // mid-flight derived status would be running
		expect(workflow.status).toBe('running')
		workflow.skip()
		expect(workflow.status).toBe('skipped')
	})

	it('stop forces stopped and emits', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		const events = recordEmitterEvents(workflow.emitter, ['stop'])
		workflow.stop()
		expect(workflow.status).toBe('stopped')
		expect(events.stop.count).toBe(1)
	})

	it('complete forces completed, overriding the derived value, and emits complete', () => {
		// `complete()` reuses the same #force override machinery as skip / stop: it pins `completed`
		// even when the derived status would be pending (no task ran), and `completed` IS a
		// WorkflowEventMap event so the emit fires. This is the runner's no-op-settle seam.
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		const events = recordEmitterEvents(workflow.emitter, ['start', 'complete', 'fail', 'stop'])
		expect(workflow.status).toBe('pending') // nothing ran ⇒ derived pending
		workflow.complete()
		expect(workflow.status).toBe('completed')
		expect(events.complete.count).toBe(1)
		// Only the complete event fired — no spurious start / fail / stop.
		expect(events.start.count).toBe(0)
		expect(events.fail.count).toBe(0)
		expect(events.stop.count).toBe(0)
	})
})

describe('Workflow — the result tree (workflow tier, both directions)', () => {
	it('flattens every settled task’s result across phases in positional order', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		completeTask(workflow, 'a', 't0')
		const t1 = workflow.phase('a')?.task('t1')
		t1?.start()
		t1?.fail(new Error('mid'))
		completeTask(workflow, 'b', 't2')
		// Phases in order (a then b), each phase’s task results in order.
		expect(workflow.results().map((result) => result.task.id)).toEqual(['t0', 't1', 't2'])
		// A node navigates UP its lineage from a leaf result.
		const leaf = workflow.phase('a')?.task('t0')
		expect(leaf?.workflow.id).toBe('wf')
		expect(leaf?.phase.id).toBe('a')
	})

	it('collects across a mix of terminal kinds — skip / stop contribute no result', () => {
		// Phase a: t0 completes, t1 is skipped (no boxed outcome). Phase b: t2 fails. Only the
		// completed + failed leaves box a result, so the workflow tier is [t0, t2] in positional order.
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		completeTask(workflow, 'a', 't0')
		workflow.phase('a')?.task('t1')?.skip()
		const t2 = workflow.phase('b')?.task('t2')
		t2?.start()
		t2?.fail(new Error('late'))
		const results = workflow.results()
		expect(results.map((result) => result.task.id)).toEqual(['t0', 't2'])
		expect(results.map((result) => result.status)).toEqual(['completed', 'failed'])
	})

	it('a deeply-nested failed task carries its REAL Failure and full UP-lineage', () => {
		// Reach the failing leaf in the LATER phase, then navigate UP from its recorded result: the
		// boxed outcome is the genuine Failure (the real Error), and the lineage chain is intact
		// task → phase → workflow (so a result is self-describing wherever it travels).
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		const boom = new Error('deep failure')
		const t2 = workflow.phase('b')?.task('t2')
		t2?.start()
		t2?.fail(boom)
		const failed = workflow.results().find((result) => result.status === 'failed')
		if (failed?.result === undefined || failed.result.success !== false) {
			throw new Error('expected the failed leaf to box a Failure')
		}
		expect(failed.result.error).toBe(boom)
		// Up the lineage from the result itself.
		expect(failed.task.id).toBe('t2')
		expect(failed.phase.id).toBe('b')
		expect(failed.workflow.id).toBe('wf')
		expect(failed.task.phase.id).toBe('b')
		expect(failed.task.phase.workflow.id).toBe('wf')
	})
})

describe('Workflow — snapshot() is pure JSON', () => {
	it('serializes structure + status + results + order with no class/function/Map', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(true))
		completeTask(workflow, 'a', 't0')
		const snapshot = workflow.snapshot()
		// A round-trip through JSON is lossless ⇒ pure JSON (no Map / function / class instance).
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
		expect(snapshot.phases.map((phase) => phase.id)).toEqual(['a', 'b'])
		expect(snapshot.phases[0]?.tasks.map((task) => task.id)).toEqual(['t0', 't1'])
		expect(snapshot.phases[0]?.tasks[0]?.status).toBe('completed')
		expect(snapshot.phases[0]?.tasks[0]?.result?.status).toBe('completed')
	})
})

describe('Workflow — snapshot → restore round-trip', () => {
	it('reproduces status at every node + the recorded results', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(true))
		completeTask(workflow, 'a', 't0')
		const t1 = workflow.phase('a')?.task('t1')
		t1?.start()
		t1?.fail(new Error('halt'))
		const restored = restoreWorkflow(workflow.snapshot(), { bail: workflow.bail })
		// Whole-tree status equality.
		expect(restored.status).toBe(workflow.status)
		expect(restored.status).toBe('failed')
		expect(restored.phase('a')?.status).toBe(workflow.phase('a')?.status)
		expect(restored.phase('a')?.task('t0')?.status).toBe('completed')
		expect(restored.phase('a')?.task('t1')?.status).toBe('failed')
		// The recorded result tree round-trips.
		expect(restored.results().map((result) => result.task.id)).toEqual(
			workflow.results().map((result) => result.task.id),
		)
		expect(restored.phase('a')?.task('t1')?.result?.result?.success).toBe(false)
		// And the snapshot of the restored tree equals the original snapshot.
		expect(restored.snapshot()).toEqual(workflow.snapshot())
	})

	it('preserves positional order after an interior skip', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		// Skip the INTERIOR task (t0 of phase a), settle the rest — order must survive.
		workflow.phase('a')?.task('t0')?.skip()
		completeTask(workflow, 'a', 't1')
		completeTask(workflow, 'b', 't2')
		const restored = restoreWorkflow(workflow.snapshot(), { bail: false })
		expect(
			restored
				.phase('a')
				?.tasks.tasks()
				.map((task) => task.id),
		).toEqual(['t0', 't1'])
		expect(restored.phase('a')?.task('t0')?.status).toBe('skipped')
		expect(restored.phase('a')?.task('t1')?.status).toBe('completed')
	})

	it('round-trips a forced #override at the phase and workflow tiers', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		// Force a phase override that DIVERGES from the derived value: skip phase a while a task ran.
		workflow.phase('a')?.task('t0')?.start()
		workflow.phase('a')?.skip()
		expect(workflow.phase('a')?.status).toBe('skipped')
		const restored = restoreWorkflow(workflow.snapshot(), { bail: false })
		// The override is reconstructed: phase a stays skipped even though a child is mid-flight.
		expect(restored.phase('a')?.status).toBe('skipped')
		expect(restored.phase('a')?.task('t0')?.status).toBe('running')
		expect(restored.snapshot()).toEqual(workflow.snapshot())
	})

	it('round-trips a whole-workflow override', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		workflow.phase('a')?.task('t0')?.start() // derived would be running
		workflow.stop()
		const restored = restoreWorkflow(workflow.snapshot(), { bail: false })
		expect(restored.status).toBe('stopped')
		expect(restored.snapshot()).toEqual(workflow.snapshot())
	})

	it('a partially-progressed, mixed-status tree round-trips deep-equal (bail + statuses + order)', () => {
		// A tree with EVERY kind of node state in flight at once: phase a has a completed task (t0), a
		// failed task (t1) — so phase a derives failed; phase b's t2 is skipped. Under bail:true the
		// workflow derives failed. The whole snapshot (bail, every node's status + recorded results +
		// positional order, no spurious overrides) must reproduce exactly through a restore.
		const workflow = createWorkflow(buildTwoPhaseWorkflow(true))
		completeTask(workflow, 'a', 't0')
		const t1 = workflow.phase('a')?.task('t1')
		t1?.start()
		t1?.fail(new Error('mixed'))
		workflow.phase('b')?.task('t2')?.skip()
		const snapshot = workflow.snapshot()
		const restored = restoreWorkflow(snapshot)
		// Whole-snapshot deep equality is the strongest fidelity claim (structure + status + results
		// + order + bail + overrides all at once).
		expect(restored.snapshot()).toEqual(snapshot)
		// Spot-check the individual node statuses survived.
		expect(restored.status).toBe('failed')
		expect(restored.phase('a')?.task('t0')?.status).toBe('completed')
		expect(restored.phase('a')?.task('t1')?.status).toBe('failed')
		expect(restored.phase('b')?.task('t2')?.status).toBe('skipped')
		// Positional order of the interior tasks is preserved.
		expect(
			restored
				.phase('a')
				?.tasks.tasks()
				.map((task) => task.id),
		).toEqual(['t0', 't1'])
	})

	it('restores an empty tree (zero phases) identically', () => {
		const workflow = createWorkflow({ id: 'wf', name: 'WF', bail: false, phases: [] })
		const restored = restoreWorkflow(workflow.snapshot())
		expect(restored.status).toBe('pending')
		expect(restored.phases.count).toBe(0)
		expect(restored.snapshot()).toEqual(workflow.snapshot())
	})

	it('a restored tree keeps transitioning + cascading from where it left off', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		completeTask(workflow, 'a', 't0') // t1, t2 still pending
		const restored = restoreWorkflow(workflow.snapshot(), { bail: false })
		expect(restored.status).toBe('running')
		// The live machine still works after restore — finish everything ⇒ completed.
		restored.phase('a')?.task('t1')?.start()
		restored.phase('a')?.task('t1')?.complete('ok')
		restored.phase('b')?.task('t2')?.start()
		restored.phase('b')?.task('t2')?.complete('ok')
		expect(restored.status).toBe('completed')
	})
})

describe('Workflow — the snapshot is self-contained (bail + override persist)', () => {
	it('persists bail in the snapshot and restores faithfully without a silent default', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(true))
		const snapshot = workflow.snapshot()
		expect(snapshot.bail).toBe(true)
		// Restore WITHOUT an options.bail — the policy must come from the snapshot, not default false.
		const restored = restoreWorkflow(snapshot)
		expect(restored.bail).toBe(true)
	})

	it('a per-phase bail OVERRIDE round-trips: a strict phase under a graceful workflow stays failed', () => {
		// THE headline per-phase-bail persistence proof. A graceful (bail:false) workflow with a
		// strict-bail phase a whose task fails → the workflow derives `failed` (the strict phase halts
		// even under the graceful default). A snapshot → restore (taking bail FROM the snapshot) must
		// reproduce the same workflow status AND the same per-phase effective bail, so the per-phase
		// override is durable, not lost to the workflow-level default.
		const definition: WorkflowDefinition = {
			id: 'wf',
			name: 'WF',
			bail: false, // graceful at the workflow tier…
			phases: [
				{
					id: 'a',
					name: 'A',
					bail: true, // …but THIS phase is strict
					tasks: [{ id: 't0', name: 'T0', run: { via: 'function', name: 'f' } }],
				},
				{
					id: 'b',
					name: 'B',
					tasks: [{ id: 't1', name: 'T1', run: { via: 'function', name: 'f' } }],
				},
			],
		}
		const workflow = createWorkflow(definition)
		const t0 = workflow.phase('a')?.task('t0')
		t0?.start()
		t0?.fail(new Error('boom'))
		// The strict phase a halts the whole workflow even though the workflow default is graceful.
		expect(workflow.status).toBe('failed')
		expect(workflow.phase('a')?.bail).toBe(true)
		expect(workflow.phase('b')?.bail).toBe(false) // inherits the graceful workflow default

		const snapshot = workflow.snapshot()
		expect(snapshot.bail).toBe(false) // the workflow tier is graceful
		expect(snapshot.phases.find((phase) => phase.id === 'a')?.bail).toBe(true) // the override persisted
		// Restore taking bail FROM THE SNAPSHOT (no options): the per-phase override survives, so the
		// restored workflow re-derives the SAME `failed`, and the phase bail round-trips.
		const restored = restoreWorkflow(snapshot)
		expect(restored.status).toBe(workflow.status)
		expect(restored.status).toBe('failed')
		expect(restored.phase('a')?.bail).toBe(true)
		expect(restored.phase('b')?.bail).toBe(false)
		expect(restored.snapshot()).toEqual(snapshot)
	})

	it('persists no override when the status is genuinely derived', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		completeTask(workflow, 'a', 't0') // derived running, no skip / stop forced
		const snapshot = workflow.snapshot()
		expect(snapshot.override).toBeUndefined()
		expect(snapshot.phases.every((phase) => phase.override === undefined)).toBe(true)
	})

	it('bail-mismatched restore: a derived `failed` under bail:true does NOT pin a false override', () => {
		// THE regression. Run under bail:true to a DERIVED `failed`: phase a fails (t0 done, t1
		// failed) while phase b is still all-pending. The effective status is `failed` (the failed
		// phase a halts under bail), but it is DERIVED — no override was ever forced.
		const workflow = createWorkflow(buildTwoPhaseWorkflow(true))
		completeTask(workflow, 'a', 't0')
		const t1 = workflow.phase('a')?.task('t1')
		t1?.start()
		t1?.fail(new Error('halt'))
		expect(workflow.status).toBe('failed')
		expect(workflow.phase('b')?.status).toBe('pending') // b never ran
		const snapshot = workflow.snapshot()
		// The snapshot carries the real policy + NO forced override (the old code stored neither).
		expect(snapshot.bail).toBe(true)
		expect(snapshot.override).toBeUndefined()

		// Restore taking the policy FROM THE SNAPSHOT (no options) — under the deleted divergence
		// heuristic + silent bail:false this re-derived `running`, DIVERGED from the stored `failed`,
		// and FALSELY pinned `failed` as a permanent override, freezing the tree forever.
		const restored = restoreWorkflow(snapshot)
		expect(restored.bail).toBe(true)
		expect(restored.status).toBe('failed')
		// No false override pin: the restored tree carries no forced override at any tier — the
		// `failed` is DERIVED from the real failed phase under the restored bail:true.
		expect(restored.snapshot().override).toBeUndefined()
		expect(restored.snapshot().phases.every((phase) => phase.override === undefined)).toBe(true)
		// And the still-pending phase b can PROGRESS — the phase tier is derived, not pinned.
		completeTask(restored, 'b', 't2')
		expect(restored.phase('b')?.status).toBe('completed')
	})

	it('the snapshot is DATA, not a pin: an explicit options.bail override re-derives', () => {
		// The same `failed` snapshot, restored with an explicit bail:false override, re-derives
		// `running` (one phase terminal, one pending) — proving the stored `failed` was never a pin,
		// just the effective status under the policy it ran under. The explicit override wins.
		const workflow = createWorkflow(buildTwoPhaseWorkflow(true))
		completeTask(workflow, 'a', 't0')
		const t1 = workflow.phase('a')?.task('t1')
		t1?.start()
		t1?.fail(new Error('halt'))
		const restored = restoreWorkflow(workflow.snapshot(), { bail: false })
		expect(restored.bail).toBe(false)
		// Under graceful mode the failed phase folds in as terminal; phase b is pending ⇒ running.
		expect(restored.status).toBe('running')
		completeTask(restored, 'b', 't2')
		expect(restored.status).toBe('completed')
	})

	it('round-trips a forced override via the explicit field (workflow tier)', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		workflow.phase('a')?.task('t0')?.start() // derived would be running
		workflow.stop() // FORCE stopped — an override that diverges from the derived value
		const snapshot = workflow.snapshot()
		// The override is persisted in its OWN field (present because one is in force).
		expect(snapshot.override).toBe('stopped')
		const restored = restoreWorkflow(snapshot)
		// Restored DIRECTLY from the field — the forced status survives and the snapshot round-trips.
		expect(restored.status).toBe('stopped')
		expect(restored.snapshot().override).toBe('stopped')
		expect(restored.snapshot()).toEqual(snapshot)
		// The override pins against further child churn, exactly as the live original did (this
		// mutates the child, so it no longer equals the pre-churn snapshot — the pin is what matters).
		restored.phase('a')?.task('t0')?.complete('ok')
		expect(restored.status).toBe('stopped')
	})

	it('round-trips a forced override via the explicit field (phase tier)', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		workflow.phase('a')?.task('t0')?.start() // phase a derived running
		workflow.phase('a')?.skip() // FORCE phase a to skipped — diverges from derived running
		const snapshot = workflow.snapshot()
		const phaseSnapshot = snapshot.phases.find((phase) => phase.id === 'a')
		expect(phaseSnapshot?.override).toBe('skipped')
		const restored = restoreWorkflow(snapshot)
		expect(restored.phase('a')?.status).toBe('skipped')
		// The child is still mid-flight, but the restored override pins the phase to skipped.
		expect(restored.phase('a')?.task('t0')?.status).toBe('running')
		expect(restored.phase('a')?.snapshot().override).toBe('skipped')
	})

	it('assertSnapshot rejects a non-boolean bail and an out-of-vocabulary override', () => {
		const snapshot = createWorkflow(buildTwoPhaseWorkflow(false)).snapshot()
		const badBail = { ...snapshot, bail: 'yes' }
		expect(
			isWorkflowError(captureError(() => restoreWorkflow(JSON.parse(JSON.stringify(badBail)))))
				? 'rejected'
				: 'accepted',
		).toBe('rejected')
		const badOverride = { ...snapshot, override: 'bogus' }
		const error = captureError(() => restoreWorkflow(JSON.parse(JSON.stringify(badOverride))))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('RESTORE')
	})
})

describe('Workflow — restore rejects a malformed snapshot', () => {
	it('throws RESTORE for a status outside the lifecycle vocabulary', () => {
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false))
		const snapshot = workflow.snapshot()
		const broken = {
			...snapshot,
			phases: [
				{ ...snapshot.phases[0], tasks: [{ ...snapshot.phases[0]?.tasks[0], status: 'bogus' }] },
			],
		}
		const error = captureError(() => restoreWorkflow(JSON.parse(JSON.stringify(broken))))
		expect(isWorkflowError(error) ? error.code : undefined).toBe('RESTORE')
	})
})

/** A definition with `count` sequential single-task pending phases (`p0..p{count-1}`). */
function buildMultiPhaseWorkflow(count: number): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		bail: false,
		phases: Array.from({ length: count }, (_unused, index) => ({
			id: `p${index}`,
			name: `P${index}`,
			tasks: [{ id: `t${index}`, name: `T${index}`, run: { via: 'function', name: 'f' } }],
		})),
	}
}

describe('Workflow — pause/resume/paused', () => {
	it('pause sets paused true; resume clears it — both idempotent', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		expect(workflow.paused).toBe(false)
		workflow.pause()
		expect(workflow.paused).toBe(true)
		workflow.pause() // idempotent no-op
		expect(workflow.paused).toBe(true)
		workflow.resume()
		expect(workflow.paused).toBe(false)
		workflow.resume() // idempotent no-op
		expect(workflow.paused).toBe(false)
	})

	it('pause is a no-op once the workflow is terminal', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		workflow.stop()
		expect(workflow.status).toBe('stopped')
		workflow.pause()
		expect(workflow.paused).toBe(false)
	})

	it('pause is a no-op once the workflow is destroyed', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		workflow.destroy()
		workflow.pause()
		expect(workflow.paused).toBe(false)
	})
})

describe('Workflow — wait()', () => {
	it('resolves immediately when not paused', async () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		await expect(workflow.wait()).resolves.toBeUndefined()
	})

	it('parks while paused, releasing on resume', async () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		workflow.pause()
		let settled = false
		const waiting = workflow.wait().then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		workflow.resume()
		await waiting
		expect(settled).toBe(true)
	})

	it('parks while paused, releasing on skip', async () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		workflow.pause()
		let settled = false
		const waiting = workflow.wait().then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		workflow.skip()
		await waiting
		expect(settled).toBe(true)
	})

	it('parks while paused, releasing on stop', async () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		workflow.pause()
		let settled = false
		const waiting = workflow.wait().then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		workflow.stop()
		await waiting
		expect(settled).toBe(true)
	})

	it('parks while paused, releasing on destroy', async () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		workflow.pause()
		let settled = false
		const waiting = workflow.wait().then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		workflow.destroy()
		await waiting
		expect(settled).toBe(true)
	})
})

describe('Workflow — destroy()', () => {
	it('cascades stop to every non-terminal phase, aborts signal, and marks destroyed', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(2))
		expect(workflow.signal.aborted).toBe(false)
		expect(workflow.destroyed).toBe(false)
		workflow.destroy()
		expect(workflow.destroyed).toBe(true)
		expect(workflow.signal.aborted).toBe(true)
		expect(workflow.phase('p0')?.status).toBe('stopped')
		expect(workflow.phase('p1')?.status).toBe('stopped')
		expect(workflow.status).toBe('stopped')
	})

	it('does not override a phase that already reached a genuine terminal status', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(2))
		const leaf = workflow.phase('p0')?.task('t0')
		leaf?.start()
		leaf?.complete('ok')
		expect(workflow.phase('p0')?.status).toBe('completed')
		workflow.destroy()
		// The already-terminal phase is untouched; only the still-pending phase is force-stopped.
		expect(workflow.phase('p0')?.status).toBe('completed')
		expect(workflow.phase('p1')?.status).toBe('stopped')
	})

	it('releases a parked phase-level wait() gate via the destroy cascade', async () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		const phase = workflow.phase('p0')
		if (phase === undefined) throw new Error('expected phase p0 to exist')
		phase.pause()
		let settled = false
		const waiting = phase.wait().then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		workflow.destroy()
		await waiting
		expect(settled).toBe(true)
	})

	it('is idempotent — a second destroy is a no-op', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		workflow.destroy()
		const signal = workflow.signal
		expect(() => workflow.destroy()).not.toThrow()
		expect(workflow.destroyed).toBe(true)
		expect(workflow.signal).toBe(signal)
	})

	it('refuses every structural mutator and pause once destroyed', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(2))
		workflow.destroy()
		const addResult = workflow.add({
			id: 'new',
			name: 'New',
			tasks: [],
		})
		expect(addResult.success).toBe(false)
		const removeResult = workflow.remove('p1')
		expect(removeResult.success).toBe(false)
		const moveResult = workflow.move('p1', 0)
		expect(moveResult.success).toBe(false)
		const updateResult = workflow.update('p1', { name: 'Renamed' })
		expect(updateResult.success).toBe(false)
		workflow.pause()
		expect(workflow.paused).toBe(false)
	})
})

describe('Workflow — signal', () => {
	it('fires exactly once on destroy', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		const recorder = createRecorder<[Event]>()
		workflow.signal.addEventListener('abort', recorder.handler)
		workflow.destroy()
		workflow.destroy() // idempotent — must not fire twice
		expect(recorder.count).toBe(1)
	})
})

describe('Workflow — structural API: add() mints a live phase', () => {
	it('add returns the created phase in the Result and it is live + navigable in the tree', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		const result = workflow.add({
			id: 'p1',
			name: 'P1',
			tasks: [{ id: 't1', name: 'T1', run: { via: 'function', name: 'f' } }],
		})
		expect(result.success).toBe(true)
		if (!result.success) throw new Error('expected add to succeed')
		expect(result.value.id).toBe('p1')
		expect(workflow.phase('p1')).toBe(result.value)
		expect(result.value.workflow).toBe(workflow)
		expect(workflow.phases.count).toBe(2)
	})

	it('a task minted into a phase cascades status recomputes when driven via start()/complete()', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		const result = workflow.add({
			id: 'p1',
			name: 'P1',
			tasks: [{ id: 't1', name: 'T1', run: { via: 'function', name: 'f' } }],
		})
		if (!result.success) throw new Error('expected add to succeed')
		const phase = result.value
		expect(phase.status).toBe('pending')
		const task = phase.task('t1')
		task?.start()
		expect(phase.status).toBe('running')
		expect(workflow.status).toBe('running')
		task?.complete('ok')
		expect(phase.status).toBe('completed')
	})

	it('duplicate phase id fails with MUTATION', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		const result = workflow.add({ id: 'p0', name: 'Dup', tasks: [] })
		expect(result.success).toBe(false)
		if (result.success) throw new Error('expected add to fail')
		expect(result.error.code).toBe('MUTATION')
	})

	it('an out-of-bounds index fails with MUTATION', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		const result = workflow.add({ id: 'p9', name: 'P9', tasks: [] }, 99)
		expect(result.success).toBe(false)
		if (result.success) throw new Error('expected add to fail')
		expect(result.error.code).toBe('MUTATION')
	})

	it('a terminal workflow refuses add', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		workflow.stop()
		const result = workflow.add({ id: 'p9', name: 'P9', tasks: [] })
		expect(result.success).toBe(false)
		if (result.success) throw new Error('expected add to fail')
		expect(result.error.code).toBe('MUTATION')
	})
})

describe('Workflow — the pending-suffix boundary (add/remove/move gate against terminal-prefix)', () => {
	it('add at index 0 fails once an early phase is terminal; add at the end succeeds', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(2))
		const leaf = workflow.phase('p0')?.task('t0')
		leaf?.start()
		leaf?.complete('ok') // p0 is now terminal (completed) — the boundary moves past it
		const front = workflow.add({ id: 'new', name: 'New', tasks: [] }, 0)
		if (front.success) throw new Error('expected front add to fail')
		expect(front.error.code).toBe('MUTATION')
		const tail = workflow.add({ id: 'new', name: 'New', tasks: [] })
		expect(tail.success).toBe(true)
	})

	it('move before the boundary fails; move of a target-before-boundary fails', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(3))
		const leaf = workflow.phase('p0')?.task('t0')
		leaf?.start()
		leaf?.complete('ok') // boundary is now 1 (p0 terminal, p1/p2 pending)
		// Moving a pending phase TO a position before the boundary fails.
		const toBoundary = workflow.move('p1', 0)
		if (toBoundary.success) throw new Error('expected move to boundary to fail')
		expect(toBoundary.error.code).toBe('MUTATION')
		// Moving the already-terminal p0 (a target before the boundary) fails.
		const terminalTarget = workflow.move('p0', 1)
		if (terminalTarget.success) throw new Error('expected move of terminal target to fail')
		expect(terminalTarget.error.code).toBe('MUTATION')
	})

	it('remove of a non-pending (terminal, before-boundary) target fails', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(2))
		const leaf = workflow.phase('p0')?.task('t0')
		leaf?.start()
		leaf?.complete('ok')
		const result = workflow.remove('p0')
		if (result.success) throw new Error('expected remove of terminal target to fail')
		expect(result.error.code).toBe('MUTATION')
		// The still-pending phase behind the boundary can still be removed.
		const removable = workflow.remove('p1')
		expect(removable.success).toBe(true)
	})

	it('update of a non-pending, before-boundary target fails', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(2))
		const leaf = workflow.phase('p0')?.task('t0')
		leaf?.start()
		leaf?.complete('ok')
		const result = workflow.update('p0', { name: 'Renamed' })
		if (result.success) throw new Error('expected update of terminal target to fail')
		expect(result.error.code).toBe('MUTATION')
	})
})

describe('Workflow — add/remove/move/update events fire on success only', () => {
	it('emits add with the created phase + index on success, nothing on refusal', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		const events = recordEmitterEvents(workflow.emitter, ['add'])
		const result = workflow.add({ id: 'p1', name: 'P1', tasks: [] })
		if (!result.success) throw new Error('expected add to succeed')
		expect(events.add.count).toBe(1)
		expect(events.add.calls[0]).toEqual([result.value, 1])
		// A refused add (duplicate id) emits nothing.
		workflow.add({ id: 'p0', name: 'Dup', tasks: [] })
		expect(events.add.count).toBe(1)
	})

	it('emits remove with the removed phase on success, nothing on refusal', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		const events = recordEmitterEvents(workflow.emitter, ['remove'])
		const result = workflow.remove('p0')
		if (!result.success) throw new Error('expected remove to succeed')
		expect(events.remove.count).toBe(1)
		expect(events.remove.calls[0]).toEqual([result.value])
		// A refused remove (unknown id) emits nothing.
		workflow.remove('missing')
		expect(events.remove.count).toBe(1)
	})

	it('emits move with the moved phase + destination index on success, nothing on refusal', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(2))
		const events = recordEmitterEvents(workflow.emitter, ['move'])
		const result = workflow.move('p1', 0)
		if (!result.success) throw new Error('expected move to succeed')
		expect(events.move.count).toBe(1)
		expect(events.move.calls[0]).toEqual([result.value, 0])
		// A refused move (unknown id) emits nothing.
		workflow.move('missing', 0)
		expect(events.move.count).toBe(1)
	})

	it('emits update with the patched phase on success, nothing on refusal', () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		const events = recordEmitterEvents(workflow.emitter, ['update'])
		const result = workflow.update('p0', { name: 'Renamed' })
		if (!result.success) throw new Error('expected update to succeed')
		expect(events.update.count).toBe(1)
		expect(events.update.calls[0]).toEqual([result.value])
		expect(workflow.phase('p0')?.name).toBe('Renamed')
		// A refused update (unknown id) emits nothing.
		workflow.update('missing', { name: 'x' })
		expect(events.update.count).toBe(1)
	})
})

describe('Workflow — leak checks (destroy releases waiters, pause/resume churn stays sound)', () => {
	it('destroy releases every parked waiter so awaiting wait() completes', async () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		workflow.pause()
		const waiters = [workflow.wait(), workflow.wait(), workflow.wait()]
		workflow.destroy()
		await expect(Promise.all(waiters)).resolves.toBeDefined()
	})

	it('repeated pause/resume churn never leaves paused stuck true or wait() unresolved', async () => {
		const workflow = createWorkflow(buildMultiPhaseWorkflow(1))
		for (let i = 0; i < 25; i += 1) {
			workflow.pause()
			expect(workflow.paused).toBe(true)
			workflow.resume()
			expect(workflow.paused).toBe(false)
			await expect(workflow.wait()).resolves.toBeUndefined()
		}
	})
})

describe('Workflow — emit-safety (§13)', () => {
	it('isolates a throwing listener, routes it to the error handler, and still cascades', () => {
		const errors = createErrorRecorder()
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false), { error: errors.handler })
		workflow.emitter.on('start', () => {
			throw new Error('listener boom')
		})
		expect(() => completeTask(workflow, 'a', 't0')).not.toThrow()
		expect(workflow.status).toBe('running')
		// The throw is routed to the emitter's error handler — (error, event) order.
		expect(errors.count).toBe(1)
		expect(errors.calls[0]?.[1]).toBe('start')
	})

	it('wires initial listeners from the on option', () => {
		const fired: string[] = []
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false), {
			on: { start: () => fired.push('start') },
		})
		completeTask(workflow, 'a', 't0')
		expect(fired).toEqual(['start'])
	})

	it('a throwing listener on an INTERIOR phase still lets the cascade settle the workflow', () => {
		// The cascade is Task → Phase → Workflow. A buggy listener on the phase must not break the
		// chain: the phase's emitter isolates the throw (routing it to its own error handler), and
		// the workflow still re-derives all the way to completed. Emit-safety holds at every tier of
		// the cascade, not just at the entity that threw.
		const errors = createErrorRecorder()
		const workflow = createWorkflow(buildTwoPhaseWorkflow(false), {
			phases: { a: { error: errors.handler } },
		})
		const phase = workflow.phase('a')
		if (phase === undefined) throw new Error('expected phase a to exist')
		phase.emitter.on('start', () => {
			throw new Error('interior listener boom')
		})
		// Drive the whole tree — the throwing phase listener fires on phase a's start…
		expect(() => {
			completeTask(workflow, 'a', 't0')
			completeTask(workflow, 'a', 't1')
			completeTask(workflow, 'b', 't2')
		}).not.toThrow()
		// …the phase routed the throw to its error handler, and the workflow still settled to completed.
		expect(errors.count).toBe(1)
		expect(errors.calls[0]?.[1]).toBe('start')
		expect(workflow.status).toBe('completed')
	})
})
