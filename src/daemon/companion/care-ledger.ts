/**
 * care-ledger — per-chat proactive-care state (last claimed send + no-reply
 * streak), the learning signal calibration.ts reads to decide whether a
 * proactive nudge is due. Write-through (debounceMs:0) per
 * architecture-conventions #5: low-frequency critical state survives kill -9.
 */
import { join } from 'node:path'
import { makeStateStore, type StateStore } from '../state-store'
import type { CareLedgerEntry } from './calibration'

export interface CareLedger {
  get(chatId: string): CareLedgerEntry
  claim(chatId: string, nowIso: string): void
  claimHunt(chatId: string, nowIso: string): void
  resetNoReply(chatId: string): void
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
  return {
    get: read,
    claim(chatId, nowIso) {
      const cur = read(chatId)
      const next: CareLedgerEntry = { ...cur, lastProactiveAtIso: nowIso, noReplyCount: cur.noReplyCount + 1 }
      store.set(chatId, JSON.stringify(next))
    },
    claimHunt(chatId, nowIso) {
      const cur = read(chatId)
      const next: CareLedgerEntry = { ...cur, lastHuntAtIso: nowIso, noReplyCount: cur.noReplyCount + 1 }
      store.set(chatId, JSON.stringify(next))
    },
    resetNoReply(chatId) {
      const raw = store.get(chatId)
      if (!raw) return
      const cur = read(chatId)
      const next: CareLedgerEntry = { ...cur, noReplyCount: 0 }
      store.set(chatId, JSON.stringify(next))
    },
  }
}
