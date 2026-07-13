// ── Browser-only setup (AGENTS §16.1) ─────────────────────────────────────────
//
// Loaded after `setup.ts` for the `src:browser` test project, which runs in a
// real Chromium (DOM + the browser scheduling APIs available). No browser-only
// fixtures are needed yet — the browser schedule backends' tests
// (`BrowserSchedule` / `FrameSchedule` / `IdleSchedule` / factories) drive real
// `requestAnimationFrame` / `requestIdleCallback` / `scheduler.postTask` through
// the shared `setup.ts` helpers (`instrumentSignal`, `waitForDelay`) alone. Add
// browser-specific helpers here if/when a future browser-only fixture needs one.
