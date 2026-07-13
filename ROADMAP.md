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
2. Publish `@orkestrel/queue` and `@orkestrel/pool` to npm. **IN PROGRESS** —
   next up, handled manually.
3. **worker** — built on queue and pool.
4. **runner** and **controller** — depend on queue/pool/worker and integrate
   INTO `@orkestrel/workflow` as native modules (the same treatment the
   scheduler received), replacing today's unresolved `@orkestrel/runner`
   imports with local core modules.
5. **agent** — the final package; depends on the runner that ships inside
   `@orkestrel/workflow`.

Current known state: `@orkestrel/workflow` imports `@orkestrel/agent` and
`@orkestrel/runner` as bare specifiers that do not resolve yet — typecheck /
tests are red on exactly those specifiers and nothing else (format / lint
green; the browser / server surfaces compile clean). Stage 4 resolves the
runner imports by integration; stage 5 resolves the agent imports by
publication.
