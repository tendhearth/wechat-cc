import { describe, it, expect } from 'vitest'
import { PHONE_CHAT_MAX_IMAGES } from '@wechat-cc/protocol'
import { clearDrafts, dropDraftImages, peekDraftImages, putDraftImages, setPairingScope } from '../state/drafts'
import type { PickedImage } from '../state/image-upload'
import { clearShare, getShare, putShare, subscribeShare } from '../state/share-inbox'
import { isShareExtensionUrl, mergeDraftText, normalizeShare, shareGate, shareRoute, withTitle } from './share'

const MAX = PHONE_CHAT_MAX_IMAGES
const iosFile = (n: number, mime = 'image/jpeg', extra: Record<string, unknown> = {}) =>
  ({ path: `file:///private/var/mobile/Containers/Shared/AppGroup/X/${n}.jpg`, fileName: `IMG_${n}.HEIC`, fileSize: 1000 + n, mimeType: mime, type: '0', ...extra })
const androidFile = (n: number, mime = 'image/jpeg') =>
  ({ contentUri: `content://media/external/images/media/${n}`, filePath: `/storage/emulated/0/DCIM/${n}.jpg`, fileName: `${n}.jpg`, fileSize: String(2000 + n), mimeType: mime })

describe('normalizeShare —— 系统交来的原始内容 ⇒ {正文, 图, 不收的}', () => {
  it('iOS 文字(JSON 字符串)', () => {
    expect(normalizeShare(JSON.stringify({ text: '记得买牛奶', type: 'text' }), MAX)).toEqual({ text: '记得买牛奶', images: [], overMax: false, unsupported: 0, tooLarge: 0 })
  })
  it('iOS Safari 网页:标题 + 网址(meta 是 JSON 字符串);没标题就只有网址', () => {
    const raw = JSON.stringify({ weburls: [{ url: 'https://example.com/a', meta: JSON.stringify({ title: '一篇文章', 'og:image': 'x' }) }], type: 'weburl' })
    expect(normalizeShare(raw, MAX).text).toBe('一篇文章\nhttps://example.com/a')
    expect(normalizeShare(JSON.stringify({ weburls: [{ url: 'https://example.com/a', meta: '{}' }], type: 'weburl' }), MAX).text).toBe('https://example.com/a')
    expect(normalizeShare(JSON.stringify({ weburls: [{ url: 'https://example.com/a', meta: 'not json' }], type: 'weburl' }), MAX).text).toBe('https://example.com/a')
  })
  it('安卓文字(对象):EXTRA_TITLE 有就放在链接前面;标题已在正文里不重复', () => {
    expect(normalizeShare({ text: 'https://example.com/b', type: 'text', meta: { title: 'B 页' } }, MAX).text).toBe('B 页\nhttps://example.com/b')
    expect(normalizeShare({ text: 'B 页 https://example.com/b', type: 'text', meta: { title: 'B 页' } }, MAX).text).toBe('B 页 https://example.com/b')
    expect(normalizeShare({ text: '  只是一句  ', type: 'text', meta: { title: null } }, MAX).text).toBe('只是一句')
  })
  it('iOS 图片:App Group 里的 file://,除 GIF 外都重编 JPEG(HEIC 也转)', () => {
    const d = normalizeShare(JSON.stringify({ files: [iosFile(1, 'image/heic'), iosFile(2, 'image/png'), iosFile(3, 'image/gif')], type: 'media' }), MAX)
    expect(d.images).toEqual([
      { uri: 'file:///private/var/mobile/Containers/Shared/AppGroup/X/1.jpg', name: 'IMG_1.HEIC', mime: 'image/heic', size: 1001, encode: 'jpeg' },
      { uri: 'file:///private/var/mobile/Containers/Shared/AppGroup/X/2.jpg', name: 'IMG_2.HEIC', mime: 'image/png', size: 1002, encode: 'jpeg' },
      { uri: 'file:///private/var/mobile/Containers/Shared/AppGroup/X/3.jpg', name: 'IMG_3.HEIC', mime: 'image/gif', size: 1003, encode: 'raw' },
    ])
    expect(d.text).toBe('')
  })
  it('安卓图片:用随分享授权的 content://,不用 filePath(安卓 13 起没媒体权限读不了);fileSize 是字符串', () => {
    const d = normalizeShare({ files: [androidFile(7)], type: 'file' }, MAX)
    expect(d.images).toEqual([{ uri: 'content://media/external/images/media/7', name: '7.jpg', mime: 'image/jpeg', size: 2007, encode: 'jpeg' }])
  })
  it('安卓单张 SEND 的 files 里夹着的 "type"→"file" Pair、空项、没 uri 的都丢掉', () => {
    const d = normalizeShare({ files: [androidFile(1), { first: 'type', second: 'file' }, ['type', 'file'], null, { mimeType: 'image/png' }], type: 'file' }, MAX)
    expect(d.images.map(i => i.uri)).toEqual(['content://media/external/images/media/1'])
    expect(d.unsupported).toBe(0)
  })
  it('只有 filePath 的 ⇒ 补成 file://', () => {
    expect(normalizeShare({ files: [{ filePath: '/sdcard/a.png', mimeType: 'image/png' }] }, MAX).images[0]!.uri).toBe('file:///sdcard/a.png')
  })
  it(`超过 ${MAX} 张:前 ${MAX} 张留下,overMax`, () => {
    const d = normalizeShare({ files: [1, 2, 3, 4, 5, 6].map(n => androidFile(n)) }, MAX)
    expect(d.images).toHaveLength(MAX)
    expect(d.overMax).toBe(true)
    expect(normalizeShare({ files: [1, 2, 3, 4].map(n => androidFile(n)) }, 4).overMax).toBe(false)
  })
  it('视频 / PDF / 没有 mime 的:这一版不收,数一下(页面说「只收文字、链接和图片」)', () => {
    const d = normalizeShare(JSON.stringify({ files: [iosFile(1, 'video/quicktime'), iosFile(2, 'application/pdf'), iosFile(3, ''), iosFile(4)], type: 'file' }), MAX)
    expect(d.unsupported).toBe(3)
    expect(d.images.map(i => i.size)).toEqual([1004])
  })
  it('GIF 原样就超过 5MB:读都不读,记 tooLarge;要重编的不按原大小拦(重编后通常就小了)', () => {
    const big = 6 * 1024 * 1024
    const d = normalizeShare({ files: [{ ...androidFile(1, 'image/gif'), fileSize: String(big) }, { ...androidFile(2), fileSize: String(big) }] }, MAX)
    expect(d.tooLarge).toBe(1)
    expect(d.images.map(i => i.encode)).toEqual(['jpeg'])
  })
  it('认不出的:空、坏 JSON、数组、数字 ⇒ 空的一份', () => {
    const empty = { text: '', images: [], overMax: false, unsupported: 0, tooLarge: 0 }
    for (const raw of [null, undefined, '', '{', '[]', 42, [], { files: 'x', text: 3 }]) expect(normalizeShare(raw, MAX)).toEqual(empty)
  })
})

