import { createMemoryDriver } from '@orkestrel/database'
import type { BudgetInterface, TokenUsage } from '@orkestrel/budget'
import type { RecorderInterface } from '@orkestrel/test'
import type {
	LifecycleStatus,
	PhaseDerivation,
	TaskControllerInterface,
	TaskDefinition,
	WorkflowRunnerInterface,
	WorkflowRunnerOptions,
	WorkflowRegistry,
	PhaseInterface,
	ControllerInterface,
	RunnerInterface,
	SchedulerInterface,
	SchedulerOptions,
	TaskInterface,
	TaskResult,
	TaskSnapshot,
	TaskUpdate,
	WorkflowDefinition,
	WorkflowFunction,
	WorkflowInterface,
	WorkflowSnapshot,
	WorkflowStoreInterface,
} from '@src/core'
import { compileGuard } from '@orkestrel/contract'
import { createAbort } from '@orkestrel/abort'
import { createRecorder, requireValue } from '@orkestrel/test'
import {
	Collection,
	success,
	failure,
	createRunner,
	createMemoryWorkflowStore,
	createDatabaseWorkflowStore,
	createScheduler,
	createWorkflow,
	createWorkflowRunner,
	isWorkflowError,
	taskUpdateShape,
} from '@src/core'
import { Controller } from '../src/core/Controller.js'
import { TaskController } from '../src/core/tasks/TaskController.js'

/** Builds an activity fixture with an own enumerable timestamp getter. */
export function buildActivityStamp(
	read: () => number,
	operations: readonly unknown[] = [],
	constraints?: readonly unknown[],
): WorkflowActivityStamp {
	return {
		operations,
		...(constraints === undefined ? {} : { constraints }),
		get updated() {
			return read()
		},
	}
}

/** Builds a registry whose own enumerable compile getter resolves lazily. */
export function buildCompileRegistry(read: () => WorkflowFunction): WorkflowRegistry {
	return {
		get compile(): WorkflowFunction {
			return read()
		},
	}
}

/** Returns a JSON null task outcome. */
export function returnWorkflowNull(): null {
	return null
}

/** Rejects the scripted workflow task with its fixed handler fault. */
export function throwWorkflowFault(): never {
	throw new Error('boom')
}

/** Returns the live task identifier as its handler outcome. */
export function readWorkflowTaskId(controller: TaskControllerInterface): string {
	return controller.task.id
}

/** Builds the phase-inheritance fixture under the supplied workflow bail policy. */
export function buildBailDefinition(bail: boolean): WorkflowDefinition {
	return buildRunnerDefinition(
		[
			{ id: 'a', tasks: [buildFunctionTask('t0', 'fail')] },
			{ id: 'b', tasks: [buildFunctionTask('t1', 'ok')] },
		],
		bail,
	)
}

/** Builds a task handler that records its eventual abort and optional start. */
export function createParkedTask(
	aborted: RecorderInterface<readonly [string]>,
	started?: RecorderInterface<readonly [string]>,
): WorkflowFunction {
	return (controller) =>
		new Promise<string>((resolve) => {
			started?.handler(controller.task.id)
			controller.signal.addEventListener(
				'abort',
				() => {
					aborted.handler(controller.task.id)
					resolve('aborted')
				},
				{ once: true },
			)
		})
}

/** Rejects a running task when its real attempt signal aborts. */
export function rejectTaskAbort(controller: TaskControllerInterface): Promise<null> {
	return new Promise<null>((_resolve, reject) => {
		controller.signal.addEventListener('abort', () => reject(new Error('handler observed abort')), {
			once: true,
		})
	})
}

/** Builds a work registry that records and returns each task identifier. */
export function buildRecordedFunctions(
	recorder: RecorderInterface<readonly [string]>,
): WorkflowRegistry {
	return {
		work: (controller) => {
			recorder.handler(controller.task.id)
			return controller.task.id
		},
	}
}

/** Implements the scheduler's scripted infrastructure-failure boundary. */
export class FaultScheduler implements SchedulerInterface {
	readonly #failure: unknown

	constructor(fault: unknown) {
		this.#failure = fault
	}

	yield(): Promise<void> {
		return Promise.reject(this.#failure)
	}

	delay(): Promise<void> {
		return Promise.resolve()
	}
}

/** Builds a workflow execution fixture with the supplied scenario values. */
export function createPacedRunner(options?: WorkflowRunnerOptions): WorkflowRunnerInterface {
	return createWorkflowRunner({
		...options,
		scheduler: options?.scheduler ?? createRecordingScheduler(),
	})
}

/** Builds a workflow execution fixture with the supplied scenario values. */
export function buildFunctionTask(id: string, fn: string): TaskDefinition {
	return { id, name: id, behavior: fn }
}

/** Builds a workflow execution fixture with the supplied scenario values. */
export function buildRunnerDefinition(
	phases: ReadonlyArray<{
		readonly id: string
		readonly tasks: readonly TaskDefinition[]
		readonly concurrency?: number
		readonly bail?: boolean
	}>,
	bail = false,
): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		bail,
		phases: phases.map((phase) => ({
			id: phase.id,
			name: phase.id,
			...(phase.concurrency === undefined ? {} : { concurrency: phase.concurrency }),
			...(phase.bail === undefined ? {} : { bail: phase.bail }),
			tasks: phase.tasks,
		})),
	}
}

/** Builds a workflow execution fixture with the supplied scenario values. */
export function createOrderFunction(order: string[]): WorkflowFunction {
	return (controller) => {
		order.push(controller.task.id)
		return controller.task.id
	}
}

