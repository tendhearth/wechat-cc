import { describe, expect, it } from 'vitest'
import { runCodexFixtureGate, variantsFor, CODEX_SCENARIOS } from './codex-fixture'
import { evaluateGate } from './gate'

// 回复交付第 4 步(Codex)剧本臂的闸门是可复现的:不连模型,照 codex exec 事件形状演的假 Codex + 生产全链,一两秒。
// 钉住的是「为什么翻 daemon」的那几条数字 —— 谁改了协调器 / 交付 / Codex 事件翻译让它们变了,这里先红。
// 真模型那一小批(35 轮)的数字在 docs/reference/reply-once-experiment.md「第 4 步」,原始流的回放在
// src/core/conversation-coordinator.codex-delivery.test.ts。
describe('reply-once codex 剧本臂(回复交付第 4 步,不连模型)', () => {
  it('b 不适用;strict 只跑纯说话的场景', () => {
    expect(CODEX_SCENARIOS).not.toContain('b')
    expect(variantsFor('a')).toEqual(['recorded', 'drift', 'strict'])
    expect(variantsFor('h')).toEqual(['recorded', 'drift'])
  })

  it('daemon:除了 g 的相对条件(legacy 推送本来就不发),每条过关线都过;任何外部条件下 0 双发 / 0 旁白外泄 / 0 令牌外泄', async () => {
    const rows = await runCodexFixtureGate()
    const daemon = evaluateGate(rows, 'codex_daemon', 'codex_legacy')
    for (const line of daemon) {
      if (line.scenario === 'g' && !line.detail.startsWith('__overall__')) { expect(line.detail).toMatch(/静默且 0 外发:2\/2/); continue }
      expect(line.pass, line.detail).toBe(true)
    }
    const d = rows.filter(r => r.arm === 'codex_daemon')
    expect(d.reduce((a, r) => a + (r.doubleSend ?? 0), 0)).toBe(0)
    expect(d.reduce((a, r) => a + (r.narrationLeaked ?? 0), 0)).toBe(0)
    expect(d.some(r => r.tokenLeaked)).toBe(false)
    expect(d.some(r => (r.apiPaths ?? []).includes('FALLBACK_REPLY'))).toBe(false)
    // h 里那一步 shell:以前不产 tool_call,「顺便看下仓库状态。」会和结论粘成一段交付。
    expect(rows.filter(r => r.arm === 'codex_daemon' && r.scenario === 'h').every(r => (r.delivered ?? []).length === 1 && !(r.delivered ?? [])[0]!.includes('仓库状态'))).toBe(true)

    // legacy 的故障点(对照):形状照 SDK 时没坏;CLI 比 SDK 新 ⇒ 开场旁白外泄;strict ⇒ reply 被拒仍算「回过」⇒ 一个字都没收到。
    const legacy = rows.filter(r => r.arm === 'codex_legacy')
    const of = (v: string) => legacy.filter(r => (r.apiPaths ?? []).includes(`variant:${v}`))
    expect(of('recorded').filter(r => r.scenario !== 'i').reduce((a, r) => a + (r.narrationLeaked ?? 0), 0)).toBe(0)
    expect(of('drift').reduce((a, r) => a + (r.narrationLeaked ?? 0), 0)).toBeGreaterThanOrEqual(6)
    expect(of('strict').filter(r => r.scenario !== 'i').every(r => (r.delivered ?? []).length === 0)).toBe(true)
    expect(evaluateGate(rows, 'codex_legacy', 'codex_legacy').filter(l => !l.pass).map(l => l.scenario)).toEqual(expect.arrayContaining(['a', 'c', 'e', 'h', 'i']))
  })
})
