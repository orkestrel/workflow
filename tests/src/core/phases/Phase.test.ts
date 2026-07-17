import type { PhaseInterface, WorkflowDefinition, WorkflowInterface } from '@src/core'
import { createWorkflow, restoreWorkflow } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createErrorRecorder, recordEmitterEvents } from '../../../setup.js'

// The DERIVED phase state machine (W-b): status derived from its tasks via the W-a
// helper, recomputed reactively as a task transitions (the cascade's middle tier), the
// override, and the phase tier of the result tree. Real definition stubs — no mocks.

/** A definition stub of one phase holding `count` function-tasks (`t0..t{count-1}`). */
function buildPhaseWorkflow(count: number): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		phases: [
			{
				id: 'p',
				name: 'P',
				tasks: Array.from({ length: count }, (_unused, index) => ({
					id: `t${index}`,
					name: `T${index}`,
					run: 'f' as const,
				})),
			},
		],
	}
}

/** Resolve the lone phase of a {@link buildPhaseWorkflow} tree. */
function lonePhase(workflow: WorkflowInterface): PhaseInterface {
	const phase = workflow.phase('p')
	if (phase === undefined) throw new Error('expected the lone phase to exist')
	return phase
}

describe('Phase — derived status (the cascade)', () => {
	it('is pending while every task is pending', () => {
		expect(lonePhase(createWorkflow(buildPhaseWorkflow(2))).status).toBe('pending')
	})

	it('becomes running when a task starts', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		phase.task('t0')?.start()
		expect(phase.status).toBe('running')
	})

	it('becomes completed when all tasks complete', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		for (const task of phase.tasks.tasks()) {
			task.start()
			task.complete('ok')
		}
		expect(phase.status).toBe('completed')
	})

	it('becomes failed when any task fails (bail-agnostic at the phase tier)', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		phase.task('t0')?.start()
		phase.task('t0')?.complete('ok')
		phase.task('t1')?.start()
		phase.task('t1')?.fail(new Error('boom'))
		expect(phase.status).toBe('failed')
	})

	it('is skipped when every task is skipped, completed when some complete + some skip', () => {
		const allSkipped = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		for (const task of allSkipped.tasks.tasks()) task.skip()
		expect(allSkipped.status).toBe('skipped')

		const mixed = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		mixed.task('t0')?.start()
		mixed.task('t0')?.complete('ok')
		mixed.task('t1')?.skip()
		expect(mixed.status).toBe('completed')
	})

	it('becomes stopped when every task is stopped (the entity path, not just the helper)', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		for (const task of phase.tasks.tasks()) task.stop()
		expect(phase.status).toBe('stopped')
	})

	it('stays running while one terminal task sits beside a still-pending sibling', () => {
		// The "started but not all settled" class at the entity tier: one task completed, one never
		// ran — the phase is NOT done, so the derived status is running (not completed).
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		phase.task('t0')?.start()
		phase.task('t0')?.complete('ok')
		expect(phase.status).toBe('running')
	})
})

describe('Phase — degenerate sizes (zero-task + single-task)', () => {
	it('a zero-task phase derives pending (an empty set of children)', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(0)))
		expect(phase.tasks.count).toBe(0)
		expect(phase.status).toBe('pending')
	})

	it('a single-task phase tracks its one task through the lifecycle', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		expect(phase.status).toBe('pending')
		phase.task('t0')?.start()
		expect(phase.status).toBe('running')
		phase.task('t0')?.complete('ok')
		expect(phase.status).toBe('completed')
	})

	it('a zero-task phase can still be force-skipped / force-stopped via the override', () => {
		const skipped = lonePhase(createWorkflow(buildPhaseWorkflow(0)))
		skipped.skip()
		expect(skipped.status).toBe('skipped')
		const stopped = lonePhase(createWorkflow(buildPhaseWorkflow(0)))
		stopped.stop()
		expect(stopped.status).toBe('stopped')
	})
})

