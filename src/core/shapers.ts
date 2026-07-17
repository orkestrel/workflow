import {
	arrayShape,
	integerShape,
	literalShape,
	objectShape,
	optionalShape,
	stringShape,
} from '@orkestrel/contract'

// Workflow contract shapes — the shape VALUES the contract (factories.ts) compiles
// into the four lockstep outputs (JSON Schema + guard + parser + generator). These
// shapes MUST agree with the hand-written definition interfaces (types.ts), which
// are the source of truth (AGENTS §14): a valid `WorkflowDefinition` is accepted by
// the compiled `is` / `parse`, and the seeded `generate` produces a valid one.
//
// The definition interfaces stay hand-written rather than `Infer`-derived from
// these shapes — the databases module already hit TS2589 on nested `objectShape`
// generics, and this tree nests three levels (workflow → phase → task → form), so
// the shapes are consumed as plain `ContractShape` runtime descriptors and the
// contract is typed `ContractInterface<WorkflowDefinition>` at the factory.
//
// Per-field `description`s ride INSIDE the advertised JSON Schema (compilers.ts
// `compileSchema` emits a shape's `description` verbatim) — advisory metadata only: it
// never changes what the guard / parser accept (the contract stays byte-for-byte strict).

// The description-carrying `bail` toggle rides on the shared `literalShape` (the
// `@orkestrel/contract` module) — a described single-value literal is just
// `literalShape([value], { description })`, so no module-local helper is needed.

/**
 * The shape of a {@link import('./types.js').TaskDefinition} — identity plus an optional
 * `run` behavior reference (a plain registry-key string, min length 1). `description` is
 * optional prose.
 */
export const taskShape = objectShape({
	id: stringShape({ min: 1, description: 'Unique task id within its phase.' }),
	name: stringShape({ min: 1, description: 'Human-readable task name.' }),
	description: optionalShape(stringShape({ description: 'Optional task description.' })),
	run: optionalShape(
		stringShape({
			min: 1,
			description:
				'The registered behavior name to invoke (a registry key, not a label); omitted has no handler.',
		}),
	),
	retries: optionalShape(
		integerShape({
			min: 0,
			description:
				'Extra attempts after the first on failure; overrides the phase default. Omitted means none.',
		}),
	),
	timeout: optionalShape(
		integerShape({
			min: 0,
			description:
				'Per-attempt deadline in milliseconds; overrides the phase default. Omitted means no deadline.',
		}),
	),
})

/**
 * The shape of a {@link import('./types.js').PhaseDefinition} — identity, its ordered
 * {@link taskShape} tasks, and an optional positive-integer `concurrency` throttle
 * (max tasks in flight; omitted ⇒ unbounded).
 */
export const phaseShape = objectShape({
	id: stringShape({ min: 1, description: 'Unique phase id within the workflow.' }),
	name: stringShape({ min: 1, description: 'Human-readable phase name.' }),
	description: optionalShape(stringShape({ description: 'Optional phase description.' })),
	tasks: arrayShape(taskShape, { description: 'The phase tasks; they run CONCURRENTLY.' }),
	concurrency: optionalShape(
		integerShape({
			min: 1,
			description: 'Max tasks in flight at once (a resource throttle); omitted means unbounded.',
		}),
	),
	bail: optionalShape(
		literalShape([true, false], {
			description: 'Per-phase failure-policy override; omitted inherits the workflow bail.',
		}),
	),
})

/**
 * The shape of a {@link import('./types.js').WorkflowDefinition} — the contract root:
 * identity, its ordered {@link phaseShape} phases, and the optional `bail` boolean
 * failure policy (the literal pair `true`/`false`, the runtime mirror of the boolean
 * toggle; omitted ⇒ the graceful default).
 */
export const workflowShape = objectShape({
	id: stringShape({ min: 1, description: 'Unique workflow id.' }),
	name: stringShape({ min: 1, description: 'Human-readable workflow name.' }),
	description: optionalShape(stringShape({ description: 'Optional workflow description.' })),
	phases: arrayShape(phaseShape, {
		description: 'The workflow phases; they run SEQUENTIALLY, in order.',
	}),
	bail: optionalShape(
		literalShape([true, false], {
			description:
				'Failure policy: false (default) continues gracefully, true halts on the first failure.',
		}),
	),
})

// === Update (patch) shapes — the mutation API's `update` payload validation
//
// These shapes validate a {@link import('./types.js').TaskUpdate} /
// {@link import('./types.js').PhaseUpdate} — a declarative PARTIAL edit to an
// existing `pending` entity (AGENTS §12), never a full replacement. Every field is
// therefore optional; a PROVIDED field still carries the same constraint as its
// creation-time counterpart (`taskShape` / `phaseShape`) so a patch cannot smuggle in
// an invalid value.

/**
 * The shape of a {@link import('./types.js').TaskUpdate} — a partial edit to a
 * `pending` task's `name` / `description`, both optional.
 *
 * @remarks
 * Mirrors {@link taskShape}'s `name` / `description` constraints exactly (a provided
 * `name` still has `minLength: 1`); never `id` / `run` / `retries` / `timeout` (those
 * are not patchable fields, AGENTS §12).
 */
export const taskUpdateShape = objectShape({
	name: optionalShape(stringShape({ min: 1, description: 'New task name.' })),
	description: optionalShape(stringShape({ description: 'New task description.' })),
})

/**
 * The shape of a {@link import('./types.js').PhaseUpdate} — a partial edit to a
 * `pending` phase's `name` / `description` / `concurrency` / `bail`, all optional.
 *
 * @remarks
 * Mirrors {@link phaseShape}'s corresponding field constraints exactly; never `id` /
 * `tasks` (structural children change through the phase's own `add` / `remove` /
 * `move`, not a patch, AGENTS §12).
 */
export const phaseUpdateShape = objectShape({
	name: optionalShape(stringShape({ min: 1, description: 'New phase name.' })),
	description: optionalShape(stringShape({ description: 'New phase description.' })),
	concurrency: optionalShape(
		integerShape({
			min: 1,
			description:
				'Max tasks in flight at once (a resource throttle); omitted leaves it unchanged.',
		}),
	),
	bail: optionalShape(
		literalShape([true, false], {
			description: 'Per-phase failure-policy override; omitted leaves it unchanged.',
		}),
	),
})
