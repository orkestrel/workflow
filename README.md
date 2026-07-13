# @orkestrel/workflow

A typed workflow engine for the `@orkestrel` line — a serializable
`Workflow → Phase → Task` tree that a UI or an LLM authors as pure JSON, and
a thin `WorkflowRunner` executes by COMPOSING the shipped substrate (a
per-phase `Runner`, `Abort`, `Timeout`, `Budget`, and a cooperative
cross-environment `Schedule`) rather than re-implementing its own
concurrency / retry / abort machinery.

## Install

```sh
npm install @orkestrel/workflow
```

## Requirements

- Core is cross-environment ESM; `./browser` adds browser-native cooperative
  schedule backends (`requestAnimationFrame` / `requestIdleCallback` /
  Prioritized Task Scheduling), `./server` adds the Node-native
  `setImmediate` schedule backend

## Status

Pre-release (`0.0.1`): the definition contract, the live entity tree, the
thin runner (with the `function` / `tool` / `agent` task forms and the
depth/cycle-bounded agent-native recursion), the durable `WorkflowStore`
(in-memory + driver-pluggable), and the cooperative `Schedule` (the
cross-environment default plus the browser and Node environment backends)
are all implemented and tested, but the public API is still unstable and
may change without notice. See [guides/src/workflow.md](./guides/src/workflow.md)
for the full documented surface.

## Package

Published as three environment-scoped entry points per the `exports` field
in `package.json`: `.` (the shared, environment-agnostic core — the
definition/entity/runner surface plus the cross-environment `Schedule`
default), `./browser` (adds the browser-native schedule backends), and
`./server` (adds the Node-native schedule backend). Core ships dual
ESM+CJS builds; `./browser` is ESM-only.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
