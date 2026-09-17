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
  it('replace 把缓冲区清空时要清掉孤儿计时器；下一个 itemId 拿到完整的 windowMs', () => {
    vi.useFakeTimers()
    const out: AgentEvent[] = []; const c = makeDeltaCoalescer(e => out.push(e), { windowMs: 150 })
    c.push(append('a', 'x'))                                       // t=0，计时器到点=150
    vi.advanceTimersByTime(60)                                      // t=60
    c.push({ kind: 'text', text: 'x', itemId: 'a', textMode: 'replace' }) // 清空缓冲 ⇒ 必须清掉孤儿计时器
    c.push(append('b', 'y'))                                        // t=60，若计时器被误留下就不会重新起窗口
    vi.advanceTimersByTime(149)                                     // t=209，b 的完整窗口还没到(60+150=210)
    expect(out.some(e => e.kind === 'text' && e.itemId === 'b')).toBe(false)
    vi.advanceTimersByTime(1)                                       // t=210
    expect(out.filter(e => e.kind === 'text' && e.itemId === 'b')).toEqual([append('b', 'y')])
    vi.useRealTimers()
  })
  it('replace 一个 itemId 时若缓冲区里还有别的 itemId，不清计时器，那个 itemId 按原计划到点 flush', () => {
    vi.useFakeTimers()
    const out: AgentEvent[] = []; const c = makeDeltaCoalescer(e => out.push(e), { windowMs: 150 })
    c.push(append('a', 'x'))                                        // t=0，计时器到点=150
    vi.advanceTimersByTime(60)                                       // t=60
    c.push(append('b', 'y'))                                         // 缓冲区里 a、b 都在，沿用同一个计时器
    c.push({ kind: 'text', text: 'x', itemId: 'a', textMode: 'replace' }) // 只清 a，b 还在 ⇒ 计时器不该被清
    vi.advanceTimersByTime(89)                                       // t=149，还没到原计划的 150
    expect(out.some(e => e.kind === 'text' && e.itemId === 'b')).toBe(false)
    vi.advanceTimersByTime(1)                                        // t=150，原计划的到点时刻
    expect(out.filter(e => e.kind === 'text' && e.itemId === 'b')).toEqual([append('b', 'y')])
    vi.useRealTimers()
  })
})
