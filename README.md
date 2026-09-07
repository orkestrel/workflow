# @orkestrel/workflow

> Orchestration as data: a JSON-serializable `Workflow → Phase → Task` tree that a UI or an
> LLM authors, a store persists, and a thin engine drives by composing the shipped execution
> substrate.

Author the definition as plain JSON, register the functions its tasks name, and
hand both to the runner: it builds the live tree, runs each phase in turn with
that phase's tasks concurrent, and resolves the settled result. Host-independent,
with browser-native and Node-native scheduler backends beside the default. Part
of the `@orkestrel` line.

## Install

```sh
npm install @orkestrel/workflow
```

## Requirements

- Core is cross-environment ESM; `./browser` adds browser-native cooperative
  scheduler backends (`requestAnimationFrame` / `requestIdleCallback` /
  Prioritized Task Scheduling), `./server` adds the Node-native
  `setImmediate` scheduler backend

## Status

Pre-release: the definition contract, live entity tree, runner,
cooperative schedulers, and durable stores are implemented and tested. A task
can publish its current note, progress, operations, constraints, pulse, and
signal; observers can derive silence without polling. Workflow, phase, and task
execution can pause, resume, wait, skip, stop, and destroy according to the
documented lifecycle.

Snapshots are exact JSON values with owned nested data. Attempts, checkpoints,
settlements, and final state can be persisted through memory or database-backed
stores, then explicitly restored or recovered without reusing a consumed
attempt. Runtime pause gates are intentionally not persisted.

Provider sessions, external processes, MCP projection, journals, leases, and
distributed fencing remain integration concerns rather than core workflow
behavior. See [guides/workflow.md](./guides/workflow.md) for the complete
shipped contract. The proposed integration architecture lives with the
package that implements it, as `plan/PROPOSAL.md` in `@orkestrel/supervisor`.

## Package

Published as environment-scoped entry points: `.` provides the shared
environment-agnostic core and default scheduler, `./browser` adds browser-native
schedulers, and `./server` adds the Node-native scheduler. Core ships dual
ESM+CJS builds; `./browser` is ESM-only.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
