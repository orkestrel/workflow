// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants below are this
// package's own, and are the only part a sibling package changes.

import type { TaskInterface, TaskUpdate, WorkflowDefinition } from '@src/core'
import { describe, expect, it } from 'vitest'
import { compileGuard } from '@orkestrel/contract'
import {
	canTransitionTask,
	collectResults,
	Collection,
	createWorkflow,
	createWorkflowContract,
	createWorkflowRunner,
	deriveBoundary,
	derivePhaseStatus,
	deriveWorkflowStatus,
	isTerminalStatus,
	taskUpdateShape,
} from '@src/core'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
	findMissing,
	findMissingSymbols,
	findUnexampled,
	findUnlisted,
	isExternalLink,
	parseManifest,
	resolveLink,
} from '@orkestrel/guide'
import { readFileSync } from 'node:fs'
import { requireValue } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({
	'@orkestrel/workflow': 'src/core',
	'@src/core': 'src/core',
	'@src/browser': 'src/browser',
	'@src/server': 'src/server',
})
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the second assertion below fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([
	'class Controller',
	'class Phase',
	'class Task',
	'class TaskController',
])

/** Root-level files this package's guides link to. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['AGENTS.md'])

/** The guide whose flagship fences the executed half transcribes and runs. */
const WORKFLOW_GUIDE = 'guides/workflow.md'

const root = new URL('../', import.meta.url)
const files: Record<string, string> = {
	...readInventory(root, ['src', 'guides', 'tests'], { extensions: ['.ts', '.md'] }),
}
for (const name of ROOT_FILES) files[name] = readFileSync(new URL(name, root), 'utf8')
const manifest = parseManifest(
	requireValue(files['guides/README.md'], 'Missing file: guides/README.md'),
	'guides',
)
const sources = createSourceManager({ files, modules: MODULES })

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

for (const entry of manifest) {
	const guide = createGuide(requireValue(files[entry.spec], `Missing file: ${entry.spec}`))
	const source = createSource({ files, module: entry.source })

	describe(`${entry.concept}`, () => {
		it('uses only listed fence languages', () => {
			expect(findUnlisted(guide.fences(), FENCE_LANGUAGES)).toEqual([])
		})

		it('extracts a non-empty documented surface', () => {
			expect(guide.surface().length).toBeGreaterThan(0)
		})
		it('re-exports every direct declaration that is not named internal', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
		})
		it('names no symbol internal that the barrel already exports', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
		})
		it('re-exports only direct declarations', () => {
			expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
		})
		it('documents every barrel export', () => {
			expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
		})
		it('documents only barrel exports', () => {
			expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
		})

		it('exposes no hidden module-scope declarations', () => {
			expect(source.hidden().map(computeSymbolKey)).toEqual([])
		})

		for (const group of guide.methods()) {
			const members = source.methods(group.interface)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, group.methods)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(group.methods, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface ? [] : findMissing(source.methods(entity), group.methods)
					expect(extra).toEqual([])
				})
			})
		}

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.keyword === 'function')
				.map((symbol) => symbol.name)
			expect(findUnexampled(names, fences, source.examples())).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					const examples =
						entity === group.interface
							? source.examples(group.interface)
							: source.examples(group.interface).concat(source.examples(entity))
					expect(findUnexampled(group.methods, fences, examples)).toEqual([])
				})
			})
		}

		it('imports only real exports in every ```ts fence', () => {
			const fences = guide.fences().filter((fence) => fence.language === EXAMPLE_LANGUAGE)
			for (const fence of fences) {
				for (const { specifier, names } of extractFenceImports(fence.code)) {
					const imported = sources.source(specifier)
					if (imported === undefined) continue
					const surface = imported.surface().map((symbol) => symbol.name)
					expect(findMissing(names, surface)).toEqual([])
				}
			}
		})

		it('resolves every relative link', () => {
			const broken = guide
				.links()
				.filter((href) => !isExternalLink(href))
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(broken).toEqual([])
		})
		it('links only to test files that exist', () => {
			const missing = guide
				.tests()
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(missing).toEqual([])
		})
	})
}

