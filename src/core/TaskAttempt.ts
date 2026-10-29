import type { AttemptOutcome, TaskAttemptInterface } from './types.js'

/** Holds one handler outcome without moving its invocation or exception boundary. */
export class TaskAttempt implements TaskAttemptInterface {
	#outcome: AttemptOutcome | undefined

	get outcome(): AttemptOutcome | undefined {
		return this.#outcome
	}

	resolve(outcome: AttemptOutcome): void {
		this.#outcome = outcome
	}
}
