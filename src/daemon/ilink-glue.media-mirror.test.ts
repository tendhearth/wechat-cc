/**
 * ilink-glue 的媒体镜像钩子(手机伙伴第 2 步,2026-10-18):sendFile / replyVoice **成功之后**才报;
 * `mirror:false` 不报;失败不报;钩子抛错不影响发送结果。CDN 上传换成假的(fake-ilink 没有上传),sendmessage 走真的假服务器。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('./media', async (orig) => ({
  ...(await orig<typeof import('./media')>()),
  buildMediaItemFromFile: vi.fn(async () => ({ type: 2 })),
}))
vi.mock('./ilink/voice', async (orig) => {
  const real = await orig<typeof import('./ilink/voice')>()
  return {
    ...real,
    makeVoice: () => ({
      replyVoice: async (_c: string, text: string) => (text === 'fail' ? { ok: false as const, reason: 'error' } : { ok: true as const, msgId: 'v-1' }),
      synthesizeSpeech: async () => ({ audio: Buffer.from('x'), mime: 'audio/mpeg' }),
      saveConfig: async () => ({ ok: true }), configStatus: async () => ({ configured: true }),
    }),
  }
})

import { makeIlinkAdapter, type Account } from './ilink-glue'
import { openTestDb } from '../lib/db'
import { makeConversationStore } from '../adapters/store/conversation-store'
import { startFakeIlink, type FakeIlinkHandle } from './__e2e__/fake-ilink-server'

describe('ilink-glue —— 媒体发成功才报给镜像', () => {
  let fake: FakeIlinkHandle
  beforeEach(async () => { fake = await startFakeIlink() })
  afterEach(async () => { await fake.stop() })

  function setup() {
    const db = openTestDb()
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-media-mirror-'))
    const acct: Account = { id: 'A1', botId: 'b', userId: 'ubot', baseUrl: fake.baseUrl, token: 'T', syncBuf: '' }
    const a = makeIlinkAdapter({ stateDir, accounts: [acct], db, conversationStore: makeConversationStore(db) })
    a.captureContextToken('owner', 'tok')
    const seen: Array<{ chatId: string; m: unknown }> = []
    a.onMediaSent?.((chatId, m) => seen.push({ chatId, m }))
    const file = join(stateDir, 'pic.png')
    writeFileSync(file, 'png')
    return { a, seen, file }
  }

  it('sendFile 成功 ⇒ 报 { kind: file, path };mirror:false ⇒ 不报', async () => {
    const s = setup()
    await s.a.sendFile('owner', s.file)
    expect(s.seen).toEqual([{ chatId: 'owner', m: { kind: 'file', path: s.file } }])
    await s.a.sendFile('owner', s.file, { mirror: false })
    expect(s.seen).toHaveLength(1)
  })

  it('发送失败 ⇒ 不报(镜像只记真的送出去了的)', async () => {
    const s = setup()
    fake.failSendMessage()
    await expect(s.a.sendFile('owner', s.file)).rejects.toThrow()
    await expect(s.a.sendFile('stranger', s.file)).rejects.toThrow(/unknown chat_id/)
    expect(s.seen).toEqual([])
  })

  it('钩子抛错不影响发送结果;noteSentMedia 原样转给钩子;摘掉钩子 ⇒ 不报', async () => {
    const s = setup()
    s.a.onMediaSent?.(() => { throw new Error('boom') })
    await expect(s.a.sendFile('owner', s.file)).resolves.toBeUndefined()
    const got: unknown[] = []
    s.a.onMediaSent?.((_c, m) => got.push(m))
    s.a.noteSentMedia?.('owner', { kind: 'sticker', file: 'a.png', label: '开心' })
    expect(got).toEqual([{ kind: 'sticker', file: 'a.png', label: '开心' }])
    s.a.onMediaSent?.(null)
    await s.a.sendFile('owner', s.file)
    expect(got).toHaveLength(1)
  })

  it('replyVoice 成功 ⇒ 报 { kind: voice, text }(不存音频);失败不报', async () => {
    const s = setup()
    expect((await s.a.voice.replyVoice('owner', '晚安')).ok).toBe(true)
    expect((await s.a.voice.replyVoice('owner', 'fail')).ok).toBe(false)
    expect(s.seen).toEqual([{ chatId: 'owner', m: { kind: 'voice', text: '晚安' } }])
  })
})
