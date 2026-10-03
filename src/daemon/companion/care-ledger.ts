/**
 * care-ledger — per-chat proactive-care state (last claimed send + no-reply
 * streak), the learning signal calibration.ts reads to decide whether a
 * proactive nudge is due. Write-through (debounceMs:0) per
 * architecture-conventions #5: low-frequency critical state survives kill -9.
 */
import { join } from 'node:path'
import { makeStateStore, type StateStore } from '../state-store'
import type { CareLedgerEntry } from './calibration'

/** 一次登记的回执,撤回时用(只撤这一次,见 unclaim)。 */
export interface CareClaim {
  field: 'lastProactiveAtIso' | 'lastHuntAtIso' | 'lastVisitAtIso' | 'lastMemoryAtIso'
  /** 这次登记写进去的时间。 */
  at: string
  /** 登记之前这个字段的值。 */
  prior: string | undefined
  /** 登记那一刻的「未回复计数」纪元(resetNoReply 一次加一)。 */
  epoch: number
}

export interface CareLedger {
  get(chatId: string): CareLedgerEntry
  claim(chatId: string, nowIso: string): CareClaim
  claimHunt(chatId: string, nowIso: string): CareClaim
  /** 串门出门前登记(at-most-once,同 claimHunt)。 */
  claimVisit(chatId: string, nowIso: string): CareClaim
  /** 记忆通知发出前登记(at-most-once,同 claimHunt)。 */
  claimMemory(chatId: string, nowIso: string): CareClaim
  resetNoReply(chatId: string): void
  /**
   * 只撤回**这一次**登记(评审 #193 P2-3 / 第二轮 #194):先登记再出门之后那一次模型调用被网络守护
   * 拒了 —— 什么都没发出去,这次登记不能算数。定向撤:时间字段只在还是这次写的值时放回;未回复计数
   * 只在这期间没被清零过(主人没来信)时减一。期间别的新活动(主人来信清零、别的登记)全部保留。
   */
  unclaim(chatId: string, claim: CareClaim): void
}

const DEFAULT_ENTRY: CareLedgerEntry = { noReplyCount: 0 }

export function makeCareLedger(stateDir: string, deps?: { store?: StateStore }): CareLedger {
  const store = deps?.store ?? makeStateStore(join(stateDir, 'care_ledger.json'), { debounceMs: 0 })
  const read = (chatId: string): CareLedgerEntry => {
    const raw = store.get(chatId)
    if (!raw) return DEFAULT_ENTRY
    try {
      const p = JSON.parse(raw) as unknown
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as CareLedgerEntry) : DEFAULT_ENTRY
    } catch {
      return DEFAULT_ENTRY
    }
  }
  // 每个 chat 的「未回复计数」纪元:resetNoReply 一次加一。登记和撤回在同一拍、同一个进程里,内存就够。
  const epochs = new Map<string, number>()
  const epochOf = (chatId: string) => epochs.get(chatId) ?? 0
  const claimField = (chatId: string, field: CareClaim['field'], nowIso: string): CareClaim => {
    const cur = read(chatId)
    const ticket: CareClaim = { field, at: nowIso, prior: cur[field], epoch: epochOf(chatId) }
    store.set(chatId, JSON.stringify({ ...cur, [field]: nowIso, noReplyCount: cur.noReplyCount + 1 }))
    return ticket
  }
  return {
    get: read,
    claim: (chatId, nowIso) => claimField(chatId, 'lastProactiveAtIso', nowIso),
    claimHunt: (chatId, nowIso) => claimField(chatId, 'lastHuntAtIso', nowIso),
    claimVisit: (chatId, nowIso) => claimField(chatId, 'lastVisitAtIso', nowIso),
    claimMemory: (chatId, nowIso) => claimField(chatId, 'lastMemoryAtIso', nowIso),
    unclaim(chatId, claim) {
      const cur = read(chatId)
      const next: CareLedgerEntry = { ...cur }
      if (cur[claim.field] === claim.at) {
        if (claim.prior === undefined) delete next[claim.field]
        else next[claim.field] = claim.prior
      }
      if (epochOf(chatId) === claim.epoch && cur.noReplyCount > 0) next.noReplyCount = cur.noReplyCount - 1
      store.set(chatId, JSON.stringify(next))
    },
    resetNoReply(chatId) {
      epochs.set(chatId, epochOf(chatId) + 1)
      const raw = store.get(chatId)
      if (!raw) return
      const cur = read(chatId)
      const next: CareLedgerEntry = { ...cur, noReplyCount: 0 }
      store.set(chatId, JSON.stringify(next))
    },
  }
}
