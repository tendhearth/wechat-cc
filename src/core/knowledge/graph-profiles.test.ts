// src/core/knowledge/graph-profiles.test.ts
//
// Knowledge Kernel GR Task 2 — numeric-faithful port of wxgraph/profile.py's
// build_profiles + percentile + closeness scoring. These tests PIN THE
// NUMBERS: every expected value is either an exact rational (integer counts,
// clamp01-forced 0.0/1.0, reciprocity fractions) or, where irrational math is
// unavoidable (exp/log1p), computed independently in this file via the same
// Math primitives the implementation must use — never by importing/reusing
// buildProfiles's own internals to generate its own expected value.
//
// Source of truth: wechat-cc-plugins/packages/wxgraph/wxgraph/profile.py
// (and its wechat-cc-plugins/packages/wxgraph/tests/test_profile.py, whose
// first six cases are ported here near-verbatim).
import { describe, it, expect } from 'vitest'
import { buildProfiles, percentile, DEFAULT_WEIGHTS, type Msg } from './graph-profiles'

const DAY = 86400
const GAP = 6 * 3600

function m(
  conversation: string,
  sender_un: string,
  ts: number,
  kind = 'text',
  is_group = false,
): Msg {
  return { is_group, sender_un, conversation, ts, ltype: 1, content: '', kind }
}

describe('percentile', () => {
  it('matches profile.py\'s percentile exactly (empty / single / linear interp)', () => {
    expect(percentile([], 0.95)).toBe(0.0)
    expect(percentile([10], 0.95)).toBe(10)
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 9) // linear interp midpoint
  })
})

describe('buildProfiles — basic counts and direction (ported from test_basic_counts_and_direction)', () => {
  it('accumulates sent/recv, transfer direction, type tags, active_days', () => {
    const me = 'me'
    const a = 'a'
    const now = 1000 * DAY
    const msgs = [
      m(a, me, 100 * DAY),
      m(a, a, 101 * DAY),
      m(a, me, 900 * DAY),
      m(a, a, 900 * DAY, 'voice'),
      m(a, me, 900 * DAY, 'transfer'), // transfer out (sender === owner)
    ]
    const [p] = buildProfiles(msgs, me, now)
    expect(p!.username).toBe(a)
    expect(p!.total).toBe(5)
    expect(p!.sent).toBe(3)
    expect(p!.recv).toBe(2)
    expect(p!.first_ts).toBe(100 * DAY)
    expect(p!.last_ts).toBe(900 * DAY)
    expect(p!.transfer_out).toBe(1)
    expect(p!.transfer_in).toBe(0)
    expect(p!.types['voice']).toBe(1)
    expect(p!.types['transfer']).toBe(1)
    expect(p!.active_days).toBe(3) // days 100, 101, 900
  })
})

describe('buildProfiles — initiations gap rule (ported from test_initiations_gap_rule)', () => {
  it('counts an owner message as an initiation when prev is null or gap > GAP', () => {
    const me = 'me'
    const a = 'a'
    const now = 1000 * DAY
    const msgs = [
      m(a, me, 100 * DAY), // initiation (first, prevTs null)
      m(a, a, 100 * DAY + 60), // reply, no gap (not owner anyway)
      m(a, me, 100 * DAY + 7 * 3600), // >6h after prev -> initiation
    ]
    const [p] = buildProfiles(msgs, me, now)
    expect(p!.initiations).toBe(2)
  })

  it('boundary: exactly GAP does NOT trigger a new initiation; GAP+1 does', () => {
    const me = 'me'
    const a = 'a'
    const now = 1000 * DAY
    const msgs = [
      m(a, me, 0), // initiation #1 (prevTs null)
      m(a, me, GAP), // gap === GAP, NOT > GAP -> no new initiation
      m(a, me, GAP + (GAP + 1)), // gap from prev === GAP+1, > GAP -> initiation #2
    ]
    const [p] = buildProfiles(msgs, me, now)
    expect(p!.initiations).toBe(2)
  })
})

