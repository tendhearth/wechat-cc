// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { emitJson } from '../output'
import { LogOutput } from '../schema'
export const logsCmd = defineCommand({
  meta: { name: 'logs', description: "Tail the daemon's channel.log (default --tail 50)" },
  args: {
    tail: { type: 'string', description: 'Number of trailing entries (default 50)' },
    json: { type: 'boolean', description: 'JSON envelope (parsed entries)' },
    'out-file': { type: 'string', description: 'Write JSON to a sibling file (avoids pipe buffer truncation in compiled binaries)' },
  },
  async run({ args }) {
    const tailNum = args.tail ? Number.parseInt(args.tail, 10) : 50
    const tail = Number.isFinite(tailNum) ? tailNum : 50
    const outFile = args['out-file']
    const { tailLog, formatLogsForCli } = await import('../logs.ts')
    const { LogsOutput } = await import('../schema.ts')
    const result = tailLog(STATE_DIR, tail)
    // JSON success path routes through emitJson so --out-file is honoured —
    // bun --compile pipes drop bytes on MB-sized payloads (sessions hit the
    // same wall and use this pattern; see lib.rs:22-26 for the rationale).
    if (args.json && result.ok) {
      emitJson(LogsOutput.parse(result), outFile)
      return
    }
    const out = formatLogsForCli(result, Boolean(args.json))
    if (out.stdout) console.log(out.stdout)
    if (out.stderr) console.error(out.stderr)
    if (out.exitCode !== 0) process.exit(out.exitCode)
  },
})

// ── wechat-cc log <tag> <msg> [--fields <json>] [--json] ─────────────────────
// Fire-and-forget log writer for external callers (e.g. the desktop frontend).
// Used by RECONNECT_DIAGNOSE telemetry (Step 4).
export const logCmd = defineCommand({
  meta: { name: 'log', description: 'Write a structured log line to channel.log (for frontend telemetry)' },
  args: {
    tag: { type: 'positional', required: true, description: 'Log tag (e.g. RECONNECT_DIAGNOSE)', valueHint: 'tag' },
    msg: { type: 'positional', required: true, description: 'Human-readable log message', valueHint: 'msg' },
    fields: { type: 'string', description: 'Structured fields as a JSON object string (e.g. \'{"code":1}\')' },
    json: { type: 'boolean', description: 'Emit { ok: true } JSON envelope on stdout' },
  },
  async run({ args }) {
    const { runLogCommand } = await import('../log.ts')
    let result: { ok: true }
    try {
      result = runLogCommand({ tag: args.tag, msg: args.msg, fieldsJson: args.fields })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`log: ${msg}`)
      process.exit(2)
    }
    if (args.json) console.log(JSON.stringify(LogOutput.parse(result)))
  },
})

