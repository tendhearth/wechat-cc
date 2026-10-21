import { describe, expect, it, vi } from 'vitest'
import { makeSpeechPolicy } from '../speech/policy'
import type { ProactiveOutbound, ProactiveTurn } from '../companion/proactive-channel'
import { announceNewSticker } from './tick-bodies'

const OWNER = 'owner@im.wechat'
function setup(o: { care?: 'off' | 'low'; quiet?: boolean; stickerOk?: boolean } = {}) {
  const sent: string[] = []
  const stickers: string[] = []
  const turn: ProactiveTurn = {
    sendText: async (_c, t) => { sent.push(t); return { msgId: 'm' } }, channel: () => 'wechat', textOnly: () => false,
    sendAttachment: async () => false, sendSticker: async (_c, tag) => { if (o.stickerOk === false) return false; stickers.push(tag); return true }, finish: () => {},
  }
  const outbound: ProactiveOutbound = { appDeliverable: () => false, canDeliver: () => true, open: () => turn, sendOnce: async () => ({ ok: true }) }
  const speech = makeSpeechPolicy({ care: () => o.care ?? 'low', quietEndsAt: () => (o.quiet ? Date.now() + 3600_000 : null), outbound, log: () => {} })
  const logs: string[] = []
  const d = { speech, stickers: { resolve: (t: string) => (t === '开心' ? '/lib/happy.png' : null) }, log: (t: string, l: string) => { logs.push(`${t}|${l}`) } }
  return { d, sent, stickers, logs }
}

describe('新贴纸那一句 —— 走 SpeechPolicy;图跟字一起走,图发不出去就什么都不说', () => {
  it('照常 ⇒ 先发表情,再一句', async () => {
    const s = setup()
    await announceNewSticker(s.d, OWNER, '开心')
    expect(s.stickers).toEqual(['开心'])
    expect(s.sent).toEqual(['我画了张新表情!以后想说「开心」的时候就用它~'])
  })
  it('别烦我 / 免打扰 ⇒ 都不发(以前这条两样都不看)', async () => {
    for (const o of [{ care: 'off' as const }, { quiet: true }]) {
      const s = setup(o)
      await announceNewSticker(s.d, OWNER, '开心')
      expect(s.stickers).toEqual([]); expect(s.sent).toEqual([])
    }
  })
  it('**表情发不出去 ⇒ 那句话也不发**,不退成光秃秃的文字', async () => {
    const s = setup({ stickerOk: false })
    await announceNewSticker(s.d, OWNER, '开心')
    expect(s.sent).toEqual([])
    expect(s.logs.some(l => l.includes('sticker undeliverable'))).toBe(true)
  })
  it('库里找不到那张图 / 门没接 ⇒ 不发,记一行', async () => {
    const s = setup()
    await announceNewSticker(s.d, OWNER, '没这张')
    expect(s.sent).toEqual([])
    const logs: string[] = []
    await announceNewSticker({ stickers: { resolve: () => '/p' }, log: (t, l) => logs.push(l) }, OWNER, '开心')
    expect(logs[0]).toContain('speech policy not wired')
  })
})
