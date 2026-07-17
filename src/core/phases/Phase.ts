import type { Result } from '@orkestrel/contract'
import type { EmitterInterface } from '@orkestrel/emitter'
import type {
	DeferredInterface,
	PhaseContext,
	PhaseEventMap,
	PhaseInterface,
	PhaseOptions,
	PhaseSnapshot,
	PhaseStatus,
	PhaseUpdate,
	TaskDefinition,
	TaskInterface,
	TaskManagerInterface,
	TaskOptions,
	TaskResult,
	TaskSnapshot,
	TaskUpdate,
	WorkflowFunctions,
	WorkflowInterface,
} from '../types.js'
import { Emitter } from '@orkestrel/emitter'
import { WorkflowError } from '../errors.js'
import {
	buildPhaseContext,
	buildTaskContext,
	createDeferred,
	derivePhaseStatus,
	failure,
	findFailure,
	isTerminalStatus,
	taskDefinitionToSnapshot,
} from '../helpers.js'
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
 * - **Structural API (AGENTS §7).** `add` / `remove` / `move` / `update` gate BEFORE
 *   delegating to {@link tasks} (the manager gates the target's own existence/status/id/
 *   bounds), then emit the matching {@link PhaseEventMap} event on success only. NATIVE
 *   gating, purely from this phase's own derived `status` (no runner-installed hook): while
 *   `pending`, any valid `index` is accepted; while `running`, `add` accepts ONLY a pure
 *   append (a live runner subscribed to the `add` event picks it up), and `remove` / `move` /
 *   `update` always fail gracefully (the tasks are already handed to the execution
 *   substrate); while terminal, everything is refused.
 * - **Patch (AGENTS §12).** `patch` applies a validated {@link PhaseUpdate} to SELF
 *   (`name` / `description` / `concurrency` / `bail`) — defense-in-depth: it throws a
 *   `MUTATION` {@link WorkflowError} unless this phase's own `status` is `pending`, mirroring
 *   the owning {@link WorkflowInterface.update}'s gate.
 * - **Minting (AGENTS §7).** {@link add} MINTS a live {@link Task} from a {@link TaskDefinition}
 *   (converts it to a {@link TaskSnapshot}, builds the task wired to THIS phase) — the same
 *   construction path {@link #append} uses at build time, so a live mint and a restored/built
 *   task are wired IDENTICALLY. At construction, the workflow-level
 *   {@link import('../types.js').WorkflowFunctions} registry (threaded from
 *   {@link import('../types.js').WorkflowOptions.functions}) resolves each task's `run` name into
 *   its runtime {@link import('../types.js').TaskInterface.handler} ONCE; a `run` that is omitted
 *   or unregistered resolves to no handler (the no-handler rule).
 * - **Runtime lifecycle (AGENTS §10).** `pause` / `resume` / `wait` mirror the workflow's own
 *   quartet, scoped to this phase — a driving
 *   {@link import('../types.js').WorkflowRunnerInterface.execute} gates a task's own
 *   pre-dispatch on the workflow's gate FIRST, then this phase's gate, WITHOUT touching
 *   {@link status} — `paused` is runtime-only, never persisted. `skip` / `stop` (this phase's
 *   own terminal forcing) always release a parked {@link wait} waiter, mirroring
 *   {@link import('../Workflow.js').Workflow.destroy}'s cascade — a permanently-ended phase
 *   has nothing left to pause for.
 */
export class Phase implements PhaseInterface {
	readonly #id: string
	#name: string
	#description: string | undefined
	readonly #workflow: WorkflowInterface
	// Escalate a derived-status change UP to the parent workflow (which re-derives under `bail`)
	// — injected by the parent so the phase needs no back-reference plumbing of its own.
	readonly #escalateUp: () => void
	readonly #tasks: TaskManager = new TaskManager()
	// The workflow-level function registry each task's `run` name resolves against ONCE at
	// construction (build, restore, or a live mint) — threaded from Workflow, never re-read.
	// Because resolution happens at THAT construction/mint moment, mutating the registry object
	// after this phase (or an earlier task) has resolved changes only later mints, never
	// already-resolved tasks — do not mutate it.
	readonly #functions: WorkflowFunctions | undefined
	// The EFFECTIVE failure policy this phase runs under (`phase.bail ?? workflow.bail`, resolved
	// at seed time and carried on the snapshot) — read by the runner to decide fail-fast vs
	// settle-all for THIS phase, and by the workflow's per-phase-bail-aware status derivation.
	// Mutable (AGENTS §7): a `pending` phase's `patch` may override it before a run starts.
	#bail: boolean
	// Max tasks in flight at once (a resource throttle), seeded from the snapshot; mutable via a
	// `pending` phase's `patch` (AGENTS §7). `undefined` ⇒ unbounded.
	#concurrency: number | undefined
	// The PUSH observation surface (§13) — owned, never inherited. The emitter isolates a
	// listener throw (routing it to the `error` handler), never the cascade.
	readonly #emitter: Emitter<PhaseEventMap>
	// The last computed status — the baseline a recompute diffs against to detect a CHANGE.
	#status: PhaseStatus
	// The forced status of a `skip` / `stop`, overriding the derived value; `undefined` ⇒ derived.
	#override: PhaseStatus | undefined
	// RUNTIME-ONLY (never persisted): whether the phase is currently paused.
	#paused: boolean
	// The parked `wait()` gate while paused; `undefined` when not paused — released (resolved) by
	// `resume` / `stop` / `skip`.
	#gate: DeferredInterface<void> | undefined

	constructor(
		snapshot: PhaseSnapshot,
		workflow: WorkflowInterface,
		escalate: () => void,
		options?: PhaseOptions,
		bail?: boolean,
		functions?: WorkflowFunctions,
	) {
		this.#id = snapshot.id
		this.#name = snapshot.name
		this.#description = snapshot.description
		this.#workflow = workflow
		this.#escalateUp = escalate
		this.#functions = functions
		// The effective per-phase policy: the explicit workflow `bail` OVERRIDE when supplied (a
		// deliberate "re-run the whole tree under THIS uniform policy" knob — `createWorkflow` /
		// `restoreWorkflow` thread `options.bail` here), else the snapshot's persisted per-phase `bail`
		// (so an option-less restore is IDENTICAL — each phase's own persisted policy governs). The
		// snapshot already resolved `phase.bail ?? workflowBail` at seed time, mirroring how Workflow
		// reads its own `#bail`.
		this.#bail = bail ?? snapshot.bail
		this.#concurrency = snapshot.concurrency
		this.#emitter = new Emitter<PhaseEventMap>({ on: options?.on, error: options?.error })
		// Build the live tasks positionally from the snapshot — each wired to recompute THIS phase
		// on a transition, carrying its own restore state (status + result + metadata) and resolving
		// its `run` name against `#functions` into its runtime handler.
		for (const task of snapshot.tasks) this.#append(task, options)
		// Restore the override DIRECTLY from the snapshot's own field (present only when a whole-
		// phase skip / stop forced it) — no fragile status-divergence guess. Then seed the baseline
		// from the EFFECTIVE status so a recompute diffs against the right value.
		this.#override = snapshot.override
		this.#status = this.status
		this.#paused = false
		this.#gate = undefined
	}

	get emitter(): EmitterInterface<PhaseEventMap> {
		return this.#emitter
	}

	get id(): string {
		return this.#id
	}

	get name(): string {
		return this.#name
	}

	get description(): string | undefined {
		return this.#description
	}

	get context(): PhaseContext {
		// Computed fresh so a renamed phase's context reflects its CURRENT identity — the phase's
		// own id/name/description plus the live parent workflow context.
		return buildPhaseContext(this.#workflow.context, {
			id: this.#id,
			name: this.#name,
			...(this.#description === undefined ? {} : { description: this.#description }),
		})
	}

	get workflow(): WorkflowInterface {
		return this.#workflow
	}

	get bail(): boolean {
		return this.#bail
	}

	get concurrency(): number | undefined {
		return this.#concurrency
	}

	get paused(): boolean {
		return this.#paused
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
		// IDEMPOTENT / NO-OP once `status` is already terminal (a settled phase cannot be
		// re-forced) — but a parked `wait()` waiter is ALWAYS released regardless (a terminal
		// phase must never hold one; kept unconditional for safety).
		if (!isTerminalStatus(this.status)) this.#force('skipped')
		this.#paused = false
		this.#release()
	}

	stop(): void {
		// `stop` (AGENTS §10) FORCES the phase to `stopped` — same override discipline as `skip`;
		// `stopped` IS a PhaseEventMap event, so this emit fires. NO-OP once `status` is already
		// terminal (a settled phase cannot be re-forced). Always releases a parked `wait()`
		// waiter (AGENTS §10 — a permanently-ended phase has nothing left to pause for), even on
		// the no-op branch, for safety.
		if (!isTerminalStatus(this.status)) this.#force('stopped')
		this.#paused = false
		this.#release()
	}

	pause(): void {
		// Idempotent: a no-op when already paused or terminal — pausing a settled phase has
		// nothing to suspend.
		if (this.#paused || isTerminalStatus(this.status)) return
		this.#paused = true
		this.#gate = createDeferred<void>()
	}

	resume(): void {
		// Idempotent: a no-op unless currently paused.
		if (!this.#paused) return
		this.#paused = false
		this.#release()
	}

	wait(): Promise<void> {
		// Promise-parked (AGENTS §21), never a timer or busy-loop — resolves immediately when not
		// paused; while paused, the shared gate resolves on `resume` / `stop` / `skip`.
		return this.#paused && this.#gate !== undefined ? this.#gate.promise : Promise.resolve()
	}

	add(definition: TaskDefinition, index?: number): Result<TaskInterface, WorkflowError> {
		const status = this.status
		if (isTerminalStatus(status)) {
			return failure(
				new WorkflowError('MUTATION', `phase '${this.#id}' is terminal`, {
					id: this.#id,
					status,
				}),
			)
		}
		const created = this.#mint(definition)
		if (status === 'running') {
			// Running: only a pure append is eligible — a live runner subscribed to the `add`
			// event picks the new task up for same-run execution.
			const at = index ?? this.#tasks.count
			if (at !== this.#tasks.count) {
				return failure(
					new WorkflowError(
						'MUTATION',
						`phase '${this.#id}' only accepts an append while executing`,
						{ id: this.#id, index: at },
					),
				)
			}
			return this.#addTo(created, index, at)
		}
		return this.#addTo(created, index, index ?? this.#tasks.count)
	}

	remove(id: string): Result<TaskInterface, WorkflowError> {
		if (this.status !== 'pending') {
			return failure(
				new WorkflowError('MUTATION', `phase '${this.#id}' is not pending`, {
					id: this.#id,
					status: this.status,
				}),
			)
		}
		const result = this.#tasks.remove(id)
		if (result.success) this.#emitter.emit('remove', result.value)
		return result
	}

	move(id: string, index: number): Result<TaskInterface, WorkflowError> {
		if (this.status !== 'pending') {
			return failure(
				new WorkflowError('MUTATION', `phase '${this.#id}' is not pending`, {
					id: this.#id,
					status: this.status,
				}),
			)
		}
		const result = this.#tasks.move(id, index)
		if (result.success) this.#emitter.emit('move', result.value, index)
		return result
	}

	update(id: string, patch: TaskUpdate): Result<TaskInterface, WorkflowError> {
		if (this.status !== 'pending') {
			return failure(
				new WorkflowError('MUTATION', `phase '${this.#id}' is not pending`, {
					id: this.#id,
					status: this.status,
				}),
			)
		}
		const result = this.#tasks.update(id, patch)
		if (result.success) this.#emitter.emit('update', result.value)
		return result
	}

	patch(value: PhaseUpdate): void {
		// Defense-in-depth (AGENTS §12): the owning WorkflowInterface.update gates FIRST, so a
		// direct call here THROWS unless this phase is genuinely `pending`.
		if (this.status !== 'pending') {
			throw new WorkflowError('MUTATION', `phase '${this.#id}' can only be patched while pending`, {
				id: this.#id,
				status: this.status,
			})
		}
		if (value.name !== undefined) this.#name = value.name
		if (value.description !== undefined) this.#description = value.description
		if (value.concurrency !== undefined) this.#concurrency = value.concurrency
		if (value.bail !== undefined) this.#bail = value.bail
	}

	snapshot(): PhaseSnapshot {
		// Pure JSON: identity + the EFFECTIVE status (override-or-derived) + the ACTUAL override
		// (emitted only when one is in force) + the effective `bail` this phase ran under (always —
		// a REQUIRED field, like Workflow's) + the concurrency throttle (when set) + the tasks'
		// snapshots in positional order. Persisting the override + bail + concurrency directly lets a
		// restore reinstate them without guessing from a divergence.
		return {
			id: this.id,
			name: this.name,
			...(this.description === undefined ? {} : { description: this.description }),
			status: this.status,
			...(this.#override === undefined ? {} : { override: this.#override }),
			bail: this.#bail,
			...(this.#concurrency === undefined ? {} : { concurrency: this.#concurrency }),
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
		const found = findFailure(this.results())
		if (found === undefined) {
			throw new Error(`phase '${this.id}' derived failed with no failing task result`)
		}
		return found
	}

	// Resolve the parked `wait()` gate (when one exists) and clear it — the shared release step
	// behind `resume` / `stop` / `skip` (all three always release a parked waiter).
	#release(): void {
		if (this.#gate === undefined) return
		this.#gate.resolve()
		this.#gate = undefined
	}

	// Delegate an `add` to the task manager and emit `add` (the inserted task + its final
	// `at` index) on success — the shared tail of the hooked and un-hooked `add` branches.
	#addTo(
		task: TaskInterface,
		index: number | undefined,
		at: number,
	): Result<TaskInterface, WorkflowError> {
		const result = this.#tasks.add(task, index)
		if (result.success) this.#emitter.emit('add', result.value, at)
		return result
	}

	// Build one live task from its snapshot, threading its per-task options (its own `on` /
	// `metadata`, keyed by id under the phase options) and its restore state (including its
	// declarative `run` / `retries` / `timeout`), then append it.
	#append(task: TaskSnapshot, options: PhaseOptions | undefined): void {
		const created = this.#create(task, options?.tasks?.[task.id])
		this.#tasks.append(created)
	}

	// Build one live task wired to THIS phase — the shared construction step behind both
	// `#append` (build-time wiring, from a TaskSnapshot's restore state) and `#mint` (a live
	// `add`, from a freshly-converted TaskDefinition snapshot) — so a mint and a built/restored
	// task are wired IDENTICALLY (recompute cascade, emitter hooks, context stamping). Resolves
	// `snapshot.run` against `#functions` ONCE into the task's runtime handler.
	#create(snapshot: TaskSnapshot, options: TaskOptions | undefined): Task {
		const context = buildTaskContext(this.context, snapshot)
		const handler = snapshot.run === undefined ? undefined : this.#functions?.[snapshot.run]
		return new Task(
			context,
			this,
			this.#workflow,
			() => this.#recompute(),
			options,
			snapshot.status,
			snapshot.result,
			snapshot.run,
			snapshot.retries,
			snapshot.timeout,
			handler,
		)
	}

	// MINT a live task from a TaskDefinition for a live `add` — converts it to an initial
	// TaskSnapshot (definitionToSnapshot's per-task step, carrying its `run` / `retries` /
	// `timeout`) then builds it via `#create`, which resolves its handler the SAME way.
	#mint(definition: TaskDefinition): Task {
		return this.#create(taskDefinitionToSnapshot(definition), undefined)
	}

	// The live tasks' statuses, in positional order — the input to `derivePhaseStatus`.
	#statuses(): readonly PhaseStatus[] {
		return this.#tasks.tasks().map((task) => task.status)
	}
}
