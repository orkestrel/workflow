// ── Browser-only setup ────────────────────────────────────────────────────────
//
// Loaded after `setup.ts` for the `src:browser` test project, which runs in a
// real Chromium (DOM + the browser scheduling APIs available). No browser-only
// fixtures are needed yet — the browser scheduler backends' tests
// (`BrowserScheduler` / `FrameScheduler` / `IdleScheduler` / factories) drive real
// `requestAnimationFrame` / `requestIdleCallback` / `scheduler.postTask` through
// `setup.ts`'s own `instrumentSignal` and `@orkestrel/test`'s `waitForDelay` alone.
// Add browser-specific helpers here if/when a future browser-only fixture needs one.
