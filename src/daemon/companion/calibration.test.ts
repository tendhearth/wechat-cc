import { describe, expect, it } from 'vitest'
import { careLevel, shouldSpeak, type CareLedgerEntry } from './calibration'

// Fixed clock — no Date.now() / no `new Date()` at call sites in the
// implementation. Test fixtures derive ISO strings by numeric ms arithmetic
// off one fixed epoch, then format with `new Date(ms).toISOString()` (a pure
// formatting call, not a "now" read).
const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = '2026-07-09T12:00:00Z'
const NOW_MS = Date.parse(NOW)
const agoIso = (ms: number) => new Date(NOW_MS - ms).toISOString()

const emptyLedger: CareLedgerEntry = { noReplyCount: 0 }

describe('careLevel', () => {
  it('unset + owner chat ⇒ low', () => {
    expect(careLevel('chat-1', {}, 'chat-1')).toBe('low')
  })

  it('unset + non-owner chat ⇒ off', () => {
    expect(careLevel('chat-2', {}, 'chat-1')).toBe('off')
  })

  it('unset + defaultChatId undefined ⇒ off (never owner)', () => {
    expect(careLevel('chat-1', {}, undefined)).toBe('off')
  })

  it('explicit prefs.care wins over owner default (off)', () => {
    expect(careLevel('chat-1', { care: 'off' }, 'chat-1')).toBe('off')
  })

  it('explicit prefs.care wins over owner default (high)', () => {
    expect(careLevel('chat-1', { care: 'high' }, 'chat-1')).toBe('high')
  })

  it('explicit prefs.care wins for a non-owner chat', () => {
    expect(careLevel('chat-2', { care: 'high' }, 'chat-1')).toBe('high')
  })
})

describe('shouldSpeak — off level always denies', () => {
  it('agenda kind ⇒ care_off', () => {
    expect(
      shouldSpeak({ kind: 'agenda', level: 'off', nowIso: NOW, ledger: emptyLedger }),
    ).toEqual({ ok: false, reason: 'care_off' })
  })

  it('gap kind ⇒ care_off (even with a fully-eligible ledger)', () => {
    expect(
      shouldSpeak({
        kind: 'gap',
        level: 'off',
        nowIso: NOW,
        ledger: emptyLedger,
        lastInboundAtIso: agoIso(30 * DAY),
      }),
    ).toEqual({ ok: false, reason: 'care_off' })
  })
})

describe('shouldSpeak — agenda', () => {
  for (const level of ['low', 'high'] as const) {
    it(`${level}: no lastProactiveAtIso ⇒ ok`, () => {
      expect(
        shouldSpeak({ kind: 'agenda', level, nowIso: NOW, ledger: emptyLedger }),
      ).toEqual({ ok: true })
    })

    it(`${level}: 19h59m since lastProactive ⇒ deny agenda_cooldown`, () => {
      const ledger: CareLedgerEntry = {
        lastProactiveAtIso: agoIso(19 * HOUR + 59 * 60_000),
        noReplyCount: 0,
      }
      expect(shouldSpeak({ kind: 'agenda', level, nowIso: NOW, ledger })).toEqual({
        ok: false,
        reason: 'agenda_cooldown',
      })
    })

    it(`${level}: 20h01m since lastProactive ⇒ ok`, () => {
      const ledger: CareLedgerEntry = {
        lastProactiveAtIso: agoIso(20 * HOUR + 60_000),
        noReplyCount: 0,
      }
      expect(shouldSpeak({ kind: 'agenda', level, nowIso: NOW, ledger })).toEqual({ ok: true })
    })
  }

  it('exactly 20h since lastProactive ⇒ ok (boundary is inclusive of the cooldown edge)', () => {
    const ledger: CareLedgerEntry = { lastProactiveAtIso: agoIso(20 * HOUR), noReplyCount: 0 }
    expect(shouldSpeak({ kind: 'agenda', level: 'low', nowIso: NOW, ledger })).toEqual({ ok: true })
  })

  it('noReplyCount does NOT gate agenda — still ok at count 2 once cooldown has passed', () => {
    const ledger: CareLedgerEntry = { lastProactiveAtIso: agoIso(30 * HOUR), noReplyCount: 2 }
    expect(shouldSpeak({ kind: 'agenda', level: 'low', nowIso: NOW, ledger })).toEqual({ ok: true })
  })

  it('noReplyCount does NOT gate agenda — even mid-cooldown, denial reason is agenda_cooldown, not paused_no_reply', () => {
    const ledger: CareLedgerEntry = { lastProactiveAtIso: agoIso(1 * HOUR), noReplyCount: 5 }
    expect(shouldSpeak({ kind: 'agenda', level: 'low', nowIso: NOW, ledger })).toEqual({
      ok: false,
      reason: 'agenda_cooldown',
    })
  })
})

