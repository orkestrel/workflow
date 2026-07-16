import type { Result } from '@orkestrel/contract'
import type { PhaseInterface, PhaseManagerInterface, PhaseUpdate } from '../types.js'
import { compileGuard } from '@orkestrel/contract'
import { WorkflowError } from '../errors.js'
import { insertEntry, moveEntry } from '../helpers.js'
import { phaseUpdateShape } from '../shapers.js'

/**
 * The lean child manager (AGENTS §9) of a {@link import('../Workflow.js').Workflow}'s
 * live phases — an insertion-ordered registry keyed by phase `id`, the phase analogue
 * of {@link import('../tasks/TaskManager.js').TaskManager}.
 *
 * @remarks
 * - **Positional store.** Phases live in an insertion-ordered `Map` keyed by `id`;
 *   `append` adds one at the end, `phase(id)` looks one up, `phases()` lists them in
 *   positional order, `count` is the size. A snapshot RESTORE re-`append`s in the
 *   snapshot's order, reproducing it exactly.
 * - **Gated mutation API (AGENTS §12).** `add` / `remove` / `move` / `update` are the
 *   graceful `Result` counterparts to `append`, gating ONLY on the target's OWN
 *   existence/status/id/bounds — a duplicate id, an absent/non-`pending` target, an
 *   out-of-bounds `index`, or a patch that fails {@link phaseUpdateShape} validation
 *   all fail gracefully with a `MUTATION` {@link WorkflowError} instead of throwing.
 * - **No batch matrix.** A workflow's phases are a fixed positional set, so AGENTS §9.2
 *   is deliberately omitted.
 * - **Event-free.** A purely structural container — the live {@link PhaseInterface}s own
 *   their own emitters.
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
	readonly #phases = new Map<string, PhaseInterface>()
	// The compiled guard validating a `PhaseUpdate` patch (AGENTS §14) before it reaches
	// `update`'s `phase.patch` call.
	readonly #isUpdate = compileGuard(phaseUpdateShape)

	get count(): number {
		return this.#phases.size
	}

	append(phase: PhaseInterface): void {
		if (this.#phases.has(phase.id)) {
			throw new WorkflowError('MUTATION', `duplicate phase id '${phase.id}'`, { id: phase.id })
		}
		this.#phases.set(phase.id, phase)
	}

	add(phase: PhaseInterface, index?: number): Result<PhaseInterface, WorkflowError> {
		if (this.#phases.has(phase.id)) {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `duplicate phase id '${phase.id}'`, { id: phase.id }),
			}
		}
		const at = index ?? this.#phases.size
		if (at < 0 || at > this.#phases.size) {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `index '${at}' out of bounds`, { index: at }),
			}
		}
		this.#reorder(insertEntry([...this.#phases.entries()], at, phase.id, phase))
		return { success: true, value: phase }
	}

	remove(id: string): Result<PhaseInterface, WorkflowError> {
		const target = this.#phases.get(id)
		if (target === undefined || target.status !== 'pending') {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `phase '${id}' is not a pending phase`, { id }),
			}
		}
		this.#phases.delete(id)
		return { success: true, value: target }
	}

	move(id: string, index: number): Result<PhaseInterface, WorkflowError> {
		const target = this.#phases.get(id)
		if (target === undefined || target.status !== 'pending') {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `phase '${id}' is not a pending phase`, { id }),
			}
		}
		if (index < 0 || index >= this.#phases.size) {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `index '${index}' out of bounds`, { index }),
			}
		}
		this.#reorder(moveEntry([...this.#phases.entries()], id, index))
		return { success: true, value: target }
	}

	update(id: string, patch: PhaseUpdate): Result<PhaseInterface, WorkflowError> {
		const target = this.#phases.get(id)
		if (target === undefined || target.status !== 'pending') {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `phase '${id}' is not a pending phase`, { id }),
			}
		}
		if (!this.#isUpdate(patch)) {
			return {
				success: false,
				error: new WorkflowError('MUTATION', `invalid patch for phase '${id}'`, { id }),
			}
		}
		target.patch(patch)
		return { success: true, value: target }
	}

	phase(id: string): PhaseInterface | undefined {
		return this.#phases.get(id)
	}

	phases(): readonly PhaseInterface[] {
		return [...this.#phases.values()]
	}

	// Rebuild the positional store from `entries` — the shared reorder step behind
	// `add` (insert) and `move` (reposition), keeping the `Map`'s insertion order the
	// single source of positional truth.
	#reorder(entries: readonly (readonly [string, PhaseInterface])[]): void {
		this.#phases.clear()
		for (const [key, value] of entries) this.#phases.set(key, value)
	}
}
