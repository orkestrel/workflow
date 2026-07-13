import type { EmitterInterface } from '../../emitters/types.js'
import type {
	PhaseContext,
	PhaseEventMap,
	PhaseInterface,
	PhaseOptions,
	PhaseSnapshot,
	PhaseStatus,
	TaskInterface,
	TaskManagerInterface,
	TaskResult,
	TaskSnapshot,
	WorkflowInterface,
} from '../types.js'
import { Emitter } from '../../emitters/Emitter.js'
import { buildTaskContext, derivePhaseStatus } from '../helpers.js'
import { Task } from '../tasks/Task.js'
import { TaskManager } from '../tasks/TaskManager.js'

/**
 * The live DERIVED state machine (W-b) for one phase — an observable (AGENTS §13) whose
 * {@link PhaseStatus} is computed from its tasks (never set directly) and recomputed
 * reactively as a task transitions (the middle tier of the cascade).
 *
 * @remarks
 * - **Derived status.** `status` is `#override` when one is in force, else
 *   {@link derivePhaseStatus} over the live tasks' statuses. {@link #recompute} (passed to
 *   each child {@link Task}) re-derives on every child transition; a CHANGE emits the matching
 *   event AND escalates to the workflow ({@link #escalate}, the upward step of the cascade).
 * - **Override (AGENTS §10).** `skip` / `stop` FORCE the phase's status (e.g. skipping a whole
 *   phase), overriding the derived value; the override is PERSISTED in the snapshot's own
 *   `override` field and restored DIRECTLY (no divergence guess), so a forced phase round-trips.
 * - **Children (AGENTS §9).** `tasks` is the lean {@link TaskManager} (an accessor + `count`,
 *   no batch matrix); built positionally from the snapshot so order survives an interior `skip`.
 *   `results()` collects the settled tasks' {@link TaskResult}s (the phase tier of the result
 *   tree); `workflow` navigates UP to the live parent.
 * - **Observable (AGENTS §13).** The owned {@link emitter} ({@link PhaseEventMap}) fires
 *   `start` / `complete` / `fail` / `stop` on a derived-status CHANGE, strictly AFTER the
 *   recompute + escalate; the emitter isolates a listener throw and routes it to its `error`
 *   handler (the `error` option); `fail` carries the failing task's {@link TaskResult}.
 */
export class Phase implements PhaseInterface {
	readonly #context: PhaseContext
	readonly #workflow: WorkflowInterface
	// Escalate a derived-status change UP to the parent workflow (which re-derives under `bail`)
	// — injected by the parent so the phase needs no back-reference plumbing of its own.
	readonly #escalateUp: () => void
	readonly #tasks: TaskManager = new TaskManager()
	// The EFFECTIVE failure policy this phase runs under (`phase.bail ?? workflow.bail`, resolved
	// at seed time and carried on the snapshot) — read by the runner to decide fail-fast vs
	// settle-all for THIS phase, and by the workflow's per-phase-bail-aware status derivation.
	readonly #bail: boolean
	// The PUSH observation surface (§13) — owned, never inherited. The emitter isolates a
	// listener throw (routing it to the `error` handler), never the cascade.
	readonly #emitter: Emitter<PhaseEventMap>
	// The last computed status — the baseline a recompute diffs against to detect a CHANGE.
	#status: PhaseStatus
	// The forced status of a `skip` / `stop`, overriding the derived value; `undefined` ⇒ derived.
	#override: PhaseStatus | undefined

	constructor(
		snapshot: PhaseSnapshot,
		workflow: WorkflowInterface,
		escalate: () => void,
		options?: PhaseOptions,
		bail?: boolean,
	) {
		this.#context = { id: snapshot.id, name: snapshot.name, workflow: workflow.context }
		if (snapshot.description !== undefined) {
			this.#context = { ...this.#context, description: snapshot.description }
		}
		this.#workflow = workflow
		this.#escalateUp = escalate
		// The effective per-phase policy: the explicit workflow `bail` OVERRIDE when supplied (a
		// deliberate "re-run the whole tree under THIS uniform policy" knob — `createWorkflow` /
		// `restoreWorkflow` thread `options.bail` here), else the snapshot's persisted per-phase `bail`
		// (so an option-less restore is IDENTICAL — each phase's own persisted policy governs). The
		// snapshot already resolved `phase.bail ?? workflowBail` at seed time, mirroring how Workflow
		// reads its own `#bail`.
		this.#bail = bail ?? snapshot.bail
		this.#emitter = new Emitter<PhaseEventMap>({ on: options?.on, error: options?.error })
		// Build the live tasks positionally from the snapshot — each wired to recompute THIS phase
		// on a transition, and carrying its own restore state (status + result + metadata).
		for (const task of snapshot.tasks) this.#append(task, options)
		// Restore the override DIRECTLY from the snapshot's own field (present only when a whole-
		// phase skip / stop forced it) — no fragile status-divergence guess. Then seed the baseline
		// from the EFFECTIVE status so a recompute diffs against the right value.
		this.#override = snapshot.override
		this.#status = this.status
	}

	get emitter(): EmitterInterface<PhaseEventMap> {
		return this.#emitter
	}