describe('shouldSpeak — gap', () => {
  it('no lastInboundAtIso ⇒ never_talked', () => {
    expect(
      shouldSpeak({ kind: 'gap', level: 'low', nowIso: NOW, ledger: emptyLedger }),
    ).toEqual({ ok: false, reason: 'never_talked' })
  })

  it('never_talked takes priority over paused_no_reply when both would apply', () => {
    const ledger: CareLedgerEntry = { noReplyCount: 5 }
    expect(shouldSpeak({ kind: 'gap', level: 'low', nowIso: NOW, ledger })).toEqual({
      ok: false,
      reason: 'never_talked',
    })
  })

  it('noReplyCount:2 ⇒ paused_no_reply (checked before distance gates)', () => {
    const ledger: CareLedgerEntry = { noReplyCount: 2 }
    expect(
      shouldSpeak({ kind: 'gap', level: 'low', nowIso: NOW, ledger, lastInboundAtIso: agoIso(30 * DAY) }),
    ).toEqual({ ok: false, reason: 'paused_no_reply' })
  })

  it('paused_no_reply takes priority over gap_inbound_recent when both would apply', () => {
    const ledger: CareLedgerEntry = { noReplyCount: 3 }
    expect(
      shouldSpeak({ kind: 'gap', level: 'low', nowIso: NOW, ledger, lastInboundAtIso: agoIso(1 * HOUR) }),
    ).toEqual({ ok: false, reason: 'paused_no_reply' })
  })

  it('noReplyCount:1 ⇒ NOT paused, falls through to ok when distance gates clear', () => {
    const ledger: CareLedgerEntry = { noReplyCount: 1 }
    expect(
      shouldSpeak({ kind: 'gap', level: 'low', nowIso: NOW, ledger, lastInboundAtIso: agoIso(30 * DAY) }),
    ).toEqual({ ok: true })
  })

  it('low (N=7): 6d23h since lastInbound ⇒ deny gap_inbound_recent', () => {
    const ledger: CareLedgerEntry = { noReplyCount: 0 }
    expect(
      shouldSpeak({
        kind: 'gap',
        level: 'low',
        nowIso: NOW,
        ledger,
        lastInboundAtIso: agoIso(6 * DAY + 23 * HOUR),
      }),
    ).toEqual({ ok: false, reason: 'gap_inbound_recent' })
  })

  it('low (N=7): 7d01h since lastInbound, no lastProactive ⇒ ok', () => {
    const ledger: CareLedgerEntry = { noReplyCount: 0 }
    expect(
      shouldSpeak({
        kind: 'gap',
        level: 'low',
        nowIso: NOW,
        ledger,
        lastInboundAtIso: agoIso(7 * DAY + 1 * HOUR),
      }),
    ).toEqual({ ok: true })
  })

  it('low (N=7): exactly 7d since lastInbound ⇒ ok (boundary is inclusive)', () => {
    const ledger: CareLedgerEntry = { noReplyCount: 0 }
    expect(
      shouldSpeak({ kind: 'gap', level: 'low', nowIso: NOW, ledger, lastInboundAtIso: agoIso(7 * DAY) }),
    ).toEqual({ ok: true })
  })

  it('both-gaps rule: inbound 8d ago (clears N) BUT proactive 1d ago (within N) ⇒ deny gap_proactive_recent', () => {
    const ledger: CareLedgerEntry = { lastProactiveAtIso: agoIso(1 * DAY), noReplyCount: 0 }
    expect(
      shouldSpeak({ kind: 'gap', level: 'low', nowIso: NOW, ledger, lastInboundAtIso: agoIso(8 * DAY) }),
    ).toEqual({ ok: false, reason: 'gap_proactive_recent' })
  })

  it('both gaps satisfied (inbound 8d ago, proactive 8d ago) ⇒ ok', () => {
    const ledger: CareLedgerEntry = { lastProactiveAtIso: agoIso(8 * DAY), noReplyCount: 0 }
    expect(
      shouldSpeak({ kind: 'gap', level: 'low', nowIso: NOW, ledger, lastInboundAtIso: agoIso(8 * DAY) }),
    ).toEqual({ ok: true })
  })

  it('both gaps satisfied exactly at N=7 boundary for proactive too ⇒ ok', () => {
    const ledger: CareLedgerEntry = { lastProactiveAtIso: agoIso(7 * DAY), noReplyCount: 0 }
    expect(
      shouldSpeak({ kind: 'gap', level: 'low', nowIso: NOW, ledger, lastInboundAtIso: agoIso(10 * DAY) }),
    ).toEqual({ ok: true })
  })

  it('high (N=2): 1d23h since lastInbound ⇒ deny gap_inbound_recent', () => {
    const ledger: CareLedgerEntry = { noReplyCount: 0 }
    expect(
      shouldSpeak({
        kind: 'gap',
        level: 'high',
        nowIso: NOW,
        ledger,
        lastInboundAtIso: agoIso(1 * DAY + 23 * HOUR),
      }),
    ).toEqual({ ok: false, reason: 'gap_inbound_recent' })
  })

  it('high (N=2): 2d01h since lastInbound, no lastProactive ⇒ ok', () => {
    const ledger: CareLedgerEntry = { noReplyCount: 0 }
    expect(
      shouldSpeak({
        kind: 'gap',
        level: 'high',
        nowIso: NOW,
        ledger,
        lastInboundAtIso: agoIso(2 * DAY + 1 * HOUR),
      }),
    ).toEqual({ ok: true })
  })

  it('high (N=2): both-gaps rule — inbound 5d ago (clears) but proactive 1d ago (within N) ⇒ deny gap_proactive_recent', () => {
    const ledger: CareLedgerEntry = { lastProactiveAtIso: agoIso(1 * DAY), noReplyCount: 0 }
    expect(
      shouldSpeak({ kind: 'gap', level: 'high', nowIso: NOW, ledger, lastInboundAtIso: agoIso(5 * DAY) }),
    ).toEqual({ ok: false, reason: 'gap_proactive_recent' })
  })
})
