// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { readJsonFile } from '../../lib/read-json-file'
import { join } from 'node:path'
import { STATE_DIR } from '../../lib/config'
import { DaemonKillOutput } from '../schema'
const daemonKillCmd = defineCommand({
  meta: { name: 'kill', description: 'Force-kill a daemon process by pid (verifies cmdline; SIGTERM 1.5s grace then SIGKILL)' },
  args: {
    pid: { type: 'positional', required: true, description: 'Process id (positive integer)', valueHint: 'pid' },
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const pid = Number.parseInt(args.pid, 10)
    if (!Number.isFinite(pid) || pid <= 0) {
      console.error(`pid must be a positive integer (got: ${args.pid})`)
      process.exit(2)
    }
    const { killDaemonByPid, defaultKillDeps } = await import('../daemon-kill.ts')
    const result = await killDaemonByPid(defaultKillDeps(), pid)
    if (args.json) console.log(JSON.stringify(DaemonKillOutput.parse(result), null, 2))
    else console.log(result.killed ? `killed pid ${result.pid}` : `failed: ${result.message}`)
    if (!result.killed) process.exit(1)
  },
})

const daemonKillResidualCmd = defineCommand({
  meta: {
    name: 'kill-residual',
    description: 'Read server.pid and kill the daemon if alive (covers manual `wechat-cc run` instances launchctl/systemd cannot reach)',
  },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    const { killResidualDaemon, defaultResidualKillDeps } = await import('../daemon-kill.ts')
    const result = await killResidualDaemon(defaultResidualKillDeps(), join(STATE_DIR, 'server.pid'))
    if (args.json) console.log(JSON.stringify(DaemonKillOutput.parse(result), null, 2))
    else console.log(result.killed ? `killed pid ${result.pid}` : result.message)
    // Exit 0 for "nothing to kill" or successful kill — the desktop's restart
    // step treats those identically (lock is free, proceed to start). Only
    // exit 1 if we found a live daemon we couldn't kill (operator must
    // intervene before the next start succeeds).
    if (!result.killed && /still alive/.test(result.message)) process.exit(1)
  },
})

const daemonApiInfoCmd = defineCommand({
  meta: { name: 'api-info', description: 'Read internal-api-info.json (base URL + token) — used by the desktop GUI to call /v1/* endpoints' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope (always emits JSON; flag is for CLI consistency)' },
    // NO --operator FLAG, deliberately. The admin operator credential is read
    // only by processes that hold it natively — the Tauri host (lib.rs:
    // agent_converse / agent_speak / agent_transcribe / customer_review_api)
    // and the dev server. Exposing it through the CLI would mean anything able
    // to run `wechat-cc` — including the webview, since the production
    // `wechat_cli_json` command applies no argument filtering — could obtain
    // admin authority and reach POST /v1/companion/converse, i.e. speak to
    // WeChat as the owner. A --operator flag existed briefly in 45a5211 and
    // was removed in the 2026-07-28 review.
  },
  async run({ args }) {
    const { existsSync, readFileSync } = await import('node:fs')
    const infoPath = join(STATE_DIR, 'internal-api-info.json')
    if (!existsSync(infoPath)) {
      console.log(JSON.stringify({ ok: false, error: 'daemon not running (internal-api-info.json not found)' }))
      process.exit(1)
    }
    let info: { baseUrl?: string; tokenFilePath?: string; operatorTokenFilePath?: string }
    try {
      info = readJsonFile(infoPath)
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: `could not read internal-api-info.json: ${err instanceof Error ? err.message : String(err)}` }))
      process.exit(1)
    }
    if (!info.baseUrl || !info.tokenFilePath) {
      console.log(JSON.stringify({ ok: false, error: 'internal-api-info.json is malformed (missing baseUrl or tokenFilePath)' }))
      process.exit(1)
    }
    // Always the trusted token — see the note on the missing --operator flag.
    const credentialPath = info.tokenFilePath
    let token: string
    try {
      token = readFileSync(credentialPath, 'utf8').trim()
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: `could not read token file: ${err instanceof Error ? err.message : String(err)}` }))
      process.exit(1)
    }
    console.log(JSON.stringify({ ok: true, baseUrl: info.baseUrl, token }))
  },
})

const daemonA2AEnableCmd = defineCommand({
  meta: { name: 'enable', description: 'Enable the A2A inbound server (writes agent-config.json; restart needed)' },
  args: {
    host: { type: 'string', description: 'Bind host (default: 127.0.0.1)' },
    port: { type: 'string', description: 'Bind port (default: 8717)' },
  },
  async run({ args }) {
    const port = args.port ? Number.parseInt(args.port, 10) : 8717
    if (!Number.isFinite(port)) {
      console.error(`port must be a number; got ${JSON.stringify(args.port)}`)
      process.exit(1)
    }
    const { cmdDaemonA2AEnable } = await import('../agent.ts')
    cmdDaemonA2AEnable(STATE_DIR, { host: args.host, port })
  },
})

const daemonA2ADisableCmd = defineCommand({
  meta: { name: 'disable', description: 'Disable the A2A inbound server (removes a2a_listen from agent-config.json; restart needed)' },
  async run() {
    const { cmdDaemonA2ADisable } = await import('../agent.ts')
    cmdDaemonA2ADisable(STATE_DIR)
  },
})

const daemonA2AStatusCmd = defineCommand({
  meta: { name: 'status', description: 'Show A2A server config (on-disk) vs runtime (currently bound); flags drift' },
  async run() {
    const { cmdDaemonA2AStatus } = await import('../agent.ts')
    cmdDaemonA2AStatus(STATE_DIR)
  },
})

const daemonA2ACmd = defineCommand({
  meta: { name: 'a2a', description: 'A2A inbound server config — enable, disable, status' },
  subCommands: {
    enable: daemonA2AEnableCmd,
    disable: daemonA2ADisableCmd,
    status: daemonA2AStatusCmd,
  },
})

export const daemonCmd = defineCommand({
  meta: { name: 'daemon', description: 'Daemon process control' },
  subCommands: { kill: daemonKillCmd, 'kill-residual': daemonKillResidualCmd, 'api-info': daemonApiInfoCmd, a2a: daemonA2ACmd },
})