describe('buildProfiles — scores and closeness math for a single symmetric pair (ported from test_scores_and_closeness_math)', () => {
  it('last message today + single contact -> recency=1, volume=1, reciprocity=1, intimacy=0', () => {
    const me = 'me'
    const a = 'a'
    const now = 100 * DAY
    // last msg today -> s_recency = 1.0; single contact -> P95 == its own value -> s_volume = 1
    const msgs = [m(a, me, 100 * DAY), m(a, a, 100 * DAY)]
    const [p] = buildProfiles(msgs, me, now)
    expect(p!.s_recency).toBeCloseTo(1.0, 9)
    expect(p!.s_volume).toBeCloseTo(1.0, 9)
    expect(p!.s_reciprocity).toBeCloseTo(1.0, 9) // sent === recv === 1
    // intimacy: no voice/call/transfer -> log1p(0)/log1p(P95) = 0
    expect(p!.s_intimacy).toBe(0.0)
    const w = DEFAULT_WEIGHTS
    const expected = w.recency * 1.0 + w.volume * 1.0 + w.intimacy * 0.0 + w.reciprocity * 1.0
    expect(p!.closeness).toBeCloseTo(expected, 9)
  })
})

describe('buildProfiles — shared_groups counts only mutual speakers (ported)', () => {
  it('a contact who also spoke in a shared group gets shared_groups=1; one who never spoke there gets 0', () => {
    const me = 'me'
    const a = 'a'
    const b = 'b'
    const grp = 'g@chatroom'
    const now = 100 * DAY
    const msgs = [
      m(a, me, 10 * DAY),
      m(a, a, 11 * DAY), // 1:1 with a
      m(b, me, 10 * DAY), // 1:1 with b (b never replies)
      m(grp, me, 12 * DAY, 'text', true), // I spoke in group
      m(grp, a, 12 * DAY, 'text', true), // a spoke in group -> shared
      // b never spoke in the group
    ]
    const profs = new Map(buildProfiles(msgs, me, now).map(p => [p.username, p]))
    expect(profs.get(a)!.shared_groups).toBe(1)
    expect(profs.get(b)!.shared_groups).toBe(0)
  })
})

describe('buildProfiles — group-only contact is not a profile (ported)', () => {
  it('a contact seen only in a group (never 1:1) produces no profile row', () => {
    const me = 'me'
    const msgs = [
      m('g@chatroom', 'stranger', 10 * DAY, 'text', true),
      m('g@chatroom', me, 10 * DAY, 'text', true),
    ]
    expect(buildProfiles(msgs, me, 100 * DAY)).toEqual([])
  })
})

describe('buildProfiles — self-chat contact is skipped', () => {
  it('a 1:1 message where conversation === owner (filehelper/self-chat edge) produces no profile', () => {
    const me = 'me'
    const msgs = [m(me, me, 10 * DAY, 'text', false)]
    expect(buildProfiles(msgs, me, 100 * DAY)).toEqual([])
  })
})

describe('buildProfiles — recency decay: recent vs old contact', () => {
  it('a contact last active today scores s_recency=1; one last active exactly 90 days ago scores exp(-1)', () => {
    const me = 'me'
    const now = 100 * DAY
    const msgs = [
      m('r', 'r', 100 * DAY), // recent: last_ts === now
      m('o', 'o', 10 * DAY), // old: now - last_ts === 90 * DAY === TAU_DAYS
    ]
    const profs = new Map(buildProfiles(msgs, me, now).map(p => [p.username, p]))
    const r = profs.get('r')!
    const o = profs.get('o')!
    // both contacts have total=1 -> P95([1,1]) === 1 -> s_volume === 1 for both,
    // isolating recency as the only differing sub-score.
    expect(r.s_volume).toBeCloseTo(1.0, 9)
    expect(o.s_volume).toBeCloseTo(1.0, 9)
    expect(r.s_recency).toBeCloseTo(1.0, 9)
    expect(o.s_recency).toBeCloseTo(Math.exp(-1), 9) // exp(-90/TAU_DAYS) with TAU_DAYS=90
    expect(r.closeness).toBeGreaterThan(o.closeness)
  })
})

describe('buildProfiles — reciprocity balance: balanced vs sent-heavy', () => {
  it('sent===recv -> s_reciprocity=1.0; |sent-recv|/total=0.5 -> s_reciprocity=0.5', () => {
    const me = 'me'
    const now = 100 * DAY
    const msgs = [
      // balanced: sent=2, recv=2
      m('balanced', me, 50 * DAY),
      m('balanced', 'balanced', 50 * DAY + 10),
      m('balanced', me, 50 * DAY + 20),
      m('balanced', 'balanced', 50 * DAY + 30),
      // sentHeavy: sent=3, recv=1
      m('sentHeavy', me, 60 * DAY),
      m('sentHeavy', me, 60 * DAY + 10),
      m('sentHeavy', me, 60 * DAY + 20),
      m('sentHeavy', 'sentHeavy', 60 * DAY + 30),
    ]
    const profs = new Map(buildProfiles(msgs, me, now).map(p => [p.username, p]))
    expect(profs.get('balanced')!.s_reciprocity).toBeCloseTo(1.0, 9)
    expect(profs.get('sentHeavy')!.s_reciprocity).toBeCloseTo(0.5, 9) // 1 - |3-1|/4
  })
})

