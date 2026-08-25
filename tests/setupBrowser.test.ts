import * as setupBrowser from './setupBrowser.js'
import { describe, expect, it } from 'vitest'

// `tests/setupBrowser.ts` is deliberately export-free: the `src:browser` project loads it after
// `setup.ts`, and every browser fixture the Chromium suites need comes from `setup.ts` or
// `@orkestrel/test`. Its whole observable contract is therefore that loading it adds nothing —
// no helper the browser suites could bind to, and no side effect on the loading environment.
// The day it exports a DOM-driving helper, this case fails and the proof grows the contracts
// that helper carries.

describe('setupBrowser', () => {
	it('adds no binding to the projects that load it', () => {
		expect(Object.keys(setupBrowser)).toEqual([])
	})
})
