// ── Server-only setup (AGENTS §16.1) ──────────────────────────────────────────
//
// Loaded after `setup.ts` for the `src:server` test project, which runs under
// Node. No node-only fixtures are needed yet — the Node schedule backend's
// tests (`NodeSchedule` / factories) drive real `setImmediate` / `setTimeout`
// through the shared `setup.ts` helpers (`createRecorder`, `instrumentSignal`)
// alone. Add node-specific helpers here if/when a future server-only fixture
// needs one.
