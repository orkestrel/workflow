# Guides

A dual-axis index into this repository's guides — by concept, and by directory.

## By concept

| Concept  | Spec                         | Source                                                                                    | Tests                                                                                                                         |
| -------- | ---------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Workflow | [`workflow.md`](workflow.md) | [`src/core`](../src/core), [`src/browser`](../src/browser), [`src/server`](../src/server) | [`tests/src/core`](../tests/src/core), [`tests/src/browser`](../tests/src/browser), [`tests/src/server`](../tests/src/server) |

## By directory

| Directory     | Guide                        |
| ------------- | ---------------------------- |
| `src/core`    | [`workflow.md`](workflow.md) |
| `src/browser` | [`workflow.md`](workflow.md) |
| `src/server`  | [`workflow.md`](workflow.md) |

## Dependency reference

[`contract.md`](contract.md) is a byte-identical mirror of the guide for
`@orkestrel/contract` — a runtime dependency. It documents **that package's**
surface (guards, combinators, parsers, and the shape DSL), not anything sourced
in this repo; it is kept here so a reader of this package can see the primitives
it is built from without leaving this guide set.

[`emitter.md`](emitter.md) is a byte-identical mirror of the guide for
`@orkestrel/emitter` — a runtime dependency. It documents **that package's**
surface (the typed push-observation `Emitter`), not anything sourced in this
repo; it is kept here for the same reason.

[`abort.md`](abort.md) is a byte-identical mirror of the guide for
`@orkestrel/abort` — a runtime dependency. It documents **that package's**
surface (the `Abort` class, `AbortInterface`, and the parent-linking /
cascading-cancellation contract), not anything sourced in this repo; it is
kept here so a reader of this package can see the primitives it is built
from without leaving this guide set.

[`budget.md`](budget.md) is a byte-identical mirror of the guide for
`@orkestrel/budget` — a runtime dependency. It documents **that package's**
surface (the `Budget` class, `BudgetInterface`, and token-usage accounting),
not anything sourced in this repo; it is kept here for the same reason.

[`database.md`](database.md) is a byte-identical mirror of the guide
for `@orkestrel/database` — a runtime dependency the workflow stores layer
persistence over. It documents **that package's** surface (the database,
tables, and query layer), not anything sourced in this repo; it is kept here
so a reader of this guide can see the driver-pluggable half without leaving
this guide set.

[`timeout.md`](timeout.md) is a byte-identical mirror of the guide
for `@orkestrel/timeout` — a runtime dependency. It documents **that
package's** surface (the `Timeout` class and `TimeoutInterface`), not
anything sourced in this repo; it is kept here for the same reason.

[`queue.md`](queue.md) is a byte-identical mirror of the guide for
`@orkestrel/queue` — the runtime dependency the substrate `Runner` composes for
backpressure, retries, and the per-attempt timeout. It documents **that
package's** surface (the `Queue` class, `QueueInterface`, and the bounded-concurrency
dispatch contract), not anything sourced in this repo; it is kept here so a reader
of the substrate can see the engine it drives without leaving this guide set.

[`guide.md`](guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

[`test.md`](test.md) is a byte-identical mirror of the guide for
`@orkestrel/test` — the devDependency supplying this repo's shared test
helpers (the call recorder, the real delay, the owned scratch directory). It
documents **that package's** surface, not anything sourced in this repo; it is
kept here so a reader of the suites can see the helpers they import.

[`scaffold.md`](scaffold.md) is a byte-identical mirror of the guide for
`@orkestrel/scaffold` — the devDependency owning this repo's vendored
configuration and its `audit` / `repair` commands. It documents **that
package's** surface, not anything sourced in this repo; it is kept here so a
reader can see what governs the files this package does not own.

[`probe.md`](probe.md) is a byte-identical mirror of the guide for
`@orkestrel/probe` — the devDependency exposing the `prove` tool that settles a
TypeScript claim before code rests on it. It documents **that package's**
surface, not anything sourced in this repo; it is kept here for the same reason.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; see `.claude/rules/documentation.md` § Parity for documentation as a contract.
