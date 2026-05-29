import { defineConfig } from '@playwright/test'

// Default the production CSP ON for every run so the dashboard is always
// exercised under the same Content-Security-Policy the bundled Tauri webview
// enforces, and csp.spec.ts stops being skipped by default. The fixture
// spreads process.env into the shim it spawns, so setting it here (the runner
// process) reaches both the shim's CSP injection and the spec skip-gates.
// Cross-platform (no shell `VAR=… cmd` prefix). Override with
// WECHAT_CC_INJECT_CSP=0 to run without CSP injection.
process.env.WECHAT_CC_INJECT_CSP ??= '1'

export default defineConfig({
  testDir: './playwright',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
