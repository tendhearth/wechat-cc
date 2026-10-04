// `wechat-cc cli status|upgrade|rollback` —— 外部 agent CLI(Claude Code / Codex / cursor-agent / agy)的
// 版本与自动升级(主人 2026-10-04,docs/maintainer/cli-auto-upgrade.md)。
// status:本机只读探测(--check 再现查最新);upgrade / rollback:交给在跑的 daemon(它守着「只在空闲时动手、
// 同一时刻只做一件、动手期间挡住空闲自动重启」这几条),用 operator 凭据调 /v1/cli/*。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'

const EXIT = { ok: 0, failed: 1, noDaemon: 2 } as const
const NAMES = 'claude | codex | cursor | agy'

const statusCmd = defineCommand({
  meta: { name: 'status', description: '本机外部 agent CLI 的版本、升级器、能否自动退回,以及 daemon 记下的自动升级状态(只读)' },
  args: {
    check: { type: 'boolean', description: '现查一次最新版本(官方发布元数据,只读;不装、不写状态)' },
    json: { type: 'boolean', description: 'JSON 输出' },
  },
  async run({ args }) {
    const { collectAgentCliStatus, formatAgentCliStatus, defaultAgentCliStatusDeps } = await import('../agent-cli-status')
    const s = await collectAgentCliStatus(await defaultAgentCliStatusDeps(STATE_DIR), { check: Boolean(args.check) })
    console.log(args.json ? JSON.stringify(s, null, 2) : formatAgentCliStatus(s))
  },
})

async function callDaemon(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null } | null> {
  const { readApiInfo } = await import('../../lib/api-info')
  const api = readApiInfo(STATE_DIR)
  if (!api) return null
  try {
    // 升级 + 两段自检 + 可能的退回都在这一次请求里做完:给足时间。
    const res = await fetch(`${api.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${api.operatorToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45 * 60_000),
    })
    const json = await res.json().catch(() => null) as Record<string, unknown> | null
    return { status: res.status, json }
  } catch (err) {
    const { isConnectFailure } = await import('../../lib/net-errors')
    if (err instanceof Error && isConnectFailure(err.message)) return null
    throw err
  }
}

function report(kind: string, r: { status: number; json: Record<string, unknown> | null }, json: boolean): never {
  const outcome = (r.json?.outcome ?? null) as { ok?: boolean; result?: string; from?: string | null; to?: string | null; detail?: string } | null
  if (json) console.log(JSON.stringify(r.json, null, 2))
  else if (!outcome) console.error(`cli ${kind}: HTTP ${r.status} ${String(r.json?.error ?? '')}`)
  else console.log(`${outcome.result}${outcome.from || outcome.to ? `:${outcome.from ?? '?'} → ${outcome.to ?? '?'}` : ''}${outcome.detail ? `\n${outcome.detail}` : ''}`)
  process.exit(outcome?.ok ? EXIT.ok : EXIT.failed)
}

const upgradeCmd = defineCommand({
  meta: { name: 'upgrade', description: '现在就查最新并用官方升级器升级一个 CLI(只在空闲时;升完自检,不过自动退回)。daemon 需在跑' },
  args: {
    name: { type: 'positional', required: true, description: NAMES },
    force: { type: 'boolean', description: '即使已是最新 / 最新是记过的坏版本,也跑一次官方升级器' },
    json: { type: 'boolean', description: 'JSON 输出' },
  },
  async run({ args }) {
    const r = await callDaemon('/v1/cli/upgrade', { name: args.name, ...(args.force ? { force: true } : {}) })
    if (!r) { console.error('cli upgrade: daemon 没在跑(升级要由 daemon 来做:它负责空闲判定和升级后的自检)'); process.exit(EXIT.noDaemon) }
    report('upgrade', r, Boolean(args.json))
  },
})

const rollbackCmd = defineCommand({
  meta: { name: 'rollback', description: '退回上一个版本(本机留着的旧版本 / 官方装指定版本),当前版本记为有问题。daemon 需在跑' },
  args: {
    name: { type: 'positional', required: true, description: NAMES },
    json: { type: 'boolean', description: 'JSON 输出' },
  },
  async run({ args }) {
    const r = await callDaemon('/v1/cli/rollback', { name: args.name })
    if (!r) { console.error('cli rollback: daemon 没在跑'); process.exit(EXIT.noDaemon) }
    report('rollback', r, Boolean(args.json))
  },
})

export const cliCmd = defineCommand({
  meta: { name: 'cli', description: '外部 agent CLI(claude / codex / cursor-agent / agy)的版本与自动升级' },
  subCommands: { status: statusCmd, upgrade: upgradeCmd, rollback: rollbackCmd },
})
