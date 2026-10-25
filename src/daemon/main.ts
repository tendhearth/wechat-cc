#!/usr/bin/env bun
if (!process.env.CLAUDE_CODE_ENTRYPOINT) { process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts' }
// 回环守卫(spec 2026-09-09-cli-hook-push §3):daemon 经 SDK 拉起的 claude / codex
// 继承这个环境,主人装的 hooks 在它们身上也会触发;`wechat-cc hook` 看到这个变量
// 就直接退出,不然 daemon 自己的每个回合都会被推回微信。
process.env.WECHAT_CC_DAEMON_CHILD = '1'
import { join } from 'node:path'
import { log } from '../lib/log'
import { loadAccess } from '../lib/access'
import { markCleanShutdown, markPlannedRestart } from '../lib/restart-markers'
import { createModules } from './modules/container'
import type { LifecycleHolder } from './modules/lifecycle-module'
import { makeDaemonShutdown } from './runtime/shutdown'
import { openFoundation, type Foundation } from './foundation'
import { daemonModules, type BootModule } from './daemon-modules'
import type { WiredDeps } from './wiring'
import type { PollingLifecycle } from './polling-lifecycle'
import { resolveAdminChatId } from './bootstrap'
import { removeAgyGlobalMcp } from './bootstrap/agy-mcp-config'
import { loadCompanionConfig } from './companion/config'
import { SUBSYSTEM_NAMES } from './capabilities'

function errorDetails(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message
  try { return JSON.stringify(err) } catch { return String(err) }
}

export interface BootDaemonOpts {
  stateDir: string
  dangerously: boolean
  /**
   * 收尾函数一建好就交出来(第三批 3b 第 2 步):开机途中收到 SIGTERM,信号处理拿它停掉已经起了的东西,
   * 不用等 bootDaemon 返回。以前信号处理在开机走完之后才装,开机途中收到 SIGTERM 就是默认行为:直接死,什么都不收。
   */
  onShutdownReady?: (shutdown: () => Promise<void>) => void
  /**
   * Eval-harness override — when set, both companion schedulers use this
   * interval (ms) instead of the production defaults. Eval harness passes
   * `1_000_000_000` (≈11.5 days; jitter-safe under setTimeout's int32 cap)
   * to suppress auto-fire so the engine drives ticks with fireTick().
   * Production callers (cli `run`, signal handlers) never set this.
   */
  schedulerIntervalMs?: number
}
export interface DaemonHandle {
  shutdown(): Promise<void>
  pollingReconcile?(): Promise<void>
  /**
   * Eval-harness seam — manually fire one tick of the named kind, with the
   * given virtual timestamp baked into the envelope. Bypasses the scheduler
   * gates (shouldRun + jitter). Returns when the tick body completes.
   *
   * Production callers never use this; production uses the periodic scheduler
   * registered via registerCompanionPush / registerCompanionIntrospect.
   */
  fireTick(kind: 'push' | 'introspect', at: Date): Promise<void>
}

export async function bootDaemon(opts: BootDaemonOpts): Promise<DaemonHandle> {
  // 主体 try 之前就失败(库打不开、迁移失败、锁抢不到 ……)也要把锁、心跳、db 放掉:
  // main() 退出前会指数退避等上几十秒到 30 分钟,这段时间里锁还拿着,回滚拉起的老 sidecar / 手动 start 都抢不到
  // (重构第二批步 6a)。都是幂等的:try 里失败时 shutdown 已经做过一遍也无妨。
  const undo: Array<() => void> = []
  try { return await bootDaemonInner(opts, undo) } catch (err) {
    for (const f of undo.reverse()) { try { f() } catch { /* 尽力 */ } }
    throw err
  }
}

/**
 * 开机 = 地基(foundation.ts)+ 一个模块容器(daemon-modules.ts)。启停只有容器这一种写法:
 * 开机顺序由模块的 needs 推出来,关机严格倒过来;没有手排的登记顺序,也没有 Ref / setter 式的晚绑定。
 */
async function bootDaemonInner(opts: BootDaemonOpts, undo: Array<() => void>): Promise<DaemonHandle> {
  const { stateDir, dangerously } = opts
  const base = await openFoundation({ stateDir }, undo)
  // Restart: let the caller flush (HTTP response / a log line), then graceful shutdown + exit so
  // launchd/systemd KeepAlive respawns a fresh daemon. ONE closure, TWO triggers: the operator
  // POST /v1/daemon/restart route and the self-restart idle-tick check — same graceful path.
  const requestRestart = (reason: string) => {
    log('DAEMON', `restart requested (${reason}) — shutting down for KeepAlive respawn`)
    // 给下次开机留一张「这次是计划内的」纸条:daemon 自己要求的重启一律不在微信里播报。
    markPlannedRestart(stateDir, reason)
    // 这也是一次优雅退出:留优雅退出纸条,下一个进程撞上锁时才认得出「它在收尾」、等它退。
    markCleanShutdown(stateDir, `restart:${reason}`)
    setTimeout(() => { void shutdown().finally(() => process.exit(0)) }, 500)
  }
  const f: Foundation = { ...base, dangerously, ...(opts.schedulerIntervalMs !== undefined ? { schedulerIntervalMs: opts.schedulerIntervalMs } : {}), requestRestart }
  const modules = createModules(daemonModules(f), { log: (t, l) => log(t, l) })
  // 状态进 /v1/health.subsystems(和 bootstrap 的可选接线块一起)
  f.sup.adopt(modules)
  // 收尾(runtime/shutdown.ts):不管启动有没有走完,都停已经起了的 —— 容器逆序、bootstrap 的收尾清单、agy 配置、db、锁。
  const shutdown = makeDaemonShutdown({
    log: (t, l) => log(t, l),
    stopHeartbeat: base.stopHeartbeat,
    lc: modules,
    teardown: base.bootTeardown,
    boot: () => modules.provided<BootModule>('bootstrap')?.boot ?? null,
    removeAgyGlobalMcp: () => removeAgyGlobalMcp({ log }),
    closeDb: () => base.db.close(),
    releaseLock: base.releaseLock,
  })
  opts.onShutdownReady?.(shutdown)

  try {
    await modules.start()
  } catch (err) {
    log('DAEMON', `startup failed mid-init: ${err instanceof Error ? err.message : String(err)}`)
    await shutdown(); throw err
  }
  const wired = modules.provided<WiredDeps>('wired')
  if (!wired) {
    // 开机途中被要求停(SIGTERM 落在开机途中):容器在模块边界停下了,收尾由发起停的那一方做完(它随后 exit)。
    // 不当开机失败(不进退避),只交回收尾。
    log('DAEMON', 'boot stopped part-way by a shutdown request')
    return { shutdown, fireTick: async () => {} }
  }

  // 外部集成反馈 #6:这个 flag 的语义像"跳过工具确认",实际是全局提权
  // (resolveEffectiveTier 对每个 allowlist 会话都返回 admin)。日志明说,让 operator 看清 blast radius。
  const modeStr = dangerously
    ? 'mode=dangerouslySkipPermissions=true — 注意:此模式下所有 allowlist 会话均按 admin 处理(全局提权),不只是跳过确认'
    : 'mode=strict (Phase 1 permission relay active)'
  log('DAEMON', `started pid=${process.pid} accounts=${base.accounts.length} ${modeStr}`)
  if (dangerously) log('DAEMON', 'warning: Claude will still confirm destructive ops via natural-language reply, but no permission prompts will appear.')
  // Subsystem degraded-boot (spec 2026-08-17 §3) — 启动完成后的一次性管理员汇总。只报 degraded(off 是常态,不扰人);
  // 发送失败只落日志,绝不影响启动结果。
  const degradedSubsystems = f.sup.degraded()
  if (degradedSubsystems.length > 0) {
    log('SUBSYS', `boot completed degraded: ${degradedSubsystems.map(d => `${d.name}(${d.error ?? '?'})`).join(', ')}`)
    const adminChatId = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
    if (adminChatId) {
      // 给主人看的是功能名(和「CC 现在怎么样」同一张表),原始错误只在上面那行日志里。
      const names = [...new Set(degradedSubsystems.map(d => SUBSYSTEM_NAMES[d.name] ?? d.name))].join('、')
      // 经 CC 开口那道门(boot_notice 归 report);「CC 现在怎么样」里同样看得到这几样
      void wired.speech.tell('boot_notice', adminChatId, `这次开机有几样没起来：${names}。其它功能照常。`)
        .then(sent => { if (!sent) log('SUBSYS', 'admin degraded summary not sent (deferred by speech policy or send failed)') })
        .catch(err => log('SUBSYS', `admin degraded summary send failed: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  const polling = modules.provided<LifecycleHolder<PollingLifecycle>>('polling')?.current() ?? null
  return {
    shutdown,
    pollingReconcile: polling ? () => polling.reconcile() : undefined,
    fireTick: async (kind, at) => {
      const nowIso = at.toISOString()
      if (kind === 'push') await wired.ticks.pushTick({ nowIso })
      else await wired.ticks.introspectTick({ nowIso })
    },
  }
}

// CLI entry — sets up signal handlers, calls bootDaemon, waits. Exported so
// cli.ts's `run` command can call it explicitly. Previously cli.ts relied on
// `await import('./src/daemon/main.ts')` triggering a top-level main() via
// side-effect, but that broke the moment we added the e2e bootDaemon export
// and gated the side-effect on `import.meta.main` — when cli.ts imports this
// module, import.meta.main is false (standard ESM semantics), so no daemon
// would start. Compiled `wechat-cc-cli.exe run` would silently no-op.
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs'
import { resolveDaemonStateDir } from './resolve-state-dir'
import { recordBootFailure, clearBootFailures } from './runtime/boot-backoff'
export async function main() {
  const stateDir = resolveDaemonStateDir()
  // daemon.env — provider API keys' restart-surviving home (env-file.ts).
  // Loaded BEFORE bootDaemon so provider registration sees the keys; the
  // real environment always wins over the file. Key NAMES only in logs.
  try {
    const envPath = join(stateDir, 'daemon.env')
    if (fsExistsSync(envPath)) {
      const { parseEnvFile } = await import('../lib/env-file')
      const fileEnv = parseEnvFile(fsReadFileSync(envPath, 'utf8'))
      const applied = Object.keys(fileEnv).filter(k => process.env[k] === undefined)
      for (const k of applied) process.env[k] = fileEnv[k]!
      if (applied.length > 0) log('DAEMON', `daemon.env loaded: ${applied.join(', ')}`)
    }
  } catch (err) { log('DAEMON', `daemon.env load failed (continuing): ${err instanceof Error ? err.message : err}`) }
  const dangerously = process.argv.includes('--dangerously')
  // 信号处理在开机**之前**装(第三批 3b 第 2 步):开机途中收到 SIGTERM(launchctl kickstart -k、换包、注销)也走收尾,
  // 停掉已经起了的那些(收尾清单、已经登记的子系统、db、锁),而不是默认行为直接死。收尾函数一建好 bootDaemon 就交过来。
  let shutdownFn: (() => Promise<void>) | null = null
  let alreadyShuttingDown = false
  const cliShutdown = async (sig: string) => {
    if (alreadyShuttingDown) { log('DAEMON', `${sig} during shutdown — forcing exit`); process.exit(130) }
    alreadyShuttingDown = true; log('DAEMON', `${sig} received, shutting down${handleReady ? '' : ' (during boot)'}`)
    // 有人让它停(launchctl kickstart -k / bootout、App 更新换包、注销关机)——
    // 先留纸条再收尾:哪怕收尾中途被 SIGKILL,下次开机也认得出这是计划内的。
    markCleanShutdown(stateDir, sig)
    if (shutdownFn) await shutdownFn()
    process.exit(0)
  }
  process.on('SIGINT', () => void cliShutdown('SIGINT'))
  process.on('SIGTERM', () => void cliShutdown('SIGTERM'))
  let handleReady = false
  let handle: DaemonHandle
  try { handle = await bootDaemon({ stateDir, dangerously, onShutdownReady: (fn) => { shutdownFn = fn } }) } catch (err) {
    console.error('[wechat-cc] fatal:', err)
    // 指数退避(重构第二批步 6a):launchd / systemd 只是每 5–10 秒拉起一次,确定性的启动失败(配置坏了、迁移失败)
    // 会变成重启风暴。退出前按连续失败次数等:10s、20s、40s … 封顶 30 分钟。
    const { count, delayMs } = recordBootFailure(stateDir, Date.now())
    // 原因也进 channel.log:以前只在 stderr(launchd.err.log),日志里只有一句「startup failed」,self soak / self discover
    // 和主人都看不出为什么(10-21~22 真机 9 次,原因全是「another daemon already running」,只能去翻 stderr)。
    log('DAEMON', `startup failed (${count} in a row): ${(err instanceof Error ? err.message : String(err)).slice(0, 300)} — waiting ${Math.round(delayMs / 1000)}s before exit`)
    await new Promise(r => setTimeout(r, delayMs))
    process.exit(1)
  }
  clearBootFailures(stateDir)
  process.on('beforeExit', (code) => log('DAEMON', `beforeExit code=${code}`))
  process.on('exit', (code) => log('DAEMON', `exit code=${code}`))
  process.on('uncaughtException', (err) => {
    log('DAEMON', `uncaughtException: ${errorDetails(err)}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    log('DAEMON', `unhandledRejection: ${errorDetails(reason)}`)
    process.exit(1)
  })
  handleReady = true
  shutdownFn = () => handle.shutdown()
  process.on('SIGUSR1', () => { handle.pollingReconcile?.()?.catch(err => log('RECONCILE', `SIGUSR1 reconcile failed: ${err instanceof Error ? err.message : String(err)}`)) })
  // SIGUSR2 — fire a companion push tick now (instead of waiting for the ~20min
  // scheduler). Sent by `wechat-cc companion push`. See cli/companion-push.ts.
  process.on('SIGUSR2', () => {
    log('SCHED', 'SIGUSR2 — manual push tick requested')
    handle.fireTick('push', new Date()).catch(err => log('SCHED', `SIGUSR2 push tick failed: ${err instanceof Error ? err.message : String(err)}`))
  })
  // SIGWINCH — fire the daily introspection + optional Atelier tick now. This
  // is a local operator/testing control; the normal scheduler remains daily.
  process.on('SIGWINCH', () => {
    log('SCHED', 'SIGWINCH — manual introspect tick requested')
    handle.fireTick('introspect', new Date()).catch(err => log('SCHED', `SIGWINCH introspect tick failed: ${err instanceof Error ? err.message : String(err)}`))
  })
}

// Direct invocation: `bun src/daemon/main.ts` (dev mode). In compiled binaries
// the entry is cli.ts, which imports + calls main() explicitly, so this guard
// only matters for source-mode dev runs.
if (import.meta.main) {
  main().catch((err) => { console.error('[wechat-cc] fatal:', err); process.exit(1) })
}
