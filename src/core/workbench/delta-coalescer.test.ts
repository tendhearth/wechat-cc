import { describe, it, expect, vi } from 'vitest'
import { makeDeltaCoalescer } from './delta-coalescer'
import type { AgentEvent } from '../agent-provider'

const append = (itemId: string, text: string): AgentEvent => ({ kind: 'text', text, itemId, textMode: 'append' })
describe('DeltaCoalescer', () => {
  it('150ms 内的同 itemId 增量合成一条', () => {
    vi.useFakeTimers()
    const out: AgentEvent[] = []; const c = makeDeltaCoalescer(e => out.push(e), { windowMs: 150 })
    c.push(append('a', '你')); c.push(append('a', '好')); c.push(append('a', '呀'))
    expect(out).toEqual([])
    vi.advanceTimersByTime(150)
    expect(out).toEqual([append('a', '你好呀')])
    vi.useRealTimers()
  })
  it('非 append 事件到来 ⇒ 先 flush 再原样放行;replace 先 flush 同 itemId', () => {
    const out: AgentEvent[] = []; const c = makeDeltaCoalescer(e => out.push(e), { windowMs: 10_000 })
    c.push(append('a', '你')); c.push({ kind: 'tool_call', tool: 'Bash', activity: { id: 'x', type: 'command', status: 'running', label: 'ls' } } as AgentEvent)
    expect(out.map(e => e.kind)).toEqual(['text', 'tool_call'])
    c.push(append('a', '好')); c.push({ kind: 'text', text: '你好', itemId: 'a', textMode: 'replace' })
    expect(out.slice(2)).toEqual([append('a', '好'), { kind: 'text', text: '你好', itemId: 'a', textMode: 'replace' }])
  })
  it('不同 itemId 各自一条,flush 按先后', () => {
    const out: AgentEvent[] = []; const c = makeDeltaCoalescer(e => out.push(e), { windowMs: 10_000 })
    c.push(append('a', '1')); c.push(append('b', '2')); c.push(append('a', '3')); c.flush()
    expect(out).toEqual([append('a', '13'), append('b', '2')])
  })
  it('dispose 也 flush 且不再触发定时器', () => {
    vi.useFakeTimers()
    const out: AgentEvent[] = []; const c = makeDeltaCoalescer(e => out.push(e))
    c.push(append('a', 'x')); c.dispose(); expect(out).toHaveLength(1)
    vi.advanceTimersByTime(1000); expect(out).toHaveLength(1)
    vi.useRealTimers()
  })
})
