import type { TimeoutInterface } from '@orkestrel/timeout'
import type {
	RunHolderInterface,
	WorkflowExecutionInterface,
	WorkflowInterface,
	WorkflowPersistenceInterface,
	WorkflowRunOptions,
} from './types.js'
import { isFiniteNumber } from '@orkestrel/contract'
import { createTimeout } from '@orkestrel/timeout'
import { MAX_TIMER_MS } from './constants.js'
import { WorkflowPersistence } from './WorkflowPersistence.js'

/** Owns the bounds, durability, and live phase cursor of one workflow execution. */
export class WorkflowExecution implements WorkflowExecutionInterface {
	#cursor = 0
	#timeout: TimeoutInterface | undefined
	#persistence: WorkflowPersistenceInterface | undefined
	#signal: AbortSignal | undefined
	#cancel: (() => void) | undefined

	get cursor(): number {
		return this.#cursor
	}

	get persistence(): WorkflowPersistenceInterface | undefined {
		return this.#persistence
	}

	start(
		workflow: WorkflowInterface,
		holder: RunHolderInterface,
		signal: AbortSignal | undefined,
		ms: number | undefined,
		budget: WorkflowRunOptions['budget'],
		store: WorkflowRunOptions['store'],
	): AbortSignal {
		this.#timeout =
			ms !== undefined && isFiniteNumber(ms) && ms > 0 && ms <= MAX_TIMER_MS
				? createTimeout({ ms })
				: undefined
		this.#timeout?.start()
		budget?.start()
		this.#signal = this.#fold(workflow, signal, budget)
		this.#persistence = store === undefined ? undefined : new WorkflowPersistence(workflow, store)
		this.#cancel = this.#abort.bind(this, holder, this.#signal)
		if (this.#signal.aborted) this.#cancel()
		else this.#signal.addEventListener('abort', this.#cancel, { once: true })
		return this.#signal
	}

	advance(): void {
		this.#cursor += 1
	}

	clear(): void {
		this.#persistence?.detach()
		this.#timeout?.clear()
		if (this.#signal !== undefined && this.#cancel !== undefined) {
			this.#signal.removeEventListener('abort', this.#cancel)
		}
	}

	#abort(holder: RunHolderInterface, signal: AbortSignal): void {
		void holder.runner?.abort(signal.reason)
	}

	#fold(
		workflow: WorkflowInterface,
		signal: AbortSignal | undefined,
		budget: WorkflowRunOptions['budget'],
	): AbortSignal {
		const signals: AbortSignal[] = [workflow.signal]
		if (signal !== undefined) signals.push(signal)
		if (this.#timeout !== undefined) signals.push(this.#timeout.signal)
		if (budget !== undefined) signals.push(budget.signal)
		return signals.length === 1 ? workflow.signal : AbortSignal.any(signals)
	}
}
