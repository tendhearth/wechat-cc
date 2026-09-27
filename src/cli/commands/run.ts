// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
// ── PR4 batch 3c — heavy entry points ────────────────────────────────
//
// 6 commands, the rest of the legacy switch. After this batch the
// parseCliArgs function + CliArgs union can be deleted entirely; only
// the help fall-through remains, and that's served by citty's
// auto-generated root help.
//
// Notable shapes:
//   - `run` mutates process.argv before main.ts import (legacy --dangerously
//     dance preserved verbatim).
//   - `setup` either drives an interactive QR scan (imports setup.ts which
//     never returns) or returns a one-shot JSON envelope under --qr-json.
//   - `setup-poll --qrcode` is required.
//   - `service` keeps a positional action (status/install/start/stop/uninstall)
//     because all five share ~95% of the same setup; nesting into 5
//     subCommands would mean shared-helper-with-5-args. Tri-state
//     --unattended / --auto-start use parseBoolValue.
//   - `reply` has multi-word positional text — citty's positionals are
//     1-slot, so we declare none and read args._ (RawArgs._ — the
//     unconsumed positionals citty hands through). Stdin path preserved.
//   - `update --check` flips between probe + apply modes; same body
//     branches as the legacy case.

export const runCmd = defineCommand({
  meta: { name: 'run', description: 'Start the daemon (foreground). --dangerously skips permission prompts.' },
  args: {
    dangerously: { type: 'boolean', description: 'Skip permission prompts (matches claude --dangerously-skip-permissions)' },
    // Legacy v0.x flags. Kept declared so citty doesn't reject them; warned
    // in run() to nudge users toward the new daemon model. Without these
    // declarations, `wechat-cc run --fresh` would error on parse.
    fresh: { type: 'boolean', description: 'Legacy v0.x flag (ignored)' },
    continue: { type: 'boolean', description: 'Legacy v0.x flag (ignored)' },
    channels: { type: 'boolean', description: 'Legacy v0.x flag (ignored)' },
    'mcp-config': { type: 'string', description: 'Legacy v0.x flag (ignored)' },
  },
  async run({ args }) {
    if (args.fresh) console.warn(`[wechat-cc] legacy flag ignored: --fresh (v1.0+ daemon doesn't spawn claude directly)`)
    if (args.continue) console.warn(`[wechat-cc] legacy flag ignored: --continue (v1.0+ daemon doesn't spawn claude directly)`)
    if (args.channels) console.warn(`[wechat-cc] legacy flag ignored: --channels (v1.0+ daemon doesn't spawn claude directly)`)
    if (args['mcp-config']) console.warn(`[wechat-cc] legacy flag ignored: --mcp-config (v1.0+ daemon doesn't spawn claude directly)`)
    // Run the daemon in-process by calling main.ts's exported main(). Used
    // to spawn `bun src/daemon/main.ts`, but that doesn't work in
    // `bun build --compile`d binaries where the source tree isn't on disk —
    // the compiled sidecar shipped inside the desktop bundle is the single
    // source of truth for both CLI and daemon. We must call main() EXPLICITLY:
    // a bare `await import(...)` won't trigger main() because import.meta.main
    // is false for any imported module under standard ESM semantics, so the
    // import-then-block pattern silently no-ops.
    if (args.dangerously && !process.argv.includes('--dangerously')) {
      process.argv.push('--dangerously')
    }
    const { main: runDaemon } = await import('../../daemon/main.ts')
    await runDaemon()
    // main() returns after attaching signal handlers; the daemon's lifecycle
    // (HTTP server, polling intervals) keeps the event loop alive. Block here
    // so cli.ts's caller doesn't see a premature resolve.
    await new Promise(() => {})
  },
})
