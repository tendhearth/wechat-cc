// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { readJsonFile } from '../../lib/read-json-file'
import { join } from 'node:path'
import { STATE_DIR } from '../../lib/config'
// ── mode set — programmatic mode switch via running daemon's internal-api ──
//
// Reads STATE_DIR/internal-api-info.json (written by daemon on start) to
// discover the bound port + token file. Posts to /v1/conversation/set-mode.
// On error (daemon not running, 401, 5xx): clear error message + exit 1.

const modeSetCmd = defineCommand({
  meta: { name: 'set', description: 'Set chat mode programmatically (calls running daemon via internal-api)' },
  args: {
    chatId: { type: 'positional', required: true, description: 'WeChat chat id', valueHint: 'chat-id' },
    mode: {
      type: 'positional',
      required: true,
      description: 'cc|codex|solo|both|chat (or full JSON mode shape)',
      valueHint: 'cc|codex|solo|both|chat|json',
    },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { existsSync, readFileSync } = await import('node:fs')
    const infoPath = join(STATE_DIR, 'internal-api-info.json')
    const jsonOut = Boolean(args.json)

    const emitError = (msg: string): never => {
      if (jsonOut) console.log(JSON.stringify({ ok: false, error: msg }))
      else console.error(`mode set: ${msg}`)
      process.exit(1)
    }

    if (!existsSync(infoPath)) {
      emitError('daemon not running (internal-api-info.json not found — start the daemon first)')
    }

    let info: { baseUrl: string; tokenFilePath: string }
    try {
      info = readJsonFile(infoPath)
    } catch (err) {
      emitError(`could not read internal-api-info.json: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!info!.baseUrl || !info!.tokenFilePath) {
      emitError('internal-api-info.json is malformed (missing baseUrl or tokenFilePath)')
    }

    let tokenHex: string
    try {
      tokenHex = readFileSync(info!.tokenFilePath, 'utf8').trim()
    } catch (err) {
      emitError(`could not read token file: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Map shorthands to full Mode shapes (matches mode-commands.ts semantics)
    const SHORTHAND: Record<string, object> = {
      cc:    { kind: 'solo', provider: 'claude' },
      codex: { kind: 'solo', provider: 'codex' },
      solo:  { kind: 'solo', provider: 'claude' },
      both:  { kind: 'parallel' },
      chat:  { kind: 'chatroom' },
    }

    let modeObj: object
    const raw = args.mode
    if (SHORTHAND[raw]) {
      modeObj = SHORTHAND[raw]!
    } else {
      try {
        modeObj = JSON.parse(raw)
        if (typeof modeObj !== 'object' || modeObj === null) throw new Error('must be a JSON object')
      } catch (err) {
        emitError(`unrecognised mode '${raw}' — use cc/codex/solo/both/chat or a JSON mode shape: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    let resp: Response
    try {
      resp = await fetch(`${info!.baseUrl}/v1/conversation/set-mode`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${tokenHex!}`,
        },
        body: JSON.stringify({ chatId: args.chatId, mode: modeObj! }),
      })
    } catch (err) {
      emitError(`could not reach daemon (${info!.baseUrl}): ${err instanceof Error ? err.message : String(err)}`)
    }

    if (!resp!.ok) {
      const text = await resp!.text().catch(() => '')
      if (resp!.status === 401) {
        // Distinguish stale CLI token from daemon auth rejection: the
        // 401 happens for both, but operator action differs. A stale
        // token means rotating the file under .claude/channels/wechat
        // (or a daemon restart that rotates it); an auth rejected
        // response from a fresh token means the daemon's identity
        // store is out of sync with the CLI's. Surface the body so
        // both cases are obvious.
        const looksStale = /token mismatch|stale|expired/i.test(text)
        const hint = looksStale
          ? 'stale token — restart the daemon to rotate, OR delete ~/.claude/channels/wechat/internal-token and re-run.'
          : 'daemon rejected authentication. The CLI loaded the current token but the daemon refused it; check daemon logs for [AUTH] entries.'
        emitError(`unauthorized: ${hint}`)
      }
      emitError(`daemon returned ${resp!.status}: ${text}`)
    }

    const result = await resp!.json() as Record<string, unknown>
    if (jsonOut) console.log(JSON.stringify(result, null, 2))
    else console.log(`mode set: ok (chat=${args.chatId} mode=${JSON.stringify(modeObj!)})`)
  },
})

export const modeCmd = defineCommand({
  meta: { name: 'mode', description: 'Conversation mode management (programmatic switch via running daemon)' },
  subCommands: { set: modeSetCmd },
})
