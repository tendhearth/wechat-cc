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
    companionPushDeps: { shouldRun, log, onTick: ticks.pushTick, intervalMs: opts.schedulerIntervalMs },
    companionIntrospectDeps: { shouldRun, log, onTick: ticks.introspectTick, intervalMs: opts.schedulerIntervalMs },
    companionIngestDeps: { shouldRun: shouldRunIngest, log, onTick: ticks.ingestTick, intervalMs: opts.schedulerIntervalMs },
    guardDeps: {
      pollMs: 30_000,
      isEnabled: () => loadGuardConfig(stateDir).enabled,
      probeUrl: () => loadGuardConfig(stateDir).probe_url,
      ipifyUrl: () => loadGuardConfig(stateDir).ipify_url,
      log,
      onStateChange: async (prev, next) => {
        if (prev.reachable && !next.reachable) {
          log('GUARD', `network DOWN — shutting down all sessions (was ${prev.ip}, now ${next.ip})`)
          try {
            log('GUARD', 'sessionManager.shutdown start')
            await boot.sessionManager.shutdown()
            log('GUARD', 'sessionManager.shutdown complete')
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
    },
    startupDeps: {
      stateDir, db, ilink, log,
      accountCount: accounts.length,
      dangerously,
      runIntrospectOnce: ticks.introspectTick,
    },
  }
}