/** Builds a workflow execution fixture with the supplied scenario values. */
export function buildReliableTask(
	id: string,
	fn: string,
	reliability: { readonly retries?: number; readonly timeout?: number },
): TaskDefinition {
	return {
		id,
		name: id,
		behavior: fn,
		...(reliability.retries === undefined ? {} : { retries: reliability.retries }),
		...(reliability.timeout === undefined ? {} : { timeout: reliability.timeout }),
	}
}

/** Builds a workflow execution fixture with the supplied scenario values. */
export function createAbortSibling(aborted: WorkflowAbortRecorder): WorkflowFunction {
	return (controller: TaskControllerInterface) =>
		new Promise<string>((resolve) => {
			if (controller.signal.aborted) {
				aborted.handler(controller.task.id)
				resolve('aborted')
				return
			}
			controller.signal.addEventListener(
				'abort',
				() => {
					aborted.handler(controller.task.id)
					resolve('aborted')
				},
				{ once: true },
			)
		})
}

/** Builds a workflow execution fixture with the supplied scenario values. */
export function buildParkedPhases(): WorkflowDefinition {
	return buildRunnerDefinition([
		{ id: 'a', tasks: [buildFunctionTask('t0', 'a')] },
		{ id: 'b', tasks: [buildFunctionTask('t1', 'rec')] },
		{ id: 'c', tasks: [buildFunctionTask('t2', 'rec')] },
	])
}

/** Parks a task fixture until its real attempt deadline aborts. */
export const parkUntilDeadline: WorkflowFunction = (controller: TaskControllerInterface) =>
	new Promise<string>((resolve) => {
		if (controller.signal.aborted) {
			resolve('timed-out')
			return
		}
		controller.signal.addEventListener('abort', () => resolve('timed-out'), { once: true })
	})

/** Returns the initial inert runner option value. */
export function returnWorkflowZero(): number {
	return 0
}

/** Builds the live manager fixture in declared positional order. */
export function buildPhaseTasks() {
	const workflow = createWorkflow({
		id: 'wf',
		name: 'WF',
		phases: [
			{
				id: 'p',
				name: 'P',
				tasks: [
					{ id: 't0', name: 'T0', behavior: 'f' },
					{ id: 't1', name: 'T1', behavior: 'f' },
					{ id: 't2', name: 'T2', behavior: 'f' },
				],
			},
		],
	})
	const phase = workflow.phase('p')
	if (phase === undefined) throw new Error('expected the phase to exist')
	return phase
}

/** Builds the live manager fixture in declared positional order. */
export function buildWorkflowPhases() {
	return createWorkflow({
		id: 'wf',
		name: 'WF',
		phases: [
			{ id: 'a', name: 'A', tasks: [{ id: 't', name: 'T', behavior: 'f' }] },
			{ id: 'b', name: 'B', tasks: [{ id: 't', name: 'T', behavior: 'f' }] },
			{ id: 'c', name: 'C', tasks: [{ id: 't', name: 'T', behavior: 'f' }] },
		],
	})
}

/** Drives each forced terminal task status. */
export const TASK_FORCED_DRIVERS = Object.freeze([
	(task: TaskInterface) => task.skip(),
	(task: TaskInterface) => task.stop(),
])

/** Drives each terminal task status through its legal transitions. */
export const TASK_TERMINAL_DRIVERS = Object.freeze([
	(task: TaskInterface) => {
		task.start()
		task.complete('v')
	},
	(task: TaskInterface) => {
		task.start()
		task.fail({ origin: 'handler', message: 'e' })
	},
	...TASK_FORCED_DRIVERS,
])

/** Builds or reads a task fixture through the workflow contract. */
export function buildSingleTaskWorkflow(): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		phases: [{ id: 'p', name: 'P', tasks: [{ id: 't', name: 'T', behavior: 'f' }] }],
	}
}

/** Builds or reads a task fixture through the workflow contract. */
export function requireWorkflowTask(workflow: WorkflowInterface): TaskInterface {
	const task = workflow.phase('p')?.task('t')
	if (task === undefined) throw new Error('expected the lone task to exist')
	return task
}

/** Builds or reads a task fixture through the workflow contract. */
export function readWorkflowCode(error: unknown): string | undefined {
	return isWorkflowError(error) ? error.code : undefined
}

/** Builds an own enumerable claim getter whose later read changes its identifier. */
export function buildWorkflowClaim(reads: WorkflowObservation<number>): WorkflowClaimFixture {
	return {
		get id() {
			reads.value += 1
			return reads.value === 1 ? 'stable' : ''
		},
		name: 'Operation',
		started: 0,
	}
}

/** Builds or drives the workflow fixture through its public lifecycle. */
export function buildTwoPhaseWorkflow(bail: boolean): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		bail,
		phases: [
			{
				id: 'a',
				name: 'A',
				tasks: [
					{ id: 't0', name: 'T0', behavior: 'f' },
					{ id: 't1', name: 'T1', behavior: 'f' },
				],
			},
			{
				id: 'b',
				name: 'B',
				tasks: [{ id: 't2', name: 'T2', behavior: 'f' }],
			},
		],
	}
}

/** Builds or drives the workflow fixture through its public lifecycle. */
export function completeTask(workflow: WorkflowInterface, phase: string, task: string): void {
	const leaf = workflow.phase(phase)?.task(task)
	leaf?.start()
	leaf?.complete('ok')
}

/** Builds or drives the workflow fixture through its public lifecycle. */
export function buildEmptyWorkflow(bail: boolean): WorkflowDefinition {
	return { id: 'wf', name: 'WF', bail, phases: [] }
}

