import { describe, it, expect } from 'vitest'
import { parseSeekCommand, resolveSeekRef } from './seek-command'
import type { SeekRow } from './social-seek-store'

describe('parseSeekCommand', () => {
  it('派 <id> → confirm', () => {
    expect(parseSeekCommand('派 abc123def')).toEqual({ kind: 'confirm', ref: 'abc123def' })
  })
  it('leading # tolerated', () => {
    expect(parseSeekCommand('派 #abc123')).toEqual({ kind: 'confirm', ref: 'abc123' })
  })
  it('取消 <id> → cancel', () => {
    expect(parseSeekCommand('取消 abc123')).toEqual({ kind: 'cancel', ref: 'abc123' })
  })
  it('bare 派 → null', () => {
    expect(parseSeekCommand('派')).toBeNull()
  })
  it('non-command → null', () => {
    expect(parseSeekCommand('今天天气不错')).toBeNull()
  })
  it('multi-token → null (single token only)', () => {
    expect(parseSeekCommand('派多个 词')).toBeNull()
  })

  // Delegate-collision guard (I2) — 派 is ALREADY the delegate imperative
  // (admin-commands.ts DELEGATE_RE: 让/派 <hand> 执行/跑 <task>). The ref
  // token here is constrained to [0-9a-fA-F-]+ so a token containing 执行/跑
  // or any CJK hand name can never match, making this parser structurally
  // disjoint from DELEGATE_RE even if it were reached.
  it('派 <hand> 跑 <task> (multi-token AND non-id) → null', () => {
    expect(parseSeekCommand('派 家里 跑 拉日志')).toBeNull()
  })
  it('派 <CJK single token containing 跑> → null (single token but not id-charset)', () => {
    expect(parseSeekCommand('派 家里跑任务')).toBeNull()
  })
  it('派 <real id-ish token> → confirm', () => {
    expect(parseSeekCommand('派 3f9a2b')).toEqual({ kind: 'confirm', ref: '3f9a2b' })
  })
})

describe('resolveSeekRef', () => {
  function row(id: string, status: SeekRow['status']): SeekRow {
    return {
      id, status, kind: 'seek', topic: 't',
      redacted_topic: null, redacted_city: null,
      hop: 1, peers_asked: 0, created_at: '', updated_at: '',
    }
  }

  it('exact full-id match (any length) → ok', () => {
    const rows = [row('ab', 'proposed')]
    expect(resolveSeekRef('ab', rows)).toEqual({ ok: true, id: 'ab' })
  })

  it('unique ≥6-char prefix among proposed rows → ok', () => {
    const rows = [row('3f9a2bcccc', 'proposed'), row('deadbeef00', 'proposed')]
    expect(resolveSeekRef('3f9a2b', rows)).toEqual({ ok: true, id: '3f9a2bcccc' })
  })

  it('prefix matching ≥2 proposed rows → ambiguous', () => {
    const rows = [row('3f9a2b1111', 'proposed'), row('3f9a2b2222', 'proposed')]
    expect(resolveSeekRef('3f9a2b', rows)).toEqual({ ok: false, reason: 'ambiguous' })
  })

  it('prefix <6 chars with no exact match → ambiguous (nudge to longer prefix)', () => {
    const rows = [row('3f9a2bcccc', 'proposed')]
    expect(resolveSeekRef('3f9a', rows)).toEqual({ ok: false, reason: 'ambiguous' })
  })

  it('no match → not_found', () => {
    const rows = [row('3f9a2bcccc', 'proposed')]
    expect(resolveSeekRef('deadbeef', rows)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('prefix that only matches a NON-proposed row → not_found', () => {
    const rows = [row('3f9a2bcccc', 'foraging')]
    expect(resolveSeekRef('3f9a2b', rows)).toEqual({ ok: false, reason: 'not_found' })
  })
})
