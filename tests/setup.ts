import type { BudgetInterface, TokenUsage } from '@orkestrel/budget'
import type { EmitterInterface, EventMap } from '@orkestrel/emitter'
import type { RecorderInterface } from '@orkestrel/test'
import type {
	SchedulerInterface,
	SchedulerOptions,
	TaskInterface,
	TaskResult,
	TaskSnapshot,
	WorkflowDefinition,
	WorkflowFunction,
	WorkflowInterface,
	WorkflowSnapshot,
	WorkflowStoreInterface,
} from '@src/core'
import { createRecorder } from '@orkestrel/test'
import { createScheduler, createWorkflowRunner, TaskController } from '@src/core'

/** Shared invalid task activity frames used by cloner and guard boundary tests. */
export const INVALID_TASK_ACTIVITIES: ReadonlyArray<readonly [input: unknown]> = Object.freeze([
	[{ note: '' }],
	[{ progress: { current: Number.NaN } }],
	[{ progress: { current: -1 } }],
	[{ progress: { current: 2, total: 1 } }],
	[{ progress: { current: 1, unit: '' } }],
	[{ operations: [{ id: '', name: 'Operation', started: 0 }] }],
	[{ operations: [{ id: 'operation', name: '', started: 0 }] }],
	[{ operations: [{ id: 'operation', name: 'Operation', started: Number.POSITIVE_INFINITY }] }],
	[
		{
			constraints: [
				{ id: 'same', name: 'One', started: 0 },
				{ id: 'same', name: 'Two', started: 1 },
			],
		},
	],
])

/** Copy a task snapshot while omitting its exact-optional activity field. */
export function omitTaskActivity(snapshot: TaskSnapshot): TaskSnapshot {
	return {
		id: snapshot.id,
		name: snapshot.name,
		...(snapshot.description === undefined ? {} : { description: snapshot.description }),
		status: snapshot.status,
		...(snapshot.result === undefined ? {} : { result: snapshot.result }),
		metadata: snapshot.metadata,
		attempts: snapshot.attempts,
		...(snapshot.run === undefined ? {} : { run: snapshot.run }),
		...(snapshot.retries === undefined ? {} : { retries: snapshot.retries }),
		...(snapshot.timeout === undefined ? {} : { timeout: snapshot.timeout }),
	}
}

// ── Environment-agnostic base setup (AGENTS §16.1) ────────────────────────────
//
// Loaded first by every test project (`vite.config.ts` `setupFiles[0]`). Holds ONLY
// helpers with no `node:*` / DOM dependency, so it is safe for `src:core`,
// `src:browser`, and `src:server` alike. Environment-specific helpers live in their
// own matching setup file (`setupBrowser.ts`, `setupServer.ts`).

/** Resolve a required live task fixture or throw a fixture-construction error. */
export function requireTask(
	workflow: WorkflowInterface,
	phase: string,
	task: string,
): TaskInterface {
	const found = workflow.phase(phase)?.task(task)
	if (found === undefined) throw new Error(`expected task '${phase}/${task}'`)
	return found
}

/** Build a real TaskController over a live task for direct handle tests. */
export function createTaskControllerFixture(
	task: TaskInterface,
	signal: AbortSignal,
	results: () => readonly TaskResult[],
): TaskController {
	return new TaskController(
		signal,
		task.snapshot().metadata,
		task,
		task.attempts,
		results,
		(input) => task.report(input),
		() => task.pulse(),
	)
}

/**
 * Copy a value through `JSON.stringify` / `JSON.parse`, preserving its type.
 *
 * Local rather than `@orkestrel/test`'s: the published `roundTripJSON` constrains its
 * argument to `JSONValue`, whose object arm needs an index signature. TypeScript grants
 * one to a type alias and never to an `interface`, so a `WorkflowSnapshot` — an interface,
 * as `AGENTS.md` requires of a public type — cannot satisfy it. Adopt the published helper
 * once that constraint is lifted.
 *
 * @typeParam T - The value's type, preserved across the clone
 * @param value - The (JSON-serializable) value to round-trip
 * @returns A structurally identical deep clone of `value`
 */
export function roundTripJSON<T>(value: T): T {
	return JSON.parse(JSON.stringify(value))
}

/** A manually-settled promise — the `resolve` / `reject` lifted out of its executor. */
export interface TestGateInterface<T> {
	readonly promise: Promise<T>
	readonly resolve: (value: T) => void
	readonly reject: (error: unknown) => void
}

/**
 * Create a {@link TestGateInterface} — a deferred whose `promise` settles only when
 * the test calls `resolve` / `reject`. Lets a test gate a real handler on a signal it
 * controls, to prove ordering / concurrency / pause behaviour without racing wall-clock
 * timers (AGENTS §16.1).
 *
 * @typeParam T - The value the gate's `promise` resolves with
 * @returns A gate exposing its `promise` and its `resolve` / `reject`
 */
