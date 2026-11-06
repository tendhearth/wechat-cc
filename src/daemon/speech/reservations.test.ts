import { expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { INITIATIVE_INTERVAL_MS, makeSpeechReservations } from './reservations'
import { makeSpeechLedgerStore } from './ledger-store'

it('atomically admits one ordinary source; scheduled bypasses interval and shares the active slot', () => {
  const db = openTestDb()
  try {
    const r = makeSpeechReservations(db)
    const p = { ref: 'letter:a', recipient: 'owner', kind: 'letter' as const, now: 100, payload: { letterId: 'a' } }
    expect(r.reserve(p)).toEqual({ ok: true })
    expect(r.reserve({ ...p, ref: 'memory:a' })).toEqual({ ok: false, reason: 'occupied' })
    expect(r.reserve({ ...p, ref: 'brief:a', scheduled: true })).toEqual({ ok: false, reason: 'occupied' })
    expect(r.sending(p.ref)).toBe(true)
    makeSpeechLedgerStore(db, { now: () => 100 }).append({ kind: 'letter', origin: 'initiative', chatId: 'owner', outcome: 'allowed', reason: null, channel: 'wechat', ts: new Date(100).toISOString(), spokenAt: 100, ref: p.ref })
    r.settle(p.ref, 'confirmed')
    expect(r.reserve({ ...p, ref: 'memory:a', now: 101 })).toEqual({ ok: false, reason: 'interval' })
    expect(r.reserve({ ...p, ref: 'brief:a', kind: 'brief', scheduled: true })).toEqual({ ok: true })
    r.settle('brief:a', 'not_sent')
    expect(r.reserve({ ...p, ref: 'memory:a', now: 100 + INITIATIVE_INTERVAL_MS })).toEqual({ ok: true })
    expect(r.reserve(p)).toEqual({ ok: false, reason: 'duplicate' })
  } finally { db.close() }
})

it('recovery never retries an unknown send; it occupies one interval without forging spoken_at', () => {
  const db = openTestDb()
  try {
    const r = makeSpeechReservations(db)
    const p = { ref: 'letter:a', recipient: 'owner', kind: 'letter' as const, now: 100, payload: {} }
    expect(r.reserve(p)).toEqual({ ok: true })
    expect(r.sending(p.ref)).toBe(true)
    const restarted = makeSpeechReservations(db)
    restarted.recover()
    expect(restarted.available('owner', 101)).toBe(false)
    expect(makeSpeechLedgerStore(db).lastInitiativeAt('owner')).toBeNull()
    expect(restarted.reserve(p)).toEqual({ ok: false, reason: 'duplicate' })
    expect(restarted.available('owner', 100 + INITIATIVE_INTERVAL_MS)).toBe(true)
    expect(restarted.reserve({ ...p, ref: 'memory:a', now: 100 + INITIATIVE_INTERVAL_MS })).toEqual({ ok: true })
    restarted.recover()
    expect(restarted.reserve({ ...p, ref: 'memory:a', now: 100 + INITIATIVE_INTERVAL_MS })).toEqual({ ok: true })
    restarted.settle('memory:a', 'not_sent')
    expect(restarted.available('owner', 100 + INITIATIVE_INTERVAL_MS)).toBe(true)
    expect(restarted.available('visitor', 101)).toBe(true)
  } finally { db.close() }
})

it('confirmed external delivery with a missing ledger write stays unknown and occupies the interval', () => {
  const db = openTestDb()
  try {
    const r = makeSpeechReservations(db)
    expect(r.reserve({ ref: 'letter:a', recipient: 'owner', kind: 'letter', now: 100, payload: {} })).toEqual({ ok: true })
    r.sending('letter:a')
    r.settle('letter:a', 'confirmed')
    expect(r.available('owner', 101)).toBe(false)
    expect(r.available('owner', 100 + INITIATIVE_INTERVAL_MS)).toBe(true)
    expect(db.query("SELECT status FROM speech_pending WHERE ref='letter:a'").get()).toEqual({ status: 'unknown' })
  } finally { db.close() }
})

it('only a confirmed completed reservation can be reopened for explicit partial-page continuation', () => {
  const db = openTestDb()
  try {
    const r = makeSpeechReservations(db)
    const p = { ref: 'letter:partial', recipient: 'owner', kind: 'letter' as const, now: 100, payload: {} }
    r.reserve(p); r.sending(p.ref); r.settle(p.ref, 'unknown')
    expect(r.reserve({ ...p, now: 100 + INITIATIVE_INTERVAL_MS, resumeConfirmed: true })).toEqual({ ok: false, reason: 'duplicate' })
  } finally { db.close() }
})
