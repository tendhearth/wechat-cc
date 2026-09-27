// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
import { GuardStatusOutput, GuardEnableOutput, GuardDisableOutput } from '../schema'
const guardStatusCmd = defineCommand({
  meta: { name: 'status', description: "Live one-shot probe — current external IP + reachability" },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
  },
  async run({ args }) {
    // Live one-shot probe (independent of any running daemon's
    // scheduler). Useful for both the dashboard status row and
    // operator debugging — `wechat-cc guard status --json` from
    // any terminal returns the current external IP + reachability.
    const { loadGuardConfig } = await import('../../daemon/guard/store')
    const { fetchPublicIp, probeReachable } = await import('../../daemon/guard/probe')
    const cfg = loadGuardConfig(STATE_DIR)
    const ipRes = await fetchPublicIp({ url: cfg.ipify_url })
    const probeRes = await probeReachable(cfg.probe_url)
    const out = {
      enabled: cfg.enabled,
      ip: ipRes.ip,
      reachable: probeRes.reachable,
      probe_url: cfg.probe_url,
      ip_error: ipRes.error ?? null,
      probe_error: probeRes.error ?? null,
      probe_ms: probeRes.ms,
    }
    if (args.json) console.log(JSON.stringify(GuardStatusOutput.parse(out), null, 2))
    else {
      console.log(`enabled: ${out.enabled}`)
      console.log(`ip:      ${out.ip ?? '?'}${out.ip_error ? ` (${out.ip_error})` : ''}`)
      console.log(`probe:   ${out.reachable ? 'reachable' : 'UNREACHABLE'} (${cfg.probe_url})${out.probe_error ? ` — ${out.probe_error}` : ''}`)
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
