/**
 * Lifecycle dep builder — 6 lifecycle deps (companion×2, guard, sessions, ilink, polling) + startup.
 * Pure field mapping, no business logic.
 */
import type { Db } from '../../lib/db'
import type { IlinkAdapter, IlinkAccount } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import type { CompanionPushDeps, CompanionIntrospectDeps, CompanionIngestDeps } from '../companion/lifecycle'
import type { SchedulerDeps } from '../guard/scheduler'
import type { SessionsLifecycleDeps } from '../sessions-lifecycle'
import type { IlinkLifecycleDeps } from '../ilink-lifecycle'
import type { PollingDeps } from '../polling-lifecycle'
import type { StartupSweepDeps } from '../startup-sweeps'
import { loadCompanionConfig } from '../companion/config'
import { loadGuardConfig } from '../guard/store'
import { findBx } from '../guard/bx'
import { makeExecutorPausePolicy } from '../guard/pause-policy'
import { classifyWith, unprotectedMessage } from '../../lib/network-gate'
import { parseUpdates } from '../poll-loop'
import { writeHeartbeat, HEARTBEAT_FILE } from '../single-instance'
import { join } from 'node:path'
import { makeHeartbeatStore } from '../../core/connection-heartbeat'
import { makeSessionStateStore } from '../../core/session-state'
import type { TickBodies } from './tick-bodies'

export interface LifecycleDepsOpts {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  accounts: IlinkAccount[]
  boot: Bootstrap
  dangerously: boolean
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /** 网络守护运行时(2026-10-02):后台 tick 不安全就跳过;翻到不安全时停工作台执行者。 */
  guardRuntime?: import('../guard/runtime').GuardRuntime
  workbench?: Pick<import('../../core/workbench/service').WorkbenchService, 'pauseForNetwork'>
  /**
   * Optional override for both push + introspect scheduler intervals.
   * When set, both schedulers use this value instead of their defaults.
   * Eval harness passes `1_000_000_000` (≈11.5 days; jitter-safe under
   * setTimeout's int32 cap) to suppress auto-fire.
   */
  schedulerIntervalMs?: number
}

