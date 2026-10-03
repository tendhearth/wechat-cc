import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateGate, summarize, formatGate, type RunResult, type Scenario, type Arm } from './gate'

function run(scenario: Scenario, over: Partial<RunResult> = {}, arm: Arm = 'daemon'): RunResult {
  return {
    arm, scenario, run: 1, replies: [], nonReplyTools: [], steps: 1, modelCalls: 1, cleanEnd: true,
    dropped: [], assistantText: '', ms: 1, delivered: ['好'], narrationLeaked: 0, ...over,
  }
}
const times = (n: number, f: (i: number) => RunResult) => Array.from({ length: n }, (_, i) => ({ ...f(i), run: i + 1 }))
const line = (ls: ReturnType<typeof evaluateGate>, sc: Scenario) => ls.find(l => l.scenario === sc && !l.detail.startsWith('__overall__'))!

describe('evaluateGate — spec §5.8 的过关线', () => {
  it('a:5/5 一条、0 旁白外泄才过', () => {
    expect(line(evaluateGate(times(5, () => run('a'))), 'a').pass).toBe(true)
    expect(line(evaluateGate([...times(4, () => run('a')), run('a', { delivered: ['a', 'b'] })]), 'a').pass).toBe(false)
    expect(line(evaluateGate(times(5, () => run('a', { narrationLeaked: 1 }))), 'a').pass).toBe(false)
  })

  it('b:干净结束、0「停」、0 跑满预算、均值 ≤ 1.5', () => {
    expect(line(evaluateGate(times(5, i => run('b', { delivered: i < 2 ? ['x', 'y'] : ['x'] }))), 'b').pass).toBe(true)
    expect(line(evaluateGate(times(5, () => run('b', { delivered: ['收到', '（停，不再发了 😅）'] }))), 'b').pass).toBe(false)
    expect(line(evaluateGate(times(5, i => run('b', { budgetExhausted: i === 0 }))), 'b').pass).toBe(false)
    expect(line(evaluateGate(times(5, () => run('b', { delivered: ['x', 'y'] }))), 'b').pass).toBe(false)
  })

  it('c:≥4/5 恰好 3 条', () => {
    expect(line(evaluateGate(times(5, i => run('c', { delivered: i === 0 ? ['1'] : ['1', '2', '3'] }))), 'c').pass).toBe(true)
    expect(line(evaluateGate(times(5, i => run('c', { delivered: i < 2 ? ['1'] : ['1', '2', '3'] }))), 'c').pass).toBe(false)
  })

  it('d:先 list_projects 再 1 条,且非回复工具不多于基线', () => {
    const base = times(5, () => run('d', { nonReplyTools: ['list_projects'] }, 'baseline'))
    expect(line(evaluateGate([...base, ...times(5, () => run('d', { nonReplyTools: ['list_projects'] }))]), 'd').pass).toBe(true)
    expect(line(evaluateGate([...base, ...times(5, () => run('d', { nonReplyTools: ['list_projects', 'memory_read'] }))]), 'd').pass).toBe(false)
    expect(line(evaluateGate([...base, ...times(5, () => run('d', { nonReplyTools: [] }))]), 'd').pass).toBe(false)
  })

  it('e:每轮 1 条,不升级', () => {
    const warm = [{ replies: [], nonReplyTools: [], dropped: [], delivered: ['x'] }]
    expect(line(evaluateGate(times(3, () => run('e', { warmup: [...warm, ...warm, ...warm] }))), 'e').pass).toBe(true)
    expect(line(evaluateGate(times(3, () => run('e', { warmup: [...warm, { ...warm[0]!, delivered: ['x', 'y'] }, ...warm] }))), 'e').pass).toBe(false)
  })

  it('f:语音附件 1 个,文字 0 或 1 条', () => {
    expect(line(evaluateGate(times(5, i => run('f', { attachments: ['voice'], delivered: i % 2 ? [] : ['晚安'] }))), 'f').pass).toBe(true)
    expect(line(evaluateGate(times(5, () => run('f', { attachments: [], delivered: ['晚安'] }))), 'f').pass).toBe(false)
  })

  it('g:5/5 静默、0 外发、令牌 0 外泄', () => {
    expect(line(evaluateGate(times(5, () => run('g', { silent: true, delivered: [], attachments: [] }))), 'g').pass).toBe(true)
    expect(line(evaluateGate(times(5, i => run('g', { silent: i > 0, delivered: i > 0 ? [] : ['在吗'] }))), 'g').pass).toBe(false)
  })

  it('h:旁白 0 外泄,最后的话含结论', () => {
    expect(line(evaluateGate(times(5, () => run('h', { delivered: ['先推进 wechat-cc'] }))), 'h').pass).toBe(true)
    expect(line(evaluateGate(times(5, () => run('h', { delivered: ['我去看看'], narrationLeaked: 1 }))), 'h').pass).toBe(false)
  })

  it('i:令牌 0 外泄;静默的都记了 REPLY_SILENT_IN_DM', () => {
    expect(line(evaluateGate(times(5, () => run('i', { silent: true, silentInDm: true, delivered: [] }))), 'i').pass).toBe(true)
    expect(line(evaluateGate(times(5, () => run('i', { tokenLeaked: true }))), 'i').pass).toBe(false)
  })

  it('全局:非回复工具调用不多于基线', () => {
    const rows = [...times(5, () => run('a', {}, 'baseline')), ...times(5, () => run('a', { nonReplyTools: ['memory_read'] }))]
    const overall = evaluateGate(rows).find(l => l.detail.startsWith('__overall__'))!
    expect(overall.pass).toBe(false)
    expect(formatGate(evaluateGate(rows))).toContain('| 全局 |')
  })
})

describe('summarize — 老数据(2026-10-02)照样能汇总', () => {
  it('没有新字段的行退回 replies 的口径', () => {
    const rows = readFileSync(join(import.meta.dirname, 'results-2026-10-02.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as RunResult)
    const table = summarize(rows)
    expect(table).toContain('| baseline | b | 5 | 12.0 (12,12,12,12,12)')
  })
})