describe('buildProfiles — intimacy: voice/transfer bump vs a plain contact', () => {
  it('a contact with enough voice+transfer events clamps to s_intimacy=1.0; a plain contact is exactly 0.0', () => {
    const me = 'me'
    const now = 100 * DAY
    const msgs = [
      // plain: 5 text messages, no voice/call/transfer -> n_int = 0
      m('plain', me, 10 * DAY),
      m('plain', 'plain', 10 * DAY + 1),
      m('plain', me, 10 * DAY + 2),
      m('plain', 'plain', 10 * DAY + 3),
      m('plain', me, 10 * DAY + 4),
      // intimate: 3 voice (recv) + 1 transfer out (sent) + 1 transfer in (recv) -> n_int = 5
      m('intimate', 'intimate', 20 * DAY, 'voice'),
      m('intimate', 'intimate', 20 * DAY + 1, 'voice'),
      m('intimate', 'intimate', 20 * DAY + 2, 'voice'),
      m('intimate', me, 20 * DAY + 3, 'transfer'),
      m('intimate', 'intimate', 20 * DAY + 4, 'transfer'),
    ]
    const profs = new Map(buildProfiles(msgs, me, now).map(p => [p.username, p]))
    // P95([0,5]) === 4.75 < 5 (intimate's n_int) -> log1p(5) > log1p(4.75) -> clamps to exactly 1.0
    expect(profs.get('intimate')!.s_intimacy).toBeCloseTo(1.0, 9)
    // plain's n_int === 0 -> log1p(0) === 0 -> exactly 0.0 regardless of denominator
    expect(profs.get('plain')!.s_intimacy).toBe(0.0)
  })
})

