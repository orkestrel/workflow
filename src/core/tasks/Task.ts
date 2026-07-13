import type { EmitterInterface } from '@orkestrel/emitter'
import type {
	PhaseInterface,
	TaskContext,
	TaskEventMap,
	TaskInterface,
	TaskOptions,
	TaskResult,
	TaskSnapshot,
	TaskStatus,
	WorkflowInterface,
} from '../types.js'
import { Emitter } from '@orkestrel/emitter'
import { WorkflowError } from '../errors.js'
import { canTransitionTask } from '../helpers.js'

/**
 * The live leaf state machine (W-b) for one task — an observable (AGENTS §13), guarded
 * synchronous task whose explicit {@link TaskStatus} advances through the AGENTS §10
 * transitions, recording a {@link TaskResult} on a terminal outcome.
 *
 * @remarks
 * - **Guarded transitions (AGENTS §10).** `start` (→ `running`), then `complete(value)`
 *   (→ `completed`, records a {@link import('@orkestrel/contract').Success}), `fail(error)`
 *   (→ `failed`, records a {@link import('@orkestrel/contract').Failure}), `skip` (→ `skipped`),
 *   `stop` (→ `stopped`). Each consults {@link canTransitionTask} FIRST and throws a
 *   `TRANSITION` {@link WorkflowError} on an illegal move (e.g. completing a non-`running`
 *   task) — the legal graph is the single source of truth, so the leaf can never reach an
 *   impossible state.
 * - **Override (snapshot fidelity).** `skip` / `stop` set `#override` to the forced terminal
 *   status, so a RESTORE can tell a forced leaf (`skipped` / `stopped`) from a run-produced
 *   one and reinstate it AS an override — preserving the round-trip.
 * - **The cascade.** Every status change records its boxed result (when any), fires the leaf's
 *   OWN event, THEN calls the parent phase's `#recompute` (injected at construction) so the
 *   transition propagates UP (Task → Phase → Workflow re-derive). The own-event-before-cascade
 *   order means an observer sees the CAUSE (this leaf changed) before the EFFECT (the parents
 *   re-derive) — the project precedent (`Runner.#settle` emits its own `fail` before propagating).
 * - **Observable (AGENTS §13).** The owned {@link emitter} ({@link TaskEventMap}) fires the
 *   matching event strictly AFTER the state change, BEFORE the cascade; the emitter isolates
 *   a listener throw and routes it to its `error` handler (the `error` option), so a buggy
 *   observer can never corrupt a transition.
 */
export class Task implements TaskInterface {
	readonly #context: TaskContext
	readonly #phase: PhaseInterface
	readonly #workflow: WorkflowInterface
	// Propagate a status change UP to the parent phase (which re-derives, then escalates to the
	// workflow) — injected by the parent so the leaf needs no back-reference plumbing of its own.
	readonly #recompute: () => void
	readonly #metadata: Readonly<Record<string, unknown>>
	// The PUSH observation surface (§13) — owned, never inherited. The emitter isolates a
	// listener throw (routing it to the `error` handler), so it can never escape into a
	// transition or the cascade.
	readonly #emitter: Emitter<TaskEventMap>
	#status: TaskStatus
	// The recorded outcome once the task settled with one (`completed` / `failed`), else undefined.
	#result: TaskResult | undefined

	constructor(
		context: TaskContext,
		phase: PhaseInterface,
		workflow: WorkflowInterface,
		recompute: () => void,
		options?: TaskOptions,
		status: TaskStatus = 'pending',
		result?: TaskResult,
	) {
		this.#context = context
		this.#phase = phase
		this.#workflow = workflow
		this.#recompute = recompute
		this.#metadata = options?.metadata ?? {}
		this.#emitter = new Emitter<TaskEventMap>({ on: options?.on, error: options?.error })
		this.#status = status
		// A RESTORE seeds the recorded outcome (present for a `completed` / `failed` leaf), so
		// the result tree round-trips; a fresh leaf starts with none. A leaf's terminal status
		// (`skipped` / `stopped`) already encodes a forced state, so the leaf needs no separate
		// override field — the override round-trip lives on the DERIVED Phase / Workflow nodes.
		this.#result = result
	}

