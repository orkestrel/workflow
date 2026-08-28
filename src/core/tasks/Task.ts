import type { AbortInterface } from '@orkestrel/abort'
import type { JSONRecord, JSONValue, Result } from '@orkestrel/contract'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { TimeoutInterface } from '@orkestrel/timeout'
import type {
	DeferredInterface,
	PhaseInterface,
	TaskActivity,
	TaskActivityInput,
	TaskContext,
	TaskEventMap,
	TaskFailure,
	TaskInterface,
	TaskOptions,
	TaskResult,
	TaskSnapshot,
	TaskStatus,
	TaskUpdate,
	WorkflowFunction,
	WorkflowInterface,
} from '../types.js'
import { createAbort } from '@orkestrel/abort'
import { cloneJSONRecord, cloneJSONValue, isContractError } from '@orkestrel/contract'
import { Emitter } from '@orkestrel/emitter'
import { createTimeout } from '@orkestrel/timeout'
import { cloneTaskActivity } from '../cloners.js'
import { WorkflowError } from '../errors.js'
import {
	buildTaskContext,
	canTransitionTask,
	createDeferred,
	failure,
	resolveTaskSilence,
	success,
} from '../helpers.js'

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
 * - **Snapshot fidelity.** A leaf needs no override: `skipped` / `stopped` are explicit terminal
 *   statuses, and restore reinstates the leaf directly from {@link TaskSnapshot.status}.
 * - **The cascade.** Every status change records its boxed result (when any), fires the leaf's
 *   OWN event, THEN calls the parent phase's `#recompute` (injected at construction) so the
 *   transition propagates UP (Task → Phase → Workflow re-derive). The own-event-before-cascade
 *   order means an observer sees the CAUSE (this leaf changed) before the EFFECT (the parents
 *   re-derive) — the project precedent (`Runner.#settle` emits its own `fail` before propagating).
 * - **Observable (AGENTS §13).** The owned {@link emitter} ({@link TaskEventMap}) fires the
 *   matching event strictly AFTER the state change, BEFORE the cascade; the emitter isolates
 *   a listener throw and routes it to its `error` handler (the `error` option), so a buggy
 *   observer can never corrupt a transition.
 * - **Declarative config (AGENTS §12).** `run` / `retries` / `timeout` PERSIST in a
 *   {@link TaskSnapshot} (like a phase's `bail` / `concurrency`), carried verbatim from the
 *   matching {@link import('../types.js').TaskDefinition} / {@link TaskSnapshot} field. `handler`
 *   is the RUNTIME-ONLY counterpart — `run` resolved ONCE at construction against the
 *   workflow-level {@link import('../types.js').WorkflowOptions.functions} registry — and is
 *   NEVER persisted; `undefined` when `run` is omitted or unregistered. Only omission is a
 *   deliberate no-op; unresolved named work is rejected before dispatch.
 */
export class Task implements TaskInterface {
	declare readonly description?: string
	readonly #context: TaskContext
	readonly #phase: PhaseInterface
	readonly #workflow: WorkflowInterface
	// Propagate a status change UP to the parent phase (which re-derives, then escalates to the
	// workflow) — injected by the parent so the leaf needs no back-reference plumbing of its own.
	readonly #recompute: () => void
	readonly #metadata: JSONRecord
	// The PUSH observation surface (§13) — owned, never inherited. The emitter isolates a
	// listener throw (routing it to the `error` handler), so it can never escape into a
	// transition or the cascade.
	readonly #emitter: Emitter<TaskEventMap>
	#status: TaskStatus
	// The recorded outcome once the task settled with one (`completed` / `failed`), else undefined.
	#result: TaskResult | undefined
	// `name` / `description` seed from `#context` but live as independent fields (AGENTS §12) so
	// `patch` can rename SELF without mutating the immutable lineage `#context` a `TaskResult`
	// stamps.
	#name: string
	// PERSISTED declarative config, carried verbatim from the TaskDefinition / TaskSnapshot.
	readonly #run: string | undefined
	readonly #retries: number | undefined
	readonly #timeout: number | undefined
	#attempts: number
	// RUNTIME-ONLY (never persisted): `run` resolved ONCE at construction against the
	// workflow-level functions registry; `undefined` when `run` is omitted or unregistered.
	readonly #handler: WorkflowFunction | undefined
	readonly #abort: AbortInterface
	readonly #silence: number | undefined
	readonly #onSilence: () => void
	readonly #liveness: TimeoutInterface | undefined
	#activity: TaskActivity | undefined
	#paused: boolean
	#gate: DeferredInterface<void> | undefined
	#timerSignal: AbortSignal | undefined

	constructor(
		context: TaskContext,
		phase: PhaseInterface,
		workflow: WorkflowInterface,
		recompute: () => void,
		options?: TaskOptions,
		status: TaskStatus = 'pending',
		result?: TaskResult,
		run?: string,
		retries?: number,
		timeout?: number,
		metadata: JSONRecord = {},
		attempts = 0,
		activity?: TaskActivity,
		handler?: WorkflowFunction,
		silence?: number,
	) {
		this.#context = buildTaskContext(context.phase, context)
		this.#phase = phase
		this.#workflow = workflow
		this.#recompute = recompute
		try {
			const metadataOption = options?.metadata
			this.#metadata = cloneJSONRecord(metadataOption ?? metadata)
		} catch (error) {
			if (isContractError(error)) {
				throw new WorkflowError(
					'RESTORE',
					`task '${context.id}' metadata could not be read safely: ${error.message}`,
					{ task: context.id },
				)
			}
			throw new WorkflowError('RESTORE', `task '${context.id}' metadata could not be read safely`, {
				task: context.id,
			})
		}
		const on = options?.on
		const listenerError = options?.error
		const silenceOption = options?.silence
		this.#emitter = new Emitter<TaskEventMap>({
			...(on === undefined ? {} : { on }),
			...(listenerError === undefined ? {} : { error: listenerError }),
		})
		this.#status = status
		// A RESTORE seeds the recorded outcome (present for a `completed` / `failed` leaf), so
		// the result tree round-trips; a fresh leaf starts with none. A leaf's terminal status
		// (`skipped` / `stopped`) already encodes a forced state, so the leaf needs no separate
		// override field — the override round-trip lives on the DERIVED Phase / Workflow nodes.
		this.#result = result
		this.#name = context.name
		if (context.description !== undefined) {
			Object.defineProperty(this, 'description', {
				configurable: true,
				value: context.description,
			})
		}
		// Carried verbatim from the TaskDefinition / TaskSnapshot (declarative, persisted).
		this.#run = run
		this.#retries = retries
		this.#timeout = timeout
		this.#attempts = attempts
		// Resolved ONCE by the caller (Phase) against the functions registry; stored as-is.
		this.#handler = handler
		this.#abort = createAbort()
		this.#silence = resolveTaskSilence(silenceOption, silence)
		this.#onSilence = this.#expire.bind(this)
		this.#liveness =
			this.#silence === undefined
				? undefined
				: createTimeout({ ms: this.#silence, signal: this.#abort.signal })
		this.#activity = activity === undefined ? undefined : cloneTaskActivity(activity)
		this.#paused = false
		this.#gate = undefined
		this.#timerSignal = undefined
	}

	get emitter(): EmitterInterface<TaskEventMap> {
		return this.#emitter
	}

	get id(): string {
		return this.#context.id
	}

	get name(): string {
		return this.#name
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

	get attempts(): number {
		return this.#attempts
	}

	get run(): string | undefined {
		return this.#run
	}

	get handler(): WorkflowFunction | undefined {
		return this.#handler
	}

	get retries(): number | undefined {
		return this.#retries
	}

	get timeout(): number | undefined {
		return this.#timeout
	}

	get activity(): TaskActivity | undefined {
		return this.#activity
	}

	get silence(): number | undefined {
		return this.#silence
	}

	get silent(): boolean {
		return this.#status === 'running' && this.#liveness?.expired === true
	}

	get paused(): boolean {
		return this.#paused
	}

	get signal(): AbortSignal {
		return this.#abort.signal
	}

	start(): void {
		const budget = Math.max(0, this.#retries ?? 0) + 1
		if ((this.#status !== 'pending' && this.#status !== 'running') || this.#attempts >= budget) {
			throw new WorkflowError('TRANSITION', `task '${this.id}' cannot start another attempt`, {
				task: this.id,
				status: this.#status,
				attempts: this.#attempts,
				budget,
			})
		}
		if (this.#status === 'pending') this.#transition('running')
		this.#attempts += 1
		this.#activity = cloneTaskActivity({}, this.#stamp())
		this.#arm()
		// Own event FIRST, THEN the cascade — an observer sees the cause (this task started) before
		// the effect (the phase / workflow re-derive), mirroring `Runner.#settle` (AGENTS §13).
		this.#emitter.emit('start', this.id)
		this.#recompute()
	}

	complete(value: JSONValue): void {
		let owned: JSONValue
		try {
			owned = cloneJSONValue(value)
		} catch (error) {
			if (isContractError(error)) {
				throw new WorkflowError(
					'RESTORE',
					`task '${this.id}' result could not be read safely: ${error.message}`,
					{ task: this.id },
				)
			}
			throw new WorkflowError('RESTORE', `task '${this.id}' result could not be read safely`, {
				task: this.id,
			})
		}
		this.#transition('completed')
		this.#finish()
		// Box the produced value as a Success (an inline `Result` branch, the codebase idiom) and
		// RECORD it BEFORE escalating, so the parents' `results()` already see it when the cascade
		// re-derives. Then observe the leaf's own `complete` FIRST, and escalate the cascade LAST —
		// so the leaf's own event fires before any parent's cascade event (cause before effect).
		const result = this.#record('completed', Object.freeze({ success: true, value: owned }))
		this.#emitter.emit('complete', result)
		this.#recompute()
	}

	fail(error: TaskFailure): void {
		// Normalize into the persisted JSON contract before transitioning. Record before escalating
		// so parent result reads already see the terminal outcome.
		const origin =
			error.origin === 'handler' || error.origin === 'timeout' || error.origin === 'recovery'
				? error.origin
				: 'handler'
		const message =
			typeof error.message === 'string' && error.message.length > 0
				? error.message
				: 'unknown failure'
		this.#transition('failed')
		this.#finish()
		const result = this.#record(
			'failed',
			Object.freeze({
				success: false,
				error: Object.freeze({ origin, message }),
			}),
		)
		this.#emitter.emit('fail', result)
		this.#recompute()
	}

	skip(): void {
		// `skip` (AGENTS §10) moves a `pending` / `running` task to the terminal `skipped` state —
		// the status itself records the forced terminal (no boxed outcome: a skip produced none).
		// Own event FIRST, THEN the cascade (cause before effect).
		this.#transition('skipped')
		this.#finish()
		this.#abort.abort()
		this.#emitter.emit('skip')
		this.#recompute()
	}

	stop(): void {
		// `stop` (AGENTS §10) moves a `pending` / `running` task to the terminal `stopped` state —
		// same discipline as `skip`; a stop likewise produced no boxed outcome. Own event FIRST,
		// THEN the cascade.
		this.#transition('stopped')
		this.#finish()
		this.#abort.abort()
		this.#emitter.emit('stop')
		this.#recompute()
	}

	report(input: TaskActivityInput): Result<TaskActivity, WorkflowError> {
		if (this.#status !== 'running') {
			return failure(
				new WorkflowError('TRANSITION', `task '${this.id}' cannot report while '${this.#status}'`, {
					task: this.id,
					status: this.#status,
				}),
			)
		}
		try {
			const activity = cloneTaskActivity(input, this.#stamp())
			this.#activity = activity
			this.#arm()
			this.#emitter.emit('report', activity)
			return success(activity)
		} catch (error) {
			return failure(
				error instanceof WorkflowError
					? error
					: new WorkflowError('MUTATION', 'task activity report was refused', {
							task: this.id,
						}),
			)
		}
	}

	pulse(): boolean {
		if (this.#status !== 'running' || this.#activity === undefined) return false
		this.#touch()
		this.#arm()
		const activity = this.#activity
		this.#emitter.emit('pulse', activity)
		return true
	}

	pause(): void {
		if (this.#paused || (this.#status !== 'pending' && this.#status !== 'running')) return
		this.#paused = true
		this.#gate = createDeferred<void>()
		this.#emitter.emit('pause')
	}

	resume(): void {
		if (!this.#paused) return
		this.#paused = false
		this.#release()
		this.#emitter.emit('resume')
	}

	wait(): Promise<void> {
		return this.#paused && this.#gate !== undefined ? this.#gate.promise : Promise.resolve()
	}

	/**
	 * Apply a validated declarative patch to SELF (`name` / `description`).
	 *
	 * @remarks
	 * Defense-in-depth (AGENTS §12): the owning
	 * {@link import('../types.js').TaskManagerInterface.update} gates FIRST (target
	 * exists + `pending`), so this is the second, redundant check — it THROWS a
	 * `MUTATION` {@link WorkflowError} unless this task's own `status` is `pending`.
	 *
	 * @param value - The {@link TaskUpdate} fields to apply
	 * @example
	 * ```ts
	 * task.patch({ name: 'Renamed task' })
	 * ```
	 */
	patch(value: TaskUpdate): void {
		if (this.#status !== 'pending') {
			throw new WorkflowError(
				'MUTATION',
				`task '${this.id}' cannot be patched while '${this.#status}'`,
				{ task: this.id, status: this.#status },
			)
		}
		if (value.name !== undefined) this.#name = value.name
		if (value.description !== undefined) {
			Object.defineProperty(this, 'description', {
				configurable: true,
				value: value.description,
			})
		}
	}

	snapshot(): TaskSnapshot {
		// Pure JSON: identity + status + the recorded result + the open metadata bag + the
		// declarative run/retries/timeout config (like a phase's bail/concurrency). The leaf's
		// status IS its forced-terminal marker (`skipped` / `stopped`), so restore reinstates the
		// leaf from `status` directly — no separate override field is needed at the leaf.
		return {
			id: this.id,
			name: this.name,
			...(this.description === undefined ? {} : { description: this.description }),
			status: this.#status,
			...(this.#result === undefined ? {} : { result: this.#result }),
			metadata: this.#metadata,
			attempts: this.#attempts,
			...(this.#run === undefined ? {} : { run: this.#run }),
			...(this.#retries === undefined ? {} : { retries: this.#retries }),
			...(this.#timeout === undefined ? {} : { timeout: this.#timeout }),
			...(this.#activity === undefined ? {} : { activity: this.#activity }),
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
		const frozen = Object.freeze(record)
		this.#result = frozen
		return frozen
	}

	#touch(): void {
		if (this.#activity === undefined) return
		this.#activity = Object.freeze({
			...this.#activity,
			updated: this.#stamp(),
		})
	}

	#stamp(): number {
		return Math.max(Date.now(), this.#activity?.updated ?? 0)
	}

	#finish(): void {
		this.#clear()
		this.#paused = false
		this.#release()
	}

	#arm(): void {
		this.#clear()
		const liveness = this.#liveness
		if (liveness === undefined || this.#status !== 'running') return
		liveness.start()
		const signal = liveness.signal
		this.#timerSignal = signal
		signal.addEventListener('abort', this.#onSilence, { once: true })
	}

	#clear(): void {
		const signal = this.#timerSignal
		if (signal !== undefined) signal.removeEventListener('abort', this.#onSilence)
		this.#timerSignal = undefined
		this.#liveness?.clear()
	}

	#expire(): void {
		this.#timerSignal = undefined
		if (this.#status !== 'running' || this.#liveness?.expired !== true) return
		this.#emitter.emit('silence')
	}

	#release(): void {
		if (this.#gate === undefined) return
		this.#gate.resolve()
		this.#gate = undefined
	}
}
