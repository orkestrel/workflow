import type { Result } from '@orkestrel/contract'
import type { AbortInterface } from '@orkestrel/abort'
import type { EmitterInterface } from '@orkestrel/emitter'
import type {
	LifecycleStatus,
	PhaseDefinition,
	PhaseDerivation,
	PhaseInterface,
	PhaseManagerInterface,
	PhaseOptions,
	PhaseSnapshot,
	PhaseUpdate,
	TaskResult,
	WorkflowContext,
	WorkflowEventMap,
	WorkflowInterface,
	WorkflowOptions,
	WorkflowRegistry,
	WorkflowSnapshot,
} from './types.js'
import { createAbort } from '@orkestrel/abort'
import { Emitter } from '@orkestrel/emitter'
import { cloneWorkflowSnapshot } from './cloners.js'
import { WorkflowError } from './errors.js'
import {
	buildWorkflowContext,
	captureWorkflowOptions,
	collectResults,
	deriveBoundary,
	deriveWorkflowStatus,
	failure,
	findFailure,
	isTerminalStatus,
	phaseDefinitionToSnapshot,
} from './helpers.js'
import { Phase } from './phases/Phase.js'
import { PhaseManager } from './phases/PhaseManager.js'

/**
 * Implements the live DERIVED state machine (W-b) for a whole workflow — the observable ROOT
 * whose {@link LifecycleStatus} is computed from its phases under the `bail` policy and
 * recomputed reactively as the cascade propagates up from a task transition.
 *
 * @remarks
 * - **Construction.** Built from a {@link WorkflowSnapshot} (the unified input —
 *   {@link import('./factories.js').createWorkflow} seeds an initial snapshot from a
 *   {@link import('./types.js').WorkflowDefinition}, {@link import('./factories.js').createRestoredWorkflow}
 *   passes a persisted one). Each child {@link Phase} is wired to escalate to `#recompute`.
 * - **Derived status.** `status` is `#override` when forced, else
 *   {@link deriveWorkflowStatus} over the live phases' statuses feeding `bail`. `failed` is
 *   reachable ONLY under `bail: true` (a single failed task halts the workflow); under
 *   `bail: false` a failed phase folds into `completed`. `#recompute` diffs on each phase
 *   change; a CHANGE emits.
 * - **Override.** `skip` / `stop` FORCE the status; an executed task-free pending tree
 *   may also be force-completed vacuously. The override is PERSISTED in the snapshot's own
 *   `override` field and restored DIRECTLY (no divergence guess). The snapshot also persists
 *   `bail`, so a restore re-derives status identically without a silent policy default.
 * - **Result tree.** `results()` flattens every phase's `results()` ({@link collectResults}) — the
 *   workflow tier; `phase(id)` + each `phase.task(id)` navigate DOWN, a task's `phase` / `workflow`
 *   navigate UP.
 * - **Snapshot.** `snapshot()` serializes the whole live tree to a {@link WorkflowSnapshot} (pure
 *   JSON); {@link import('./factories.js').createRestoredWorkflow} rebuilds an equivalent live tree.
 * - **Observable.** The owned {@link emitter} ({@link WorkflowEventMap}) fires
 *   `start` / `complete` / `fail` / `pause` / `resume` / `skip` / `stop` after the
 *   corresponding status or runtime-gate change; the emitter isolates a listener throw and
 *   routes it to its `error` handler (the `error` option); `fail` carries the failing task's
 *   {@link TaskResult}.
 * - **Structural API.** `add` / `remove` / `move` / `update` gate BEFORE
 *   delegating to {@link phases} (the manager gates the target's own existence/status/id/
 *   bounds), then emit the matching {@link WorkflowEventMap} event on success only. NATIVE,
 *   bottom-up gating (no runner-installed hook): refused outright while this workflow's own
 *   `status` is terminal; otherwise a target position must fall within the PENDING SUFFIX —
 *   the contiguous trailing run of `pending` phases — whose boundary is
 *   {@link import('./helpers.js').deriveBoundary} over the live phases' statuses. A `pending`
 *   workflow's phases are all `pending`, so the boundary is `0` and every position is
 *   naturally accepted.
 * - **Runtime lifecycle.** `pause` / `resume` / `wait` gate execution at the runner's
 *   phase/task boundaries WITHOUT touching {@link status} — `paused` is runtime-only, never
 *   persisted. `destroy` is a terminal teardown: it `stop`s every non-terminal task and
 *   phase (releasing their gates and liveness resources), aborts {@link signal}, forces the
 *   workflow `stop` override when needed, releases its parked waiter, and marks
 *   {@link destroyed} — all idempotent.
 *
 * @example
 * ```ts
 * import { definitionToSnapshot, Workflow } from '@orkestrel/workflow'
 *
 * const definition = {
 * 	id: 'release',
 * 	name: 'Release',
 * 	phases: [{ id: 'build', name: 'Build', tasks: [{ id: 'compile', name: 'Compile' }] }],
 * }
 * const workflow = new Workflow(definitionToSnapshot(definition))
 * workflow.status // 'pending'
 * workflow.phase('build')?.task('compile')?.status // 'pending'
 * workflow.snapshot().id // 'release'
 * ```
 */
