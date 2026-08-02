import { globSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isBrowserVuePath } from './setup.js'
import { inspectCodingLaw, inspectCodingWorkspace, inspectTSDocAliases } from './setupPolicy.js'
import { chromium } from 'playwright'

describe('repository coding law', () => {
	it('keeps Vue single-file components exclusively in browser environments', () => {
		const files = globSync('{app,src}/**/*.vue')

		expect(files.every(isBrowserVuePath)).toBe(true)
	})

	it('enforces source placement, exports, readonly contracts, and syntax law', () => {
		expect(inspectCodingWorkspace(process.cwd())).toEqual([])
	})

	it('rejects private aliases in TSDoc without rejecting source imports or ordinary comments', () => {
		const privateExample = `/**
 * @example
 * import { createWorkflow } from '@src/core'
 */
export function inspectValue(value: unknown): unknown {
	return value
}`
		const allowedSource = `import type { WorkflowOptions } from '@src/core'
// import { createWorkflow } from '@src/core'
/* import { createWorkflowManager } from '@src/core' */
export function inspectValue(value: unknown): unknown {
	return value
}`

		expect(inspectTSDocAliases('src/core/helpers.ts', privateExample)).toEqual([
			'src/core/helpers.ts:1:1 forbids private @src/* imports in TSDoc examples',
		])
		expect(inspectCodingLaw('src/core/helpers.ts', privateExample)).toContain(
			'src/core/helpers.ts:1:1 forbids private @src/* imports in TSDoc examples',
		)
		expect(inspectTSDocAliases('src/core/helpers.ts', allowedSource)).toEqual([])
		expect(inspectCodingLaw('src/core/helpers.ts', allowedSource)).toEqual([])
	})

	it.skipIf(!existsSync(chromium.executablePath()))(
		'runs browser suites only when the real Chromium executable is installed',
		() => {
			expect(existsSync(chromium.executablePath())).toBe(true)
		},
	)
})