// The EXECUTED half. Every preceding check reads a name — from source text or from a barrel — and
// a name that resolves proves nothing about a sentence beside it, so a fence whose comment claims
// a value the code contradicts passes all of them. The cases here run the flagship fences of
// `guides/workflow.md` and assert the values their comments claim. Each behaviour case is paired
// with a presence guard reading the fence text back out of the inventory, so a fence edit reddens
// the transcription rather than leaving it silently stale. Change a fence, change the
// transcription beside it.
describe('flagship fences', () => {
	const guideText = requireValue(files[WORKFLOW_GUIDE], `Missing file: ${WORKFLOW_GUIDE}`)

	const releaseDefinition: WorkflowDefinition = {
		id: 'release',
		name: 'Release',
		phases: [
			{
				id: 'build',
				name: 'Build',
				tasks: [
					{ id: 'compile', name: 'Compile', behavior: 'compile' },
					{ id: 'lint', name: 'Lint', behavior: 'lint' },
				],
			},
			{
				id: 'ship',
				name: 'Ship',
				tasks: [{ id: 'publish', name: 'Publish', behavior: 'publish' }],
			},
		],
	}

	it('runs the opening fence to a completed workflow whose compile task completed', async () => {
		const runner = createWorkflowRunner()

		const result = await runner.execute(releaseDefinition, {
			functions: {
				compile: async (controller) => `built ${controller.task.id}`,
				lint: async () => 'clean',
				publish: async () => 'published',
			},
		})

		expect(result.status).toBe('completed')
		expect(result.workflow.phase('build')?.task('compile')?.status).toBe('completed')
	})

	it('carries the opening fence lines the transcription copies', () => {
		expect(guideText).toContain('const runner = createWorkflowRunner()')
		expect(guideText).toContain("result.status // 'completed'")
		expect(guideText).toContain(
			"result.workflow.phase('build')?.task('compile')?.status // 'completed'",
		)
	})

	it('reads the documented positional collection fence', () => {
		const workflow = createWorkflow(releaseDefinition)
		const first = requireValue(workflow.phase('build')?.task('compile'), 'expected compile task')
		const second = requireValue(workflow.phase('build')?.task('lint'), 'expected lint task')

		const store = new Collection<TaskInterface, TaskUpdate>('task', compileGuard(taskUpdateShape))
		store.append(first)
		store.add(second, 0)
		store.move(second.id, 1)
		store.update(first.id, { name: 'Renamed task' })

		expect(store.entry(first.id)).toBe(first)
		expect(store.entries()).toEqual([first, second])
		expect(store.count).toBe(2)
	})

	it('carries the positional collection fence lines the transcription copies', () => {
		expect(guideText).toContain(
			"const store = new Collection<TaskInterface, TaskUpdate>('task', compileGuard(taskUpdateShape))",
		)
		expect(guideText).toContain('store.entries() // [first, second], in positional order')
		expect(guideText).toContain('store.count // 2')
	})

	it('accepts the documented definition through the compiled contract fence', () => {
		const contract = createWorkflowContract()

		expect(contract.is(releaseDefinition)).toBe(true)
		expect(contract.parse({ id: '', phases: [] })).toBeUndefined()
	})

	it('carries the contract fence lines the transcription copies', () => {
		expect(guideText).toContain('const contract = createWorkflowContract()')
		expect(guideText).toContain('contract.is(definition) // true')
		expect(guideText).toContain("contract.parse({ id: '', phases: [] }) // undefined")
	})

	it('grafts a live phase and task through the append fence', () => {
		const main = createWorkflow({
			id: 'wf',
			name: 'Wf',
			phases: [{ id: 'p1', name: 'P1', tasks: [] }],
		})
		const extra = createWorkflow({
			id: 'extra',
			name: 'Extra',
			phases: [{ id: 'p2', name: 'P2', tasks: [{ id: 't1', name: 'T1', behavior: 'noop' }] }],
		})

		const phase = extra.phase('p2')
		if (phase) main.phases.append(phase)
		const task = phase?.task('t1')
		const target = main.phase('p1')
		if (task && target) target.tasks.append(task)

		expect(main.phases.count).toBe(2)
		expect(target?.tasks.count).toBe(1)
	})

	it('carries the append fence lines the transcription copies', () => {
		expect(guideText).toContain('main.phases.count // 2')
		expect(guideText).toContain('target?.tasks.count // 1')
	})

	it('returns the documented values from the derivation fence', () => {
		expect(isTerminalStatus('completed')).toBe(true)
		expect(derivePhaseStatus(['completed', 'skipped'])).toBe('completed')
		expect(deriveWorkflowStatus([{ status: 'failed', bail: false }])).toBe('completed')
		expect(canTransitionTask('pending', 'running')).toBe(true)
		expect(deriveBoundary(['completed', 'completed', 'pending', 'pending'])).toBe(2)
		expect(collectResults([[], []])).toEqual([])
	})

	it('carries the derivation fence lines the transcription copies', () => {
		expect(guideText).toContain("isTerminalStatus('completed') // true")
		expect(guideText).toContain("derivePhaseStatus(['completed', 'skipped']) // 'completed'")
		expect(guideText).toContain(
			"deriveWorkflowStatus([{ status: 'failed', bail: false }]) // 'completed'",
		)
		expect(guideText).toContain("canTransitionTask('pending', 'running') // true")
		expect(guideText).toContain(
			"deriveBoundary(['completed', 'completed', 'pending', 'pending']) // 2",
		)
		expect(guideText).toContain('collectResults([[], []]) // []')
	})
})
