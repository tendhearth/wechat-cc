import { describe, it, expect } from 'vitest'
import { parseSeekCommand } from './seek-command'

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