describe('去处、配对门、草稿合并', () => {
  it('跟 CC 说 ⇒ 对话页 / chat 草稿;交给 CC 做一件事 ⇒ 新交办 / new 草稿', () => {
    expect(shareRoute('chat')).toEqual({ href: '/chat', draftKey: 'chat' })
    expect(shareRoute('matter')).toEqual({ href: '/compose', draftKey: 'new' })
  })
  it('没配对也没选先看看 ⇒ 先配对;配了 / 演示 ⇒ 直接选', () => {
    expect(shareGate({ seenWelcome: false })).toBe('needsPair')
    expect(shareGate({ seenWelcome: true })).toBe('ready')
  })
  it('并进已有草稿:空稿直接放;原来写了的留着另起一行;同一段已在里面不重复', () => {
    expect(mergeDraftText('', '  链接  ')).toBe('链接')
    expect(mergeDraftText('我想问   \n', '链接')).toBe('我想问\n链接')
    expect(mergeDraftText('我想问\n链接', '链接')).toBe('我想问\n链接')
    expect(mergeDraftText('留着', '   ')).toBe('留着')
  })
  it('withTitle:没有标题 / 标题为空白 ⇒ 原文', () => {
    expect(withTitle('https://a.b', null)).toBe('https://a.b')
    expect(withTitle('https://a.b', '  ')).toBe('https://a.b')
    expect(withTitle('', '只有标题')).toBe('只有标题')
  })
  it('认得分享扩展开的链接,别的不认', () => {
    expect(isShareExtensionUrl('tendhearth://dataUrl=tendhearthShareKey?nonce=1#media')).toBe(true)
    expect(isShareExtensionUrl('tendhearth://push-open?taskId=a')).toBe(false)
    expect(isShareExtensionUrl('https://example.com/dataUrl=x')).toBe(false)
    expect(isShareExtensionUrl(null)).toBe(false)
  })
})

describe('share-inbox 与草稿旁的图', () => {
  const img = (id: string): PickedImage => ({ id, name: `${id}.jpg`, mime: 'image/jpeg', size: 3, sha256: 'x', bytes: new Uint8Array([1, 2, 3]), uri: `file:///${id}` })
  it('新的分享顶掉旧的(seq 递增);清了就没了;订阅者收到每次变化', () => {
    let n = 0
    const off = subscribeShare(() => { n++ })
    const a = putShare(normalizeShare({ text: 'a' }, MAX))
    const b = putShare(normalizeShare({ text: 'b' }, MAX))
    expect(b.seq).toBeGreaterThan(a.seq)
    expect(getShare()?.draft.text).toBe('b')
    clearShare(); clearShare()
    expect(getShare()).toBeNull()
    off()
    putShare(normalizeShare({ text: 'c' }, MAX))
    expect(n).toBe(3)
    clearShare()
  })
  it('分享的图放在草稿旁:peek 不取走、drop 才清;空数组 = 清', () => {
    putDraftImages('chat', [img('a')])
    expect(peekDraftImages('chat').map(i => i.id)).toEqual(['a'])
    expect(peekDraftImages('chat').map(i => i.id)).toEqual(['a'])
    dropDraftImages('chat')
    expect(peekDraftImages('chat')).toEqual([])
    putDraftImages('new', [img('b')]); putDraftImages('new', [])
    expect(peekDraftImages('new')).toEqual([])
  })
  it('换配对 / clearDrafts ⇒ 草稿旁的图一起清(不带到另一台电脑);还没选去处的分享不跟着清(配好回来接着选)', () => {
    setPairingScope('none')
    putShare(normalizeShare({ text: '留着' }, MAX))
    putDraftImages('chat', [img('a')])
    setPairingScope('live:d1:p1')
    expect(peekDraftImages('chat')).toEqual([])
    expect(getShare()?.draft.text).toBe('留着')
    putDraftImages('new', [img('b')])
    clearDrafts()
    expect(peekDraftImages('new')).toEqual([])
    clearShare()
  })
})
