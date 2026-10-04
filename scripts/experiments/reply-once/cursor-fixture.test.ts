import { describe, expect, it } from 'vitest'
import { runCursorGate, variantsFor, CURSOR_SCENARIOS } from './cursor-fixture'
import { evaluateGate } from './gate'

// 回复交付第 3 步(Cursor)的闸门本身就是可复现的:不连模型,假 cursor-agent acp + 生产全链,几秒钟。
// 钉住的是「为什么翻 daemon」的那几条数字 —— 谁改了协调器 / 交付 / ACP 翻译器让它们变了,这里先红。
// ACP 客户端在 win32 第一行就拒绝(进程树清理未验证),与 acp-agent-provider.test.ts 同样不在 Windows 上跑。
describe.skipIf(process.platform === 'win32')('reply-once cursor 臂(回复交付第 3 步,不连模型)', () => {
  it('b 不适用;strict 只跑纯说话的场景', () => {
    expect(CURSOR_SCENARIOS).not.toContain('b')
    expect(variantsFor('a')).toEqual(['recorded', 'drift', 'strict'])
    expect(variantsFor('d')).toEqual(['recorded', 'drift'])
  })

  it('daemon:除了 g 的相对条件(legacy 推送本来就不发),每条过关线都过;任何外部条件下 0 双发 / 0 旁白外泄 / 0 令牌外泄', async () => {
    const rows = await runCursorGate()
    const daemon = evaluateGate(rows, 'cursor_daemon', 'cursor_legacy')
    for (const line of daemon) {
      if (line.scenario === 'g' && !line.detail.startsWith('__overall__')) { expect(line.detail).toMatch(/静默且 0 外发:2\/2/); continue }
      expect(line.pass, line.detail).toBe(true)
    }
    const d = rows.filter(r => r.arm === 'cursor_daemon')
    expect(d.reduce((a, r) => a + (r.doubleSend ?? 0), 0)).toBe(0)
    expect(d.reduce((a, r) => a + (r.narrationLeaked ?? 0), 0)).toBe(0)
    expect(d.some(r => r.tokenLeaked)).toBe(false)
    expect(d.some(r => (r.apiPaths ?? []).includes('FALLBACK_REPLY'))).toBe(false)

    // legacy 的故障点(对照):身份照真机时没坏;CLI 不带身份 ⇒ 双发 + 旁白外泄;strict ⇒ reply 被拒仍算「回过」⇒ 一个字都没收到。
    const legacy = rows.filter(r => r.arm === 'cursor_legacy')
    const of = (v: string) => legacy.filter(r => (r.apiPaths ?? []).includes(`variant:${v}`))
    expect(of('recorded').filter(r => r.scenario !== 'i').reduce((a, r) => a + (r.doubleSend ?? 0), 0)).toBe(0)
    expect(of('drift').reduce((a, r) => a + (r.doubleSend ?? 0), 0)).toBeGreaterThanOrEqual(4)
    expect(of('drift').reduce((a, r) => a + (r.narrationLeaked ?? 0), 0)).toBeGreaterThan(0)
    expect(of('strict').filter(r => r.scenario !== 'i').every(r => (r.delivered ?? []).length === 0)).toBe(true)
    expect(evaluateGate(rows, 'cursor_legacy', 'cursor_legacy').filter(l => !l.pass).map(l => l.scenario)).toEqual(expect.arrayContaining(['a', 'c', 'd', 'e', 'h', 'i']))
  })
})
