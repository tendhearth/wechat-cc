import { describe, expect, it, vi } from 'vitest'
import { makeSpeechPolicy } from '../../daemon/speech/policy'
import type { ProactiveOutbound, ProactiveTurn } from '../../daemon/companion/proactive-channel'
import { announceNewSticker } from './artist-step'
import { makePendingNotices } from '../../daemon/speech/pending-notices'
import { openTestDb } from '../../lib/db'

const OWNER = 'owner@im.wechat'
function setup(o: { care?: 'off' | 'low'; quiet?: boolean | (() => boolean); stickerOk?: boolean; now?: () => number } = {}) {
  const sent: string[] = []
  const stickers: string[] = []
  const turn: ProactiveTurn = {
    sendText: async (_c, t) => { sent.push(t); return { msgId: 'm' } }, channel: () => 'wechat', textOnly: () => false,
    sendAttachment: async () => false, sendSticker: async (_c, tag) => { if (o.stickerOk === false) return false; stickers.push(tag); return true }, finish: () => {},
  }
  const outbound: ProactiveOutbound = { appDeliverable: () => false, canDeliver: () => true, open: () => turn, sendOnce: async () => ({ ok: true }) }
  const quiet = () => (typeof o.quiet === 'function' ? o.quiet() : !!o.quiet)
  const db = openTestDb()
  const ledger: Array<{ kind: string; outcome: string; reason: string | null }> = []
  const speech = makeSpeechPolicy({ care: () => o.care ?? 'low', quietEndsAt: (_c, n) => (quiet() ? n + 3600_000 : null), outbound, log: () => {}, ledger: e => { ledger.push(e) }, pending: makePendingNotices({ db, log: () => {}, ...(o.now ? { now: o.now } : {}) }), ...(o.now ? { now: o.now } : {}) })
  const logs: string[] = []
  const d = { speech, stickers: { resolve: (t: string) => (t === '开心' ? '/lib/happy.png' : null) }, log: (t: string, l: string) => { logs.push(`${t}|${l}`) } }
  return { d, sent, stickers, logs, speech, db, ledger }
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

describe('新贴纸那一句推后也补(S2c,主人 11-04:6 小时过期)', () => {
  it('免打扰里画好 ⇒ 先不说,进待说队列;过了免打扰 ⇒ 表情和那一句一起补上,只一次', async () => {
    let q = true
    const s = setup({ quiet: () => q })
    expect(await announceNewSticker(s.d, OWNER, '开心')).toBe('deferred')
    expect(s.stickers).toEqual([])
    q = false
    await s.speech.flushPending()
    await s.speech.flushPending()
    expect(s.stickers).toEqual(['开心'])
    expect(s.sent).toEqual(['我画了张新表情!以后想说「开心」的时候就用它~'])
  })
  it('6 小时还没说出去 ⇒ 不说了,记一行「过期作废」', async () => {
    let t = Date.parse('2026-11-04T14:00:00.000Z'), q = true
    const s = setup({ quiet: () => q, now: () => t })
    await announceNewSticker(s.d, OWNER, '开心')
    t += 6 * 3600_000
    q = false
    await s.speech.flushPending()
    expect(s.stickers).toEqual([]); expect(s.sent).toEqual([])
    expect(s.ledger.at(-1)).toMatchObject({ kind: 'sticker', outcome: 'dropped', reason: 'expired' })
  })
  it('补的时候表情发不出去 ⇒ 那句话也不发,这一样作罢(不退成文字、不再撞)', async () => {
    let q = true
    const s = setup({ quiet: () => q, stickerOk: false })
    await announceNewSticker(s.d, OWNER, '开心')
    q = false
    await s.speech.flushPending()
    expect(s.sent).toEqual([])
    expect(s.db.query('SELECT COUNT(*) AS n FROM speech_pending').get()).toEqual({ n: 0 })
  })
  it('别烦我 ⇒ 当时就不说,也不补', async () => {
    const s = setup({ care: 'off' })
    expect(await announceNewSticker(s.d, OWNER, '开心')).toBe('dropped')
    expect(s.db.query('SELECT COUNT(*) AS n FROM speech_pending').get()).toEqual({ n: 0 })
  })
})
