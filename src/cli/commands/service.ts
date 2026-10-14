// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { join } from 'node:path'
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, renameSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { SOURCE_REPO_ROOT } from '../repo-root'
import { STATE_DIR } from '../../lib/config'
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import { appMainBinaryPath, compiledBinaryPath, compiledRepoRoot } from '../../lib/runtime-info'
import { defaultDoctorDeps, serviceStatus } from '../doctor'
import { buildServicePlan, installService, reloadService, startService, stopService, uninstallService } from '../service-manager'
import { parseBoolValue } from '../flags'
import { ServiceStatusOutput, ServiceInstallOutput, ServiceStartOutput, ServiceStopOutput, ServiceUninstallOutput, ServiceRepairOutput } from '../schema'
import { runServiceRepair } from '../service-repair'
import { claudeSettingsPath, codexHooksPath, hookCommandLine, hookStatus, installHooks } from '../hook'
export const serviceCmd = defineCommand({
  meta: {
    name: 'service',
    description: 'Daemon service management — register / start / stop / uninstall a launchd / systemd / ScheduledTask entry',
  },
  args: {
    action: {
      type: 'positional',
      required: true,
      description: 'status | install | start | stop | uninstall | repair',
      valueHint: 'status|install|start|stop|uninstall|repair',
    },
    json: { type: 'boolean', description: 'JSON envelope' },
    // Tri-state strings (parseBoolValue inside run): true / false / undefined.
    // Citty's boolean type can't distinguish "absent" from "explicit false",
    // and service install treats omission as "leave existing config alone".
    unattended: { type: 'string', description: 'true | false | yes | no | on | off — persist into agent-config (omit to leave unchanged)' },
    'auto-start': { type: 'string', description: 'true | false | yes | no | on | off — register for boot/login auto-start' },
    'no-reload': { type: 'boolean', description: 'repair: rewrite the LaunchAgent file but do not bootout/bootstrap it' },
  },
  async run({ args }) {
    const validActions = ['status', 'install', 'start', 'stop', 'uninstall', 'repair'] as const
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
    if (action === 'repair') {
      // app 换了位置 / 换了二进制名(1.7.5 改名迁移)之后,把 LaunchAgent / 终端 hook /
      // 转发脚本改到自己身上。判定与边界见 service-repair.ts / app-relocation.ts。
      const home = homedir()
      const self = { mainBinary: appBinaryPath ?? null, sidecar: binaryPath ?? null }
      const readFile = (p: string): string | null => { try { return readFileSync(p, 'utf8') } catch { return null } }
      const result = runServiceRepair({
        platform: process.platform,
        self,
        plistPath: plan.serviceFile ?? '',
        forwarderPath: join(home, '.local', 'bin', 'wechat-cc'),
        hookFiles: [
          { source: 'claude', file: claudeSettingsPath(home) },
          { source: 'codex', file: codexHooksPath(home, process.env) },
        ],
        readFile,
        exists: existsSync,
        writeFileAtomic: (p, content, mode) => {
          mkdirSync(dirname(p), { recursive: true })
          const tmp = `${p}.tmp-${process.pid}`
          writeFileSync(tmp, content)
          if (mode !== undefined) chmodSync(tmp, mode)
          renameSync(tmp, p)
        },
        hookStatus,
        installHook: (file, source, sidecar) => { installHooks(file, source, hookCommandLine({ execPath: sidecar, compiled: true, cliEntry: '', source })) },
        reloadLaunchAgent: () => {
          // launchctl 的 gui/<uid> 域只有一个:HOME 被改过(测试 / 临时目录演练)时,bootout 照样会
          // 打到这个用户**真的** com.wechat-cc.daemon 上 —— 2026-10-04 写这段时就这样把主人的 daemon
          // 换成了临时目录里的构建。HOME 跟账户的真家目录对不上 ⇒ 只改文件,绝不碰 launchd。
          if (homedir() !== userInfo().homedir) return 'HOME is overridden — refusing to touch the real launchd domain'
          try { reloadService(plan, { dryRun }); return null } catch (e) { return e instanceof Error ? e.message : String(e) }
        },
        dryRun,
        // citty/mri 把 `--no-reload` 变成 `reload:false`(声明的 'no-reload' 键是 undefined)——
        // 与 self deploy 的 `--no-rollback` 同一个坑,两种拼法都认。
        reload: !((args as Record<string, unknown>)['no-reload'] === true || (args as Record<string, unknown>).reload === false),
      })
      if (json) console.log(JSON.stringify(ServiceRepairOutput.parse({ ok: true, action: 'repair', dryRun, ...result }), null, 2))
      else {
        const la = result.launchAgent
        console.log(la.action === 'rewrite' ? `LaunchAgent: ${la.from} → ${la.to}${la.reloaded ? ' (reloaded)' : ''}${la.reloadError ? ` (reload failed: ${la.reloadError})` : ''}` : `LaunchAgent: ${la.reason}`)
        for (const h of result.hooks) console.log(`hook ${h.source}: ${h.from} → ${h.to}`)
        console.log(`forwarder ${result.forwarder.path}: ${result.forwarder.action}`)
      }
      return
    }
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
            mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
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