	get id(): string {
		return this.#context.id
	}

	get name(): string {
		return this.#context.name
	}

	get description(): string | undefined {
		return this.#context.description
	}

	get context(): PhaseContext {
		return this.#context
	}

	get workflow(): WorkflowInterface {
		return this.#workflow
	}

	get bail(): boolean {
		return this.#bail
	}

	get status(): PhaseStatus {
		// The override wins when forced; otherwise the status is derived from the live tasks.
		return this.#override ?? derivePhaseStatus(this.#statuses())
	}

	get tasks(): TaskManagerInterface {
		return this.#tasks
	}

	task(id: string): TaskInterface | undefined {
		return this.#tasks.task(id)
	}

	results(): readonly TaskResult[] {
		// The phase tier of the result tree — every settled task's recorded result, in positional
		// order. A `pending` / `running` task (or a forced skip / stop) contributed none.
		const results: TaskResult[] = []
		for (const task of this.#tasks.tasks()) {
			if (task.result !== undefined) results.push(task.result)
		}
		return results
	}

	skip(): void {
		// `skip` (AGENTS §10) FORCES the phase to `skipped`, overriding the derived value — then
		// recompute so the change is detected + escalated (no PhaseEventMap event for a skip).
		this.#force('skipped')
	}

	stop(): void {
		// `stop` (AGENTS §10) FORCES the phase to `stopped` — same override discipline as `skip`;
		// `stopped` IS a PhaseEventMap event, so this emit fires.
		this.#force('stopped')
	}

	snapshot(): PhaseSnapshot {
		// Pure JSON: identity + the EFFECTIVE status (override-or-derived) + the ACTUAL override
		// (emitted only when one is in force) + the effective `bail` this phase ran under (always —
		// a REQUIRED field, like Workflow's) + the tasks' snapshots in positional order. Persisting
		// the override + bail directly lets a restore reinstate them without guessing from a divergence.
		return {
			id: this.id,
			name: this.name,
			...(this.description === undefined ? {} : { description: this.description }),
			status: this.status,
			...(this.#override === undefined ? {} : { override: this.#override }),
			bail: this.#bail,
			tasks: this.#tasks.tasks().map((task) => task.snapshot()),
		}
	}

	// Recompute the derived status after a child transition (the callback wired into each Task):
	// diff the new effective status against the baseline; on a CHANGE, advance the baseline, emit
	// the matching event, and escalate to the workflow. An override pins the status, so a forced
	// phase ignores further child churn. Placed so the parents settle before observers see it.
	#recompute(): void {
		const next = this.status
		if (next === this.#status) {
			// No phase-level change, but a child still transitioned — escalate so the workflow can
			// re-derive (its own diff decides whether the workflow itself changed + emits).
			this.#escalateUp()
			return
		}
		this.#status = next
		this.#emitFor(next)
		this.#escalateUp()
	}

	// Apply a forced status (skip / stop): set the override, then recompute so the change is
	// detected, emitted (when the status maps to an event), and escalated.
	#force(status: PhaseStatus): void {
		this.#override = status
		this.#recompute()
	}

	// Emit the PhaseEventMap event matching a newly-entered status. `running` ⇒ `start`,
	// `completed` ⇒ `complete`, `failed` ⇒ `fail` (with the failing task's result), `stopped`
	// ⇒ `stop`. `pending` / `skipped` have no event (a phase never re-enters `pending`, and a
	// skip is a task-tier concept) — they emit nothing.
	#emitFor(status: PhaseStatus): void {
		if (status === 'running') this.#emitter.emit('start', this.id)
		else if (status === 'completed') this.#emitter.emit('complete')
		else if (status === 'failed') this.#emitter.emit('fail', this.#failure())
		else if (status === 'stopped') this.#emitter.emit('stop')
	}

	// The failing task's REAL recorded {@link TaskResult} — the first task whose result is a
	// Failure — so the `fail` event carries the true cause. A phase derives `failed` ONLY when a
	// child failed with a `Failure` result, so one always exists when `#emitFor('failed')` calls
	// this: assert that invariant (§12 programmer-error guard, mirroring `Runner.#dispatch`) rather
	// than fabricating a synthetic result — a fake, lineage-degenerate `TaskResult` would mask the
	// true cause while still type-checking.
	#failure(): TaskResult {
		for (const task of this.#tasks.tasks()) {
			const result = task.result
			if (result?.result?.success === false) return result
		}
		throw new Error(`phase '${this.id}' derived failed with no failing task result`)
	}

	// Build one live task from its snapshot, threading its per-task options (its own `on` /
	// `metadata`, keyed by id under the phase options) and its restore state, then append it.
	#append(task: TaskSnapshot, options: PhaseOptions | undefined): void {
		const context = buildTaskContext(this.#context, task)
		const created = new Task(
			context,
			this,
			this.#workflow,
			() => this.#recompute(),
			options?.tasks?.[task.id],
			task.status,
			task.result,
		)
		this.#tasks.append(created)
	}

	// The live tasks' statuses, in positional order — the input to `derivePhaseStatus`.
	#statuses(): readonly PhaseStatus[] {
		return this.#tasks.tasks().map((task) => task.status)
	}
}
