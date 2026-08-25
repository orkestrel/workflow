import * as setupServer from './setupServer.js'
import { describe, expect, it } from 'vitest'

// `tests/setupServer.ts` is deliberately export-free: the `src:server` project loads it after
// `setup.ts`, and the Node scheduler suites drive real `setImmediate` and `setTimeout` through
// `setup.ts`'s `instrumentSignal` and `@orkestrel/test`'s recorder alone. Its whole observable
// contract is therefore that loading it adds nothing — no helper the server suites could bind
// to, and no side effect on the loading environment. The day it exports a Node helper, this
// case fails and the proof grows the contracts that helper carries.

describe('setupServer', () => {
	it('adds no binding to the projects that load it', () => {
		expect(Object.keys(setupServer)).toEqual([])
	})
})
