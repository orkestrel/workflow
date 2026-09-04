// ── Server-only setup ─────────────────────────────────────────────────────────
//
// Loaded after `setup.ts` for the `src:server` test project, which runs under
// Node. No node-only fixtures are needed yet — the Node scheduler backend's
// tests (`NodeScheduler` / factories) drive real `setImmediate` / `setTimeout`
// through `@orkestrel/test`'s `createRecorder` and `setup.ts`'s own
// `instrumentSignal` alone. Add node-specific helpers here if/when a future
// server-only fixture needs one.
