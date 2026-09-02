import type { Result } from '@orkestrel/contract'
import type { EmitterInterface } from '@orkestrel/emitter'
import type {
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
	WorkflowFunction,
	WorkflowFunctions,
	WorkflowInterface,
} from '../types.js'
import { Emitter } from '@orkestrel/emitter'
import { WorkflowError } from '../errors.js'
import {
	buildPhaseContext,
	buildTaskContext,
	derivePhaseStatus,
	failure,
	findFailure,
	isTerminalStatus,
	taskDefinitionToSnapshot,
} from '../helpers.js'
import { Task } from '../tasks/Task.js'
import { TaskManager } from '../tasks/TaskManager.js'

/**
 * Implements the live DERIVED state machine (W-b) for one phase — an observable (AGENTS §13) whose
 * {@link PhaseStatus} is computed from its tasks (never set directly) and recomputed
 * reactively as a task transitions (the middle tier of the cascade).
 *
 * @remarks
 * - **Derived status.** `status` is `#override` when one is in force, else
 *   {@link derivePhaseStatus} over the live tasks' statuses. `#recompute` (passed to
 *   each child {@link Task}) re-derives on every child transition; a CHANGE emits the matching
 *   event AND escalates to the workflow (`#escalate`, the upward step of the cascade).
 * - **Override (AGENTS §10).** `skip` / `stop` FORCE the phase's status (e.g. skipping a whole
 *   phase), overriding the derived value; the override is PERSISTED in the snapshot's own
 *   `override` field and restored DIRECTLY (no divergence guess), so a forced phase round-trips.
 * - **Children (AGENTS §9).** `tasks` is the lean {@link TaskManager} (an accessor + `count`,
 *   no batch matrix); built positionally from the snapshot so order survives an interior `skip`.
 *   `results()` collects the settled tasks' {@link TaskResult}s (the phase tier of the result
 *   tree); `workflow` navigates UP to the live parent.
 * - **Observable (AGENTS §13).** The owned {@link emitter} ({@link PhaseEventMap}) fires
 *   `start` / `complete` / `fail` / `pause` / `resume` / `skip` / `stop` after the
 *   corresponding status or runtime-gate change. Status events fire after the phase recomputes
 *   and before it escalates to the workflow, preserving child/phase cause before parent effect.
 *   The emitter isolates a listener throw and routes it to its `error` handler (the `error`
 *   option); `fail` carries the failing task's {@link TaskResult}.
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
 *   {@link import('../types.js').WorkflowOptions.functions}) resolves every unique initial `behavior`
 *   name ONCE before any task is built; siblings sharing a name receive the exact same captured
 *   runtime {@link import('../types.js').TaskInterface.handler}. A later live {@link add} reads
 *   that name once from the retained registry at its own mint moment. An omitted or unregistered
 *   `behavior` resolves to no handler; only omission is a no-op, while an unresolved present name makes
 *   the containing tree non-drivable.
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
	// The workflow-level function registry retained from Workflow. Initial tasks capture one
	// binding per unique behavior name. A later live mint reads its own
	// binding from this retained registry; existing handlers never change when the registry does.
	readonly #functions: WorkflowFunctions | undefined
	readonly #silence: number | undefined
	// The EFFECTIVE failure policy this phase runs under (`phase.bail ?? workflow.bail`, resolved
	// at seed time and carried on the snapshot) — read by the runner to decide fail-fast vs
	// settle-all for THIS phase, and by the workflow's per-phase-bail-aware status derivation.
	// Mutable (AGENTS §7): a `pending` phase's `patch` may override it before a run starts.
	#bail: boolean
	// Max tasks in flight at once (a resource throttle), seeded from the snapshot; mutable through a
	// `pending` phase's `patch` (AGENTS §7). `undefined` ⇒ unbounded.
	#concurrency: number | undefined
	// The PUSH observation surface (§13) — owned, never inherited. The emitter isolates a
	// listener throw (routing it to the `error` handler), never the cascade.
	readonly #emitter: Emitter<PhaseEventMap>
	// The last computed status — the baseline a recompute diffs against to detect a CHANGE.
	#status: PhaseStatus
	// The forced status of a `skip` / `stop`, overriding the derived value; `undefined` ⇒ derived.
	#override: PhaseStatus | undefined
	// RUNTIME-ONLY (never persisted): whether the phase is paused.
	#paused: boolean
	// The parked `wait()` gate while paused; `undefined` when not paused — released (resolved) by
	// `resume` / `stop` / `skip`.
	#gate: PromiseWithResolvers<void> | undefined

	constructor(
		snapshot: PhaseSnapshot,
		workflow: WorkflowInterface,
		escalate: () => void,
		options?: PhaseOptions,
		bail?: boolean,
		functions?: WorkflowFunctions,
		silence?: number,
	) {
		const on = options?.on
		const error = options?.error
		const tasks = options?.tasks
		this.#id = snapshot.id
		this.#name = snapshot.name
		this.#description = snapshot.description
		this.#workflow = workflow
		this.#escalateUp = escalate
		this.#functions = functions
		this.#silence = silence
		const handlers = new Map<string, WorkflowFunction | undefined>()
		for (const task of snapshot.tasks) {
			if (task.behavior !== undefined && !handlers.has(task.behavior)) {
				handlers.set(task.behavior, functions?.[task.behavior])
			}
		}
		// The effective per-phase policy: the explicit workflow `bail` OVERRIDE when supplied (a
		// deliberate "re-run the whole tree under THIS uniform policy" knob — `createWorkflow` /
		// `createRestoredWorkflow` thread `options.bail` here), else the snapshot's persisted per-phase `bail`
		// (so an option-less restore is IDENTICAL — each phase's own persisted policy governs). The
		// snapshot already resolved `phase.bail ?? workflowBail` at seed time, mirroring how Workflow
		// reads its own `#bail`.
		this.#bail = bail ?? snapshot.bail
		this.#concurrency = snapshot.concurrency
		this.#emitter = new Emitter<PhaseEventMap>({
			...(on === undefined ? {} : { on }),
			...(error === undefined ? {} : { error }),
		})
		// Build the live tasks positionally from the snapshot — each wired to recompute THIS phase
		// on a transition, carrying its own restore state and the once-captured handler for its `behavior`.
		for (const task of snapshot.tasks) {
			const taskOptions = tasks?.[task.id]
			const handler = task.behavior === undefined ? undefined : handlers.get(task.behavior)
			this.#append(task, taskOptions, handler)
		}
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
		// recompute so the change is detected, emitted, and escalated.
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
		this.#gate = Promise.withResolvers<void>()
		this.#emitter.emit('pause')
	}

	resume(): void {
		// Idempotent: a no-op unless paused.
		if (!this.#paused) return
		this.#paused = false
		this.#release()
		this.#emitter.emit('resume')
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
			...(this.#description === undefined ? {} : { description: this.#description }),
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
	// phase ignores further child churn. The phase event precedes the parent effect.
	#recompute(): void {
		const next = this.status
		if (next === this.#status) {
			// No phase-level change, but a child still transitioned — escalate so the workflow can
			// re-derive (its own diff decides whether the workflow itself changed + emits).
			this.#escalateUp()
			return
		}
		this.#status = next
		if (isTerminalStatus(next)) {
			this.#paused = false
			this.#release()
		}
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
	// ⇒ `stop`, `skipped` ⇒ `skip`. `pending` has no event.
	#emitFor(status: PhaseStatus): void {
		if (status === 'running') this.#emitter.emit('start', this.id)
		else if (status === 'completed') this.#emitter.emit('complete')
		else if (status === 'failed') this.#emitter.emit('fail', this.#failure())
		else if (status === 'skipped') this.#emitter.emit('skip')
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
			throw new WorkflowError(
				'INVARIANT',
				`phase '${this.id}' derived failed with no failing task result`,
				{ phase: this.id },
			)
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
	// declarative `behavior` / `retries` / `timeout`), then append it.
	#append(
		task: TaskSnapshot,
		options: TaskOptions | undefined,
		handler: WorkflowFunction | undefined,
	): void {
		const created = this.#create(task, options, handler)
		this.#tasks.append(created)
	}

	// Build one live task wired to THIS phase — the shared construction step behind both
	// `#append` (build-time wiring, from a TaskSnapshot's restore state) and `#mint` (a live
	// `add`, from a freshly-converted TaskDefinition snapshot) — so a mint and a built/restored
	// task are wired IDENTICALLY (recompute cascade, emitter hooks, context stamping). The caller
	// supplies the once-resolved runtime handler for the construction moment it owns.
	#create(
		snapshot: TaskSnapshot,
		options: TaskOptions | undefined,
		handler: WorkflowFunction | undefined,
	): Task {
		const context = buildTaskContext(this.context, snapshot)
		return new Task(
			context,
			this,
			this.#workflow,
			() => this.#recompute(),
			options,
			snapshot.status,
			snapshot.result,
			snapshot.behavior,
			snapshot.retries,
			snapshot.timeout,
			snapshot.metadata,
			snapshot.attempts,
			snapshot.activity,
			handler,
			this.#silence,
		)
	}

	// MINT a live task from a TaskDefinition for a live `add` — converts it to an initial
	// TaskSnapshot (definitionToSnapshot's per-task step, carrying its `behavior` / `retries` /
	// `timeout`) then resolves its handler once against the retained registry for this live mint.
	#mint(definition: TaskDefinition): Task {
		const snapshot = taskDefinitionToSnapshot(definition)
		const handler =
			snapshot.behavior === undefined ? undefined : this.#functions?.[snapshot.behavior]
		return this.#create(snapshot, undefined, handler)
	}

	// The live tasks' statuses, in positional order — the input to `derivePhaseStatus`.
	#statuses(): readonly PhaseStatus[] {
		return this.#tasks.tasks().map((task) => task.status)
	}
}
