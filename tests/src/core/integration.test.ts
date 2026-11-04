import { BOUNDED_DIAGNOSTIC_CASES, buildDiagnosticWorkflow } from '../../setup.js'
import { isWorkflowError } from '@src/core'
import { describe, expect, it } from 'vitest'

describe('workflow diagnostics', () => {
	it.each(BOUNDED_DIAGNOSTIC_CASES)('bounds caller ids: $name', async ({ run }) => {
		const workflow = buildDiagnosticWorkflow()
		try {
			const value = await Promise.resolve()
				.then(() => run(workflow))
				.catch((error: unknown) => error)
			expect(isWorkflowError(value)).toBe(true)
			if (!isWorkflowError(value)) return
			expect(value.message.length).toBeLessThan(1024)
		} finally {
			workflow.destroy()
		}
	})
})