export class Workflow implements WorkflowInterface {
	readonly #context: WorkflowContext
	readonly #bail: boolean
	// The EXPLICIT workflow `bail` override (`options.bail`), when one was supplied — a deliberate
	// "re-run the whole tree under THIS uniform policy" knob threaded down to each phase so it
	// overrides the phase's persisted per-phase bail. `undefined` ⇒ no override (each phase keeps its
	// own persisted policy, so an option-less restore is identical). Distinct from `#bail` (the
	// resolved default), which is ALWAYS defined.
	readonly #bailOverride: boolean | undefined
	// The `function`-task behavior registry each live task's `behavior` name resolves against ONCE at
	// construction — threaded to every Phase (and, transitively, every Task). Read at RESOLVE
	// time (construction / a later live `add`'s mint), so mutating the object passed in AFTER
	// construction changes only later mints, never tasks already resolved — do not mutate it.
	readonly #functions: WorkflowRegistry | undefined
	readonly #silence: number | undefined
	readonly #phases: PhaseManager = new PhaseManager()
	// The PUSH observation surface — owned, never inherited. The emitter isolates a
	// listener throw (routing it to the `error` handler), never the cascade.
	readonly #emitter: Emitter<WorkflowEventMap>
	// Creation / update stamps carried verbatim through a snapshot round-trip.
	readonly #created: number
	#updated: number
	// The last computed status — the baseline a recompute diffs against to detect a CHANGE.
	#status: LifecycleStatus
	// The forced status of `skip` / `stop` or vacuous completion; `undefined` ⇒ derived.
	#override: LifecycleStatus | undefined
	// This workflow's own cancellation handle (AGENTS core precedent) — `signal` fires on `destroy`.
	readonly #abort: AbortInterface
	// RUNTIME-ONLY (never persisted): whether the workflow is paused.
	#paused: boolean
	// The parked `wait()` gate while paused; `undefined` when not paused — released (resolved) by
	// `resume` / `stop` / `destroy`.
	#gate: PromiseWithResolvers<void> | undefined
	// RUNTIME-ONLY (never persisted): whether `destroy` has torn this workflow down.
	#destroyed: boolean