describe('Phase — emits on a derived-status change', () => {
	it('fires start, then complete, exactly once each across the cascade', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		const events = recordEmitterEvents(phase.emitter, ['start', 'complete', 'fail', 'stop'])
		// First task starting flips pending → running (one start)…
		phase.task('t0')?.start()
		phase.task('t1')?.start()
		expect(events.start.count).toBe(1)
		expect(events.start.calls[0]?.[0]).toBe('p')
		// …and only the LAST settle flips running → completed (one complete).
		phase.task('t0')?.complete('ok')
		expect(events.complete.count).toBe(0)
		phase.task('t1')?.complete('ok')
		expect(events.complete.count).toBe(1)
	})

	it('fires fail carrying the failing task’s result', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		const events = recordEmitterEvents(phase.emitter, ['fail'])
		phase.task('t0')?.start()
		phase.task('t0')?.fail(new Error('kaboom'))
		expect(events.fail.count).toBe(1)
		expect(events.fail.calls[0]?.[0]?.status).toBe('failed')
		expect(events.fail.calls[0]?.[0]?.task.id).toBe('t0')
	})
})

describe('Phase — the #override (skip / stop a whole phase)', () => {
	it('skip forces skipped, overriding the derived value', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		// A task is mid-flight, so the DERIVED status would be running…
		phase.task('t0')?.start()
		expect(phase.status).toBe('running')
		// …but skip FORCES skipped regardless.
		phase.skip()
		expect(phase.status).toBe('skipped')
	})

	it('stop forces stopped and emits', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		const events = recordEmitterEvents(phase.emitter, ['stop'])
		phase.stop()
		expect(phase.status).toBe('stopped')
		expect(events.stop.count).toBe(1)
	})

	it('the override pins the status against further child churn', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		phase.stop()
		// A child still transitions, but the forced status is unmoved.
		phase.task('t0')?.start()
		phase.task('t0')?.complete('ok')
		expect(phase.status).toBe('stopped')
	})
})

describe('Phase — terminal no-op guards on skip / stop (F1)', () => {
	it('stop() on an already-completed phase is a no-op — no re-force, no stop event', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.task('t0')?.start()
		phase.task('t0')?.complete('ok')
		expect(phase.status).toBe('completed')
		const events = recordEmitterEvents(phase.emitter, ['stop'])
		phase.stop()
		expect(phase.status).toBe('completed')
		expect(events.stop.count).toBe(0)
	})

	it('skip() on an already-stopped phase leaves it unchanged', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		phase.stop()
		expect(phase.status).toBe('stopped')
		phase.skip()
		expect(phase.status).toBe('stopped')
	})

	it('double-stop is idempotent — the second call is a guarded no-op', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		const events = recordEmitterEvents(phase.emitter, ['stop'])
		phase.stop()
		phase.stop()
		expect(phase.status).toBe('stopped')
		expect(events.stop.count).toBe(1)
	})

	it('a parked wait() waiter is still released when stop() no-ops on an already-terminal (derived) phase', async () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.pause()
		expect(phase.paused).toBe(true)
		// Drive the sole task to completion WHILE paused — the derived status reaches `completed`
		// via the cascade (not the override), so `status` is terminal while a `wait()` gate is
		// still parked.
		phase.task('t0')?.start()
		phase.task('t0')?.complete('ok')
		expect(phase.status).toBe('completed')
		// stop() is now a guarded NO-OP (status already terminal) — but it must still release the
		// parked wait() gate unconditionally, so this promise settles rather than hanging.
		phase.stop()
		await phase.wait()
		expect(phase.status).toBe('completed')
	})
})

describe('Phase — the result tree (top-down)', () => {
	it('collects only settled tasks’ results, in positional order', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(3)))
		phase.task('t0')?.start()
		phase.task('t0')?.complete('a')
		phase.task('t2')?.start()
		phase.task('t2')?.fail(new Error('c'))
		// t1 never ran — it contributes no result; order follows task position (t0 then t2).
		const results = phase.results()
		expect(results.map((result) => result.task.id)).toEqual(['t0', 't2'])
		expect(results[0]?.status).toBe('completed')
		expect(results[1]?.status).toBe('failed')
	})

	it('collects across a mix of all four terminal kinds — only completed / failed box a result', () => {
		// One task per terminal kind (t0 completed, t1 failed, t2 skipped, t3 stopped). Only the
		// completed + failed leaves carry a boxed outcome; skip / stop are terminal WITHOUT one, so
		// they contribute no TaskResult — the phase result list is exactly [t0, t1], in order.
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(4)))
		phase.task('t0')?.start()
		phase.task('t0')?.complete('done')
		phase.task('t1')?.start()
		phase.task('t1')?.fail(new Error('boom'))
		phase.task('t2')?.skip()
		phase.task('t3')?.stop()
		const results = phase.results()
		expect(results.map((result) => result.task.id)).toEqual(['t0', 't1'])
		expect(results.map((result) => result.status)).toEqual(['completed', 'failed'])
		expect(results[1]?.result?.success).toBe(false)
		// The phase itself, with a real failure among the four, derives failed (failed is most-severe).
		expect(phase.status).toBe('failed')
	})
})

