/**
 * health runtime —— 把健康机 / 分类 / 故障记录 / 通知策略串起来的薄接线层。
 *
 * 全部对外行为只有两个入口:onFailure / onSuccess。poll-loop 调它们,
 * 其余模块只读 health.shouldSuspend()。
 */
import { makeConnectionHealth, type ConnectionHealth, type Dependency } from './connection-health'
import { classifyFailure } from './classify'
import { makeIncidentStore, type IncidentStore } from './incident-store'
import { shouldNotifyDown, shouldNotifyRecovery } from './notify-policy'

export interface HealthNotification {
  title: string
  body: string
  actionable: boolean
}

export interface HealthRuntime {
  health: ConnectionHealth
  onFailure(dep: Dependency, err: unknown): void
  onSuccess(dep: Dependency): void
  /**
   * The single incident-store instance this runtime writes through (Task 8).
   * Exposed so internal-api's GET /v1/health/incidents route (the desktop's
   * "last incident" banner + notification) reads the SAME live instance
   * rather than constructing a second one pointed at the same file — the
   * underlying state-store loads its data once at construction and doesn't
   * re-read on every `get()`, so a second instance would never observe
   * writes made through this one.
   */
  incidents: IncidentStore
}

export function makeHealthRuntime(deps: {
  stateDir: string
  now: () => number
  log: (tag: string, line: string) => void
  notify: (n: HealthNotification) => void
}): HealthRuntime {
  const health = makeConnectionHealth({ now: deps.now })
  const incidents = makeIncidentStore({ stateDir: deps.stateDir })

  /**
   * `deps.log` itself must never be trusted either — if it throws, that
   * exception must not escape onFailure/onSuccess's own catch blocks (which
   * call this from inside a catch body; an uncaught throw there would
   * propagate out of onFailure/onSuccess and — per poll-loop.ts's own
   * catch — take down that account's entire polling loop, a strictly worse
   * outcome than the failure this machine exists to report).
   */
  function safeLog(tag: string, line: string): void {
    try { deps.log(tag, line) } catch { /* logging must never become a failure source */ }
  }

  /** 通知投递失败不重试、不阻塞 —— 记一行就够,故障记录已经落盘。 */
  function safeNotify(n: HealthNotification): void {
    try { deps.notify(n) } catch (err) {
      safeLog('HEALTH', `notify failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function onFailure(dep: Dependency, err: unknown): void {
    try {
      health.recordFailure(dep, err)
      if (!health.shouldSuspend(dep)) return   // 60 秒确认期内不算故障

      const nowMs = deps.now()
      const nowIso = new Date(nowMs).toISOString()
      const klass = classifyFailure(err)
      let open = incidents.openOf(dep)
      if (!open) {
        const state = health.get(dep)
        open = incidents.open({
          dependency: dep,
          kind: klass.kind,
          actionable: klass.actionable,
          startedAt: new Date(state.firstFailureAt ?? nowMs).toISOString(),
          lastError: state.lastError,
        })
        safeLog('HEALTH', `${dep} degraded (${klass.kind})`)
      }
      if (shouldNotifyDown(open, nowMs)) {
        safeNotify({ title: klass.title, body: klass.body, actionable: klass.actionable })
        incidents.markNotified(dep, nowIso)
      }
    } catch (err) {
      safeLog('HEALTH', `onFailure swallowed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function onSuccess(dep: Dependency): void {
    try {
      health.recordSuccess(dep)

      // Unconditional close — NOT gated on the in-memory shouldSuspend()
      // read. A daemon restart resets the in-memory machine to healthy
      // while a still-open incident survives on disk (incident-store is
      // its own persistence, independent of connection-health's in-memory
      // state); gating on the in-memory flag left that on-disk incident
      // permanently open after a mid-outage restart — every future
      // failure then found an already-open, already-notified,
      // non-actionable incident and shouldNotifyDown() silently refused to
      // ever notify again. incidents.close() is already a safe no-op (and
      // does not write) when there is nothing open for this dependency, so
      // calling it on every success is cheap and always correct.
      const nowIso = new Date(deps.now()).toISOString()
      const closed = incidents.close(dep, nowIso)
      if (!closed) return

      safeLog('HEALTH', `${dep} recovered`)
      // Recovery notifications stay paired to a down notification — the gate
      // is `closed.notifiedAt !== null` (did we ever tell the owner it broke),
      // not whether THIS process observed the degraded state.
      if (shouldNotifyRecovery(closed)) {
        const mins = Math.round((Date.parse(closed.endedAt!) - Date.parse(closed.startedAt)) / 60_000)
        const span = mins >= 60 ? `${Math.round(mins / 60)} 小时` : `${mins} 分钟`
        safeNotify({
          title: '已恢复',
          body: `刚才断了约 ${span},现在已经恢复正常,你不需要做什么。`,
          actionable: false,
        })
      }
    } catch (err) {
      safeLog('HEALTH', `onSuccess swallowed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { health, onFailure, onSuccess, incidents }
}

export { SUSPEND_AFTER_MS } from './connection-health'
export type { Dependency } from './connection-health'
