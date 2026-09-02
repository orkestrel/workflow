import type { RunHolderInterface, RunnerInterface, TaskInterface } from './types.js'

/**
 * Holds the active phase {@link RunnerInterface} for one
 * {@link import('./types.js').WorkflowRunnerInterface.execute} call, for the lifetime of that run.
 *
 * @remarks
 * - **One holder per run.** The engine mints a holder as a run begins and threads that one
 *   instance through every phase of the run, so a nested `execute` reached through application
 *   composition gets its own holder and can never clobber the suspended outer run's.
 * - **`hold` is the only mutation.** A phase takes the substrate runner with `hold(runner)` as it
 *   starts and releases it with `hold()` as it settles; `runner` reads the held value back and is
 *   `undefined` between phases and after the last one.
 * - **A cancel closes over the holder.** The run-level abort listener reads `runner` when it
 *   fires, so it reaches whichever phase runner is live at that moment rather than the one that
 *   was live when the listener was armed.
 * - **Event-free.** A plain cell — no emitter, no lifecycle of its own.
 *
 * @example
 * ```ts
 * import { createRunner, RunHolder } from '@orkestrel/workflow'
 *
 * const holder = new RunHolder()
 * holder.hold(createRunner({ handler: (controller) => void controller.input }))
 * holder.runner?.stopped // false — the phase runner this run is driving
 * holder.hold() // the phase settled
 * holder.runner // undefined
 * ```
 */
export class RunHolder implements RunHolderInterface {
	#runner: RunnerInterface<TaskInterface, void> | undefined

	get runner(): RunnerInterface<TaskInterface, void> | undefined {
		return this.#runner
	}

	/**
	 * Takes the phase runner a starting phase hands this run, or releases the held one.
	 *
	 * @param runner - The phase runner to hold; omitted releases the held runner
	 * @example
	 * ```ts
	 * import { createRunner, RunHolder } from '@orkestrel/workflow'
	 *
	 * const holder = new RunHolder()
	 * holder.hold(createRunner({ handler: (controller) => void controller.input }))
	 * holder.hold() // released — `runner` reads `undefined` again
	 * ```
	 */
	hold(runner?: RunnerInterface<TaskInterface, void>): void {
		this.#runner = runner
	}
}