describe('Phase — the effective bail (per-phase override) round-trips', () => {
	// A graceful (bail:false) workflow with ONE strict-bail phase + one inheriting phase. Each live
	// phase exposes its EFFECTIVE bail, and a snapshot → restore reproduces both the per-phase bail
	// AND the phase status.
	function mixedBailWorkflow(): WorkflowDefinition {
		return {
			id: 'wf',
			name: 'WF',
			bail: false,
			phases: [
				{
					id: 'strict',
					name: 'Strict',
					bail: true,
					tasks: [{ id: 't', name: 'T', run: 'f' }],
				},
				{
					id: 'inherit',
					name: 'Inherit',
					tasks: [{ id: 't', name: 'T', run: 'f' }],
				},
			],
		}
	}

	it('exposes the effective bail — a phase override wins, else it inherits the workflow', () => {
		const workflow = createWorkflow(mixedBailWorkflow())
		expect(workflow.phase('strict')?.bail).toBe(true) // the override
		expect(workflow.phase('inherit')?.bail).toBe(false) // inherited from the graceful workflow
	})

	it('round-trips the per-phase bail AND the phase status through snapshot → restore', () => {
		const workflow = createWorkflow(mixedBailWorkflow())
		// Drive a leaf so the phase has a non-pending status worth round-tripping.
		const leaf = workflow.phase('strict')?.task('t')
		leaf?.start()
		leaf?.complete('ok')
		const original = workflow.phase('strict')
		const restored = restoreWorkflow(workflow.snapshot()).phase('strict')
		// The restored phase's status matches the original's…
		expect(restored?.status).toBe(original?.status)
		// …and its effective bail survives (the snapshot persisted it).
		expect(restored?.bail).toBe(true)
		expect(restoreWorkflow(workflow.snapshot()).phase('inherit')?.bail).toBe(false)
	})
})

describe('Phase — pause/resume/paused', () => {
	it('pause sets paused true; resume clears it — both idempotent', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		expect(phase.paused).toBe(false)
		phase.pause()
		expect(phase.paused).toBe(true)
		phase.pause() // idempotent no-op
		expect(phase.paused).toBe(true)
		phase.resume()
		expect(phase.paused).toBe(false)
		phase.resume() // idempotent no-op
		expect(phase.paused).toBe(false)
	})

	it('pause is a no-op once the phase is terminal', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.stop()
		expect(phase.status).toBe('stopped')
		phase.pause()
		expect(phase.paused).toBe(false)
	})
})

describe('Phase — wait()', () => {
	it('resolves immediately when not paused', async () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		await expect(phase.wait()).resolves.toBeUndefined()
	})

	it('parks while paused, releasing on resume', async () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.pause()
		let settled = false
		const waiting = phase.wait().then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		phase.resume()
		await waiting
		expect(settled).toBe(true)
	})

	it('parks while paused, releasing on skip', async () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.pause()
		let settled = false
		const waiting = phase.wait().then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		phase.skip()
		await waiting
		expect(settled).toBe(true)
	})

	it('parks while paused, releasing on stop', async () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.pause()
		let settled = false
		const waiting = phase.wait().then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		phase.stop()
		await waiting
		expect(settled).toBe(true)
	})
})