	constructor(snapshot: WorkflowSnapshot, options?: WorkflowOptions) {
		const captured = captureWorkflowOptions(options)
		const on = captured.on
		const bail = captured.bail
		const error = captured.error
		const phases = captured.phases
		const functions = captured.functions
		const silence = captured.silence
		this.#context = buildWorkflowContext(snapshot)
		// The snapshot carries the policy it ran under (the self-contained durable payload), so the
		// snapshot's `bail` is the source of truth; an explicit `options.bail` still wins when given.
		this.#bail = bail ?? snapshot.bail
		// The explicit override (only when supplied) — cascaded to every phase so it overrides their
		// persisted per-phase bail; omitted ⇒ each phase keeps its own persisted policy (identical restore).
		this.#bailOverride = bail
		this.#functions = functions
		this.#silence = silence
		this.#emitter = new Emitter<WorkflowEventMap>({
			...(on === undefined ? {} : { on }),
			...(error === undefined ? {} : { error }),
		})
		this.#created = snapshot.created
		this.#updated = snapshot.updated
		this.#abort = createAbort()
		this.#paused = false
		this.#gate = undefined
		this.#destroyed = false
		// Build the live phases positionally from the snapshot — each wired to recompute THIS
		// workflow on a derived-status change, carrying its own per-phase options + restore state,
		// and the workflow-level `#functions` registry, so each of its tasks resolves its `behavior`
		// name into a runtime handler ONCE at construction.
		for (const phase of snapshot.phases) {
			const phaseOptions = phases?.[phase.id]
			this.#append(phase, phaseOptions)
		}
		// Restore the override DIRECTLY from the snapshot's own field (present when whole-workflow
		// skip / stop or vacuous completion forced it) — no fragile status-divergence guess. Then
		// seed the baseline from the EFFECTIVE status so a recompute diffs against the right value.
		this.#override = snapshot.override
		this.#status = this.status
	}

	get emitter(): EmitterInterface<WorkflowEventMap> {
		return this.#emitter
	}

	get id(): string {
		return this.#context.id
	}

	get name(): string {
		return this.#context.name
	}

	// The root's identity is immutable, so the description reads straight off `#context` rather
	// than a second field that could drift from the context every `TaskResult` stamps.
	get description(): string | undefined {
		return this.#context.description
	}

	get context(): WorkflowContext {
		return this.#context
	}

	get bail(): boolean {
		return this.#bail
	}

	get paused(): boolean {
		return this.#paused
	}

	get destroyed(): boolean {
		return this.#destroyed
	}

	get signal(): AbortSignal {
		return this.#abort.signal
	}

	get status(): LifecycleStatus {
		// The override wins when forced; otherwise the status is derived from the live phases'
		// derivations — each phase's status paired with the EFFECTIVE `bail` it ran under, so the
		// failure outcome is per-phase-bail-aware (a strict phase halts even under a graceful workflow).
		return this.#override ?? deriveWorkflowStatus(this.#statuses())
	}

	get phases(): PhaseManagerInterface {
		return this.#phases
	}

	phase(id: string): PhaseInterface | undefined {
		return this.#phases.phase(id)
	}

	results(): readonly TaskResult[] {
		// The workflow tier of the result tree — every settled task's result across all phases, in
		// positional order (phases in order, each phase's task results in order).
		return collectResults(this.#phases.phases().map((phase) => phase.results()))
	}

	skip(): void {
		// `skip` FORCES the workflow to `skipped`, overriding the derived value — then
		// recompute so the change is detected and the `skip` event is emitted. IDEMPOTENT /
		// NO-OP after `status` is already terminal (a settled workflow cannot be re-forced) — but a
		// parked `wait()` waiter is ALWAYS released regardless (a terminal workflow must never hold
		// one; kept unconditional for safety even though a terminal entity holds none parked).
		if (!isTerminalStatus(this.status)) this.#force('skipped')
		this.#paused = false
		this.#release()
	}

	stop(): void {
		// `stop` FORCES the workflow to `stopped` — `stopped` IS a WorkflowEventMap
		// event, so this emit fires. NO-OP after `status` is already terminal (mirrors `skip` and
		// `destroy`'s own `if (!isTerminalStatus(...))` guard) — a settled workflow cannot be
		// re-forced. Always releases a parked `wait()` waiter (a permanently-ended
		// workflow has nothing left to pause for), even on the no-op branch, for safety.
		if (!isTerminalStatus(this.status)) this.#force('stopped')
		this.#paused = false
		this.#release()
	}

	complete(): void {
		// Forces the workflow to `completed` (overriding the derived value), reusing the same #force
		// override machinery as skip/stop. `completed` IS a WorkflowEventMap event, so the emit fires.
		// Used by the runner to settle an EXECUTED no-op tree (no work happened ⇒ vacuously done) —
		// its ONLY legitimate use, so this is a NO-OP unless `status` is still `pending` AND the
		// whole tree contains no tasks. Empty phases remain vacuous; any pending task is real work
		// and cannot be erased by a root override.
		if (
			this.status === 'pending' &&
			this.#phases.phases().every((phase) => phase.tasks.count === 0)
		) {
			this.#force('completed')
		}
	}

	pause(): void {
		// Idempotent: a no-op when already paused, terminal, or destroyed — pausing a settled or
		// torn-down workflow has nothing to suspend.
		if (this.#paused || isTerminalStatus(this.status) || this.#destroyed) return
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

	destroy(): void {
		// Idempotent terminal teardown — calling `destroy` twice never throws.
		if (this.#destroyed) return
		this.#destroyed = true
		const phases = this.#phases.phases()
		if (!isTerminalStatus(this.status)) this.stop()
		for (const phase of phases) phase.stop()
		for (const phase of phases) {
			for (const task of phase.tasks.tasks()) {
				if (!isTerminalStatus(task.status)) task.stop()
			}
		}
		this.#paused = false
		this.#release()
		this.#abort.abort()
		for (const phase of phases) {
			for (const task of phase.tasks.tasks()) task.emitter.destroy()
			phase.emitter.destroy()
		}
		this.#emitter.destroy()
	}

	wait(): Promise<void> {
		// Promise-parked, never a timer or busy-loop — resolves immediately when not
		// paused; while paused, the shared gate resolves on `resume` / `skip` / `stop` / `destroy`.
		return this.#paused && this.#gate !== undefined ? this.#gate.promise : Promise.resolve()
	}

	add(definition: PhaseDefinition, index?: number): Result<PhaseInterface, WorkflowError> {
		if (isTerminalStatus(this.status)) {
			return failure(
				new WorkflowError('MUTATION', `workflow '${this.id}' is terminal`, {
					id: this.id,
					status: this.status,
				}),
			)
		}
		const at = index ?? this.#phases.count
		if (at < this.#boundary()) {
			return failure(
				new WorkflowError('MUTATION', `workflow '${this.id}' add index precedes boundary`, {
					id: this.id,
					index: at,
				}),
			)
		}
		return this.#addTo(this.#mint(definition), index, at)
	}

	remove(id: string): Result<PhaseInterface, WorkflowError> {
		if (isTerminalStatus(this.status)) {
			return failure(
				new WorkflowError('MUTATION', `workflow '${this.id}' is terminal`, {
					id: this.id,
					status: this.status,
				}),
			)
		}
		const at = this.#indexOf(id)
		if (at === -1 || at < this.#boundary()) {
			return failure(
				new WorkflowError('MUTATION', `workflow '${this.id}' cannot remove '${id}'`, {
					id: this.id,
					phase: id,
				}),
			)
		}
		const result = this.#phases.remove(id)
		if (result.success) this.#emitter.emit('remove', result.value)
		return result
	}

	move(id: string, index: number): Result<PhaseInterface, WorkflowError> {
		if (isTerminalStatus(this.status)) {
			return failure(
				new WorkflowError('MUTATION', `workflow '${this.id}' is terminal`, {
					id: this.id,
					status: this.status,
				}),
			)
		}
		const at = this.#indexOf(id)
		const boundary = this.#boundary()
		if (at === -1 || at < boundary || index < boundary) {
			return failure(
				new WorkflowError('MUTATION', `workflow '${this.id}' cannot move '${id}'`, {
					id: this.id,
					phase: id,
					index,
				}),
			)
		}
		const result = this.#phases.move(id, index)
		if (result.success) this.#emitter.emit('move', result.value, index)
		return result
	}

	update(id: string, patch: PhaseUpdate): Result<PhaseInterface, WorkflowError> {
		if (isTerminalStatus(this.status)) {
			return failure(
				new WorkflowError('MUTATION', `workflow '${this.id}' is terminal`, {
					id: this.id,
					status: this.status,
				}),
			)
		}
		const at = this.#indexOf(id)
		if (at === -1 || at < this.#boundary()) {
			return failure(
				new WorkflowError('MUTATION', `workflow '${this.id}' cannot update '${id}'`, {
					id: this.id,
					phase: id,
				}),
			)
		}
		const result = this.#phases.update(id, patch)
		if (result.success) this.#emitter.emit('update', result.value)
		return result
	}

	snapshot(): WorkflowSnapshot {
		// Pure JSON: identity + the EFFECTIVE status + the ACTUAL override (emitted only when one is
		// in force) + the `bail` policy this tree ran under + the phases' snapshots in positional
		// order + the creation / update stamps. Persisting `override` and `bail` makes the payload
		// self-contained, so a restore reinstates the override directly and re-derives identically.
		return cloneWorkflowSnapshot({
			id: this.id,
			name: this.name,
			...(this.#context.description === undefined
				? {}
				: { description: this.#context.description }),
			status: this.status,
			...(this.#override === undefined ? {} : { override: this.#override }),
			bail: this.#bail,
			phases: this.#phases.phases().map((phase) => phase.snapshot()),
			created: this.#created,
			updated: this.#updated,
		})
	}

	// The top of the cascade: recompute the derived status after a phase change (the callback
	// wired into each Phase). Diff the new effective status against the baseline; on a CHANGE,
	// advance the baseline + the `updated` stamp, then emit the matching event. The workflow is
	// the root, so there is nothing further to escalate to.
	#recompute(): void {
		const next = this.status
		if (next === this.#status) return
		this.#status = next
		if (isTerminalStatus(next)) {
			this.#paused = false
			this.#release()
		}
		this.#updated = Math.max(Date.now(), this.#updated)
		this.#emitFor(next)
	}

	// Apply a forced status (skip / stop / vacuous complete): set the override, then recompute so
	// the change is detected + emitted (when the status maps to an event).
	#force(status: LifecycleStatus): void {
		this.#override = status
		this.#recompute()
	}

	// Emit the WorkflowEventMap event matching a newly-entered status. `running` ⇒ `start`,
	// `completed` ⇒ `complete`, `failed` ⇒ `fail` (with the failing task's result, reachable only
	// under `bail: true`), `skipped` ⇒ `skip`, `stopped` ⇒ `stop`. `pending` has no event.
	#emitFor(status: LifecycleStatus): void {
		if (status === 'running') this.#emitter.emit('start', this.id)
		else if (status === 'completed') this.#emitter.emit('complete')
		else if (status === 'failed') this.#emitter.emit('fail', this.#failure())
		else if (status === 'skipped') this.#emitter.emit('skip')
		else if (status === 'stopped') this.#emitter.emit('stop')
	}

	// Delegate an `add` to the phase manager and emit `add` (the inserted phase + its final
	// `at` index) on success — the shared tail of the hooked and un-hooked `add` branches.
	#addTo(
		phase: PhaseInterface,
		index: number | undefined,
		at: number,
	): Result<PhaseInterface, WorkflowError> {
		const result = this.#phases.add(phase, index)
		if (result.success) this.#emitter.emit('add', result.value, at)
		return result
	}

	// The positional index of the live phase `id`, or `-1` when absent — the shared lookup
	// behind the NATIVE `remove` / `move` / `update` boundary gate.
	#indexOf(id: string): number {
		return this.#phases.phases().findIndex((phase) => phase.id === id)
	}

	// The NATIVE pending-suffix boundary over the live phases' CURRENT statuses — reads
	// instance state, so it stays a method; the pure reduction itself is `deriveBoundary`.
	#boundary(): number {
		return deriveBoundary(this.#phases.phases().map((phase) => phase.status))
	}

	// The failing task's REAL recorded {@link TaskResult} — the first failed result across every
	// phase — so the `fail` event carries the true cause. A workflow derives `failed` ONLY under
	// `bail` when some task failed with a `Failure` result, so one always exists when
	// `#emitFor('failed')` calls this: assert that invariant (a programmer-error guard, mirroring
	// `Runner.#dispatch`) rather than fabricating a synthetic, lineage-degenerate result that would
	// mask the true cause while still type-checking.
	#failure(): TaskResult {
		const found = findFailure(this.results())
		if (found === undefined) {
			throw new WorkflowError(
				'INVARIANT',
				`workflow '${this.id}' derived failed with no failing task result`,
				{ workflow: this.id },
			)
		}
		return found
	}

	// Build one live phase from its snapshot, threading its per-phase options (keyed by id under
	// the workflow options) + the explicit workflow bail override (when one was supplied — it
	// overrides the phase's persisted per-phase bail) + THIS workflow's `#functions` registry
	// (so the phase's own tasks resolve their `behavior` name into a runtime handler) and wiring it
	// to recompute THIS workflow on a derived-status change.
	#append(phase: PhaseSnapshot, options: PhaseOptions | undefined): void {
		const created = new Phase(
			phase,
			this,
			() => this.#recompute(),
			options,
			this.#bailOverride,
			this.#functions,
			this.#silence,
		)
		this.#phases.append(created)
	}

	// MINT a live phase (and its tasks) from a PhaseDefinition for a live `add` — converts it to
	// an initial PhaseSnapshot (`phaseDefinitionToSnapshot`'s per-phase step, resolving effective
	// bail as `definition.bail ?? this.#bail`, carrying each task's `behavior` / `retries` / `timeout`)
	// then builds it through the Phase constructor's OWN `#functions` resolution, so a live mint and a
	// built/restored phase are wired IDENTICALLY — same recompute cascade, same emitter hooks,
	// same handler resolution.
	#mint(definition: PhaseDefinition): Phase {
		return new Phase(
			phaseDefinitionToSnapshot(definition, this.#bail),
			this,
			() => this.#recompute(),
			undefined,
			this.#bailOverride,
			this.#functions,
			this.#silence,
		)
	}

	// Resolve the parked `wait()` gate (when one exists) and clear it — the shared release step
	// behind `resume` / `stop` / `destroy` (all three always release a parked waiter).
	#release(): void {
		if (this.#gate === undefined) return
		this.#gate.resolve()
		this.#gate = undefined
	}

	// The live phases' derivations, in positional order — each phase's status paired with its
	// EFFECTIVE `bail` (phase override or the workflow default) — the input to
	// `deriveWorkflowStatus` (per-phase-bail-aware).
	#statuses(): readonly PhaseDerivation[] {
		return this.#phases.phases().map((phase) => ({ status: phase.status, bail: phase.bail }))
	}
}
