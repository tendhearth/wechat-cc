import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCareLedger } from './care-ledger'

describe('care-ledger', () => {
  it('returns the default entry for an unknown chat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      expect(makeCareLedger(dir).get('nobody')).toEqual({ noReplyCount: 0 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('claim() sets lastProactiveAtIso and increments noReplyCount', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      const ledger = makeCareLedger(dir)
      ledger.claim('c1', '2026-07-07T00:00:00.000Z')
      expect(ledger.get('c1')).toEqual({ lastProactiveAtIso: '2026-07-07T00:00:00.000Z', noReplyCount: 1 })

      ledger.claim('c1', '2026-07-08T00:00:00.000Z')
      expect(ledger.get('c1')).toEqual({ lastProactiveAtIso: '2026-07-08T00:00:00.000Z', noReplyCount: 2 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('resetNoReply() zeroes the count but keeps lastProactiveAtIso', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      const ledger = makeCareLedger(dir)
      ledger.claim('c1', '2026-07-07T00:00:00.000Z')
      ledger.claim('c1', '2026-07-08T00:00:00.000Z')
      ledger.resetNoReply('c1')
      expect(ledger.get('c1')).toEqual({ lastProactiveAtIso: '2026-07-08T00:00:00.000Z', noReplyCount: 0 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('resetNoReply() on a missing chat is a true no-op (creates no entry)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      const seen: string[] = []
      const store = {
        get: (key: string) => undefined,
        set: (key: string) => { seen.push(key) },
        delete: () => {},
        all: () => ({}),
        flush: async () => {},
      }
      const ledger = makeCareLedger(dir, { store })
      ledger.resetNoReply('ghost')
      expect(seen).toEqual([])
      expect(ledger.get('ghost')).toEqual({ noReplyCount: 0 })

      // also verify against the real on-disk store: no key materializes
      const realLedger = makeCareLedger(dir)
      realLedger.resetNoReply('ghost2')
      expect(makeCareLedger(dir).get('ghost2')).toEqual({ noReplyCount: 0 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('write-through: a FRESH instance reads claims back from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      const ledger = makeCareLedger(dir)
      ledger.claim('c1', '2026-07-07T00:00:00.000Z')
      expect(makeCareLedger(dir).get('c1')).toEqual({ lastProactiveAtIso: '2026-07-07T00:00:00.000Z', noReplyCount: 1 })
      expect(readFileSync(join(dir, 'care_ledger.json'), 'utf8')).toContain('c1')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('survives a corrupt value (falls back to the default entry)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      const ledger = makeCareLedger(dir, { store: { get: () => 'not json', set: () => {}, delete: () => {}, all: () => ({}), flush: async () => {} } })
      expect(ledger.get('c1')).toEqual({ noReplyCount: 0 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('claimHunt() sets lastHuntAtIso and increments noReplyCount, and persists (fresh instance round-trip)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      const ledger = makeCareLedger(dir)
      ledger.claimHunt('c1', '2026-07-07T00:00:00.000Z')
      expect(ledger.get('c1')).toEqual({ lastHuntAtIso: '2026-07-07T00:00:00.000Z', noReplyCount: 1 })

      ledger.claimHunt('c1', '2026-07-08T00:00:00.000Z')
      expect(ledger.get('c1')).toEqual({ lastHuntAtIso: '2026-07-08T00:00:00.000Z', noReplyCount: 2 })

      // fresh instance reads the claim back from disk
      expect(makeCareLedger(dir).get('c1')).toEqual({
        lastHuntAtIso: '2026-07-08T00:00:00.000Z',
        noReplyCount: 2,
      })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('claimHunt() leaves lastProactiveAtIso untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      const ledger = makeCareLedger(dir)
      ledger.claim('c1', '2026-07-07T00:00:00.000Z')
      ledger.claimHunt('c1', '2026-07-08T00:00:00.000Z')
      expect(ledger.get('c1')).toEqual({
        lastProactiveAtIso: '2026-07-07T00:00:00.000Z',
        lastHuntAtIso: '2026-07-08T00:00:00.000Z',
        noReplyCount: 2,
      })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('claim() leaves lastHuntAtIso untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      const ledger = makeCareLedger(dir)
      ledger.claimHunt('c1', '2026-07-07T00:00:00.000Z')
      ledger.claim('c1', '2026-07-08T00:00:00.000Z')
      expect(ledger.get('c1')).toEqual({
        lastHuntAtIso: '2026-07-07T00:00:00.000Z',
        lastProactiveAtIso: '2026-07-08T00:00:00.000Z',
        noReplyCount: 2,
      })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// 第二轮评审 #194 P2:撤回只撤本次登记的那一项,保留等待期间的新活动(主人来信清零、新的记忆通知)。
describe('care-ledger unclaim — targeted undo (review #194)', () => {
  it('undoes only this claim: owner reply reset and a later memory claim survive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      const l = makeCareLedger(dir)
      l.claim('c', '2026-05-01T00:00:00.000Z')                       // 早先一次问候,还没回
      const claim = l.claimVisit('c', '2026-05-13T10:00:00.000Z')     // 串门登记
      l.resetNoReply('c')                                             // 等待期间主人来信
      l.claimMemory('c', '2026-05-13T10:01:00.000Z')                 // 又登记了一次记忆通知
      l.unclaim('c', claim)                                           // 串门被守护拒了:只撤这一项
      expect(l.get('c')).toEqual({ lastProactiveAtIso: '2026-05-01T00:00:00.000Z', lastMemoryAtIso: '2026-05-13T10:01:00.000Z', noReplyCount: 1 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('no activity in between → back to exactly the state before the claim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      const l = makeCareLedger(dir)
      l.claimVisit('c', '2026-05-10T10:00:00.000Z')
      const before = l.get('c')
      const claim = l.claimVisit('c', '2026-05-13T10:00:00.000Z')
      l.unclaim('c', claim)
      expect(l.get('c')).toMatchObject(before)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('a newer claim of the same kind is not rolled back by undoing the older one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      const l = makeCareLedger(dir)
      const first = l.claimHunt('c', '2026-05-13T10:00:00.000Z')
      l.claimHunt('c', '2026-05-13T11:00:00.000Z')
      l.unclaim('c', first)
      expect(l.get('c')).toMatchObject({ lastHuntAtIso: '2026-05-13T11:00:00.000Z', noReplyCount: 1 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
