import type { Result } from '@orkestrel/contract'
import type { PhaseInterface, PhaseManagerInterface, PhaseUpdate } from '../types.js'
import type { WorkflowError } from '../errors.js'
import { compileGuard } from '@orkestrel/contract'
import { Collection } from '../Collection.js'
import { phaseUpdateShape } from '../shapers.js'

/**
 * Implements the lean child manager of a {@link import('../Workflow.js').Workflow}'s live
 * phases — the phase vocabulary over one insertion-ordered {@link Collection}, the phase analogue
 * of {@link import('../tasks/TaskManager.js').TaskManager}.
 *
 * @remarks
 * - **One shared store.** The insertion-ordered `Map`, the reorder step, the bounds checks, and
 *   the gated `add` / `remove` / `move` / `update` all live in {@link Collection}, built with the
 *   `phase` noun its refusals name and the compiled {@link phaseUpdateShape} guard. This class
 *   adds the domain accessors `phase` / `phases` and nothing else.
 * - **Positional store.** `append` adds one live {@link PhaseInterface} at the end, `phase(id)`
 *   looks one up, `phases()` lists them in positional order, `count` is the tally. A snapshot
 *   RESTORE re-`append`s in the snapshot's order, reproducing it exactly.
 * - **Gated mutation API.** `add` / `remove` / `move` / `update` are the graceful
 *   `Result` counterparts to `append`, gating ONLY on the target's OWN existence/status/id/bounds
 *   — a duplicate id, an absent/non-`pending` target, an out-of-bounds `index`, or a patch that
 *   fails {@link phaseUpdateShape} validation all fail gracefully with a `MUTATION`
 *   {@link WorkflowError} instead of throwing.
 * - **No batch matrix.** A workflow's phases are a fixed positional set, so the batch verbs of
 *   `.claude/rules/patterns.md` § Batch operations are
 *   deliberately omitted.
 * - **Event-free.** A purely structural container — the live {@link PhaseInterface}s own their own
 *   emitters.
 *
 * @example
 * ```ts
 * const phases = new PhaseManager()
 * phases.append(phase) // a live Phase
 * phases.phase(phase.id) // the same phase
 * phases.count // 1
 * ```
 */
export class PhaseManager implements PhaseManagerInterface {
	readonly #phases = new Collection<PhaseInterface, PhaseUpdate>(
		'phase',
		compileGuard(phaseUpdateShape),
	)

	get count(): number {
		return this.#phases.count
	}

	append(phase: PhaseInterface): void {
		this.#phases.append(phase)
	}

	add(phase: PhaseInterface, index?: number): Result<PhaseInterface, WorkflowError> {
		return this.#phases.add(phase, index)
	}

	remove(id: string): Result<PhaseInterface, WorkflowError> {
		return this.#phases.remove(id)
	}

	move(id: string, index: number): Result<PhaseInterface, WorkflowError> {
		return this.#phases.move(id, index)
	}

	update(id: string, patch: PhaseUpdate): Result<PhaseInterface, WorkflowError> {
		return this.#phases.update(id, patch)
	}

	phase(id: string): PhaseInterface | undefined {
		return this.#phases.entry(id)
	}

	phases(): readonly PhaseInterface[] {
		return this.#phases.entries()
	}
}
