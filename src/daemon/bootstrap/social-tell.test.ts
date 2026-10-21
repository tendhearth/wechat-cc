import { describe, expect, it } from 'vitest'
import { makeSpeechPolicy } from '../speech/policy'
import type { ProactiveOutbound } from '../companion/proactive-channel'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTellOwner } from './social-tell'

const OWNER = 'owner@im.wechat'
function setup(o: { care?: 'off' | 'low'; quiet?: boolean | (() => boolean); noSpeech?: boolean; stateDir?: string } = {}) {
  const sent: string[] = [], logs: string[] = []
  const quiet = typeof o.quiet === 'function' ? o.quiet : () => !!o.quiet
  const outbound: ProactiveOutbound = { appDeliverable: () => false, canDeliver: () => true, sendOnce: async () => ({ ok: true }), open: () => ({ sendText: async () => ({ msgId: 'm' }), channel: () => 'wechat', textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }) }
  const speech = makeSpeechPolicy({ care: () => o.care ?? 'low', quietEndsAt: (_c, n) => (quiet() ? n + 3600_000 : null), outbound, log: () => {} })
  const stateDir = o.stateDir ?? mkdtempSync(join(tmpdir(), 'social-tell-'))
  const t = makeTellOwner({ stateDir, resolveOperatorChatId: () => OWNER, sendAssistantText: async (_c, t) => { sent.push(t) }, speech: () => (o.noSpeech ? null : speech), log: (_t, l) => logs.push(l) })
  return { tell: t.tell, flush: t.flush, sent, logs, stateDir }
}

describe('社交通知走 CC 开口那道门(第三批 3a)', () => {
  it('照常 ⇒ 经 sendAssistantText 发', async () => {
    const s = setup()
    await s.tell('social_story', '去老王家串门了')
    expect(s.sent).toEqual(['去老王家串门了'])
  })
  it('**别烦我 ⇒ 串门见闻不说**(以前社交这几条都不看 care 档);等主人拍板的介绍照说', async () => {
    const s = setup({ care: 'off' })
    await s.tell('social_story', '去老王家串门了')
    await s.tell('social_ask', '老王的朋友想认识你。回「同意 ab」或「不了 ab」')
    expect(s.sent).toEqual(['老王的朋友想认识你。回「同意 ab」或「不了 ab」'])
    expect(s.logs.some(l => l.includes('social_story notice dropped: care_off'))).toBe(true)
  })
  it('免打扰 ⇒ 来信 / 结果推后(内容在信箱、记录里留着),介绍照说', async () => {
    const s = setup({ quiet: true })
    await s.tell('social_mail', '老王给你写信了')
    await s.tell('social_result', '老王回了你的心愿')
    await s.tell('social_ask', '想认识你')
    expect(s.sent).toEqual(['想认识你'])
  })
  it('门还没接上 ⇒ 不发、记一行(不退回直接发)', async () => {
    const s = setup({ noSpeech: true })
    await s.tell('social_mail', 'x')
    expect(s.sent).toEqual([])
    expect(s.logs[0]).toContain('speech policy not wired yet')
  })
})

describe('**report / blocking 推后不是不送**:落盘待说,门放行时一次说完(9d 评审 #528)', () => {
  it('免打扰里来信 ⇒ 当时不说;时段一过的下一拍 ⇒ 说一次;再下一拍不重复', async () => {
    let q = true
    const s = setup({ quiet: () => q })
    await s.tell('social_mail', '老王给你写信了')
    expect(s.sent).toEqual([])
    await s.flush()
    expect(s.sent).toEqual([])   // 还在免打扰里
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
  it('CC 自己的见闻(initiative)推后 ⇒ 不排队(那一类推后就是这句不说,东西在背包里)', async () => {
    let q = true
    const s = setup({ quiet: () => q })
    await s.tell('social_story', '去老王家串门了')
    q = false
    await s.flush()
    expect(s.sent).toEqual([])
  })
})