/** Builds or drives the workflow fixture through its public lifecycle. */
export function buildMultiPhaseWorkflow(count: number): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		bail: false,
		phases: Array.from({ length: count }, (_unused, index) => ({
			id: `p${index}`,
			name: `P${index}`,
			tasks: [{ id: `t${index}`, name: `T${index}`, behavior: 'f' }],
		})),
	}
}

/** Returns the fixed handler result used to compare registry identity. */
export function returnWorkflowValue(): string {
	return 'value'
}

/** Builds or resolves a phase fixture through the real workflow tree. */
export function buildPhaseWorkflow(count: number): WorkflowDefinition {
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
					behavior: 'f',
				})),
			},
		],
	}
}

/** Builds or resolves a phase fixture through the real workflow tree. */
export function requireWorkflowPhase(workflow: WorkflowInterface): PhaseInterface {
	const phase = workflow.phase('p')
	if (phase === undefined) throw new Error('expected the lone phase to exist')
	return phase
}

/** Builds or resolves a phase fixture through the real workflow tree. */
export function buildMixedBailWorkflow(): WorkflowDefinition {
	return {
		id: 'wf',
		name: 'WF',
		bail: false,
		phases: [
			{
				id: 'strict',
				name: 'Strict',
				bail: true,
				tasks: [{ id: 't', name: 'T', behavior: 'f' }],
			},
			{
				id: 'inherit',
				name: 'Inherit',
				tasks: [{ id: 't', name: 'T', behavior: 'f' }],
			},
		],
	}
}

/** Builds a unit controller over its real abort boundary and supplied spawn callback. */
export function buildController<TInput, TResult>(
	input: TInput,
	spawn: (input: TInput) => Promise<TResult> = rejectWorkflowSpawn,
): WorkflowControllerFixture<TInput, TResult> {
	const id = crypto.randomUUID()
	const abort = createAbort()
	const controller = new Controller<TInput, TResult>(id, input, abort, abort.signal, spawn)
	return { controller, id }
}

/** Rejects an unconfigured fixture spawn. */
export function rejectWorkflowSpawn(): Promise<never> {
	return Promise.reject(new Error('no spawn'))
}

/** Builds a substrate runner over live task fixtures. */
export function buildPhaseRunner(): RunnerInterface<TaskInterface, void> {
	return createRunner<TaskInterface, void>({ handler: () => undefined })
}

/** Builds a scripted storage boundary with absent reads and inert deletes by default. */
export function buildWorkflowStore(store: Partial<WorkflowStoreInterface>): WorkflowStoreInterface {
	return {
		get: () => Promise.resolve(undefined),
		set: () => Promise.resolve(),
		delete: () => Promise.resolve(),
		...store,
	}
}

/** Supplies the durability workflow fixture. */
export const DEFINITION: WorkflowDefinition = {
	id: 'durable',
	name: 'Durable',
	bail: false,
	phases: [
		{
			id: 'phase',
			name: 'Phase',
			tasks: [{ id: 'task', name: 'Task', behavior: 'work', retries: 1 }],
		},
	],
}

/** Creates a runner paced by the real scheduler fixture. */
export function createDurabilityRunner(): ReturnType<typeof createWorkflowRunner> {
	return createWorkflowRunner({ scheduler: createRecordingScheduler() })
}

/** Returns the durability fixture's required leaf snapshot. */
export function readDurabilityTask(
	snapshot: WorkflowSnapshot,
): WorkflowSnapshot['phases'][number]['tasks'][number] {
	const task = snapshot.phases[0]?.tasks[0]
	if (task === undefined) throw new Error('expected task snapshot')
	return task
}

/** Holds the value observed by callbacks during one workflow test. */
export class WorkflowObservation<T> {
	#value: T

	constructor(value: T) {
		this.#value = value
	}

	get value(): T {
		return this.#value
	}

	set value(value: T) {
		this.#value = value
	}
}

/** Lists the invalid task activity frames the cloner and guard boundary tests share. */
export const INVALID_TASK_ACTIVITIES: ReadonlyArray<readonly [input: unknown]> = Object.freeze([
	[{ note: '' }],
	[{ progress: { progress: Number.NaN } }],
	[{ progress: { progress: -1 } }],
	[{ progress: { progress: 2, total: 1 } }],
	[{ progress: { progress: 1, message: '' } }],
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
	[{ progress: { progress: 1, total: Number.NaN } }],
])

// ── Recorded event names (the second type argument `createRecorders` cannot infer) ───────
//
// `@orkestrel/test`'s `createRecorders` takes its event map as an explicit type argument,
// because that map appears only inside the source's generic `on` method and so offers the
// checker no inference candidate. Naming the map forces its event-name union to be named
// too, which TypeScript cannot infer separately. Each union below derives from the constant
// beside it, so the pair cannot drift: a name missing from the constant is missing from the
// union, and a call site reading that recorder stops at the typecheck rather than at runtime.

/** Lists every {@link import('@src/core').WorkflowEventMap} event name, in declaration order. */
export const WORKFLOW_EVENTS = Object.freeze([
	'start',
	'complete',
	'fail',
	'pause',
	'resume',
	'skip',
	'stop',
	'add',
	'remove',
	'move',
	'update',
] as const)

/** Names one recorded workflow event. */
export type WorkflowEvent = (typeof WORKFLOW_EVENTS)[number]

/** Lists every {@link import('@src/core').PhaseEventMap} event name, in declaration order. */
export const PHASE_EVENTS = Object.freeze([
	'start',
	'complete',
	'fail',
	'pause',
	'resume',
	'skip',
	'stop',
	'add',
	'remove',
	'move',
	'update',
] as const)

/** Names one recorded phase event. */
export type PhaseEvent = (typeof PHASE_EVENTS)[number]

