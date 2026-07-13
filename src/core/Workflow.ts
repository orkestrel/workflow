import type { EmitterInterface } from '@orkestrel/emitter'
import type {
	PhaseDerivation,
	PhaseInterface,
	PhaseManagerInterface,
	PhaseSnapshot,
	TaskResult,
	WorkflowContext,
	WorkflowEventMap,
	WorkflowInterface,
	WorkflowOptions,
	WorkflowSnapshot,
	WorkflowStatus,
} from './types.js'
import { Emitter } from '@orkestrel/emitter'
import { buildWorkflowContext, collectResults, deriveWorkflowStatus } from './helpers.js'
import { Phase } from './phases/Phase.js'
import { PhaseManager } from './phases/PhaseManager.js'

/**
 * The live DERIVED state machine (W-b) for a whole workflow — the observable (AGENTS §13)
 * ROOT whose {@link WorkflowStatus} is computed from its phases under the `bail` policy and
 * recomputed reactively as the cascade propagates up from a task transition.
 *
 * @remarks
 * - **Construction.** Built from a {@link WorkflowSnapshot} (the unified input —
 *   {@link import('./factories.js').createWorkflow} seeds an initial snapshot from a
 *   {@link import('./types.js').WorkflowDefinition}, {@link import('./factories.js').restoreWorkflow}
 *   passes a persisted one). Each child {@link Phase} is wired to escalate to {@link #recompute}.
 * - **Derived status.** `status` is `#override` when forced, else
 *   {@link deriveWorkflowStatus} over the live phases' statuses feeding `bail`. `failed` is
 *   reachable ONLY under `bail: true` (a single failed task halts the workflow); under
 *   `bail: false` a failed phase folds into `completed`. {@link #recompute} diffs on each phase
 *   change; a CHANGE emits.
 * - **Override (AGENTS §10).** `skip` / `stop` FORCE the status; the override is PERSISTED in the
 *   snapshot's own `override` field and restored DIRECTLY (no divergence guess). The snapshot also
 *   persists `bail`, so a restore re-derives status identically without a silent policy default.
 * - **Result tree.** `results()` flattens every phase's `results()` ({@link collectResults}) — the
 *   workflow tier; `phase(id)` + each `phase.task(id)` navigate DOWN, a task's `phase` / `workflow`
 *   navigate UP.
 * - **Snapshot.** `snapshot()` serializes the whole live tree to a {@link WorkflowSnapshot} (pure
 *   JSON); {@link import('./factories.js').restoreWorkflow} rebuilds an equivalent live tree.
 * - **Observable (AGENTS §13).** The owned {@link emitter} ({@link WorkflowEventMap}) fires
 *   `start` / `complete` / `fail` / `stop` on a derived-status CHANGE; the emitter isolates a
 *   listener throw and routes it to its `error` handler (the `error` option); `fail` carries
 *   the failing task's {@link TaskResult}.
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
	readonly #phases: PhaseManager = new PhaseManager()
	// The PUSH observation surface (§13) — owned, never inherited. The emitter isolates a
	// listener throw (routing it to the `error` handler), never the cascade.
	readonly #emitter: Emitter<WorkflowEventMap>
	// Creation / update stamps carried verbatim through a snapshot round-trip.
	readonly #created: number
	#updated: number
	// The last computed status — the baseline a recompute diffs against to detect a CHANGE.
	#status: WorkflowStatus
	// The forced status of a `skip` / `stop`, overriding the derived value; `undefined` ⇒ derived.
	#override: WorkflowStatus | undefined

	constructor(snapshot: WorkflowSnapshot, options?: WorkflowOptions) {
		this.#context = buildWorkflowContext(snapshot)
		// The snapshot carries the policy it ran under (the self-contained durable payload), so the
		// snapshot's `bail` is the source of truth; an explicit `options.bail` still wins when given.
		this.#bail = options?.bail ?? snapshot.bail
		// The explicit override (only when supplied) — cascaded to every phase so it overrides their
		// persisted per-phase bail; omitted ⇒ each phase keeps its own persisted policy (identical restore).
		this.#bailOverride = options?.bail
		this.#emitter = new Emitter<WorkflowEventMap>({ on: options?.on, error: options?.error })
		this.#created = snapshot.created
		this.#updated = snapshot.updated
		// Build the live phases positionally from the snapshot — each wired to recompute THIS
		// workflow on a derived-status change, carrying its own per-phase options + restore state.
		for (const phase of snapshot.phases) this.#append(phase, options)
		// Restore the override DIRECTLY from the snapshot's own field (present only when a whole-
		// workflow skip / stop forced it) — no fragile status-divergence guess. Then seed the
		// baseline from the EFFECTIVE status so a recompute diffs against the right value.
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

	get description(): string | undefined {
		return this.#context.description
	}

	get context(): WorkflowContext {
		return this.#context
	}

	get bail(): boolean {
		return this.#bail
	}

	get status(): WorkflowStatus {
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
		// `skip` (AGENTS §10) FORCES the workflow to `skipped`, overriding the derived value — then
		// recompute so the change is detected (no WorkflowEventMap event for a skip).
		this.#force('skipped')
	}

	stop(): void {
		// `stop` (AGENTS §10) FORCES the workflow to `stopped` — `stopped` IS a WorkflowEventMap
		// event, so this emit fires.
		this.#force('stopped')
	}

	complete(): void {
		// Forces the workflow to `completed` (overriding the derived value), reusing the same #force
		// override machinery as skip/stop. `completed` IS a WorkflowEventMap event, so the emit fires.
		// Used by the runner to settle an EXECUTED no-op tree (no work happened ⇒ vacuously done).
		this.#force('completed')
	}

	snapshot(): WorkflowSnapshot {
		// Pure JSON: identity + the EFFECTIVE status + the ACTUAL override (emitted only when one is
		// in force) + the `bail` policy this tree ran under + the phases' snapshots in positional
		// order + the creation / update stamps. Persisting `override` and `bail` makes the payload
		// self-contained, so a restore reinstates the override directly and re-derives identically.
		return {
			id: this.id,
			name: this.name,
			...(this.description === undefined ? {} : { description: this.description }),
			status: this.status,
			...(this.#override === undefined ? {} : { override: this.#override }),
			bail: this.#bail,
			phases: this.#phases.phases().map((phase) => phase.snapshot()),
			created: this.#created,
			updated: this.#updated,
		}
	}

	// The top of the cascade: recompute the derived status after a phase change (the callback
	// wired into each Phase). Diff the new effective status against the baseline; on a CHANGE,
	// advance the baseline + the `updated` stamp, then emit the matching event. The workflow is
	// the root, so there is nothing further to escalate to.
	#recompute(): void {
		const next = this.status
		if (next === this.#status) return
		this.#status = next
		this.#updated = Date.now()
		this.#emitFor(next)
	}

	// Apply a forced status (skip / stop): set the override, then recompute so the change is
	// detected + emitted (when the status maps to an event).
	#force(status: WorkflowStatus): void {
		this.#override = status
		this.#recompute()
	}

	// Emit the WorkflowEventMap event matching a newly-entered status. `running` ⇒ `start`,
	// `completed` ⇒ `complete`, `failed` ⇒ `fail` (with the failing task's result, reachable only
	// under `bail: true`), `stopped` ⇒ `stop`. `pending` / `skipped` have no event.
	#emitFor(status: WorkflowStatus): void {
		if (status === 'running') this.#emitter.emit('start', this.id)
		else if (status === 'completed') this.#emitter.emit('complete')
		else if (status === 'failed') this.#emitter.emit('fail', this.#failure())
		else if (status === 'stopped') this.#emitter.emit('stop')
	}

	// The failing task's REAL recorded {@link TaskResult} — the first failed result across every
	// phase — so the `fail` event carries the true cause. A workflow derives `failed` ONLY under
	// `bail` when some task failed with a `Failure` result, so one always exists when
	// `#emitFor('failed')` calls this: assert that invariant (§12 programmer-error guard, mirroring
	// `Runner.#dispatch`) rather than fabricating a synthetic, lineage-degenerate result that would
	// mask the true cause while still type-checking.
	#failure(): TaskResult {
		for (const result of this.results()) {
			if (result.result?.success === false) return result
		}
		throw new Error(`workflow '${this.id}' derived failed with no failing task result`)
	}

	// Build one live phase from its snapshot, threading its per-phase options (keyed by id under
	// the workflow options) + the explicit workflow bail override (when one was supplied — it
	// overrides the phase's persisted per-phase bail) and wiring it to recompute THIS workflow on a
	// derived-status change.
	#append(phase: PhaseSnapshot, options: WorkflowOptions | undefined): void {
		const created = new Phase(
			phase,
			this,
			() => this.#recompute(),
			options?.phases?.[phase.id],
			this.#bailOverride,
		)
		this.#phases.append(created)
	}

	// The live phases' derivations, in positional order — each phase's status paired with its
	// EFFECTIVE `bail` (phase override or the workflow default) — the input to
	// `deriveWorkflowStatus` (per-phase-bail-aware).
	#statuses(): readonly PhaseDerivation[] {
		return this.#phases.phases().map((phase) => ({ status: phase.status, bail: phase.bail }))
	}
}
