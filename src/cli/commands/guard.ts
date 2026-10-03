// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { GuardStatusOutput, GuardEnableOutput, GuardDisableOutput } from '../schema'

type SuspendedTaskRow = { task_id: string; title: string; provider: string; since: string }
/**
 * 被网络守护冻住的任务(主人 2026-10-03)只有在跑的 daemon 知道:问它的 /v1/health(本机回环,
 * 不出门)。daemon 没在跑 / 读不出 ⇒ null(不是 0 —— 不知道就别说没有)。
 */
async function daemonSuspendedTasks(): Promise<SuspendedTaskRow[] | null> {
  try {
    const { readDaemon } = await import('../doctor')
    const { readFileSync } = await import('node:fs')
    const d = readDaemon(STATE_DIR)
    if (!d.alive || !d.internal_api) return null
    const token = readFileSync(d.internal_api.token_file_path, 'utf8').trim()
    const res = await fetch(`http://127.0.0.1:${d.internal_api.port}/v1/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const body = await res.json() as { guard?: { suspended_tasks?: SuspendedTaskRow[] } }
    return Array.isArray(body.guard?.suspended_tasks) ? body.guard!.suspended_tasks! : null
  } catch { return null }
}
const guardStatusCmd = defineCommand({
  meta: { name: 'status', description: "Live one-shot check — bx protection (if installed) or external IP + reachability" },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    // Live one-shot probe (independent of any running daemon's
    // scheduler). Useful for both the dashboard status row and
    // operator debugging — `wechat-cc guard status --json` from
    // any terminal returns the current external IP + reachability.
    const { loadGuardConfig } = await import('../../daemon/guard/store')
    const { fetchPublicIp, probeReachable, findBx, readBxStatus, classifyConfiguredForCli } = await import('../../daemon/guard/probe')
    const cfg = loadGuardConfig(STATE_DIR)
    const ipRes = await fetchPublicIp({ url: cfg.ipify_url })
    // 装了 bx 且守护开着:只认 bx(本机 socket,只读,不发流量),不再探 google。guard.json
    // signal_source='probe' ⇒ 装着 bx 也走探测。守护关着时不碰 bx —— 开关关了就什么都不判。
    const bxPath = cfg.enabled && cfg.signal_source !== 'probe' ? findBx() : null
    // 守护 v2:按调用判 —— 列出已配置 provider 各自要不要保护(只读配置,不发流量)。
    const providers = classifyConfiguredForCli(STATE_DIR)
    const protectedInUse = providers.some(p => p.protected)
    const suspendedTasks = await daemonSuspendedTasks()
    const suspendedOut = suspendedTasks ? { suspended: suspendedTasks.length, suspended_tasks: suspendedTasks } : {}
    let out
    if (bxPath) {
      const v = await readBxStatus(bxPath)
      out = {
        enabled: cfg.enabled, ip: ipRes.ip, reachable: v.safe, probe_url: cfg.probe_url,
        ip_error: ipRes.error ?? null, probe_error: v.safe ? null : v.detail, probe_ms: null,
        source: 'bx' as const, safe: v.safe, detail: v.detail, bx_path: bxPath,
        signal_source: cfg.signal_source, protected_in_use: protectedInUse, providers, ...suspendedOut,
      }
    } else {
      const probeRes = await probeReachable(cfg.probe_url)
      out = {
        enabled: cfg.enabled, ip: ipRes.ip, reachable: probeRes.reachable, probe_url: cfg.probe_url,
        ip_error: ipRes.error ?? null, probe_error: probeRes.error ?? null, probe_ms: probeRes.ms,
        source: 'probe' as const, safe: probeRes.reachable,
        detail: probeRes.reachable ? '探测可达' : `探测失败${probeRes.error ? `(${probeRes.error})` : ''}`,
        bx_path: null,
        signal_source: cfg.signal_source, protected_in_use: protectedInUse, providers, ...suspendedOut,
      }
    }
    if (args.json) console.log(JSON.stringify(GuardStatusOutput.parse(out), null, 2))
    else {
      console.log(`enabled: ${out.enabled}`)
      console.log(`ip:      ${out.ip ?? '?'}${out.ip_error ? ` (${out.ip_error})` : ''}`)
      if (out.source === 'bx') {
        console.log(`bx:      ${out.safe ? 'protected' : 'NOT PROTECTED'} — ${out.detail} (${bxPath})`)
        if (!out.safe) console.log('         用到需要保护的接口(Claude 等)的调用会暂停;想查是否已漏过,跑 `bx leakcheck`。')
      } else {
        console.log(`probe:   ${out.reachable ? 'reachable' : 'UNREACHABLE'} (${cfg.probe_url})${out.probe_error ? ` — ${out.probe_error}` : ''}${cfg.signal_source === 'probe' ? ' [guard.json signal_source=probe]' : ''}`)
      }
      console.log('calls:   (按调用判:只有需要保护的调用会在网络未受保护时暂停)')
      for (const p of providers) {
        console.log(`  ${p.protected ? '需要保护  ' : '不需要保护'}  ${p.id}${p.model ? ` · ${p.model}` : ''}${p.host ? ` → ${p.host}` : ''} — ${p.reason}`)
      }
      if (!protectedInUse) console.log('  当前没有用到需要保护的接口')
      // 暂停在跑的任务(2026-10-03):probe 来源连续两次不安全 ⇒ 冻住,恢复后自动继续;到顶(max_suspend_minutes)停下。
      if (suspendedTasks === null) console.log('paused:  (daemon 没在跑或读不出,不知道有没有被暂停的任务)')
      else if (!suspendedTasks.length) console.log('paused:  没有被暂停的任务')
      else {
        console.log(`paused:  ${suspendedTasks.length} 个任务已暂停(网络未受保护),恢复后自动继续;超过 ${cfg.max_suspend_minutes} 分钟没恢复就停下`)
        for (const t of suspendedTasks) console.log(`  ${t.task_id}  ${t.provider}  ${t.title}  (从 ${t.since})`)
      }
    }
  },
})

async function setGuardEnabled(enabled: boolean, json: boolean): Promise<void> {
  const { loadGuardConfig, saveGuardConfig } = await import('../../daemon/guard/store')
  const cfg = loadGuardConfig(STATE_DIR)
  cfg.enabled = enabled
  saveGuardConfig(STATE_DIR, cfg)
  if (json) console.log(JSON.stringify((enabled ? GuardEnableOutput : GuardDisableOutput).parse({ ok: true, enabled: cfg.enabled })))
  else console.log(`guard: ${cfg.enabled ? 'enabled' : 'disabled'}`)
}

const guardEnableCmd = defineCommand({
  meta: { name: 'enable', description: 'Enable network-guard scheduler (next daemon start)' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) { await setGuardEnabled(true, Boolean(args.json)) },
})

const guardDisableCmd = defineCommand({
  meta: { name: 'disable', description: 'Disable network-guard scheduler' },
  args: { json: { type: 'boolean', description: 'JSON envelope' } },
  async run({ args }) { await setGuardEnabled(false, Boolean(args.json)) },
})

export const guardCmd = defineCommand({
  meta: { name: 'guard', description: 'Network-guard config + live probe' },
  subCommands: {
    status: guardStatusCmd,
    enable: guardEnableCmd,
    disable: guardDisableCmd,
  },
})