/** Lists every {@link import('@src/core').TaskEventMap} event name, in declaration order. */
export const TASK_EVENTS = Object.freeze([
	'start',
	'complete',
	'fail',
	'pause',
	'resume',
	'skip',
	'stop',
	'report',
	'pulse',
	'silence',
] as const)

/** Names one recorded task event. */
export type TaskEvent = (typeof TASK_EVENTS)[number]

/** Lists every {@link import('@src/core').RunnerEventMap} event name, in declaration order. */
export const RUNNER_EVENTS = Object.freeze([
	'start',
	'unit',
	'spawn',
	'settle',
	'fail',
	'finish',
	'abort',
] as const)

/** Names one recorded runner event. */
export type RunnerEvent = (typeof RUNNER_EVENTS)[number]

/** Copies a task snapshot while omitting its exact-optional activity field. */
export function omitTaskActivity(snapshot: TaskSnapshot): TaskSnapshot {
	return {
		id: snapshot.id,
		name: snapshot.name,
		...(snapshot.description === undefined ? {} : { description: snapshot.description }),
		status: snapshot.status,
		...(snapshot.result === undefined ? {} : { result: snapshot.result }),
		metadata: snapshot.metadata,
		attempts: snapshot.attempts,
		...(snapshot.behavior === undefined ? {} : { behavior: snapshot.behavior }),
		...(snapshot.retries === undefined ? {} : { retries: snapshot.retries }),
		...(snapshot.timeout === undefined ? {} : { timeout: snapshot.timeout }),
	}
}

// ── Environment-agnostic base setup ───────────────────────────────────────────
//
// Loaded first by every test project (`vite.config.ts` `setupFiles[0]`). Holds ONLY
// helpers with no `node:*` / DOM dependency, so it is safe for `src:core`,
// `src:browser`, and `src:server` alike. Environment-specific helpers live in their
// own matching setup file (`setupBrowser.ts`, `setupServer.ts`).

/** Resolves a required live task fixture, or throws a fixture-construction error. */
export function requireTask(
	workflow: WorkflowInterface,
	phase: string,
	task: string,
): TaskInterface {
	return requireValue(workflow.phase(phase)?.task(task), `expected task '${phase}/${task}'`)
}

/** Builds a real TaskController over a live task for direct handle tests. */
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
 * Controls store settlement through queued gates, as a scripted real
 * {@link WorkflowStoreInterface} boundary whose readonly histories expose the exact durable calls
 * made by a test.
 */
export class WorkflowStoreBoundary implements WorkflowStoreInterface {
	readonly #reads: Array<PromiseWithResolvers<WorkflowSnapshot | undefined>>
	readonly #writes: Array<PromiseWithResolvers<void>>
	readonly #gets: string[] = []
	readonly #sets: WorkflowSnapshot[] = []
	readonly #deletes: string[] = []

