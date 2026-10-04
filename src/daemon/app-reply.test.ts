import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAT_NARRATION_MAX, CHAT_TEXT_MAX } from '@wechat-cc/protocol'
import { encodeExtras, parseExtras, phoneExtrasFields, projectReplyExtras, stickerDataUri, STICKER_INLINE_MAX_BYTES, withStickerImages } from './app-reply'

describe('app-reply:回复的附件与旁白给 app 的形状', () => {
  it('按调用顺序投影;本地表情只留库里的文件名;联网表情只有 label;文件给名字 + 路径', () => {
    const x = projectReplyExtras({
      attachments: [
        { kind: 'file', path: '/Users/me/out/report.pdf' },
        { kind: 'sticker', ref: { tag: '开心' } },
        { kind: 'sticker', ref: { mood: '加油', url: 'https://media.giphy.com/x.gif' } },
        { kind: 'sticker', ref: { tag: '没了' } },
        { kind: 'voice', text: '晚安' },
      ],
      narration: [],
    }, { stickerFile: tag => (tag === '开心' ? '/state/stickers/happy.png' : null) })
    expect(x.attachments).toEqual([
      { kind: 'file', name: 'report.pdf', path: '/Users/me/out/report.pdf' },
      { kind: 'sticker', label: '开心', file: 'happy.png' },
      { kind: 'sticker', label: '加油' },
      { kind: 'sticker', label: '没了' },
      { kind: 'voice', text: '晚安' },
    ])
  })

  it('旁白:去空段、只留最后 CHAT_NARRATION_MAX 段、每段截到 CHAT_TEXT_MAX', () => {
    const many = Array.from({ length: CHAT_NARRATION_MAX + 5 }, (_, i) => `段${i}`)
    const x = projectReplyExtras({ attachments: [], narration: ['  ', ...many, 'x'.repeat(CHAT_TEXT_MAX + 10)] })
    expect(x.narration).toHaveLength(CHAT_NARRATION_MAX)
    expect(x.narration.at(-1)).toHaveLength(CHAT_TEXT_MAX)
    expect(x.narration[0]).toBe(`段${6}`)
  })

  it('落库编码:两样都空 ⇒ undefined;读回逐条核形状,坏的丢掉', () => {
    expect(encodeExtras({ attachments: [], narration: [] })).toBeUndefined()
    const enc = encodeExtras({ attachments: [{ kind: 'voice', text: 'a' }], narration: ['n'] })!
    expect(parseExtras(enc)).toEqual({ attachments: [{ kind: 'voice', text: 'a' }], narration: ['n'] })
    expect(parseExtras('not json')).toBeNull()
    expect(parseExtras(JSON.stringify({ attachments: [{ kind: 'sticker', label: 'x', file: '../../etc/passwd' }, { kind: 'file', name: 'n' }, { kind: 'zzz' }], narration: [1, 'ok'] })))
      .toEqual({ attachments: [{ kind: 'sticker', label: 'x' }], narration: ['ok'] })
  })

  it('手机线上:文件不带路径;没有 extras ⇒ 空对象(老形状)', () => {
    const enc = encodeExtras({ attachments: [{ kind: 'file', name: 'r.pdf', path: '/Users/me/r.pdf' }], narration: [] })
    expect(phoneExtrasFields(enc)).toEqual({ attachments: [{ kind: 'file', name: 'r.pdf' }] })
    expect(phoneExtrasFields(undefined)).toEqual({})
  })

  it('桌面回包的表情图:只认库目录下的纯文件名、认得的图片类型、不超过上限', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-reply-stickers-'))
    writeFileSync(join(dir, 'a.png'), Buffer.from([1, 2, 3]))
    writeFileSync(join(dir, 'big.gif'), Buffer.alloc(STICKER_INLINE_MAX_BYTES + 1))
    writeFileSync(join(dir, 'x.txt'), 'hi')
    expect(stickerDataUri(dir, 'a.png')).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`)
    expect(stickerDataUri(dir, 'big.gif')).toBeNull()
    expect(stickerDataUri(dir, 'x.txt')).toBeNull()
    expect(stickerDataUri(dir, '../a.png')).toBeNull()
    expect(stickerDataUri(dir, 'missing.png')).toBeNull()
    expect(withStickerImages([{ kind: 'sticker', label: 'l', file: 'a.png' }, { kind: 'sticker', label: 'm' }, { kind: 'voice', text: 'v' }], f => stickerDataUri(dir, f)))
      .toEqual([{ kind: 'sticker', label: 'l', file: 'a.png', image: expect.stringMatching(/^data:image\/png;base64,/) }, { kind: 'sticker', label: 'm' }, { kind: 'voice', text: 'v' }])
  })
})