describe('buildProfiles — combined scenario (kitchen sink): mixed sent/recv, voice, transfer in+out, initiation gap boundary, shared group, group-only contact excluded, self-chat skipped', () => {
  const me = 'me'
  const T0 = 100 * DAY

  // alice: 8 messages, sent=4/recv=4 (reciprocity exactly 1.0), a voice, a
  // transfer_in + transfer_out (n_int=3), an initiation-gap boundary
  // (GAP+1 triggers, exactly GAP does not), last message === `now` (recency
  // exactly 1.0).
  const aM1 = m('alice', 'alice', T0) // recv (sets prevTs first, so it is NOT null for aM2 below)
  const aM2 = m('alice', me, T0 + 100) // sent; gap from aM1 = 100, NOT > GAP -> no initiation
  const aM3 = m('alice', me, T0 + 100 + GAP + 1) // sent, gap=GAP+1 > GAP -> initiation #1
  const aM4 = m('alice', me, T0 + 100 + GAP + 1 + GAP) // sent, gap=GAP exactly -> NOT a new initiation
  const aM5 = m('alice', 'alice', T0 + 100 + GAP + 1 + GAP + 50) // recv
  const aM6 = m('alice', 'alice', 850 * DAY, 'voice') // recv
  const aM7 = m('alice', me, 900 * DAY, 'transfer') // sent, transfer_out, initiation #2 (huge gap)
  const aM8 = m('alice', 'alice', 900 * DAY + 10, 'transfer') // recv, transfer_in

  // bob: a single old recv message — deliberately weak on every axis so its
  // closeness must be strictly less than alice's without needing to
  // hand-compute its exact value (see assertion below).
  const bMsg = m('bob', 'bob', 500 * DAY)

  // grp: owner + alice both spoke (shared group); carol only ever speaks in
  // the group (no 1:1) -> must not produce a profile row at all.
  const g1 = m('grp@chatroom', me, 500 * DAY, 'text', true)
  const g2 = m('grp@chatroom', 'alice', 501 * DAY, 'text', true)
  const g3 = m('grp@chatroom', 'carol', 502 * DAY, 'text', true)

  // self-chat: conversation === owner -> must be skipped entirely.
  const selfMsg = m(me, me, 600 * DAY)

  const now = 900 * DAY + 10 // === aM8.ts, so alice's s_recency is exactly 1.0

  const all = [aM1, aM2, aM3, aM4, aM5, aM6, aM7, aM8, bMsg, g1, g2, g3, selfMsg]
  const profiles = buildProfiles(all, me, now)
  const byName = new Map(profiles.map(p => [p.username, p]))

  it('excludes group-only (carol) and self-chat (me) contacts', () => {
    expect(byName.has('carol')).toBe(false)
    expect(byName.has(me)).toBe(false)
    expect(profiles.length).toBe(2) // alice, bob only
  })

  it('alice: exact counts', () => {
    const a = byName.get('alice')!
    expect(a.total).toBe(8)
    expect(a.sent).toBe(4)
    expect(a.recv).toBe(4)
    expect(a.transfer_in).toBe(1)
    expect(a.transfer_out).toBe(1)
    expect(a.types['text']).toBe(5)
    expect(a.types['voice']).toBe(1)
    expect(a.types['transfer']).toBe(2)
    expect(a.active_days).toBe(3) // days 100, 850, 900
    expect(a.first_ts).toBe(T0)
    expect(a.last_ts).toBe(now)
    expect(a.known_days).toBe(800) // floor((now - first_ts) / DAY)
    expect(a.shared_groups).toBe(1)
  })

  it('alice: initiation gap boundary — GAP+1 triggers (aM3, aM7), exact GAP (aM4) and a small in-GAP gap (aM2) do not', () => {
    expect(byName.get('alice')!.initiations).toBe(2) // aM3, aM7 only
  })

  it('bob: exact counts', () => {
    const b = byName.get('bob')!
    expect(b.total).toBe(1)
    expect(b.sent).toBe(0)
    expect(b.recv).toBe(1)
    expect(b.transfer_in).toBe(0)
    expect(b.transfer_out).toBe(0)
    expect(b.shared_groups).toBe(0)
    expect(b.initiations).toBe(0)
  })

  it('alice: sub-scores clamp to exactly 1.0 on every axis -> closeness === sum of weights === 1.0', () => {
    const a = byName.get('alice')!
    // total=8 > P95([1,8],0.95)=7.65 -> log1p ratio > 1 (monotonic) -> clamps to 1.0
    expect(a.s_volume).toBeCloseTo(1.0, 9)
    // last_ts === now -> daysSince = 0 -> exp(0) = 1.0 exactly
    expect(a.s_recency).toBeCloseTo(1.0, 9)
    // sent === recv === 4 -> exactly 1.0
    expect(a.s_reciprocity).toBeCloseTo(1.0, 9)
    // n_int=3 > P95([0,3],0.95)=2.85 -> log1p ratio > 1 (monotonic) -> clamps to 1.0
    expect(a.s_intimacy).toBeCloseTo(1.0, 9)
    const w = DEFAULT_WEIGHTS
    expect(a.closeness).toBeCloseTo(w.recency + w.volume + w.intimacy + w.reciprocity, 9)
    expect(a.closeness).toBeCloseTo(1.0, 9)
  })

  it('ranking: alice (closeness===1.0, the theoretical max) outranks bob', () => {
    const a = byName.get('alice')!
    const b = byName.get('bob')!
    expect(a.closeness).toBeGreaterThan(b.closeness)
    const ranked = [...profiles].sort((x, y) => y.closeness - x.closeness)
    expect(ranked[0]!.username).toBe('alice')
    expect(ranked[1]!.username).toBe('bob')
  })

  it('bob: sub-scores computed independently match the implementation (not clamped, ordinary case)', () => {
    const b = byName.get('bob')!
    const p95Total = Math.max(1, 7.65) // percentile([1,8],0.95) — see combined-scenario comment
    const expectedSVolume = Math.min(1, Math.log1p(1) / Math.log1p(p95Total))
    expect(b.s_volume).toBeCloseTo(expectedSVolume, 6)
    const daysSince = Math.max(0, now - bMsg.ts) / DAY
    const expectedSRecency = Math.exp(-daysSince / 90.0)
    expect(b.s_recency).toBeCloseTo(expectedSRecency, 6)
    expect(b.s_reciprocity).toBe(0.0) // sent=0, recv=1 -> 1 - 1/1 = 0
    expect(b.s_intimacy).toBe(0.0) // n_int=0
  })
})
