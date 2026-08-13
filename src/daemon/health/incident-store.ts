/**
 * incident-store — 故障记录(spec 2026-08-03 §7)。
 *
 * 用 state-store 的写透模式(debounceMs:0,tmp+rename),不新增 db 表:
 * 这正是仓库既有约定说的"关键低频状态写透"(architecture-conventions §5,
 * 同 context_tokens.json)。故障是低频事件,滚动 20 条足够,不值得一次迁移。
 *
 * 存在的意义:桌面没开时通知无处可去,记下来,等主人下次打开桌面再告诉他
 * "过去 X 小时你的 bot 是断的"。
 */
import { join } from 'node:path'
import { makeStateStore, type StateStore } from '../state-store'
import type { Dependency } from './connection-health'
import type { FailureKind } from './classify'

export interface Incident {
  id: string
  dependency: Dependency
  kind: FailureKind
  actionable: boolean
  startedAt: string
  /** null ⇒ 仍在进行中。 */
  endedAt: string | null
  /** 通知发出的时刻;null ⇒ 从未通知过(恢复时也就不该通知)。 */
  notifiedAt: string | null
  lastError: string | null
}

export interface IncidentStore {
  open(input: Omit<Incident, 'id' | 'endedAt' | 'notifiedAt'>): Incident
  close(dep: Dependency, endedAtIso: string): Incident | null
  markNotified(dep: Dependency, atIso: string): void
  openOf(dep: Dependency): Incident | null
  list(): Incident[]
}

const KEY = 'incidents'
const MAX_KEPT = 20

export function makeIncidentStore(deps: { stateDir: string; store?: StateStore }): IncidentStore {
  const store = deps.store ?? makeStateStore(join(deps.stateDir, 'health-incidents.json'), { debounceMs: 0 })

  function read(): Incident[] {
    const raw = store.get(KEY)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed as Incident[] : []
    } catch {
      return []   // 损坏就当空历史 —— 保护机制不能成为新的故障源
    }
  }

  function write(list: Incident[]): void {
    store.set(KEY, JSON.stringify(list.slice(0, MAX_KEPT)))
  }

  return {
    open(input) {
      const incident: Incident = { ...input, id: `${input.dependency}-${input.startedAt}`, endedAt: null, notifiedAt: null }
      const list = read().filter(i => !(i.dependency === input.dependency && i.endedAt === null))
      write([incident, ...list])
      return incident
    },
    close(dep, endedAtIso) {
      const list = read()
      const idx = list.findIndex(i => i.dependency === dep && i.endedAt === null)
      if (idx === -1) return null
      const closed = { ...list[idx]!, endedAt: endedAtIso }
      list[idx] = closed
      write(list)
      return closed
    },
    markNotified(dep, atIso) {
      const list = read()
      const idx = list.findIndex(i => i.dependency === dep && i.endedAt === null)
      if (idx === -1) return
      list[idx] = { ...list[idx]!, notifiedAt: atIso }
      write(list)
    },
    openOf(dep) {
      return read().find(i => i.dependency === dep && i.endedAt === null) ?? null
    },
    list() {
      return read()
    },
  }
}
