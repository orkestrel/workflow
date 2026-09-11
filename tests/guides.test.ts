// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants that follow are this
// package's own, as is the executed section that closes the file.

import type { TaskInterface, TaskUpdate, WorkflowDefinition } from '@src/core'
import { GuideCommand } from '@orkestrel/guide/server'
import { readInventory } from '@orkestrel/test/server'
import { createVitest } from 'vitest/node'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** The package identity that binds its manifest, module map, and README pitch. */
const PACKAGE_NAME = '@orkestrel/workflow'
/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/workflow.md'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({
	[PACKAGE_NAME]: 'src/core',
	'@src/core': 'src/core',
	'@src/browser': 'src/browser',
	'@src/server': 'src/server',
})
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the assertion that follows it fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([
	'class Controller',
	'class Phase',
	'class Task',
	'class TaskController',
])

await new GuideCommand({
	root: new URL('../', import.meta.url),
	patterns: ['src/**/*.ts', 'tests/**/*.ts', 'guides/*.md', '*.md', 'package.json'],
	modules: MODULES,
	languages: FENCE_LANGUAGES,
	language: EXAMPLE_LANGUAGE,
	reader: readInventory,
	runner: createVitest,
}).execute(async ({ files, report, rows }) => {
	const { compileGuard, isRecord, parseJSON } = await import('@orkestrel/contract')
	const {
		computeSymbolKey,
		createSourceManager,
		extractFenceImports,
		findMissing,
		findMissingSymbols,
		findUnexampled,
		isExternalLink,
		resolveLink,
	} = await import('@orkestrel/guide')
	const {
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
	} = await import('@src/core')
	const { requireValue } = await import('@orkestrel/test')
	const { describe, expect, it } = await import('vitest')
	const sources = createSourceManager({ files, modules: MODULES })
	const own = requireValue(
		rows.find((row) => row.entry.spec === GUIDE_SPEC),
		`Missing manifest row: ${GUIDE_SPEC}`,
	)
	const manifest = parseJSON(requireValue(files['package.json'], 'Missing inventory: package.json'))
	if (!isRecord(manifest)) throw new Error('Invalid package manifest: package.json')

	it('manifest lists at least one guide', () => {
		expect(report.input).toEqual([])
		expect(rows.length).toBeGreaterThan(0)
		expect(own.entry.spec).toBe(GUIDE_SPEC)
	})

	// The example half of the equality case is silent over an empty population: with no
	// title on both sides `findDrift` compares no pair and the case passes on the summaries
	// alone. This pins the population this repository's own guide contributes, so removing
	// every `@example` title reddens the suite instead of quietly retiring half the gate.
	// The failure names both title sets, because a pin reporting only its own emptiness
	// leaves the reader to work out which side dropped the title.
	it('pairs at least one example title across the guide and the source', () => {
		expect(report.examples.titles.filter((finding) => finding.spec === GUIDE_SPEC)).toEqual([])
	})

	// The README's pitch and the guide's tagline are one text, each read as the blockquote
	// under its file's H1. The native report owns their comparison. The manifest assertion
	// binds that report to this package rather than allowing an unrelated package identity.
	it('opens the README with the guide tagline', () => {
		expect(manifest.name).toBe(PACKAGE_NAME)
		expect(report.pitch).toEqual([])
	})

	for (const { entry, guide, source } of rows) {
		describe(`${entry.concept}`, () => {
			it('uses only listed fence languages', () => {
				expect(report.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
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
				const members = source.methods(group.interface).map((method) => method.name)
				const documented = group.methods.map((method) => method.name)
				const entity = group.interface.replace(/Interface$/, '')
				describe(`${group.interface}`, () => {
					it('documents at least one method', () => {
						expect(group.methods.length).toBeGreaterThan(0)
					})
					it('documents every interface method', () => {
						expect(findMissing(members, documented)).toEqual([])
					})
					it('documents no phantom method', () => {
						expect(findMissing(documented, members)).toEqual([])
					})
					it(`${entity} exposes no undocumented method`, () => {
						const extra =
							entity === group.interface
								? []
								: findMissing(
										source.methods(entity).map((method) => method.name),
										documented,
									)
						expect(extra).toEqual([])
					})
				})
			}

			// The equality gate: a `Summary` cell against its export's description paragraph, a
			// titled fence against the `@example` of that title. `findDrift` owns the comparison
			// and names both sides; converge the two sides through the native entry, never by
			// weakening this assertion. `findDrift` pairs an example only where a title is
			// present on both sides, so an untitled `@example` block is outside this case. Each
			// collected line is the spec, the key, and each side's text or `absent` — the same
			// worklist the native entry prints, so a failure here is read the way that command's
			// output is.
			it('keeps every compared summary and example equal to its source', () => {
				expect(report.drift.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents an example for every Surface function', () => {
				expect(report.examples.functions.filter((finding) => finding.spec === entry.spec)).toEqual(
					[],
				)
			})

			for (const group of guide.methods()) {
				const entity = group.interface.replace(/Interface$/, '')
				const documented = group.methods.map((method) => method.name)
				const examples =
					entity === group.interface
						? source.examples(group.interface).map((example) => example.name)
						: source
								.examples(group.interface)
								.map((example) => example.name)
								.concat(source.examples(entity).map((example) => example.name))
				describe(`${group.interface} examples`, () => {
					it('documents an example for every method', () => {
						const fences = guide
							.fences()
							.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
							.map((fence) => fence.code)
						expect(findUnexampled(documented, fences, examples)).toEqual([])
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
		const guideText = requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`)

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
})
