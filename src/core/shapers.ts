import {
	arrayShape,
	integerShape,
	literalShape,
	objectShape,
	optionalShape,
	stringShape,
	unionShape,
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
// `compileSchema` emits a shape's `description` verbatim), so a small model authoring
// a tree through `createWorkflowTool` gets field-level guidance — especially on the
// `via` discriminant and the `run` union, which would otherwise be bare `enum`s with
// zero hint. The guidance is advisory metadata only: it never changes what the guard /
// parser accept (the contract stays byte-for-byte strict).

// The description-carrying `via` discriminant + `bail` toggle ride on the shared
// `literalShape` (the `@orkestrel/contract` module) — a described single-value literal
// is just `literalShape([value], { description })`, so no module-local helper is needed.

/**
 * The shape of a {@link import('./types.js').TaskForm} — a descriptive tagged union
 * over the three execution mechanisms, discriminated by the `via` literal (never a
 * bare `kind`; AGENTS §4.4). Each variant pairs the `via` discriminant with a `name`
 * (the registry key for the behavior).
 *
 * @remarks
 * The union and each `via` literal + `name` carry a `description` so the emitted JSON
 * Schema spells out what the discriminant means and that `name` is a REGISTERED key
 * (not a human label) — the field-level guidance a small model needs to fill `run`.
 */
export const taskFormShape = unionShape(
	objectShape({
		via: literalShape(['function'], { description: 'Run a registered workflow FUNCTION by name.' }),
		name: stringShape({
			min: 1,
			description: 'The registered function name to invoke (a registry key, not a label).',
		}),
	}),
	objectShape({
		via: literalShape(['tool'], { description: 'Run a registered TOOL by name.' }),
		name: stringShape({
			min: 1,
			description: 'The registered tool name to invoke (a registry key, not a label).',
		}),
	}),
	objectShape({
		via: literalShape(['agent'], { description: 'Run a registered AGENT (a subagent) by name.' }),
		name: stringShape({
			min: 1,
			description: 'The registered agent name to invoke (a registry key, not a label).',
		}),
	}),
)

/**
 * The shape of a {@link import('./types.js').TaskDefinition} — identity plus the
 * behavior reference ({@link taskFormShape}). `description` is optional prose.
 */
export const taskShape = objectShape({
	id: stringShape({ min: 1, description: 'Unique task id within its phase.' }),
	name: stringShape({ min: 1, description: 'Human-readable task name.' }),
	description: optionalShape(stringShape({ description: 'Optional task description.' })),
	run: taskFormShape,
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

// === Draft + flat-steps shapes (the tool's LENIENT authoring surfaces)
//
// These shapes are NOT part of the canonical `WorkflowDefinition` contract — they are
// the WIDENED authoring surfaces `createWorkflowTool` accepts so a small model can
// author a complete tree without emitting the full strict form. Both converge on the
// STRICT `createWorkflowContract().is` gate after expansion/completion (factories.ts),
// so soundness is preserved: the canonical contract stays unchanged and strict.

/**
 * The shape of a TASK in a draft workflow — identical to {@link taskShape} EXCEPT `id`
 * and `name` are OPTIONAL (the tool synthesizes any missing one positionally).
 *
 * @remarks
 * A PROVIDED `id` / `name` still carries `minLength: 1`, so an explicitly-empty `id: ''`
 * is INVALID (rejected by the draft contract), never auto-filled — keeping "garbage"
 * distinct from "omitted". `run` stays required.
 */
export const taskDraftShape = objectShape({
	id: optionalShape(stringShape({ min: 1, description: 'Task id; auto-filled when omitted.' })),
	name: optionalShape(
		stringShape({ min: 1, description: 'Task name; defaults to the id when omitted.' }),
	),
	description: optionalShape(stringShape({ description: 'Optional task description.' })),
	run: taskFormShape,
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
 * The shape of a PHASE in a draft workflow — identical to {@link phaseShape} EXCEPT
 * `id` and `name` are OPTIONAL, and its tasks are {@link taskDraftShape}s.
 */
export const phaseDraftShape = objectShape({
	id: optionalShape(stringShape({ min: 1, description: 'Phase id; auto-filled when omitted.' })),
	name: optionalShape(
		stringShape({ min: 1, description: 'Phase name; defaults to the id when omitted.' }),
	),
	description: optionalShape(stringShape({ description: 'Optional phase description.' })),
	tasks: arrayShape(taskDraftShape, { description: 'The phase tasks; they run CONCURRENTLY.' }),
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
 * The shape of a DRAFT workflow — identical to {@link workflowShape} EXCEPT `id` and
 * `name` are OPTIONAL at all three levels (workflow / phase / task), so a small model
 * can omit the six identity strings and let the tool synthesize them positionally.
 *
 * @remarks
 * The lenient counterpart {@link import('./factories.js').createWorkflowDraftContract}
 * compiles. `run` stays required; a provided `id` / `name` still has `minLength: 1` (so an
 * explicitly-empty `id: ''` is REJECTED, not auto-filled). After
 * {@link import('./helpers.js').completeDraft} fills the missing ids/names, the result is
 * validated against the STRICT {@link import('./factories.js').createWorkflowContract} gate
 * before running.
 */
export const workflowDraftShape = objectShape({
	id: optionalShape(stringShape({ min: 1, description: 'Workflow id; auto-filled when omitted.' })),
	name: optionalShape(
		stringShape({ min: 1, description: 'Workflow name; defaults to the id when omitted.' }),
	),
	description: optionalShape(stringShape({ description: 'Optional workflow description.' })),
	phases: arrayShape(phaseDraftShape, {
		description: 'The workflow phases; they run SEQUENTIALLY, in order.',
	}),
	bail: optionalShape(
		literalShape([true, false], {
			description:
				'Failure policy: false (default) continues gracefully, true halts on the first failure.',
		}),
	),
})

/**
 * The shape of ONE flat step — `{ name, via? }` — the building block of
 * {@link workflowStepsShape}.
 *
 * @remarks
 * `name` is the REGISTERED behavior name the step runs (it becomes the task's `run.name`);
 * `via` is the optional execution mechanism (defaults to `'function'` when omitted). The
 * tool expands each step into a one-task phase, in order
 * ({@link import('./helpers.js').expandSteps}).
 */
export const stepShape = objectShape({
	name: stringShape({
		min: 1,
		description: 'The registered behavior name this step runs (becomes the task run.name).',
	}),
	via: optionalShape(
		literalShape(['function', 'tool', 'agent'], {
			description: 'How to run it: function (default), tool, or agent.',
		}),
	),
})

/**
 * The FLAT authoring shape `createWorkflowTool` advertises as its `parameters` — the
 * simplest surface a small model can fill: `{ name?, steps: [{ name, via? }] }`.
 *
 * @remarks
 * The deliberately-reduced surface (AGENTS §21): a flat ordered list of steps, each a
 * `{ name, via? }`. The tool EXPANDS it ({@link import('./helpers.js').expandSteps}) into a
 * full {@link import('./types.js').WorkflowDefinition} — one one-task phase per step, in
 * order — then validates against the STRICT
 * {@link import('./factories.js').createWorkflowContract} gate. The full nested form is
 * STILL accepted by the tool (it branches on the args' shape) and is documented as the
 * advanced escape-hatch in the tool's description — but THIS is what `parameters` advertises.
 */
export const workflowStepsShape = objectShape({
	name: optionalShape(stringShape({ min: 1, description: 'Optional workflow name.' })),
	steps: arrayShape(stepShape, {
		description: 'The ordered steps to run, one after another (each becomes a one-task phase).',
	}),
})
