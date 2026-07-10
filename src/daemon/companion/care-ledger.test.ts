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
})
