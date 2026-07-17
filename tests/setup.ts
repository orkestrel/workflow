import type {
	ContextFormatInterface,
	MessageInterface,
	ProviderDelta,
	ProviderInterface,
	ProviderResult,
	ProviderStreamOptions,
	ToolDefinition,
} from '@orkestrel/agent'
import type { EmitterInterface, EventMap } from '@orkestrel/emitter'
import type {
	SchedulerInterface,
	SchedulerOptions,
	WorkflowDefinition,
	WorkflowFunction,
	WorkflowSnapshot,
} from '@src/core'
import { ProviderAbortError } from '@orkestrel/agent'
import { createWorkflowRunner } from '@src/core'

// ── Environment-agnostic base setup (AGENTS §16.1) ────────────────────────────
//
// Loaded first by every test project (`vite.config.ts` `setupFiles[0]`). Holds ONLY
// helpers with no `node:*` / DOM dependency, so it is safe for `src:core`,
// `src:browser`, and `src:server` alike. Environment-specific helpers live in their
// own matching setup file (`setupBrowser.ts`, `setupServer.ts`).

/**
 * Run `thunk` and return the value it threw, or `undefined` if it returned normally — the
 * one shared form of the `try { …; return undefined } catch (error) { return error }` IIFE
 * the error-path tests repeat (AGENTS §16.1). Lets a caller assert on the captured fault
 * unconditionally, never inside a conditional `expect`. For a synchronous throw site; an
 * async rejection is asserted with `await expect(…).rejects` instead.
 *
 * @param thunk - The (synchronous) operation to run and capture the throw of
 * @returns The thrown value, or `undefined` when `thunk` did not throw
 */
export function captureError(thunk: () => unknown): unknown {
	try {
		thunk()
		return undefined
	} catch (error) {
		return error
	}
}

/**
 * Wait at least `ms` milliseconds via a real `setTimeout` — the one shared form of a
 * deliberate real-clock pause a test needs outside fake timers (AGENTS §16.1).
 *
 * @param ms - The minimum delay in milliseconds; defaults to `0` (a macrotask turn)
 * @returns A promise that resolves after the delay
 */
