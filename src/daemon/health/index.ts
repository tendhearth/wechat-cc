/**
 * health runtime —— 把健康机 / 分类 / 故障记录 / 通知策略串起来的薄接线层。
 *
 * 全部对外行为只有两个入口:onFailure / onSuccess。poll-loop 调它们,
 * 其余模块只读 health.shouldSuspend()。
 */
import { makeConnectionHealth, type ConnectionHealth, type Dependency } from './connection-health'
import { classifyFailure } from './classify'
import { makeIncidentStore } from './incident-store'
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
}

export function makeHealthRuntime(deps: {
  stateDir: string
  now: () => number
  log: (tag: string, line: string) => void
  notify: (n: HealthNotification) => void
}): HealthRuntime {
  const health = makeConnectionHealth({ now: deps.now })
  const incidents = makeIncidentStore({ stateDir: deps.stateDir })

  /** 通知投递失败不重试、不阻塞 —— 记一行就够,故障记录已经落盘。 */
  function safeNotify(n: HealthNotification): void {
    try { deps.notify(n) } catch (err) {
      deps.log('HEALTH', `notify failed: ${err instanceof Error ? err.message : String(err)}`)
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
        deps.log('HEALTH', `${dep} degraded (${klass.kind})`)
      }
      if (shouldNotifyDown(open, nowMs)) {
        safeNotify({ title: klass.title, body: klass.body, actionable: klass.actionable })
        incidents.markNotified(dep, nowIso)
      }
    } catch (err) {
      deps.log('HEALTH', `onFailure swallowed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function onSuccess(dep: Dependency): void {
    try {
      const wasDegraded = health.shouldSuspend(dep)
      health.recordSuccess(dep)
      if (!wasDegraded) return

      const nowIso = new Date(deps.now()).toISOString()
      const closed = incidents.close(dep, nowIso)
      deps.log('HEALTH', `${dep} recovered`)
      if (closed && shouldNotifyRecovery(closed)) {
        const mins = Math.round((Date.parse(closed.endedAt!) - Date.parse(closed.startedAt)) / 60_000)
        const span = mins >= 60 ? `${Math.round(mins / 60)} 小时` : `${mins} 分钟`
        safeNotify({
          title: '已恢复',
          body: `刚才断了约 ${span},现在已经恢复正常,你不需要做什么。`,
          actionable: false,
        })
      }
    } catch (err) {
      deps.log('HEALTH', `onSuccess swallowed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { health, onFailure, onSuccess }
}

export { SUSPEND_AFTER_MS } from './connection-health'
export type { Dependency } from './connection-health'