	constructor(
		reads: ReadonlyArray<PromiseWithResolvers<WorkflowSnapshot | undefined>> = [],
		writes: ReadonlyArray<PromiseWithResolvers<void>> = [],
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

/** Implements a real budget boundary whose signal getter throws the supplied setup failure. */
export class FaultBudget implements BudgetInterface<TokenUsage> {
	readonly id = 'fault-budget'
	readonly max = 10
	readonly consumed = 7
	readonly remaining = 3
	readonly exhausted = false
	readonly #failure: unknown
	#starts = 0
	#clears = 0

	constructor(fault: unknown) {
		this.#failure = fault
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
// When a test only needs to count calls or inspect arguments, use a
// recorder — a real listener that records every invocation — rather than a test-
// framework spy. `handler` is a genuine callback; `calls` is each invocation's
// argument tuple, in order. The recorder itself is `@orkestrel/test`'s; what stays
// here is the emitter-error channel's argument order, named once.

/**
 * Creates a recorder for an {@link import('@orkestrel/emitter').EmitterErrorHandler} — the
 * emitter's own listener-error channel: a `RecorderInterface<[error, event]>`
 * whose `handler` is wired as the `error` option, so an emit-safety test asserts a buggy
 * listener's throw was routed here (with the offending event name) instead of corrupting the
 * entity. Argument order is `(error, event)`, matching `EmitterErrorHandler` — the invariant
 * this fixes once for every emit-safety block, over `@orkestrel/test`'s {@link createRecorder}.
 *
 * @returns A recorder of `[error: unknown, event: string]` calls
 */
export function createErrorRecorder(): RecorderInterface<readonly [error: unknown, event: string]> {
	return createRecorder<readonly [error: unknown, event: string]>()
}

// ── Signal instrumentation (a real AbortSignal, wrapped) ──────────────────────

/** Records a real {@link AbortSignal}'s `'abort'` listener bookkeeping — adds against removes. */
export interface SignalListenerCountsInterface {
	/** A recorder of `'abort'` `addEventListener` calls on the instrumented signal. */
	readonly added: RecorderInterface<readonly [string]>
	/** A recorder of `'abort'` `removeEventListener` calls on the instrumented signal. */
	readonly removed: RecorderInterface<readonly [string]>
}

/**
 * Instruments a REAL {@link AbortSignal}'s listener bookkeeping by wrapping its own
 * `addEventListener` / `removeEventListener` (delegating to the genuine implementation) and
 * counting `'abort'` adds and removes — so a test can prove a scheduler / primitive detaches
 * every abort listener it attaches (no leak), counting on the real signal rather than mocking
 * the unit under test. Environment-agnostic — `AbortSignal` exists in node and
 * the browser alike, so it lives in the shared setup.
 *
 * Local rather than `@orkestrel/test`'s `createSignal`, on two differences the swap would lose.
 * `createSignal` builds its own `AbortController` and instruments only that signal, while every
 * site here instruments a signal the unit under test produced — `workflow.signal`, and the
 * `controller.signal` a live `WorkflowFunction` receives. `createSignal` also reports one live
 * `count` (adds minus removes), which reads `0` both for a signal nothing ever subscribed to and
 * for one whose listeners were attached and detached; the leak proofs assert those apart, through
 * `added.count` above zero alongside `added.count === removed.count`.
 *
 * @param signal - The signal to instrument in place (its methods are wrapped)
 * @returns The `added` / `removed` recorders, each incremented per `'abort'` add / remove
 */
export function instrumentSignal(signal: AbortSignal): SignalListenerCountsInterface {
	const added = createRecorder<readonly [string]>()
	const removed = createRecorder<readonly [string]>()
	const realAdd = signal.addEventListener.bind(signal)
	const realRemove = signal.removeEventListener.bind(signal)
	signal.addEventListener = recordWorkflowListener.bind(undefined, added, realAdd)
	signal.removeEventListener = recordWorkflowListener.bind(undefined, removed, realRemove)
	return { added, removed }
}

/** Records an abort-listener operation before invoking its bound native method. */
export function recordWorkflowListener(
	recorder: RecorderInterface<readonly [string]>,
	operation: AbortSignal['addEventListener'],
	type: string,
	listener: EventListenerOrEventListenerObject,
	options?: boolean | AddEventListenerOptions,
): void {
	if (type === 'abort') recorder.handler(type)
	operation(type, listener, options)
}

// ── Recording scheduler (a real SchedulerInterface, wrapped) ────────────────────

/** Records how many real turn boundaries a {@link SchedulerInterface}'s `yield` paced. */
export interface RecordingSchedulerInterface extends SchedulerInterface {
	/** How many times `yield` ran — the turn boundaries the loop paced through this scheduler. */
	readonly yields: number
}

/** Wraps one shipped scheduler instance as a recorder. */
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
 * Creates a {@link RecordingSchedulerInterface} that counts `yield` calls before delegating
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
// The recurring real {@link WorkflowDefinition} stubs the workflow tests
// build, plus the deterministic settle helper that drives one through the real runner.
// All plain `@src/core` data + the shipped `createWorkflowRunner` (no `node:*`, no DOM),
// so they load in every project. A test keeps only its env-/scenario-specific bits local
// (its own driver creation, a bespoke per-test definition).

/**
 * Builds a real, valid {@link WorkflowDefinition} stub — a workflow with two phases, one task of
 * each `via` form, a `concurrency` throttle, and an explicit `bail`. Apply `overrides` to
 * produce a variant. The shared base the contract / factory / W-b entity tests build on (the
 * live tree is built from this), so the definition shape stays in one place.
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
					{ id: 'task-compile', name: 'Compile', behavior: 'compile' },
					{
						id: 'task-scan',
						name: 'Scan',
						description: 'Security scan',
						behavior: 'scanner',
					},
				],
			},
			{
				id: 'phase-review',
				name: 'Review',
				tasks: [{ id: 'task-audit', name: 'Audit', behavior: 'auditor' }],
			},
		],
		...overrides,
	}
}

/**
 * Returns the live tasks a fresh {@link buildWorkflowDefinition} tree holds, in the tuple order
 * `phase-build/task-compile`, `phase-build/task-scan`, `phase-review/task-audit`. Each is a real
 * `pending` task minted by the shipped {@link createWorkflow}, so a store test drives genuine
 * entities with real ids and statuses rather than hand-rolled stand-ins. Every call mints a fresh
 * tree, so one test's transitions cannot reach another test's tasks.
 *
 * @returns The live compile, scan, and audit tasks, in that positional order
 */
export function buildTasks(): readonly [TaskInterface, TaskInterface, TaskInterface] {
	const workflow = createWorkflow(buildWorkflowDefinition())
	return [
		requireTask(workflow, 'phase-build', 'task-compile'),
		requireTask(workflow, 'phase-build', 'task-scan'),
		requireTask(workflow, 'phase-review', 'task-audit'),
	]
}

/**
 * Returns an empty {@link Collection} over live tasks, gated by the shipped `taskUpdateShape`
 * compiled through the real {@link compileGuard} — the gated store the
 * {@link import('@src/core').PhaseManager} and {@link import('@src/core').TaskManager} hold, built
 * the way production builds it, so a refusal a test reads is the store's own rather than a
 * fixture's. `noun` reaches the real constructor unchanged, so a test can read the vocabulary a
 * refusal message names.
 *
 * @param noun - The entity noun every refusal message names. Default: `'task'`
 * @returns A fresh collection holding no entries
 */
export function buildCollection(noun = 'task'): Collection<TaskInterface, TaskUpdate> {
	return new Collection<TaskInterface, TaskUpdate>(noun, compileGuard(taskUpdateShape))
}

/**
 * Builds a real two-phase `release` {@link WorkflowDefinition} (≥1 task each) — phase `build` runs
 * two `function` tasks concurrently, phase `ship` a third in a later phase. The handlers are
 * registered on the runner BY NAME (see {@link RELEASE_FUNCTIONS}), so a settled run records
 * real `completed` statuses + results. The shared store-test fixture both the Memory and the
 * Database `WorkflowStore` twins drive (one stub, not a per-file copy).
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
					{ id: 'compile', name: 'Compile', behavior: 'compile' },
					{ id: 'lint', name: 'Lint', behavior: 'lint' },
				],
			},
			{
				id: 'ship',
				name: 'Ship',
				tasks: [{ id: 'publish', name: 'Publish', behavior: 'publish' }],
			},
		],
	}
}

/**
 * Holds the registered behaviors a {@link buildReleaseDefinition}'s tasks dispatch to BY NAME —
 * each a real {@link WorkflowFunction} returning a distinct value, so a settled snapshot carries
 * real boxed results (a real handler map shared by the store twins, never a mock).
 */
export const RELEASE_FUNCTIONS: Readonly<Record<string, WorkflowFunction>> = {
	compile: (controller) => `built ${controller.task.id}`,
	lint: () => 'clean',
	publish: () => ({ released: true }),
}

/**
 * Drives a `definition` to a SETTLED {@link WorkflowSnapshot} through the real runner — the live
 * tree is built, executed (phases sequential, tasks concurrent through {@link RELEASE_FUNCTIONS}),
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

/**
 * Reports whether a repository-relative Vue SFC path belongs to the private browser application.
 */
export function isBrowserVuePath(path: string): boolean {
	const normalized = path.replaceAll('\\', '/')
	return normalized.startsWith('app/browser/')
}

/** Builds the lifecycle derivation fixture. */
export function buildPhaseDerivations(
	statuses: readonly LifecycleStatus[],
	bail: boolean,
): readonly PhaseDerivation[] {
	return statuses.map((status) => ({ status, bail }))
}

/** Builds the lifecycle derivation fixture. */
export function enumerateStatusOrders<T>(items: readonly T[]): ReadonlyArray<readonly T[]> {
	if (items.length <= 1) return [items]
	const out: T[][] = []
	for (const [index, item] of items.entries()) {
		const rest = [...items.slice(0, index), ...items.slice(index + 1)]
		for (const permutation of enumerateStatusOrders(rest)) out.push([item, ...permutation])
	}
	return out
}

/** Builds a positional task-result fixture. */
export function buildCompletedResult(id: string): TaskResult {
	return {
		task: { id, name: id, phase: { id: 'p', name: 'P', workflow: { id: 'w', name: 'W' } } },
		phase: { id: 'p', name: 'P', workflow: { id: 'w', name: 'W' } },
		workflow: { id: 'w', name: 'W' },
		status: 'completed',
		timestamp: 0,
	}
}

/** Builds a positional task-result fixture. */
export function buildOutcomeResult(id: string, ok: boolean): TaskResult {
	return {
		task: { id, name: id, phase: { id: 'p', name: 'P', workflow: { id: 'w', name: 'W' } } },
		phase: { id: 'p', name: 'P', workflow: { id: 'w', name: 'W' } },
		workflow: { id: 'w', name: 'W' },
		status: ok ? 'completed' : 'failed',
		result: ok ? success('v') : failure({ origin: 'handler', message: `${id} failed` }),
		timestamp: 0,
	}
}

/** Supplies the lifecycle recovery fixture. */
export const EVERY_STATUS: readonly LifecycleStatus[] = [
	'pending',
	'running',
	'completed',
	'failed',
	'skipped',
	'stopped',
]

/** Supplies the lifecycle recovery fixture. */
export const RECOVERY_DEFINITION: WorkflowDefinition = {
	id: 'durable',
	name: 'Durable',
	bail: false,
	phases: [
		{
			id: 'phase',
			name: 'Phase',
			tasks: [{ id: 'task', name: 'Task', behavior: 'work', retries: 1 }],
		},
	],
}

/** Supplies the lifecycle recovery fixture. */
export const VALIDATED_FUNCTIONS = { work: () => 'validated' }

/** Supplies the lifecycle recovery fixture. */
export const RECOVERY_SHIFTED_FUNCTIONS = { work: () => 'shifted' }

/** Lists lifecycle derivation cases. */
export const PHASE_STATUS_CASES: readonly WorkflowLifecycleCase[] = [
	// — empty + all-pending (→ pending)
	[[], 'pending', 'no tasks'],
	[['pending'], 'pending', 'single pending'],
	[['pending', 'pending'], 'pending', 'all pending'],
	// — any non-terminal among the set (→ running): a started-but-unsettled phase
	[['running'], 'running', 'single running'],
	[['running', 'pending'], 'running', 'running + pending'],
	[['running', 'running'], 'running', 'all running'],
	[['completed', 'pending'], 'running', 'terminal + pending (not all settled)'],
	[['failed', 'pending'], 'running', 'failed + pending (still not all settled)'],
	[['skipped', 'pending'], 'running', 'skipped + pending'],
	[['stopped', 'pending'], 'running', 'stopped + pending'],
	[['completed', 'running'], 'running', 'completed + running'],
	[['failed', 'running'], 'running', 'failed + running (failed does NOT settle the phase)'],
	[['failed', 'completed', 'pending'], 'running', 'two terminals + a straggler pending'],
	// — all-terminal: single child of each terminal kind
	[['completed'], 'completed', 'single completed'],
	[['failed'], 'failed', 'single failed'],
	[['skipped'], 'skipped', 'single skipped'],
	[['stopped'], 'stopped', 'single stopped'],
	// — all-terminal severity ordering, discriminating ADJACENT pairs
	[['failed', 'stopped'], 'failed', 'failed > stopped'],
	[['stopped', 'completed'], 'stopped', 'stopped > completed'],
	[['completed', 'skipped'], 'completed', 'completed > skipped (skips never fail a phase)'],
	// — all-terminal severity ordering, NON-adjacent pairs (the relation is transitive)
	[['failed', 'completed'], 'failed', 'failed > completed'],
	[['failed', 'skipped'], 'failed', 'failed > skipped'],
	[['stopped', 'skipped'], 'stopped', 'stopped > skipped'],
	// — all-terminal homogeneous (the lowest-severity all-same cases)
	[['completed', 'completed'], 'completed', 'all completed'],
	[['skipped', 'skipped'], 'skipped', 'all skipped'],
	[['stopped', 'stopped'], 'stopped', 'all stopped'],
	[['failed', 'failed'], 'failed', 'all failed'],
	// — the full mix (every terminal present → the most severe, failed)
	[['failed', 'skipped', 'stopped', 'completed'], 'failed', 'all four terminals'],
	[['stopped', 'completed', 'skipped'], 'stopped', 'three terminals, no failure → stopped'],
	[['completed', 'skipped', 'completed'], 'completed', 'completes + skips → completed'],
]

/** Lists lifecycle derivation cases. */
export const WORKFLOW_STATUS_CASES: ReadonlyArray<{
	readonly input: readonly LifecycleStatus[]
	readonly bail: boolean
	readonly expected: LifecycleStatus
	readonly label: string
}> = [
	// ── bail: true (halt) — a failed phase short-circuits to `failed`, even mid-flight ──
	{ input: ['failed'], bail: true, expected: 'failed', label: 'single failed halts' },
	{
		input: ['completed', 'failed'],
		bail: true,
		expected: 'failed',
		label: 'a failure among completes halts',
	},
	{
		input: ['failed', 'pending'],
		bail: true,
		expected: 'failed',
		label: 'failed + pending: halts BEFORE the all-pending check',
	},
	{
		input: ['failed', 'running'],
		bail: true,
		expected: 'failed',
		label: 'failed + running: the failed short-circuit fires BEFORE the running check',
	},
	{
		input: ['failed', 'stopped'],
		bail: true,
		expected: 'failed',
		label: 'failed beats stopped under halt',
	},
	{ input: ['failed', 'failed'], bail: true, expected: 'failed', label: 'all failed halts' },
	{
		input: ['failed', 'skipped'],
		bail: true,
		expected: 'failed',
		label: 'failed beats skipped under halt',
	},
	// ── bail: false (graceful) — a failed phase is DATA; the workflow NEVER derives `failed` ──
	{
		input: ['failed'],
		bail: false,
		expected: 'completed',
		label: 'single failed folds into completed',
	},
	{
		input: ['completed', 'failed'],
		bail: false,
		expected: 'completed',
		label: 'failure folded into completion',
	},
	{
		input: ['failed', 'pending'],
		bail: false,
		expected: 'running',
		label: 'failed + pending: NOT all terminal ⇒ running (failed does not short-circuit)',
	},
	{
		input: ['failed', 'running'],
		bail: false,
		expected: 'running',
		label: 'failed + running: NOT all terminal ⇒ running (THE graceful→running case)',
	},
	{
		input: ['failed', 'stopped'],
		bail: false,
		expected: 'stopped',
		label: 'a stop still beats a folded failure',
	},
	{
		input: ['failed', 'failed'],
		bail: false,
		expected: 'completed',
		label: 'all failed still completes gracefully',
	},
	{
		input: ['failed', 'skipped'],
		bail: false,
		expected: 'completed',
		label: 'failed folds to completed even with only skips beside it',
	},
]

/** Lists lifecycle derivation cases. */
export const WORKFLOW_AGNOSTIC_CASES: readonly WorkflowLifecycleCase[] = [
	[[], 'pending', 'no phases'],
	[['pending'], 'pending', 'single pending'],
	[['pending', 'pending'], 'pending', 'all pending'],
	[['running'], 'running', 'single running'],
	[['running', 'pending'], 'running', 'running + pending'],
	[['completed', 'pending'], 'running', 'terminal + pending (started, not all settled)'],
	[['completed', 'running'], 'running', 'terminal + running (started, not all settled)'],
	[['completed'], 'completed', 'single completed'],
	[['completed', 'completed'], 'completed', 'all completed'],
	[['completed', 'skipped'], 'completed', 'completes + skips → completed'],
	[['skipped'], 'skipped', 'single skipped'],
	[['skipped', 'skipped'], 'skipped', 'all skipped'],
	[['stopped'], 'stopped', 'single stopped'],
	[['stopped', 'stopped'], 'stopped', 'all stopped'],
	[['stopped', 'completed'], 'stopped', 'stopped beats completed'],
	[['stopped', 'skipped'], 'stopped', 'stopped beats skipped'],
]

/** Builds a value whose string conversion throws. */
export function buildHostileString(): { readonly toString: () => string } {
	return {
		toString: () => {
			throw new Error('hostile string')
		},
	}
}

/** Builds a snapshot candidate with an own enumerable hostile identifier accessor. */
export function buildHostileWorkflow(): { readonly id: string } {
	return {
		get id(): string {
			throw new Error('accessor must not run')
		},
	}
}

/** Supplies independently resolved recovery behaviors. */
export const RECOVERY_MIXED_FUNCTIONS = {
	first: () => 'first',
	done: () => 'done',
	interrupted: () => 'interrupted',
}

/** Counts invocation of the restored work behavior. */
export function buildCountedRegistry(calls: WorkflowObservation<number>): WorkflowRegistry {
	return {
		work: () => {
			calls.value += 1
			return null
		},
	}
}

/** Builds the definition used by factory restoration proofs. */
export function buildFactoryDefinition(
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
					{ id: 'task-compile', name: 'Compile', behavior: 'compile', retries: 2, timeout: 500 },
					{ id: 'task-scan', name: 'Scan', description: 'Security scan', behavior: 'scan' },
				],
			},
			{
				id: 'phase-review',
				name: 'Review',
				tasks: [{ id: 'task-audit', name: 'Audit', behavior: 'audit' }],
			},
		],
		...overrides,
	}
}