	get emitter(): EmitterInterface<TaskEventMap> {
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

	get context(): TaskContext {
		return this.#context
	}

	get phase(): PhaseInterface {
		return this.#phase
	}

	get workflow(): WorkflowInterface {
		return this.#workflow
	}

	get status(): TaskStatus {
		return this.#status
	}

	get result(): TaskResult | undefined {
		return this.#result
	}

	start(): void {
		this.#transition('running')
		// Own event FIRST, THEN the cascade — an observer sees the cause (this task started) before
		// the effect (the phase / workflow re-derive), mirroring `Runner.#settle` (AGENTS §13).
		this.#emitter.emit('start', this.id)
		this.#escalate()
	}

	complete(value: unknown): void {
		this.#transition('completed')
		// Box the produced value as a Success (an inline `Result` branch, the codebase idiom) and
		// RECORD it BEFORE escalating, so the parents' `results()` already see it when the cascade
		// re-derives. Then observe the leaf's own `complete` FIRST, and escalate the cascade LAST —
		// so the leaf's own event fires before any parent's cascade event (cause before effect).
		const result = this.#record('completed', { success: true, value })
		this.#emitter.emit('complete', result)
		this.#escalate()
	}

	fail(error: unknown): void {
		this.#transition('failed')
		// Box the reason as a Failure — normalise a non-`Error` to an `Error` (preserving the
		// original as `cause`), matching the Queue's `#attempt` and the `TaskResult.result`
		// `Result<unknown>` (= `Result<unknown, Error>`) shape. Record BEFORE escalating (so a
		// parent's `results()` / `#failure()` sees it), observe the leaf's own `fail` FIRST, then
		// escalate the cascade LAST (a failed leaf may flip the phase / workflow to `failed` under
		// `bail` — the listener still sees cause before effect).
		const reason = error instanceof Error ? error : new Error(String(error), { cause: error })
		const result = this.#record('failed', { success: false, error: reason })
		this.#emitter.emit('fail', result)
		this.#escalate()
	}

	skip(): void {
		// `skip` (AGENTS §10) moves a `pending` / `running` task to the terminal `skipped` state —
		// the status itself records the forced terminal (no boxed outcome: a skip produced none).
		// Own event FIRST, THEN the cascade (cause before effect).
		this.#transition('skipped')
		this.#emitter.emit('skip')
		this.#escalate()
	}

	stop(): void {
		// `stop` (AGENTS §10) moves a `pending` / `running` task to the terminal `stopped` state —
		// same discipline as `skip`; a stop likewise produced no boxed outcome. Own event FIRST,
		// THEN the cascade.
		this.#transition('stopped')
		this.#emitter.emit('stop')
		this.#escalate()
	}

	snapshot(): TaskSnapshot {
		// Pure JSON: identity + status + the recorded result + the open metadata bag. The leaf's
		// status IS its forced-terminal marker (`skipped` / `stopped`), so restore reinstates the
		// leaf from `status` directly — no separate override field is needed at the leaf.
		return {
			id: this.id,
			name: this.name,
			...(this.description === undefined ? {} : { description: this.description }),
			status: this.#status,
			...(this.#result === undefined ? {} : { result: this.#result }),
			metadata: this.#metadata,
		}
	}

	// Guard then apply one status move: reject an illegal transition with a `TRANSITION` error
	// (naming the offending current status + requested target), else set the new status. The
	// cascade is NOT run here — every caller records its boxed result (when any) FIRST, notifies
	// its OWN event SECOND, then escalates LAST, so an observer sees cause (this leaf changed)
	// before effect (the parents re-derive). See `start` / `complete` / `fail` / `skip` / `stop`.
	#transition(to: TaskStatus): void {
		if (!canTransitionTask(this.#status, to)) {
			throw new WorkflowError(
				'TRANSITION',
				`task '${this.id}' cannot transition from '${this.#status}' to '${to}'`,
				{ task: this.id, from: this.#status, to },
			)
		}
		this.#status = to
	}

	// Build the lineage-stamped {@link TaskResult} for a terminal outcome, store it as `#result`,
	// and return it. The boxed `result` is present only for `completed` / `failed`.
	#record(status: TaskStatus, result: TaskResult['result']): TaskResult {
		const record: TaskResult = {
			task: this.#context,
			phase: this.#context.phase,
			workflow: this.#context.phase.workflow,
			status,
			...(result === undefined ? {} : { result }),
			timestamp: Date.now(),
		}
		this.#result = record
		return record
	}

	// Notify the parent phase that this leaf changed, so it re-derives and escalates to the
	// workflow — the single upward step of the cascade.
	#escalate(): void {
		this.#recompute()
	}
}