export function buildLifecycleDeps(opts: LifecycleDepsOpts, ticks: TickBodies): {
  companionPushDeps: CompanionPushDeps
  companionIntrospectDeps: CompanionIntrospectDeps
  companionIngestDeps: CompanionIngestDeps
  guardDeps: SchedulerDeps
  sessionsDeps: SessionsLifecycleDeps
  ilinkDeps: IlinkLifecycleDeps
  pollingDeps: Omit<PollingDeps, 'runPipeline'>
  startupDeps: StartupSweepDeps
} {
  const { stateDir, db, ilink, accounts, boot, dangerously, log } = opts
  // 后台 tick 的网络闸门(2026-10-02):不安全就安静跳过一拍(同一段不安全期只记一行日志),不重试。
  const pausePolicy = makeExecutorPausePolicy()
  const gated = (name: string, fn: () => Promise<void>) => opts.guardRuntime ? opts.guardRuntime.skipWhenUnsafe(name, fn) : fn

  // Heartbeat store — single instance shared for the lifetime of the daemon.
  // Backed by the same db handle as all other stores.
  const heartbeatStore = makeHeartbeatStore(db)
  // Same db handle / same session_state table the passive -14 path and the
  // doctor's expiredBots read — used to self-heal (clear) on a successful poll.
  const sessionStateStore = makeSessionStateStore(db)

  // Single combined gate — one config read answers both enabled +
  // not-snoozed, avoiding the prior two-call pattern that loaded
  // config twice and could race state changes between the reads.
  const shouldRun = () => {
    const cfg = loadCompanionConfig(stateDir)
    if (!cfg.enabled) return false
    const s = cfg.snooze_until
    if (s && Date.parse(s) > Date.now()) return false
    return true
  }

  // Ingestion has its own gate: the master companion gate PLUS an independent
  // off-switch (silent maintenance vs proactive push), still honoring snooze.
  const shouldRunIngest = () => {
    const cfg = loadCompanionConfig(stateDir)
    if (!cfg.enabled) return false
    if (cfg.ingest_enabled === false) return false
    const s = cfg.snooze_until
    if (s && Date.parse(s) > Date.now()) return false
    return true
  }

  return {
    // holdBusy (spec 2026-08-11 §2, Task 6) — same busy-registry instance
    // the self-restart idle check reads (boot.holdBusy / busyRegistry.hold
    // in bootstrap/index.ts), forwarded to all three companion schedulers
    // so a running tick can't be misjudged as idle.
    companionPushDeps: { shouldRun, log, onTick: gated('companion.push', () => ticks.pushTick()), intervalMs: opts.schedulerIntervalMs, holdBusy: boot.holdBusy },
    companionIntrospectDeps: { shouldRun, log, onTick: gated('companion.introspect', () => ticks.introspectTick()), intervalMs: opts.schedulerIntervalMs, holdBusy: boot.holdBusy },
    companionIngestDeps: { shouldRun: shouldRunIngest, log, onTick: gated('companion.ingest', () => ticks.ingestTick()), intervalMs: opts.schedulerIntervalMs, holdBusy: boot.holdBusy },
    guardDeps: {
      pollMs: 30_000,
      isEnabled: () => loadGuardConfig(stateDir).enabled,
      probeUrl: () => loadGuardConfig(stateDir).probe_url,
      ipifyUrl: () => loadGuardConfig(stateDir).ipify_url,
      // 装了 bx 就只认 bx(2026-10-02);没装走 ipify+探测。guard.json signal_source='probe'
      // (装着 bx、实际在用别的 VPN)⇒ 装了也走探测。
      findBx: () => (loadGuardConfig(stateDir).signal_source === 'probe' ? null : findBx()),
      log,
      // 已经在跑的工作台执行者:bx 来源永远不停(fail-closed,出不去也就漏不了);
      // probe 来源连续两次不安全才停(pause-policy.ts)—— 守护 v2:**只停需要保护的执行者**,
      // 不需要保护的(Cursor auto、国内 / 自建网关)永远不停。新的启动 / 续接 / 补充由闸门按调用拦。
      onReading: (s) => {
        if (!pausePolicy.observe(s)) return
        try {
          const gate = opts.guardRuntime?.gate
          const n = opts.workbench?.pauseForNetwork((run) => {
            const cls = classifyWith(gate, { provider: run.providerId, model: run.model, purpose: 'turn' })
            return cls.protected ? `${unprotectedMessage(s, cls.label)}已停止本轮,恢复后可以继续。` : null
          }) ?? 0
          log('GUARD', `network unprotected [probe, 2 reads] — paused ${n} protected workbench run(s)`)
        } catch (err) { log('GUARD', `workbench pause failed: ${err instanceof Error ? err.message : String(err)}`) }
      },
      onStateChange: async (prev, next) => {
        if (prev.reachable && !next.reachable) {
          // 守护 v2:只关需要保护的对话会话(按 provider + 会话模型分类);国内 / 自建 / Cursor auto 的照常。
          log('GUARD', `network DOWN — closing protected chat sessions (was ${prev.ip}, now ${next.ip})`)
          try {
            const n = await boot.sessionManager.shutdownProtected()
            log('GUARD', `closed ${n} protected chat session(s)`)
          } catch (err) {
            log('GUARD', `sessionManager.shutdown failed: ${err instanceof Error ? err.stack || err.message : String(err)}`)
            throw err
          }
        }
      },
    },
    sessionsDeps: {
      sessionManager: boot.sessionManager,
      sessionStore: boot.sessionStore,
      conversationStore: boot.conversationStore,
    },
    ilinkDeps: { ilink: { flush: () => ilink.flush() } },
    pollingDeps: {
      stateDir,
      accounts,
      ilink: {
        getUpdates: (id, base, tok, sb) =>
          ilink.getUpdatesForLoop(id, base, tok, sb ?? '') as ReturnType<PollingDeps['ilink']['getUpdates']>,
      },
      parse: parseUpdates,
      resolveUserName: (cid) => ilink.resolveUserName(cid),
      log,
      // Daemon-health heartbeat: each successful poll round-trip stamps the
      // file the instance lock reads, so a wedged/half-started daemon (poll
      // loop stalled or never started) lets it go stale and becomes
      // stealable instead of holding the lock as a dead placeholder.
      onPollCycle: () => writeHeartbeat(join(stateDir, HEARTBEAT_FILE)),
      recordHeartbeat: heartbeatStore.recordOk.bind(heartbeatStore),
      clearExpired: (id: string) => sessionStateStore.clear(id),
      // Connection-health (Task 7) — routes each poll round-trip's outcome
      // through boot.health's onSuccess/onFailure, which drives the two-state
      // machine, the incident store, and (log-only for now) notifications.
      health: {
        recordSuccess: (dep) => boot.health.onSuccess(dep),
        recordFailure: (dep, err) => boot.health.onFailure(dep, err),
      },
    },
    startupDeps: {
      stateDir, db, ilink, log,
      accountCount: accounts.length,
      dangerously,
      runIntrospectOnce: ticks.introspectTick,
    },
  }
}