/** Supplies the factory behavior registry. */
export const FACTORY_RESTORE_FUNCTIONS = {
	compile: () => null,
	scan: () => null,
	audit: () => null,
}

/** Supplies the factory behavior registry. */
export const FACTORY_SHIFTED_FUNCTIONS = {
	compile: () => 'shifted compile',
	scan: () => 'shifted scan',
	audit: () => 'shifted audit',
}

/** Returns the deterministic seed used by contract generation. */
export function returnWorkflowSeed(): number {
	return 0.42
}

/** Bounds real asynchronous workflow round trips. */
export const ROUND_TRIP_TIMEOUT_MS = 30_000

/** Supplies store restoration behaviors. */
export const STORE_RESTORE_FUNCTIONS = {
	...RELEASE_FUNCTIONS,
	scanner: () => null,
	auditor: () => null,
	f: () => null,
}

/** Lists pending and settled store round-trip cases. */
export const STORE_SNAPSHOT_CASES: readonly WorkflowSnapshotCase[] = [
	['all-pending (createWorkflow)', async () => createWorkflow(buildReleaseDefinition()).snapshot()],
	['settled (runner.execute)', () => settleSnapshot(buildReleaseDefinition())],
]

/** Builds a definition with the requested optional phase and task fields. */
export function buildFieldDefinition(overrides: {
	readonly bail?: boolean
	readonly retries?: number
	readonly timeout?: number
}): WorkflowDefinition {
	return {
		id: 'w',
		name: 'W',
		phases: [
			{
				id: 'p',
				name: 'P',
				...(overrides.bail === undefined ? {} : { bail: overrides.bail }),
				tasks: [
					{
						id: 't',
						name: 'T',
						behavior: 'f',
						...(overrides.retries === undefined ? {} : { retries: overrides.retries }),
						...(overrides.timeout === undefined ? {} : { timeout: overrides.timeout }),
					},
				],
			},
		],
	}
}

