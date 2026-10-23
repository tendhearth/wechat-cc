import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSpeechPolicy } from '../speech/policy'
import { makePendingNotices } from '../speech/pending-notices'
import type { ProactiveOutbound } from '../companion/proactive-channel'
import { makeTellOwner, makeTellOwnerAs } from './social-tell'

const OWNER = 'owner@im.wechat'
function setup(o: { care?: 'off' | 'low'; quiet?: () => boolean; noSpeech?: boolean; stateDir?: string } = {}) {
  const sent: string[] = [], logs: string[] = []
  const quiet = o.quiet ?? (() => false)
  const stateDir = o.stateDir ?? mkdtempSync(join(tmpdir(), 'social-tell-'))
  // 补说走 say 开的那一轮(这里记进 sent);当时说走 sendAssistantText(也记进 sent)
  const outbound: ProactiveOutbound = { appDeliverable: () => false, canDeliver: () => true, sendOnce: async () => ({ ok: true }), open: () => ({ sendText: async (_c, t) => { sent.push(t); return { msgId: 'm' } }, channel: () => 'wechat', textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }) }
  const speech = makeSpeechPolicy({ care: () => o.care ?? 'low', quietEndsAt: (_c, n) => (quiet() ? n + 3600_000 : null), outbound, log: () => {}, pending: makePendingNotices({ stateDir, log: (_t, l) => logs.push(l) }) })
  const tell = makeTellOwner({ resolveOperatorChatId: () => OWNER, sendAssistantText: async (_c, t) => { sent.push(t) }, speech: () => (o.noSpeech ? null : speech), log: (_t, l) => logs.push(l) })
  return { tell, flush: () => speech.flushPending(), sent, logs, stateDir }
}

describe('社交通知走 CC 开口那道门(第三批 3a)', () => {
  it('照常 ⇒ 经 sendAssistantText 发', async () => {
    const s = setup()
    await s.tell('social_story', '去老王家串门了')
    expect(s.sent).toEqual(['去老王家串门了'])
  })
  it('**别烦我 ⇒ 串门见闻不说**;等主人拍板的介绍照说', async () => {
    const s = setup({ care: 'off' })
    await s.tell('social_story', '去老王家串门了')
    await s.tell('social_ask', '老王的朋友想认识你。回「同意 ab」或「不了 ab」')
    expect(s.sent).toEqual(['老王的朋友想认识你。回「同意 ab」或「不了 ab」'])
  })
  it('门还没接上 ⇒ 不发、记一行(不退回直接发)', async () => {
    const s = setup({ noSpeech: true })
    await s.tell('social_mail', 'x')
    expect(s.sent).toEqual([])
    expect(s.logs[0]).toContain('speech policy not wired yet')
  })
})

describe('**report / blocking 推后不是不送**:门的「待说」队列接住(整合者评审 #528)', () => {
  it('免打扰里来信 ⇒ 当时不说;时段一过的下一拍 ⇒ 说一次;再下一拍不重复', async () => {
    let q = true
    const s = setup({ quiet: () => q })
    await s.tell('social_mail', '老王给你写信了')
    expect(s.sent).toEqual([])
    await s.flush()
    expect(s.sent).toEqual([])
    q = false
    await s.flush()
    expect(s.sent).toEqual(['老王给你写信了'])
    await s.flush()
    expect(s.sent).toHaveLength(1)
  })
  it('几条一起压着 ⇒ 合成一句说', async () => {
    let q = true
    const s = setup({ quiet: () => q })
    await s.tell('social_mail', '老王给你写信了')
    await s.tell('social_result', '小李回了你的心愿')
    q = false
    await s.flush()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toContain('老王给你写信了')
    expect(s.sent[0]).toContain('小李回了你的心愿')
  })
  it('落了盘:重启以后(新的一份)照样说得出来', async () => {
    let q = true
    const a = setup({ quiet: () => q })
    await a.tell('social_result', '介绍成了')
    q = false
    const b = setup({ quiet: () => q, stateDir: a.stateDir })
    await b.flush()
    expect(b.sent).toEqual(['介绍成了'])
  })
  it('CC 自己的见闻(initiative)推后 ⇒ 不排队', async () => {
    let q = true
    const s = setup({ quiet: () => q })
    await s.tell('social_story', '去老王家串门了')
    q = false
    await s.flush()
    expect(s.sent).toEqual([])
  })
  it('超过 20 条 ⇒ 丢最老的、记日志;说的时候带一句「还有 N 件更早的」', async () => {
    let q = true
    const s = setup({ quiet: () => q })
    for (let i = 1; i <= 23; i++) await s.tell('social_mail', `第 ${i} 封信`)
    expect(s.logs.some(l => l.includes('dropped the oldest'))).toBe(true)
    q = false
    await s.flush()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toContain('第 23 封信')
    expect(s.sent[0]).not.toContain('第 3 封信\n')
    expect(s.sent[0]).toContain('还有 3 件更早的')
  })
})

describe('配对结果(pairing,requested)走同一个出口:主人说了「配对」在等这一句', () => {
  it('免打扰里、别烦我里都照说(不是 initiative,也不排队等)', async () => {
    for (const o of [{ quiet: () => true }, { care: 'off' as const }]) {
      const sent: string[] = []
      const outbound: ProactiveOutbound = { appDeliverable: () => false, canDeliver: () => true, sendOnce: async () => ({ ok: true }), open: () => ({ sendText: async () => ({ msgId: 'm' }), channel: () => 'wechat', textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }) }
      const quiet = o.quiet ?? (() => false)
      const speech = makeSpeechPolicy({ care: () => o.care ?? 'low', quietEndsAt: (_c, n) => (quiet() ? n + 3600_000 : null), outbound, log: () => {} })
      const tell = makeTellOwnerAs('pairing', { resolveOperatorChatId: () => OWNER, sendAssistantText: async (_c, t) => { sent.push(t) }, speech: () => speech, log: () => {} })
      await tell('和 老王 的 bot 连上了 ✓')
      expect(sent).toEqual(['和 老王 的 bot 连上了 ✓'])
    }
  })
})
