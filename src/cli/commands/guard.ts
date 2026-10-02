// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { GuardStatusOutput, GuardEnableOutput, GuardDisableOutput } from '../schema'
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
    const { fetchPublicIp, probeReachable, findBx, readBxStatus } = await import('../../daemon/guard/probe')
    const cfg = loadGuardConfig(STATE_DIR)
    const ipRes = await fetchPublicIp({ url: cfg.ipify_url })
    // 装了 bx 且守护开着:以 bx 为准(本机 socket,只读,不发流量),不再探 google。
    // 守护关着时不碰 bx —— 和 daemon 一样,开关关了就什么都不判。
    const bxPath = cfg.enabled ? findBx() : null
    let out
    if (bxPath) {
      const v = await readBxStatus(bxPath)
      out = {
        enabled: cfg.enabled, ip: ipRes.ip, reachable: v.safe, probe_url: cfg.probe_url,
        ip_error: ipRes.error ?? null, probe_error: v.safe ? null : v.detail, probe_ms: null,
        source: 'bx' as const, safe: v.safe, detail: v.detail, bx_path: bxPath,
      }
    } else {
      const probeRes = await probeReachable(cfg.probe_url)
      out = {
        enabled: cfg.enabled, ip: ipRes.ip, reachable: probeRes.reachable, probe_url: cfg.probe_url,
        ip_error: ipRes.error ?? null, probe_error: probeRes.error ?? null, probe_ms: probeRes.ms,
        source: 'probe' as const, safe: probeRes.reachable,
        detail: probeRes.reachable ? '探测可达' : `探测失败${probeRes.error ? `(${probeRes.error})` : ''}`,
        bx_path: null,
      }
    }
    if (args.json) console.log(JSON.stringify(GuardStatusOutput.parse(out), null, 2))
    else {
      console.log(`enabled: ${out.enabled}`)
      console.log(`ip:      ${out.ip ?? '?'}${out.ip_error ? ` (${out.ip_error})` : ''}`)
      if (out.source === 'bx') {
        console.log(`bx:      ${out.safe ? 'protected' : 'NOT PROTECTED'} — ${out.detail} (${bxPath})`)
        if (!out.safe) console.log('         CC 会暂停所有模型调用;想查是否已漏过,跑 `bx leakcheck`。')
      } else {
        console.log(`probe:   ${out.reachable ? 'reachable' : 'UNREACHABLE'} (${cfg.probe_url})${out.probe_error ? ` — ${out.probe_error}` : ''}`)
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
