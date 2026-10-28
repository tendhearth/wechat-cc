import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { ChatMessage } from '@wechat-cc/protocol'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { parseExtras, phoneExtrasFields } from '../app-reply'
import { makeMediaMirror, mirrorAttachment, type MediaMirrorDeps } from './media-mirror'

const STATE = '/state'
const STICKERS = join(STATE, 'stickers')
const opts = {
  stickerDir: STICKERS,
  stickerLabel: (f: string) => (f === 'bear.png' ? '开心' : null),
  scratchRoots: ['/tmp', join(STATE, 'tts-tmp')],
}

describe('mirrorAttachment —— 送出去的东西在 App 里长什么样', () => {
  it('表情库里的图 ⇒ sticker(只留文件名,标签取库里的;库里没标签 ⇒ 文件名)', () => {
    expect(mirrorAttachment({ kind: 'file', path: join(STICKERS, 'bear.png') }, opts)).toEqual({ kind: 'sticker', label: '开心', file: 'bear.png' })
    expect(mirrorAttachment({ kind: 'file', path: join(STICKERS, 'cat.gif') }, opts)).toEqual({ kind: 'sticker', label: 'cat', file: 'cat.gif' })
  })
  it('别的文件 ⇒ file { name, path }(图片、信纸、PDF 都是;路径只留在 daemon)', () => {
    expect(mirrorAttachment({ kind: 'file', path: join(STATE, 'letters', 'x', 'page-1.png') }, opts)).toEqual({ kind: 'file', name: 'page-1.png', path: join(STATE, 'letters', 'x', 'page-1.png') })
    expect(mirrorAttachment({ kind: 'file', path: '/Users/me/r.pdf' }, opts)).toEqual({ kind: 'file', name: 'r.pdf', path: '/Users/me/r.pdf' })
    // 表情库的子目录不是表情库
    expect(mirrorAttachment({ kind: 'file', path: join(STICKERS, 'sub', 'a.png') }, opts)).toMatchObject({ kind: 'file' })
  })
  it('发完就删的临时文件、相对路径 ⇒ 不记', () => {
    expect(mirrorAttachment({ kind: 'file', path: '/tmp/online-sticker-x/1.gif' }, opts)).toBeNull()
    expect(mirrorAttachment({ kind: 'file', path: join(STATE, 'tts-tmp', 'reply.mp3') }, opts)).toBeNull()
    expect(mirrorAttachment({ kind: 'file', path: 'rel/a.png' }, opts)).toBeNull()
  })
  it('语音 ⇒ voice { text }(不存音频);联网表情按库里的文件名;文件名带路径的表情不认', () => {
    expect(mirrorAttachment({ kind: 'voice', text: '晚安' }, opts)).toEqual({ kind: 'voice', text: '晚安' })
    expect(mirrorAttachment({ kind: 'voice', text: '  ' }, opts)).toBeNull()
    expect(mirrorAttachment({ kind: 'sticker', file: 'g.gif', label: '困' }, opts)).toEqual({ kind: 'sticker', label: '困', file: 'g.gif' })
    expect(mirrorAttachment({ kind: 'sticker', file: '../g.gif', label: '困' }, opts)).toBeNull()
  })
})

function setup(o: { owner?: string | null; append?: MediaMirrorDeps['append'] } = {}) {
  const db = openTestDb()
  const store = makeMessagesStore(db)
  const touched = vi.fn()
  const logs: string[] = []
  const m = makeMediaMirror({
    ...opts,
    ownerChatId: () => (o.owner === undefined ? 'owner' : o.owner),
    append: o.append ?? (r => store.append(r)),
    touched,
    now: () => Date.parse('2026-10-18T09:00:00.000Z'),
    log: (t, l) => logs.push(`${t}|${l}`),
  })
  return { m, store, touched, logs }
}
const settle = () => new Promise(r => setTimeout(r, 0))

describe('makeMediaMirror —— 只记主人那条', () => {
  it('主人那条:一行 CC(direction=out、text 空、source=live),附件在 extras,手机线上形状过协议包', async () => {
    const s = setup()
    s.m.noteSent('owner', { kind: 'file', path: join(STICKERS, 'bear.png') })
    await settle()
    const rows = await s.store.listRange('owner', { limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ direction: 'out', kind: 'sticker', text: '', source: 'live', ts: '2026-10-18T09:00:00.000Z' })
    expect(parseExtras(rows[0]!.extras)).toEqual({ attachments: [{ kind: 'sticker', label: '开心', file: 'bear.png' }], narration: [] })
    // App 对话页拉到的那一行:与 App 轮的回复行同一个形状
    const wire = ChatMessage.parse({ id: rows[0]!.id, role: 'cc', kind: rows[0]!.kind, text: '', truncated: false, at: 1, source: 'wechat', ...phoneExtrasFields(rows[0]!.extras) })
    expect(wire.attachments).toEqual([{ kind: 'sticker', label: '开心', file: 'bear.png' }])
    expect(s.touched).toHaveBeenCalledOnce()
    expect(await s.store.latestInboundTs('owner')).toBeNull()
  })
  it('一次报几样(一封信的几页)⇒ 一行;文件路径不出 daemon', async () => {
    const s = setup()
    s.m.noteSent('owner', [{ kind: 'file', path: '/s/letters/a/page-1.png' }, { kind: 'file', path: '/s/letters/a/page-2.png' }])
    await settle()
    const rows = await s.store.listRange('owner', { limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('file')
    expect(phoneExtrasFields(rows[0]!.extras)).toEqual({ attachments: [{ kind: 'file', name: 'page-1.png' }, { kind: 'file', name: 'page-2.png' }] })
  })
  it('别人的 chat / 没有主人对话 / 全是临时文件 ⇒ 不记', async () => {
    const s = setup()
    s.m.noteSent('friend', { kind: 'voice', text: '你好' })
    s.m.noteSent('owner', { kind: 'file', path: '/tmp/x/1.gif' })
    const n = setup({ owner: null })
    n.m.noteSent('owner', { kind: 'voice', text: '你好' })
    await settle()
    expect(await s.store.listChatIds()).toEqual([])
    expect(await n.store.listChatIds()).toEqual([])
    expect(s.touched).not.toHaveBeenCalled()
  })
  it('写库失败只记日志,不捅主题、不抛', async () => {
    const s = setup({ append: async () => { throw new Error('disk') } })
    expect(() => s.m.noteSent('owner', { kind: 'voice', text: 'x' })).not.toThrow()
    await settle()
    expect(s.logs.some(l => l.includes('media mirror record failed: disk'))).toBe(true)
    expect(s.touched).not.toHaveBeenCalled()
  })
  it('同一毫秒两样不撞 id', async () => {
    const s = setup()
    s.m.noteSent('owner', { kind: 'voice', text: 'a' })
    s.m.noteSent('owner', { kind: 'voice', text: 'b' })
    await settle()
    expect(await s.store.listRange('owner', { limit: 10 })).toHaveLength(2)
  })
})
