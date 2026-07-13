import type { PhaseInterface, PhaseManagerInterface } from '../types.js'

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

	get count(): number {
		return this.#phases.size
	}

	append(phase: PhaseInterface): void {
		this.#phases.set(phase.id, phase)
	}

	phase(id: string): PhaseInterface | undefined {
		return this.#phases.get(id)
	}

	phases(): readonly PhaseInterface[] {
		return [...this.#phases.values()]
	}
}