export function waitForDelay(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Round-trip a value through `JSON.parse(JSON.stringify(...))`, returning the structurally
 * identical clone — the one shared form of the "driver-swap parity" check the store / snapshot
 * tests repeat (AGENTS §16.1). A JSON / SQLite / IndexedDB backend persists a snapshot AS JSON,
 * so a structurally-faithful, pure-JSON payload must survive the round-trip byte-for-byte; a test
 * asserts `roundTripJSON(snapshot)` deep-equals the original. Type-preserving by construction —
 * the clone has the same shape (`T`), so the result drops straight into a `toEqual` against the
 * source. Environment-agnostic (`JSON` is global in node and the browser alike).
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

// ── Call recorder (a real callback, not a mock) ──────────────────────────────
//
// AGENTS §16.1: when a test only needs to count calls or inspect arguments, use a
// recorder — a real listener that records every invocation — rather than a test-
// framework spy. `handler` is a genuine callback; `calls` is each invocation's
// argument tuple, in order.

/** A real call-recording callback over an argument tuple (AGENTS §16.1). */
export interface TestRecorderInterface<TArgs extends readonly unknown[]> {
	readonly calls: readonly TArgs[]
	readonly count: number
	readonly handler: (...args: TArgs) => void
	clear(): void
}

/**
 * Create a {@link TestRecorderInterface} — a real callback that records each
 * invocation's arguments, for asserting what fired and with what (AGENTS §16.1).
 *
 * @typeParam TArgs - The argument tuple the recorded handler receives
 * @returns A recorder whose `handler` records into `calls`
 */
export function createRecorder<TArgs extends readonly unknown[]>(): TestRecorderInterface<TArgs> {
	const calls: TArgs[] = []
	return {
		get calls() {
			return calls
		},
		get count() {
			return calls.length
		},
		handler(...args: TArgs) {
			calls.push(args)
		},
		clear() {
			calls.length = 0
		},
	}
}

/**
 * Create a recorder for an {@link import('@orkestrel/emitter').EmitterErrorHandler} — the
 * emitter's own listener-error channel (AGENTS §13): a `TestRecorderInterface<[error, event]>`
 * whose `handler` is wired as the `error` option, so an emit-safety test asserts a buggy
 * listener's throw was routed here (with the offending event name) instead of corrupting the
 * entity. Argument order is `(error, event)`, matching `EmitterErrorHandler`. A thin alias over
 * {@link createRecorder} (AGENTS §16.1 — extract-once over the per-entity emit-safety blocks).
 *
 * @returns A recorder of `[error: unknown, event: string]` calls
 */
export function createErrorRecorder(): TestRecorderInterface<
	readonly [error: unknown, event: string]
> {
	return createRecorder<readonly [error: unknown, event: string]>()
}

/** A recorder per named event of an {@link EmitterInterface}, keyed by event name. */
export type EmitterRecorders<TMap extends EventMap, TName extends keyof TMap> = {
	readonly [K in TName]: TestRecorderInterface<TMap[K]>
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
	readonly added: TestRecorderInterface<readonly [string]>
	/** A recorder of `'abort'` `removeEventListener` calls on the instrumented signal. */
	readonly removed: TestRecorderInterface<readonly [string]>
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

/** A {@link SchedulerInterface} that records how many turn boundaries its `yield` paced. */
export interface RecordingSchedulerInterface extends SchedulerInterface {
	/** How many times `yield` ran — the turn boundaries the loop paced through this scheduler. */
	readonly yields: number
}

/**
 * Create a {@link RecordingSchedulerInterface} — a real `SchedulerInterface` whose
 * `yield` counts each call (the turn boundary it paced) and resolves immediately, so a
 * test can prove pacing ran BETWEEN turns (not after the last). It honours its signal
 * exactly like the real scheduler — an already-aborted signal rejects with the reason —
 * and its `delay` is a no-op. Not a mock: a genuine scheduler the agent loop drives.
 *
 * @returns A scheduler whose `yields` reports the turn boundaries it paced
 */
export function createRecordingScheduler(): RecordingSchedulerInterface {
	let yields = 0
	return {
		get yields() {
			return yields
		},
		async yield(options?: SchedulerOptions) {
			if (options?.signal?.aborted) throw options.signal.reason
			yields += 1
		},
		async delay() {},
	}
}

// ── Scripted ProviderInterface (Ollama-free agent fixture) ───────────────────
//
// AGENTS §16.1: the ONE general scripted `ProviderInterface` the `agent`-form task tests
// drive (the `WorkflowRunner`'s depth/cycle-bounded agent dispatch). It is a real provider
// (NOT a mock of the agent): `stream` chunks the turn's content into deltas and RETURNS the
// result, honouring its `signal` between every delta (an abort throws a `ProviderAbortError`
// carrying the accumulated partial), so a cancel threaded into the agent commits a genuine
// partial. Only genuine per-scenario BEHAVIOUR fixtures stay local to their test file.

/**
 * One turn a {@link createScriptedProvider} replays — either a bare {@link ProviderResult}
 * (chunked by the provider's `deltasOf`) or a `{ result, deltas?, thoughts? }` pair whose per-turn
 * `deltas` override how that one turn's content streams and whose `thoughts` stream live
 * reasoning deltas before the content. A `deltas` of `[]` streams the content as zero deltas
 * (the result still returns).
 */
export type ScriptedTurn =
	| ProviderResult
	| {
			readonly result: ProviderResult
			readonly deltas?: readonly string[]
			readonly thoughts?: readonly string[]
	  }

/** One recorded `generate` / `stream` call on a {@link createScriptedProvider} (when `record`). */
export interface ScriptedCall {
	readonly messages: readonly MessageInterface[]
	readonly tools: readonly ToolDefinition[] | undefined
	readonly options: ProviderStreamOptions | undefined
}

/** How a {@link createScriptedProvider} chunks a turn's content into stream deltas. */
export type DeltasOf = (content: string) => readonly string[]

/**
 * Options for {@link createScriptedProvider} — every field optional, defaulting to the
 * single-delta / repeat-on-exhaust behaviour.
 *
 * @remarks
 * - `delay` — ms paused at the start of each call (lets a test observe concurrency via
 *   `maxInFlight`); defaults to `0`.
 * - `name` — sets the provider's `id` and `name`; defaults to `'scripted'`.
 * - `format` — a provider-default {@link ContextFormatInterface}, included on the provider
 *   ONLY when supplied (omitted ⇒ framing-agnostic).
 * - `deltasOf` — how a turn's content is chunked into stream deltas; defaults to one whole
 *   delta (`(content) => [content]`). A per-turn `deltas` (the `{ result, deltas }` turn
 *   form) overrides this for that turn.
 * - `exhaust` — what happens once the turn list is consumed: `'repeat'` (the DEFAULT — the
 *   last turn repeats) or `'throw'` (a call past the end throws, to assert a bounded loop
 *   never over-ran the script).
 * - `record` — when `true`, every call appends its `messages` / `tools` to `calls`.
 */
export interface ScriptedProviderOptions {
	readonly delay?: number
	readonly name?: string
	readonly format?: ContextFormatInterface
	readonly deltasOf?: DeltasOf
	readonly exhaust?: 'repeat' | 'throw'
	readonly record?: boolean
}

/**
 * A scripted {@link ProviderInterface} plus its live recorders — `maxInFlight` is the
 * high-water mark of concurrent calls (so a test can prove the runner bounded the agent
 * tasks), `started` counts calls, and `calls` records each call's `messages` / `tools`
 * (populated only under `record: true`).
 */
export interface ScriptedProviderInterface extends ProviderInterface {
	/** The highest number of `stream` calls in flight at once across this provider's life. */
	readonly maxInFlight: number
	/** How many `stream` calls have started in total. */
	readonly started: number
	/** Each call's `messages` / `tools`, in order — populated only when `record: true`. */
	readonly calls: readonly ScriptedCall[]
}

// Normalize a {@link ScriptedTurn} to its `{ result, deltas? }` parts — a bare result has
// no per-turn deltas (the `'result' in turn` discriminant narrows the union, §14, no `as`).
function turnParts(turn: ScriptedTurn): {
	readonly result: ProviderResult
	readonly deltas: readonly string[] | undefined
	readonly thoughts: readonly string[] | undefined
} {
	return 'result' in turn
		? { result: turn.result, deltas: turn.deltas, thoughts: turn.thoughts }
		: { result: turn, deltas: undefined, thoughts: undefined }
}

/**
 * Create the shared scripted {@link ProviderInterface} for deterministic, Ollama-free agent
 * tests — each `generate` / `stream` call consumes the next {@link ScriptedTurn}, streams
 * its content as deltas (per-turn `deltas`, else `deltasOf(content)`, else the whole content
 * as one delta), and RETURNS the turn's result. The call honours its `signal` between every
 * delta: an already-aborted (or mid-stream aborted) signal throws a `ProviderAbortError`
 * carrying the accumulated partial, so a cancel threaded into the agent commits a genuine
 * partial. Once the turn list is exhausted the last turn repeats (`exhaust: 'repeat'`, the
 * default) unless `exhaust: 'throw'` is set.
 *
 * @param turns - The {@link ScriptedTurn}s to replay in order (the last repeats by default)
 * @param options - The {@link ScriptedProviderOptions} (all optional; see its `@remarks`)
 * @returns A {@link ScriptedProviderInterface} (the provider + its recorders)
 */
export function createScriptedProvider(
	turns: readonly ScriptedTurn[],
	options?: ScriptedProviderOptions,
): ScriptedProviderInterface {
	const delay = options?.delay ?? 0
	const name = options?.name ?? 'scripted'
	const deltasOf = options?.deltasOf ?? ((content: string): readonly string[] => [content])
	const exhaust = options?.exhaust ?? 'repeat'
	const calls: ScriptedCall[] = []
	let index = 0
	let inFlight = 0
	let maxInFlight = 0
	let started = 0
	// Consume the next turn: past the end either repeat the last ('repeat') or throw ('throw').
	const next = (): ScriptedTurn => {
		if (index >= turns.length && exhaust === 'throw') {
			throw new Error(`createScriptedProvider exhausted at turn ${index}`)
		}
		const turn = turns[Math.min(index, turns.length - 1)] ?? { content: '' }
		index += 1
		return turn
	}
	async function* stream(
		messages: readonly MessageInterface[],
		signal: AbortSignal,
		tools?: readonly ToolDefinition[],
		run?: ProviderStreamOptions,
	): AsyncGenerator<ProviderDelta, ProviderResult> {
		if (options?.record === true) calls.push({ messages: [...messages], tools, options: run })
		started += 1
		inFlight += 1
		maxInFlight = Math.max(maxInFlight, inFlight)
		try {
			if (signal.aborted) throw new ProviderAbortError({ content: '' })
			if (delay > 0) await waitForDelay(delay)
			const turn = next()
			const { result, deltas, thoughts } = turnParts(turn)
			// Per-turn `deltas` win; else chunk the content via `deltasOf`.
			const chunks = deltas ?? deltasOf(result.content)
			let streamed = ''
			let reasoned = ''
			for (const thought of thoughts ?? []) {
				if (signal.aborted) {
					const partial: ProviderResult =
						reasoned.length > 0 ? { content: streamed, thinking: reasoned } : { content: streamed }
					throw new ProviderAbortError(partial)
				}
				reasoned += thought
				if (thought.length > 0) yield { type: 'thinking', text: thought }
			}
			for (const delta of chunks) {
				if (signal.aborted) {
					const partial: ProviderResult =
						reasoned.length > 0 ? { content: streamed, thinking: reasoned } : { content: streamed }
					throw new ProviderAbortError(partial)
				}
				streamed += delta
				if (delta.length > 0) yield { type: 'content', text: delta }
			}
			if (signal.aborted) {
				const partial: ProviderResult =
					reasoned.length > 0 ? { content: streamed, thinking: reasoned } : { content: streamed }
				throw new ProviderAbortError(partial)
			}
			return result
		} finally {
			inFlight -= 1
		}
	}
	return {
		id: name,
		name,
		...(options?.format === undefined ? {} : { format: options.format }),
		get maxInFlight() {
			return maxInFlight
		},
		get started() {
			return started
		},
		get calls() {
			return calls
		},
		stream,
		async generate(messages, signal, tools, run) {
			const generator = stream(messages, signal, tools, run)
			let step = await generator.next()
			while (!step.done) step = await generator.next()
			return step.value
		},
	}
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
 * {@link createRecordingScheduler} (its `yield` resolves immediately, honouring an abort signal
 * exactly like the shipped scheduler) so the run is DETERMINISTIC with no wall-clock `setTimeout`
 * (AGENTS §16) — the unit under test still runs in full (NOT a mock). Shared by the store twins.
 *
 * @param definition - The workflow definition to build, run to completion, and snapshot
 * @returns The settled run's snapshot
 */
export async function settleSnapshot(definition: WorkflowDefinition): Promise<WorkflowSnapshot> {
	const runner = createWorkflowRunner({ scheduler: createRecordingScheduler() })
	const result = await runner.execute(definition, { functions: RELEASE_FUNCTIONS })
	return result.workflow.snapshot()
}
