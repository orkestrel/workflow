# ROADMAP.md — the path to @orkestrel/agent

The dependency-ordered plan for completing the line. Each stage is converted to a
canonical orkestrel package (see SCAFFOLD.md) and published to npm before the next
stage begins.

1. ~~**queue** and **pool** — foundation packages. Repos arrive from the prior
   project and get the standard conversion treatment.~~ **DONE** — both converted
   to canonical core-only packages and on `main` (queue: five deps declared,
   monolith imports rewired, 89 src + 19 parity tests green; pool: carved down to
   exactly the Pool surface with `@orkestrel/emitter` as its sole dependency,
   37 src + 9 parity tests green; the shared monolith Workers guide was split
   into standalone package-specific guides).
2. ~~Publish `@orkestrel/queue` and `@orkestrel/pool` to npm.~~ **DONE** — both
   published as 0.0.1.
3. ~~**worker** — built on queue and pool.~~ **DONE (conversion)** — converted
   to the canonical core+server package on the published queue/pool/emitter/
   contract/database deps (src/server/serve.ts kept as the self-contained
   worker-thread entry with its intentionally inlined local guards, exempted
   by name in the guides parity suite; 73 src + 9 parity tests green).
   Publish to npm pending — handled manually.
4. ~~**runner** and **controller** — depend on queue/pool/worker and integrate
   INTO `@orkestrel/workflow` as native modules (the same treatment the
   scheduler received), replacing today's unresolved `@orkestrel/runner`
   imports with local core modules.~~ **DONE** — `Runner` / `Controller` live
   natively in `src/core` on the published abort/emitter/queue packages,
   `WorkflowRunner` composes the local `Runner` per phase (zero
   `@orkestrel/runner` references remain), the runners guide was merged into
   `guides/src/workflow.md`, and the guides parity suite passes 64/64
   (`@orkestrel/pool` proved unused and was dropped; worker is not a workflow
   dependency).
5. ~~**agent** — the final package; depends on the runner that ships inside
   `@orkestrel/workflow`.~~ **DONE (conversion + publish)** — converted to the
   canonical core-only package and published as `@orkestrel/agent@0.0.1`;
   this repo now declares it (`^0.0.1`) and is FULLY GREEN: zero type errors,
   and 461 core + 40 browser + 21 server + 64 guides tests pass. The two
   packages are mutually dependent — dev-time self-resolution is handled in
   `vite.config.ts` (the `@orkestrel/workflow` alias + inlining
   `@orkestrel/agent` through Vite, since Node's package self-reference does
   not reach imports made from inside node_modules).

Remaining publish handshake: (1) publish `@orkestrel/workflow@0.0.1` — every
prepublish gate passes, no bypass needed; (2) add
`"@orkestrel/workflow": "^0.0.1"` to agent's dependencies (its tests then run
for real) and publish `@orkestrel/agent@0.0.2`; (3) bump this repo's agent pin
to `^0.0.2`. After that both packages are self-sufficiently green.