/** Supplies the workflow restoration behavior. */
export const WORKFLOW_RESTORE_FUNCTIONS = { f: () => null }

/** Supplies real memory and database storage implementations. */
export const WORKFLOW_STORE_CASES: readonly WorkflowStoreCase[] = [
	['MemoryWorkflowStore', () => createMemoryWorkflowStore()],
	['DatabaseWorkflowStore', () => createDatabaseWorkflowStore(createMemoryDriver())],
]

/** Describes a pending or settled snapshot fixture. */
export type WorkflowSnapshotCase = readonly [string, () => Promise<WorkflowSnapshot>]

/** Describes a lifecycle truth-table row. */
export type WorkflowLifecycleCase = readonly [readonly LifecycleStatus[], LifecycleStatus, string]

/** Describes a real storage implementation factory. */
export type WorkflowStoreCase = readonly [
	string,
	() => ReturnType<typeof createMemoryWorkflowStore>,
]

/** Describes an activity timestamp accessor fixture. */
export interface WorkflowActivityStamp {
	readonly operations: readonly unknown[]
	readonly constraints?: readonly unknown[]
	readonly updated: number
}

/** Describes a claim with a shifting identifier accessor. */
export interface WorkflowClaimFixture {
	readonly id: string
	readonly name: string
	readonly started: number
}

