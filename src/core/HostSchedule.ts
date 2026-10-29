import type { HostScheduleFunction, HostScheduleInterface } from './types.js'
import { isAbortSignal, linkSignal } from '@orkestrel/abort'
import { attempt } from '@orkestrel/contract'
import { WorkflowError } from './errors.js'

/** Owns the cancellation and exact failure of one scheduled host operation. */
export class HostSchedule implements HostScheduleInterface {
	readonly #promise: Promise<void>
	#cancel: (() => void) | undefined
	#failure: unknown

	constructor(start: HostScheduleFunction, signal?: AbortSignal) {
		if (signal !== undefined && !isAbortSignal(signal)) {
			this.#promise = Promise.reject(
				new WorkflowError('SCHEDULE', 'createHostSchedule signal must be an AbortSignal', {
					signal: typeof signal,
				}),
			)
			return
		}
		const completion = new AbortController()
		const failed = new AbortController()
		const linked = attempt(() =>
			linkSignal(AbortSignal.any([completion.signal, failed.signal]), signal),
		)
		if (!linked.success) {
			this.#promise = Promise.reject(
				new WorkflowError('SCHEDULE', 'createHostSchedule could not link the caller signal', {
					signal: typeof signal,
				}),
			)
			return
		}
		const settled = linked.value
		if (settled.aborted) {
			this.#promise = Promise.reject(settled.reason)
			return
		}
		this.#promise = new Promise<void>((resolve, reject) => {
			settled.addEventListener(
				'abort',
				() => {
					if (completion.signal.aborted) {
						resolve()
						return
					}
					const reason = failed.signal.aborted ? this.#failure : settled.reason
					this.#clear()
					reject(reason)
				},
				{ once: true },
			)
			try {
				this.#cancel = start(
					() => completion.abort(),
					(error) => {
						this.#failure = error
						failed.abort()
					},
				)
			} catch (error) {
				this.#failure = error
				failed.abort()
			}
			if (settled.aborted) this.#clear()
		})
	}

	get promise(): Promise<void> {
		return this.#promise
	}

	#clear(): void {
		try {
			const cancel = this.#cancel
			cancel?.()
		} catch {}
	}
}
