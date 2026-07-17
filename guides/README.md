# Guides

A dual-axis index into this repository's guides — by concept, and by directory (AGENTS §22).

## By concept

| Concept  | Spec                                 | Source                                                                                    | Tests                                                                                                                         |
| -------- | ------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Workflow | [`src/workflow.md`](src/workflow.md) | [`src/core`](../src/core), [`src/browser`](../src/browser), [`src/server`](../src/server) | [`tests/src/core`](../tests/src/core), [`tests/src/browser`](../tests/src/browser), [`tests/src/server`](../tests/src/server) |

## By directory

| Directory     | Guide                                |
| ------------- | ------------------------------------ |
| `src/core`    | [`src/workflow.md`](src/workflow.md) |
| `src/browser` | [`src/workflow.md`](src/workflow.md) |
| `src/server`  | [`src/workflow.md`](src/workflow.md) |

## Dependency reference

[`src/contract.md`](src/contract.md) is a byte-identical mirror of the guide for
`@orkestrel/contract` — a runtime dependency. It documents **that package's**
surface (guards, combinators, parsers, and the shape DSL), not anything sourced
in this repo; it is kept here so a reader of this package can see the primitives
it is built from without leaving this guide set.

[`src/emitter.md`](src/emitter.md) is a byte-identical mirror of the guide for
`@orkestrel/emitter` — a runtime dependency. It documents **that package's**
surface (the typed push-observation `Emitter`), not anything sourced in this
repo; it is kept here for the same reason.

[`src/abort.md`](src/abort.md) is a byte-identical mirror of the guide for
`@orkestrel/abort` — a runtime dependency. It documents **that package's**
surface (the `Abort` class, `AbortInterface`, and the parent-linking /
cascading-cancellation contract), not anything sourced in this repo; it is
kept here so a reader of this package can see the primitives it is built
from without leaving this guide set.

[`src/budget.md`](src/budget.md) is a byte-identical mirror of the guide for
`@orkestrel/budget` — a runtime dependency. It documents **that package's**
surface (the `Budget` class, `BudgetInterface`, and token-usage accounting),
not anything sourced in this repo; it is kept here for the same reason.

[`src/database.md`](src/database.md) is a byte-identical mirror of the guide
for `@orkestrel/database` — a runtime dependency the workflow stores layer
persistence over. It documents **that package's** surface (the database,
tables, and query layer), not anything sourced in this repo; it is kept here
so a reader of this guide can see the driver-pluggable half without leaving
this guide set.

[`src/timeout.md`](src/timeout.md) is a byte-identical mirror of the guide
for `@orkestrel/timeout` — a runtime dependency. It documents **that
package's** surface (the `Timeout` class and `TimeoutInterface`), not
anything sourced in this repo; it is kept here for the same reason.

[`src/guide.md`](src/guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides/src/parity.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §22 documentation-as-contracts.
