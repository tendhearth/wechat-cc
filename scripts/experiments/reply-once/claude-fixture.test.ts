import { describe, expect, it } from 'vitest'
import { runClaudeFixtureGate, variantsFor, CLAUDE_SCENARIOS } from './claude-fixture'
import { evaluateGate } from './gate'

// 回复交付第 5 步(Claude)剧本臂的闸门是可复现的:不连模型,照 Agent SDK 消息形状演的假 query() + 生产全链,一两秒。
// 钉住的是「为什么翻 daemon」的那几条数字 —— 谁改了协调器 / 交付 / Claude 消息翻译让它们变了,这里先红。
// 真模型那一小批的数字在 docs/reference/reply-once-experiment.md「第 5 步」。
describe('reply-once claude 剧本臂(回复交付第 5 步,不连模型)', () => {
  it('九个场景都跑(b 是会话续接跨过开关);tool_error 只跑纯说话的场景', () => {
    expect(CLAUDE_SCENARIOS).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
    expect(variantsFor('a')).toEqual(['recorded', 'bundled', 'drift', 'tool_error'])
    expect(variantsFor('h')).toEqual(['recorded', 'bundled', 'drift'])
  })

  it('daemon:除了 g 的相对条件(legacy 推送本来就不发),每条过关线都过;任何外部条件下 0 双发 / 0 旁白外泄 / 0 令牌外泄', async () => {
    const rows = await runClaudeFixtureGate()
    const daemon = evaluateGate(rows, 'claude_daemon', 'claude_legacy')
    for (const line of daemon) {
      if (line.scenario === 'g' && !line.detail.startsWith('__overall__')) { expect(line.detail).toMatch(/静默且 0 外发:3\/3/); continue }
      expect(line.pass, line.detail).toBe(true)
    }
    const d = rows.filter(r => r.arm === 'claude_daemon')
    expect(d.reduce((a, r) => a + (r.doubleSend ?? 0), 0)).toBe(0)
    expect(d.reduce((a, r) => a + (r.narrationLeaked ?? 0), 0)).toBe(0)
    expect(d.some(r => r.tokenLeaked)).toBe(false)
    expect(d.some(r => (r.apiPaths ?? []).includes('FALLBACK_REPLY'))).toBe(false)
    // bundled(同一条消息里「开场 + tool_use」):以前先发 tool_call 再发文字,开场会和结论粘成最后一段。
    expect(d.filter(r => r.scenario === 'h').every(r => (r.delivered ?? []).length === 1 && !(r.delivered ?? [])[0]!.includes('仓库状态'))).toBe(true)

    // legacy 的故障点(对照):名字照 mcp__wechat__reply 时没坏;挂在插件名下 ⇒ 开场旁白外泄;reply 失败 ⇒ 一个字都没收到。
    const legacy = rows.filter(r => r.arm === 'claude_legacy')
    const of = (v: string) => legacy.filter(r => (r.apiPaths ?? []).includes(`variant:${v}`))
    for (const v of ['recorded', 'bundled']) expect(of(v).filter(r => r.scenario !== 'i').reduce((a, r) => a + (r.narrationLeaked ?? 0), 0)).toBe(0)
    expect(of('drift').reduce((a, r) => a + (r.narrationLeaked ?? 0), 0)).toBeGreaterThanOrEqual(3)
    expect(of('tool_error').filter(r => r.scenario !== 'i').every(r => (r.delivered ?? []).length === 0)).toBe(true)
    expect(evaluateGate(rows, 'claude_legacy', 'claude_legacy').filter(l => !l.pass).map(l => l.scenario)).toEqual(expect.arrayContaining(['a', 'c', 'e', 'h', 'i']))
  })
})
