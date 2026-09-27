// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { join } from 'node:path'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { SOURCE_REPO_ROOT } from '../repo-root'
import { STATE_DIR } from '../../lib/config'
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import { appMainBinaryPath, compiledBinaryPath, compiledRepoRoot } from '../../lib/runtime-info'
import { defaultDoctorDeps, serviceStatus } from '../doctor'
import { buildServicePlan, installService, startService, stopService, uninstallService } from '../service-manager'
import { parseBoolValue } from '../flags'
import { ServiceStatusOutput, ServiceInstallOutput, ServiceStartOutput, ServiceStopOutput, ServiceUninstallOutput } from '../schema'
export const serviceCmd = defineCommand({
  meta: {
    name: 'service',
    description: 'Daemon service management — register / start / stop / uninstall a launchd / systemd / ScheduledTask entry',
  },
  args: {
    action: {
      type: 'positional',
      required: true,
      description: 'status | install | start | stop | uninstall',
      valueHint: 'status|install|start|stop|uninstall',
    },
    json: { type: 'boolean', description: 'JSON envelope' },
    // Tri-state strings (parseBoolValue inside run): true / false / undefined.
    // Citty's boolean type can't distinguish "absent" from "explicit false",
    // and service install treats omission as "leave existing config alone".
    unattended: { type: 'string', description: 'true | false | yes | no | on | off — persist into agent-config (omit to leave unchanged)' },
    'auto-start': { type: 'string', description: 'true | false | yes | no | on | off — register for boot/login auto-start' },
  },
  async run({ args }) {
    const validActions = ['status', 'install', 'start', 'stop', 'uninstall'] as const
    type ServiceAction = typeof validActions[number]
    const action = args.action as ServiceAction
    if (!validActions.includes(action)) {
      console.error(`service action must be one of ${validActions.join(' | ')} (got: ${args.action})`)
      process.exit(2)
    }
    const unattended = parseBoolValue(args.unattended)
    const autoStart = parseBoolValue(args['auto-start'])
    // If the caller passed --unattended or --auto-start, persist them into
    // agent-config first so it's the source of truth (re-installs from the
    // GUI re-pick the same values).
    if (unattended !== undefined || autoStart !== undefined) {
      const existing = loadAgentConfig(STATE_DIR)
      saveAgentConfig(STATE_DIR, {
        ...existing,
        ...(unattended !== undefined ? { dangerouslySkipPermissions: unattended } : {}),
        ...(autoStart !== undefined ? { autoStart } : {}),
      })
    }
    const config = loadAgentConfig(STATE_DIR)
    // Compiled-bundle mode: launch the daemon via the same self-contained
    // binary (no external bun + cli.ts source). Source mode: legacy
    // `bunPath cli.ts run` ExecStart. compiledBinaryPath/compiledRepoRoot
    // both return non-null only in compiled mode — see runtime-info.ts.
    const binaryPath = compiledBinaryPath() ?? undefined
    const appBinaryPath = appMainBinaryPath() ?? undefined
    // 原来是 dirname(fileURLToPath(import.meta.url))(= 仓库根,cli.ts 住那);搬家后改从 repo-root 取。
    const planCwd = compiledRepoRoot() ?? SOURCE_REPO_ROOT
    const plan = buildServicePlan({
      cwd: planCwd,
      dangerouslySkipPermissions: config.dangerouslySkipPermissions,
      autoStart: config.autoStart,
      ...(binaryPath ? { binaryPath } : {}),
      ...(appBinaryPath ? { appBinaryPath } : {}),
    })
    const json = Boolean(args.json)
    if (action === 'status') {
      const status = serviceStatus(defaultDoctorDeps())
      if (json) console.log(JSON.stringify(ServiceStatusOutput.parse({ ...status, plan, agentConfig: config }), null, 2))
      else console.log(`service: ${status.state}${status.installed ? ' [installed]' : ''}${status.pid ? ` pid=${status.pid}` : ''}`)
      return
    }
    // WECHAT_CC_DRY_RUN=1 makes install/uninstall/start/stop a no-op (still
    // returns the plan in JSON). Used by the apps/desktop e2e shim so tests
    // exercise real cli.ts without touching ~/Library/LaunchAgents/launchd.
    const dryRun = process.env.WECHAT_CC_DRY_RUN === '1'
    const sideOpts = { dryRun }
    if (action === 'install') {
      // Idempotent: best-effort tear down any previous install so we can
      // re-write the plist (e.g. unattended toggle changed). Swallow errors
      // — a partial/stale state (plist missing, launchd doesn't have it)
      // would otherwise block the fresh install.
      try { uninstallService(plan, sideOpts) } catch { /* tolerate */ }
      // Wire onProgress → install-progress.json so the GUI wizard can poll
      // real step state ("(2/4) systemctl daemon-reload") instead of showing
      // an opaque "安装中…" forever. Cleared at start + end so a stale file
      // from a previous crashed install doesn't haunt the next one.
      const progressPath = join(STATE_DIR, 'install-progress.json')
      try { rmSync(progressPath, { force: true }) } catch { /* tolerate */ }
      installService(plan, {
        ...sideOpts,
        onProgress: (e) => {
          try {
            mkdirSync(STATE_DIR, { recursive: true })
            writeFileSync(progressPath, JSON.stringify({ ...e, ts: Date.now() }))
          } catch { /* progress is best-effort — never break install */ }
        },
      })
      try { rmSync(progressPath, { force: true }) } catch { /* tolerate */ }
    } else if (action === 'start') startService(plan, sideOpts)
    else if (action === 'stop') stopService(plan, sideOpts)
    else if (action === 'uninstall') uninstallService(plan, sideOpts)
    const out = { ok: true as const, action, plan, agentConfig: config, dryRun }
    const serviceActionSchema = action === 'install' ? ServiceInstallOutput
      : action === 'start' ? ServiceStartOutput
      : action === 'stop' ? ServiceStopOutput
      : ServiceUninstallOutput
    if (json) console.log(JSON.stringify(serviceActionSchema.parse(out), null, 2))
    else console.log(`service ${action}: ok${dryRun ? ' (dry-run)' : ''}`)
  },
})