export function createGate<T = void>(): TestGateInterface<T> {
	let resolve: (value: T) => void = () => {}
	let reject: (error: unknown) => void = () => {}
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

/**
 * A scripted real {@link WorkflowStoreInterface} boundary whose queued gates control store
 * settlement while its readonly histories expose the exact durable calls made by a test.
 */
export class WorkflowStoreBoundary implements WorkflowStoreInterface {
	readonly #reads: Array<TestGateInterface<WorkflowSnapshot | undefined>>
	readonly #writes: Array<TestGateInterface<void>>
	readonly #gets: string[] = []
	readonly #sets: WorkflowSnapshot[] = []
	readonly #deletes: string[] = []

	constructor(
		reads: ReadonlyArray<TestGateInterface<WorkflowSnapshot | undefined>> = [],
		writes: ReadonlyArray<TestGateInterface<void>> = [],
	) {
		this.#reads = [...reads]
		this.#writes = [...writes]
	}

	get gets(): readonly string[] {
		return this.#gets
	}

	get sets(): readonly WorkflowSnapshot[] {
		return this.#sets
	}

	get deletes(): readonly string[] {
		return this.#deletes
	}

	get(id: string): Promise<WorkflowSnapshot | undefined> {
		this.#gets.push(id)
		const gate = this.#reads.shift()
		return gate === undefined ? Promise.resolve(undefined) : gate.promise
	}

	set(snapshot: WorkflowSnapshot): Promise<void> {
		this.#sets.push(snapshot)
		const gate = this.#writes.shift()
		return gate === undefined ? Promise.resolve() : gate.promise
	}

	delete(id: string): Promise<void> {
		this.#deletes.push(id)
		return Promise.resolve()
	}
}

/** A real budget boundary whose signal getter throws the supplied setup failure. */
export class FaultBudget implements BudgetInterface<TokenUsage> {
	readonly id = 'fault-budget'
	readonly max = 10
	readonly consumed = 7
	readonly remaining = 3
	readonly exhausted = false
	readonly #failure: unknown
	#starts = 0
	#clears = 0

	constructor(failure: unknown) {
		this.#failure = failure
	}

	get signal(): AbortSignal {
		throw this.#failure
	}

	get starts(): number {
		return this.#starts
	}

	get clears(): number {
		return this.#clears
	}

	start(): void {
		this.#starts += 1
	}

	consume(usage: TokenUsage): void {
		void usage
	}

	clear(): void {
		this.#clears += 1
	}
}

// ── Call recorder (a real callback, not a mock) ──────────────────────────────
//
// AGENTS §16.1: when a test only needs to count calls or inspect arguments, use a
// recorder — a real listener that records every invocation — rather than a test-
// framework spy. `handler` is a genuine callback; `calls` is each invocation's
// argument tuple, in order.

/**
 * Create a recorder for an {@link import('@orkestrel/emitter').EmitterErrorHandler} — the
 * emitter's own listener-error channel (AGENTS §13): a `RecorderInterface<[error, event]>`
 * whose `handler` is wired as the `error` option, so an emit-safety test asserts a buggy
 * listener's throw was routed here (with the offending event name) instead of corrupting the
 * entity. Argument order is `(error, event)`, matching `EmitterErrorHandler`. A thin alias over
 * {@link createRecorder} (AGENTS §16.1 — extract-once over the per-entity emit-safety blocks).
 *
 * @returns A recorder of `[error: unknown, event: string]` calls
 */
export function createErrorRecorder(): RecorderInterface<readonly [error: unknown, event: string]> {
	return createRecorder<readonly [error: unknown, event: string]>()
}

/** A recorder per named event of an {@link EmitterInterface}, keyed by event name. */
export type EmitterRecorders<TMap extends EventMap, TName extends keyof TMap> = {
	readonly [K in TName]: RecorderInterface<TMap[K]>
}

/**
 * Wire one {@link createRecorder} onto `emitter` for each of the named events — the
 * one generic form of the per-entity `recordXEvents` bundles (AGENTS §16.1). Each
 * recorder subscribes via `emitter.on(name, recorder.handler)` and is returned keyed
 * by its event name, typed with that event's argument tuple — so a test asserts what
 * fired (`events.write.calls`) and with which payload, exactly as the local bundles did.
 *
 * @typeParam TMap - The emitter's {@link EventMap}
 * @typeParam TName - The subset of event names to record (inferred from `events`)
 * @param emitter - The emitter to subscribe the recorders to
 * @param events - The event names to record (each becomes a key of the result)
 * @returns A recorder per name, each subscribed and keyed by event name
 */
export function recordEmitterEvents<TMap extends EventMap, TName extends keyof TMap>(
	emitter: EmitterInterface<TMap>,
	events: readonly TName[],
): EmitterRecorders<TMap, TName> {
	// Accumulate into a `Partial` of the exact mapped shape — every value keeps its
	// precise per-event tuple type (a recorder is invariant in its argument tuple, so a
	// widened record won't hold it), all keys optional until assigned. Each recorder is
	// created against its event's tuple, so `on(name, handler)` is precisely typed as it
	// is wired. The dynamic key list is the untyped edge: once every listed name is
	// present we narrow `Partial` → total through a guard, never an assertion (§14).
	const recorders: Partial<EmitterRecorders<TMap, TName>> = {}
	for (const name of events) {
		const recorder = createRecorder<TMap[typeof name]>()
		emitter.on(name, recorder.handler)
		recorders[name] = recorder
	}
	if (!isTotal(recorders, events)) {
		throw new Error('recordEmitterEvents: a recorder was not wired for every event')
	}
	return recorders
}

/**
 * Narrow an accumulated `Partial<EmitterRecorders>` to its total mapped form once every
 * listed event has a recorder present — the §14 guard standing in for an assertion in
 * {@link recordEmitterEvents} (whose loop assigns one recorder per name, so this holds;
 * the explicit per-name presence check keeps the narrowing a sound guard, not a cast).
 *
 * @typeParam TMap - The emitter's {@link EventMap}
 * @typeParam TName - The subset of event names that must each have a recorder
 * @param recorders - The partially-accumulated recorder map to narrow
 * @param events - The event names that must all be present for the map to be total
 * @returns Whether every listed event has a recorder (narrowing `recorders` to total)
 */
export function isTotal<TMap extends EventMap, TName extends keyof TMap>(
	recorders: Partial<EmitterRecorders<TMap, TName>>,
	events: readonly TName[],
): recorders is EmitterRecorders<TMap, TName> {
	return events.every((name) => recorders[name] !== undefined)
}

// ── Signal instrumentation (a real AbortSignal, wrapped) ──────────────────────

/** A real {@link AbortSignal}'s `'abort'` listener bookkeeping — adds vs. removes counted. */
export interface SignalListenerCountsInterface {
	/** A recorder of `'abort'` `addEventListener` calls on the instrumented signal. */
	readonly added: RecorderInterface<readonly [string]>
	/** A recorder of `'abort'` `removeEventListener` calls on the instrumented signal. */
	readonly removed: RecorderInterface<readonly [string]>
}

/**
 * Instrument a REAL {@link AbortSignal}'s listener bookkeeping by wrapping its own
 * `addEventListener` / `removeEventListener` (delegating to the genuine implementation) and
 * counting `'abort'` adds and removes — so a test can prove a scheduler / primitive detaches
 * every abort listener it attaches (no leak), counting on the real signal rather than mocking
 * the unit under test (AGENTS §16). Environment-agnostic — `AbortSignal` exists in node and
 * the browser alike, so it lives in the shared setup.
 *
 * @param signal - The signal to instrument in place (its methods are wrapped)
 * @returns The `added` / `removed` recorders, each incremented per `'abort'` add / remove
 */
export function instrumentSignal(signal: AbortSignal): SignalListenerCountsInterface {
	const added = createRecorder<readonly [string]>()
	const removed = createRecorder<readonly [string]>()
	const realAdd = signal.addEventListener.bind(signal)
	const realRemove = signal.removeEventListener.bind(signal)
	signal.addEventListener = (
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	): void => {
		if (type === 'abort') added.handler(type)
		realAdd(type, listener, options)
	}
	signal.removeEventListener = (
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | EventListenerOptions,
	): void => {
		if (type === 'abort') removed.handler(type)
		realRemove(type, listener, options)
	}
	return { added, removed }
}

// ── Recording scheduler (a real SchedulerInterface, wrapped) ────────────────────

/** A {@link SchedulerInterface} that records how many real turn boundaries its `yield` paced. */
export interface RecordingSchedulerInterface extends SchedulerInterface {
	/** How many times `yield` ran — the turn boundaries the loop paced through this scheduler. */
	readonly yields: number
}

/** A recorder over one shipped scheduler instance. */
export class RecordingScheduler implements RecordingSchedulerInterface {
	readonly #scheduler: SchedulerInterface
	#yields = 0

	constructor(scheduler: SchedulerInterface) {
		this.#scheduler = scheduler
	}

	get yields(): number {
		return this.#yields
	}

	async yield(options?: SchedulerOptions): Promise<void> {
		this.#yields += 1
		await this.#scheduler.yield(options)
	}

	delay(ms: number, options?: SchedulerOptions): Promise<void> {
		return this.#scheduler.delay(ms, options)
	}
}

/**
 * Create a {@link RecordingSchedulerInterface} that counts `yield` calls before delegating
 * both methods to one shipped scheduler instance. Timing, cancellation, and cleanup therefore
 * retain the production scheduler's semantics.
 *
 * @returns A scheduler whose `yields` reports the real turn boundaries it paced
 */
export function createRecordingScheduler(): RecordingSchedulerInterface {
	return new RecordingScheduler(createScheduler())
}

// ── Workflow fixtures (definitions + a deterministic settle, environment-agnostic) ──
//
// AGENTS §16.1: the recurring real {@link WorkflowDefinition} stubs the workflow tests
// build, plus the deterministic settle helper that drives one through the real runner.
// All plain `@src/core` data + the shipped `createWorkflowRunner` (no `node:*`, no DOM),
// so they load in every project. A test keeps only its env-/scenario-specific bits local
// (its own driver creation, a bespoke per-test definition).

/**
 * A real, valid {@link WorkflowDefinition} stub — a workflow with two phases, one task of
 * each `via` form, a `concurrency` throttle, and an explicit `bail`. Apply `overrides` to
 * produce a variant. The shared base the contract / factory / W-b entity tests build on (the
 * live tree is built from this), so the definition shape stays in one place (AGENTS §16.1).
 *
 * @param overrides - Fields to override on the default definition (`wf-1` / `Release`)
 * @returns The assembled workflow definition
 */
export function buildWorkflowDefinition(
	overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
	return {
		id: 'wf-1',
		name: 'Release',
		description: 'Ship a release',
		bail: false,
		phases: [
			{
				id: 'phase-build',
				name: 'Build',
				concurrency: 2,
				tasks: [
					{ id: 'task-compile', name: 'Compile', run: 'compile' },
					{
						id: 'task-scan',
						name: 'Scan',
						description: 'Security scan',
						run: 'scanner',
					},
				],
			},
			{
				id: 'phase-review',
				name: 'Review',
				tasks: [{ id: 'task-audit', name: 'Audit', run: 'auditor' }],
			},
		],
		...overrides,
	}
}

/**
 * A real two-phase `release` {@link WorkflowDefinition} (≥1 task each) — phase `build` runs
 * two `function` tasks concurrently, phase `ship` a third in a later phase. The handlers are
 * registered on the runner BY NAME (see {@link RELEASE_FUNCTIONS}), so a settled run records
 * real `completed` statuses + results. The shared store-test fixture both the Memory and the
 * Database `WorkflowStore` twins drive (AGENTS §16.1 — one stub, not a per-file copy).
 *
 * @param id - The workflow id (and snapshot key); defaults to `'release'`
 * @returns The assembled `release` workflow definition
 */
export function buildReleaseDefinition(id = 'release'): WorkflowDefinition {
	return {
		id,
		name: 'Release',
		phases: [
			{
				id: 'build',
				name: 'Build',
				tasks: [
					{ id: 'compile', name: 'Compile', run: 'compile' },
					{ id: 'lint', name: 'Lint', run: 'lint' },
				],
			},
			{
				id: 'ship',
				name: 'Ship',
				tasks: [{ id: 'publish', name: 'Publish', run: 'publish' }],
			},
		],
	}
}

/**
 * The registered behaviors a {@link buildReleaseDefinition}'s tasks dispatch to BY NAME — each
 * a real {@link WorkflowFunction} returning a distinct value, so a settled snapshot carries real
 * boxed results (AGENTS §16.1 — a real handler map shared by the store twins, never a mock).
 */
export const RELEASE_FUNCTIONS: Readonly<Record<string, WorkflowFunction>> = {
	compile: (controller) => `built ${controller.task.id}`,
	lint: () => 'clean',
	publish: () => ({ released: true }),
}

/**
 * Drive a `definition` to a SETTLED {@link WorkflowSnapshot} through the real runner — the live
 * tree is built, executed (phases sequential, tasks concurrent via {@link RELEASE_FUNCTIONS}),
 * and serialized. The genuine durable payload after a run (real `completed` statuses + recorded
 * TaskResults), not a hand-rolled stub. The runner is paced by an injected
 * {@link createRecordingScheduler}, which delegates to the shipped scheduler while counting
 * cooperative turns, so the unit under test runs with production timing and cancellation.
 *
 * @param definition - The workflow definition to build, run to completion, and snapshot
 * @returns The settled run's snapshot
 */
export async function settleSnapshot(definition: WorkflowDefinition): Promise<WorkflowSnapshot> {
	const runner = createWorkflowRunner({ scheduler: createRecordingScheduler() })
	const result = await runner.execute(definition, { functions: RELEASE_FUNCTIONS })
	return result.workflow.snapshot()
}

/** Whether a repository-relative Vue SFC path belongs to the private browser application. */
export function isBrowserVuePath(path: string): boolean {
	const normalized = path.replaceAll('\\', '/')
	return normalized.startsWith('app/browser/')
}