describe('Phase — structural API: add() mints a live task', () => {
	it('add returns the created task in the Result and it is live + navigable in the tree', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		const result = phase.add({ id: 't1', name: 'T1', run: 'f' })
		expect(result.success).toBe(true)
		if (!result.success) throw new Error('expected add to succeed')
		expect(result.value.id).toBe('t1')
		expect(phase.task('t1')).toBe(result.value)
		expect(result.value.phase).toBe(phase)
		expect(phase.tasks.count).toBe(2)
	})

	it('a minted task cascades status recomputes via start()/complete()', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(0)))
		expect(phase.status).toBe('pending')
		const result = phase.add({ id: 't0', name: 'T0', run: 'f' })
		if (!result.success) throw new Error('expected add to succeed')
		result.value.start()
		expect(phase.status).toBe('running')
		result.value.complete('ok')
		expect(phase.status).toBe('completed')
	})

	it('duplicate task id fails with MUTATION', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		const result = phase.add({ id: 't0', name: 'Dup', run: 'f' })
		expect(result.success).toBe(false)
		if (result.success) throw new Error('expected add to fail')
		expect(result.error.code).toBe('MUTATION')
	})

	it('an out-of-bounds index fails with MUTATION', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		const result = phase.add({ id: 't9', name: 'T9', run: 'f' }, 99)
		expect(result.success).toBe(false)
		if (result.success) throw new Error('expected add to fail')
		expect(result.error.code).toBe('MUTATION')
	})

	it('a terminal phase refuses add', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.stop()
		const result = phase.add({ id: 't9', name: 'T9', run: 'f' })
		expect(result.success).toBe(false)
		if (result.success) throw new Error('expected add to fail')
		expect(result.error.code).toBe('MUTATION')
	})

	it('a running phase only accepts a pure append — a positioned add fails, a plain add succeeds', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		phase.task('t0')?.start() // phase is now running
		expect(phase.status).toBe('running')
		const positioned = phase.add({ id: 't2', name: 'T2', run: 'f' }, 0)
		if (positioned.success) throw new Error('expected positioned add to fail')
		expect(positioned.error.code).toBe('MUTATION')
		const events = recordEmitterEvents(phase.emitter, ['add'])
		const appended = phase.add({ id: 't2', name: 'T2', run: 'f' })
		expect(appended.success).toBe(true)
		expect(events.add.count).toBe(1)
		// The phase stays non-terminal until the newly-added, still-pending task settles too — the
		// derived-status invariant: a pending task keeps a running phase from re-deriving terminal.
		expect(phase.status).toBe('running')
		phase.task('t1')?.start()
		phase.task('t1')?.complete('ok')
		expect(phase.status).toBe('running') // t2 still pending
		phase.task('t0')?.complete('ok')
		if (!appended.success) throw new Error('expected append to succeed')
		appended.value.start()
		appended.value.complete('ok')
		expect(phase.status).toBe('completed')
	})
})

describe('Phase — add() resolves a minted task’s handler against the workflow functions registry', () => {
	it('a known run name resolves to its handler on mint; an unknown/absent one resolves to none', () => {
		const handler = () => 'value'
		const workflow = createWorkflow(buildPhaseWorkflow(0), { functions: { known: handler } })
		const phase = lonePhase(workflow)
		const known = phase.add({ id: 'k', name: 'K', run: 'known' })
		if (!known.success) throw new Error('expected add to succeed')
		expect(known.value.handler).toBe(handler)
		const unknown = phase.add({ id: 'u', name: 'U', run: 'missing' })
		if (!unknown.success) throw new Error('expected add to succeed')
		expect(unknown.value.handler).toBeUndefined()
		const absent = phase.add({ id: 'a', name: 'A' })
		if (!absent.success) throw new Error('expected add to succeed')
		expect(absent.value.handler).toBeUndefined()
	})
})

describe('Phase — remove/move/update only while pending', () => {
	it('remove/move/update succeed while pending, refuse once running', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		expect(phase.remove('t1').success).toBe(true)
		const rebuilt = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		expect(rebuilt.move('t1', 0).success).toBe(true)
		expect(rebuilt.update('t0', { name: 'Renamed' }).success).toBe(true)

		const running = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		running.task('t0')?.start()
		expect(running.status).toBe('running')
		expect(running.remove('t1').success).toBe(false)
		expect(running.move('t1', 0).success).toBe(false)
		expect(running.update('t1', { name: 'x' }).success).toBe(false)
	})

	it('remove/move/update refuse once terminal', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.stop()
		expect(phase.remove('t0').success).toBe(false)
		expect(phase.move('t0', 0).success).toBe(false)
		expect(phase.update('t0', { name: 'x' }).success).toBe(false)
	})
})

