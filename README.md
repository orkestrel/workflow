# @orkestrel/workflow

A typed, host-independent workflow engine for the `@orkestrel` line. It keeps
work as a serializable `Workflow → Phase → Task` tree and executes task behavior
through a caller-supplied function registry on a cooperative scheduler.

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
shipped contract. The proposed integration architecture now lives with the
package that implements it, as `plan/PROPOSAL.md` in `@orkestrel/supervisor`.

## Package

Published as three environment-scoped entry points: `.` provides the shared
environment-agnostic core and default scheduler, `./browser` adds browser-native
schedulers, and `./server` adds the Node-native scheduler. Core ships dual
ESM+CJS builds; `./browser` is ESM-only.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
