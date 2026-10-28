#!/usr/bin/env bun
if (!process.env.CLAUDE_CODE_ENTRYPOINT) { process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts' }
// 回环守卫(spec 2026-09-09-cli-hook-push §3):daemon 经 SDK 拉起的 claude / codex
// 继承这个环境,主人装的 hooks 在它们身上也会触发;`wechat-cc hook` 看到这个变量
// 就直接退出,不然 daemon 自己的每个回合都会被推回微信。
process.env.WECHAT_CC_DAEMON_CHILD = '1'
// daemon 的入口:地基(foundation.ts)→ 一个模块容器(daemon-modules.ts 的那张表)→ 信号。启停只有容器这一种写法:
// 开机顺序由模块的 needs 推出来,关机严格倒过来。开机前后的杂事(daemon.env、重启、开机汇报、退避、兜底、运维信号)在 runtime/ 下。
import { log } from '../lib/log'
import { markCleanShutdown } from '../lib/restart-markers'
import { createModules } from './modules/container'
import type { LifecycleHolder } from './modules/lifecycle-module'
import { openFoundation, type Foundation } from './foundation'
import { daemonModules } from './daemon-modules'
import type { WiredDeps } from './wiring'
import type { PollingLifecycle } from './polling-lifecycle'
import type { Bootstrap } from './bootstrap'
import { removeAgyGlobalMcp } from './bootstrap/agy-mcp-config'
import { makeDaemonShutdown } from './runtime/shutdown'
import { makeRequestRestart } from './runtime/restart'
import { reportBoot } from './runtime/boot-report'
import { reportVoidedCards } from './pending-cards'
import { installCrashGuards } from './runtime/crash-guards'
import { loadDaemonEnv } from './runtime/daemon-env'
import { waitAfterBootFailure, clearBootFailures } from './runtime/boot-backoff'
import { installOperatorSignals } from './runtime/operator-signals'
import { resolveDaemonStateDir } from './resolve-state-dir'

export interface BootDaemonOpts {
  stateDir: string
  dangerously: boolean
  /**
   * 收尾函数一建好就交出来(第三批 3b 第 2 步):开机途中收到 SIGTERM,信号处理拿它停掉已经起了的东西,
   * 不用等 bootDaemon 返回。以前信号处理在开机走完之后才装,开机途中收到 SIGTERM 就是默认行为:直接死,什么都不收。
   */
  onShutdownReady?: (shutdown: () => Promise<void>) => void
  /**
   * Eval-harness override — both companion schedulers use this interval (ms) instead of the production defaults.
   * The harness passes `1_000_000_000` (≈11.5 days; jitter-safe under setTimeout's int32 cap) to suppress auto-fire
   * so the engine drives ticks with fireTick(). Production callers (cli `run`, signal handlers) never set this.
   */
  schedulerIntervalMs?: number
}
export interface DaemonHandle {
  shutdown(): Promise<void>
  pollingReconcile?(): Promise<void>
  /** Eval-harness seam — fire one tick now with this virtual timestamp, bypassing the scheduler gates (shouldRun + jitter). */
  fireTick(kind: 'push' | 'introspect', at: Date): Promise<void>
}

export async function bootDaemon(opts: BootDaemonOpts): Promise<DaemonHandle> {
  // 主体 try 之前就失败(库打不开、迁移失败、锁抢不到 ……)也要把锁、心跳、db 放掉:main() 退出前会退避几十秒到 30 分钟,
  // 锁一直拿着,回滚拉起的老 sidecar / 手动 start 都抢不到(重构第二批步 6a)。都是幂等的:shutdown 已经做过一遍也无妨。
  const undo: Array<() => void> = []
  try { return await bootDaemonInner(opts, undo) } catch (err) {
    for (const f of undo.reverse()) { try { f() } catch { /* 尽力 */ } }
    throw err
  }
}

async function bootDaemonInner(opts: BootDaemonOpts, undo: Array<() => void>): Promise<DaemonHandle> {
  const { stateDir, dangerously } = opts
  const base = await openFoundation({ stateDir }, undo)
  const requestRestart = makeRequestRestart(stateDir, () => shutdown())
  const f: Foundation = { ...base, dangerously, ...(opts.schedulerIntervalMs !== undefined ? { schedulerIntervalMs: opts.schedulerIntervalMs } : {}), requestRestart }
  const modules = createModules(daemonModules(f), { log: (t, l) => log(t, l) })
  // 状态进 /v1/health.subsystems(和 bootstrap 的可选接线块一起)
  f.sup.adopt(modules)
  // 收尾(runtime/shutdown.ts):不管启动有没有走完,都停已经起了的 —— 容器逆序、agy 配置、db、锁。
  const shutdown = makeDaemonShutdown({
    log: (t, l) => log(t, l),
    stopHeartbeat: base.stopHeartbeat,
    modules,
    boot: () => modules.provided<Bootstrap>('bootstrap') ?? null,
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
  reportBoot({ stateDir, dangerously, accounts: base.accounts.length, degraded: f.sup.degraded(), speech: wired.speech })
  // 重启前挂着的拍板卡:不管这次重启是不是计划内的,主人都丢了那张卡 ⇒ 说一次(和上面「几样没起来」是两件事,各说各的)
  void reportVoidedCards({ voided: base.voidedCards, now: Date.now(), speech: wired.speech, log: (t, l) => log(t, l) })

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

/**
 * CLI 入口:装信号、开机、等着。导出给 cli.ts 的 `run` 显式调 —— 编译出来的 `wechat-cc-cli.exe run` 里 import.meta.main 是 false,
 * 靠 import 的副作用起 daemon 会悄悄什么都不做(v0.5.0 的坑,main.exports.test.ts 钉着)。
 */
export async function main() {
  const stateDir = resolveDaemonStateDir()
  await loadDaemonEnv(stateDir)
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
    // 指数退避(重构第二批步 6a):确定性的启动失败(配置坏了、迁移失败)不该变成 launchd / systemd 的重启风暴。
    await waitAfterBootFailure(stateDir, err)
    process.exit(1)
  }
  clearBootFailures(stateDir)
  installCrashGuards()
  handleReady = true
  shutdownFn = () => handle.shutdown()
  installOperatorSignals(handle)   // SIGUSR1 / SIGUSR2 / SIGWINCH
}

// 直接跑 `bun src/daemon/main.ts`(开发)。编译产物的入口是 cli.ts,它 import 再显式调 main()。
if (import.meta.main) {
  main().catch((err) => { console.error('[wechat-cc] fatal:', err); process.exit(1) })
}