describe('Phase — add/remove/move/update events fire on success only', () => {
	it('emits add with the created task + index on success, nothing on refusal', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		const events = recordEmitterEvents(phase.emitter, ['add'])
		const result = phase.add({ id: 't1', name: 'T1', run: 'f' })
		if (!result.success) throw new Error('expected add to succeed')
		expect(events.add.count).toBe(1)
		expect(events.add.calls[0]).toEqual([result.value, 1])
		phase.add({ id: 't0', name: 'Dup', run: 'f' })
		expect(events.add.count).toBe(1)
	})

	it('emits remove with the removed task on success, nothing on refusal', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		const events = recordEmitterEvents(phase.emitter, ['remove'])
		const result = phase.remove('t0')
		if (!result.success) throw new Error('expected remove to succeed')
		expect(events.remove.count).toBe(1)
		expect(events.remove.calls[0]).toEqual([result.value])
		phase.remove('missing')
		expect(events.remove.count).toBe(1)
	})

	it('emits move with the moved task + destination index on success, nothing on refusal', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(2)))
		const events = recordEmitterEvents(phase.emitter, ['move'])
		const result = phase.move('t1', 0)
		if (!result.success) throw new Error('expected move to succeed')
		expect(events.move.count).toBe(1)
		expect(events.move.calls[0]).toEqual([result.value, 0])
		phase.move('missing', 0)
		expect(events.move.count).toBe(1)
	})

	it('emits update with the patched task on success, nothing on refusal', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		const events = recordEmitterEvents(phase.emitter, ['update'])
		const result = phase.update('t0', { name: 'Renamed' })
		if (!result.success) throw new Error('expected update to succeed')
		expect(events.update.count).toBe(1)
		expect(events.update.calls[0]).toEqual([result.value])
		phase.update('missing', { name: 'x' })
		expect(events.update.count).toBe(1)
	})
})

describe('Phase — patch() gating (pending only)', () => {
	it('applies name/description/bail/concurrency while pending', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.patch({ name: 'Renamed', description: 'desc', bail: true, concurrency: 3 })
		expect(phase.name).toBe('Renamed')
		expect(phase.description).toBe('desc')
		expect(phase.bail).toBe(true)
		expect(phase.concurrency).toBe(3)
	})

	it('throws MUTATION when patched while running', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.task('t0')?.start()
		expect(phase.status).toBe('running')
		expect(() => phase.patch({ name: 'x' })).toThrow(/MUTATION|pending/)
	})

	it('throws MUTATION when patched while terminal', () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.stop()
		expect(() => phase.patch({ name: 'x' })).toThrow(/MUTATION|pending/)
	})
})

describe('Phase — skip/stop release parked waiters (symmetric with Workflow)', () => {
	it('skip releases a parked wait() waiter', async () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.pause()
		let settled = false
		const waiting = phase.wait().then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		phase.skip()
		await waiting
		expect(settled).toBe(true)
	})

	it('stop releases a parked wait() waiter', async () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		phase.pause()
		let settled = false
		const waiting = phase.wait().then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		phase.stop()
		await waiting
		expect(settled).toBe(true)
	})
})

describe('Phase — leak checks (repeated pause/resume churn stays sound)', () => {
	it('repeated pause/resume churn never leaves paused stuck true or wait() unresolved', async () => {
		const phase = lonePhase(createWorkflow(buildPhaseWorkflow(1)))
		for (let i = 0; i < 25; i += 1) {
			phase.pause()
			expect(phase.paused).toBe(true)
			phase.resume()
			expect(phase.paused).toBe(false)
			await expect(phase.wait()).resolves.toBeUndefined()
		}
	})
})

describe('Phase — emit-safety (§13)', () => {
	it('isolates a throwing listener, routes it to the error handler, and still derives', () => {
		const errors = createErrorRecorder()
		const phase = lonePhase(
			createWorkflow(buildPhaseWorkflow(1), { phases: { p: { error: errors.handler } } }),
		)
		phase.emitter.on('start', () => {
			throw new Error('listener boom')
		})
		expect(() => phase.task('t0')?.start()).not.toThrow()
		expect(phase.status).toBe('running')
		// The throw is routed to the emitter's error handler — (error, event) order.
		expect(errors.count).toBe(1)
		expect(errors.calls[0]?.[1]).toBe('start')
	})
})
