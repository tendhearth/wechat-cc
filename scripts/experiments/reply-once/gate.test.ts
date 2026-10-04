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

  // 2026-10-03 审稿第 3 条:三项都完整送达、没有丢的,气泡 ≤3;恰好 3 条单独记,不作为及格条件。
  const three = ['第一条:出门走走晒太阳', '第二条:约朋友吃个饭吧', '第三条:看一部老电影吧']
  it('c:三项都送达、没丢段、气泡 ≤3 才过;恰好 3 条只记不判', () => {
    expect(line(evaluateGate(times(5, () => run('c', { delivered: [three.join('\n')], segmentsLost: 0 }))), 'c').pass).toBe(true)
    expect(line(evaluateGate(times(5, () => run('c', { delivered: three, segmentsLost: 0 }))), 'c').detail).toContain('恰好 3 条 5/5')
    expect(line(evaluateGate(times(5, i => run('c', { delivered: three.slice(1), segmentsLost: i === 0 ? 1 : 0 }))), 'c').pass).toBe(false)
    expect(line(evaluateGate(times(5, () => run('c', { delivered: [...three, '还有一条补充的话在这里'] }))), 'c').pass).toBe(false)
  })

  // 2026-10-03 审稿第 2 条:先 list_projects,≤2 条气泡,列表完整(按 ④「列表 + 一句收尾」两条是正常的)。
  it('d:先 list_projects、≤2 条、列表完整,且非回复工具不多于基线', () => {
    const base = times(5, () => run('d', { nonReplyTools: ['list_projects'] }, 'baseline'))
    const ok = { nonReplyTools: ['list_projects'], delivered: ['- wechat-cc(当前)\n- blog', '要切换跟我说'] }
    expect(line(evaluateGate([...base, ...times(5, () => run('d', ok))]), 'd').pass).toBe(true)
    expect(line(evaluateGate([...base, ...times(5, () => run('d', { ...ok, delivered: ['有两个', '- wechat-cc', '- blog'] }))]), 'd').pass).toBe(false)
    expect(line(evaluateGate([...base, ...times(5, () => run('d', { ...ok, delivered: ['- wechat-cc(当前)'] }))]), 'd').pass).toBe(false)
    expect(line(evaluateGate([...base, ...times(5, () => run('d', { ...ok, nonReplyTools: ['list_projects', 'memory_read'] }))]), 'd').pass).toBe(false)
    expect(line(evaluateGate([...base, ...times(5, () => run('d', { ...ok, nonReplyTools: [] }))]), 'd').pass).toBe(false)
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

  // 2026-10-03 审稿第 4 条:≥4/5,并且明显好于基线(静默率至少高 40 个百分点)。
  it('g:≥4/5 静默且明显好于基线;令牌 0 外泄', () => {
    const base = times(5, () => run('g', { silent: false, delivered: ['在吗'] }, 'baseline'))
    const g = (n: number) => times(5, i => run('g', i < n ? { silent: true, delivered: [], attachments: [] } : { silent: false, delivered: ['在吗'] }))
    expect(line(evaluateGate([...base, ...g(4)]), 'g').pass).toBe(true)
    expect(line(evaluateGate([...base, ...g(3)]), 'g').pass).toBe(false)
    const goodBase = times(5, i => run('g', i < 3 ? { silent: true, delivered: [] } : { delivered: ['在吗'] }, 'baseline'))
    expect(line(evaluateGate([...goodBase, ...g(4)]), 'g').pass).toBe(false) // 只比基线高 20 个百分点
    expect(line(evaluateGate([...base, ...times(5, () => run('g', { silent: true, delivered: [], tokenLeaked: true }))]), 'g').pass).toBe(false)
  })

  it('h:没丢段(聊天型)/ 旁白 0 外泄(编码型),最后送达的话含结论', () => {
    expect(line(evaluateGate(times(5, () => run('h', { delivered: ['我查了一下', '先推进 wechat-cc'], segmentsLost: 0, textStrategy: 'all_segments', narrationLeaked: 1 }))), 'h').pass).toBe(true)
    expect(line(evaluateGate(times(5, () => run('h', { delivered: ['先推进 wechat-cc'], segmentsLost: 1, textStrategy: 'all_segments' }))), 'h').pass).toBe(false)
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