/** Describes the abort callback a parked task fixture records. */
export interface WorkflowAbortRecorder {
	readonly handler: (id: string) => void
}

/** Describes a controller fixture with its generated identifier. */
export interface WorkflowControllerFixture<TInput, TResult> {
	readonly controller: ControllerInterface<TInput, TResult>
	readonly id: string
}

/** Lists the durability failure cases. */
export const PERSISTENCE_FAILURE_CASES = [
	{ call: 1, checkpoint: 'initial', dispatched: false, status: 'stopped', durable: true },
	{ call: 3, checkpoint: 'attempt', dispatched: false, status: 'stopped', durable: true },
	{ call: 5, checkpoint: 'settlement', dispatched: true, status: 'completed', durable: true },
	{ call: 6, checkpoint: 'final', dispatched: true, status: 'completed', durable: false },
]

/** Lists the recovery policy cases. */
export const RECOVERY_POLICY_CASES = [
	{
		bail: true,
		expected: ['skipped', 'failed', 'skipped', 'skipped'],
		later: 'skipped',
	},
	{
		bail: false,
		expected: ['pending', 'failed', 'pending', 'pending'],
		later: 'pending',
	},
]

/** Lists the hierarchy tiers observed by durability. */
export const PERSISTENCE_TIER_CASES = ['workflow', 'phase']

/** Lists the workflow bail policies. */
export const WORKFLOW_BAIL_CASES = [false, true]

/** Lists commands that force a future phase to terminate. */
export const WORKFLOW_TERMINAL_COMMANDS = ['skip', 'stop']

/** Lists values outside the lifecycle vocabulary. */
export const INVALID_LIFECYCLE_VALUES: readonly unknown[] = [
	undefined,
	null,
	'',
	'complete',
	1,
	{},
	[],
]

/** Lists malformed task failures for normalization. */
export const INVALID_TASK_FAILURES = [
	{ origin: 'other', message: '' },
	{ origin: 'handler', message: 1 },
]

/** Lists falsy JSON values that remain present task results. */
export const FALSY_TASK_VALUES = [null, 0, '', false]

/** Supplies a non-plain activity object for the cloner boundary. */
export class WorkflowActivityFixture {
	readonly operations: readonly unknown[] = []
}

/** Lists unknown-key and class-instance activity refusals. */
export const FOREIGN_ACTIVITY_VALUES = [
	{ operations: [], extra: true },
	{ progress: { progress: 1, extra: true } },
	{ operations: [{ id: 'op', name: 'Operation', started: 0, extra: true }] },
	{ constraints: [{ id: 'constraint', name: 'Constraint', started: 0, extra: true }] },
	new WorkflowActivityFixture(),
]
