import { describe, it, expect, vi } from 'vitest'
import { PushPlaintext } from '@wechat-cc/protocol'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { phoneExtrasFields } from '../app-reply'
import { companionPushPayload, COMPANION_PUSH_BODY_MAX, makeAppChannel, type AppChannelDeps } from './app-channel'

function setup(o: { owner?: string | null; pushDevices?: string[]; online?: string[]; relay?: boolean; push?: AppChannelDeps['push'] } = {}) {
  const db = openTestDb()
  const store = makeMessagesStore(db)
  const touched = vi.fn()
  const push = vi.fn(o.push ?? (() => ({ sent: 1, online: 0 })))
  const logs: string[] = []
  const ch = makeAppChannel({
    ownerChatId: () => (o.owner === undefined ? 'owner_chat' : o.owner),
    pushDevices: () => o.pushDevices ?? ['d1'],
    onlineDevices: () => new Set(o.online ?? []),
    relayOnline: () => o.relay ?? true,
    append: (r) => store.append(r),
    touched,
    push,
    now: () => Date.parse('2026-10-18T09:00:00.000Z'),
    log: (t, l) => logs.push(`${t}|${l}`),
  })
  return { ch, store, touched, push, logs, db }
}

describe('makeAppChannel —— 送得到吗', () => {
  it('只认主人那条对话;要有登记推送的设备或正连着的设备', () => {
    expect(setup().ch.deliverable('owner_chat')).toBe(true)
    expect(setup().ch.deliverable('friend')).toBe(false)
    expect(setup({ owner: null }).ch.deliverable('owner_chat')).toBe(false)
    expect(setup({ pushDevices: [] }).ch.deliverable('owner_chat')).toBe(false)
    expect(setup({ pushDevices: [], online: ['d2'] }).ch.deliverable('owner_chat')).toBe(true)
  })

  it('中继断着:只有登记推送的设备 ⇒ 推不出去,不算送得到;有设备正连着 ⇒ 照样送得到', () => {
    expect(setup({ relay: false }).ch.deliverable('owner_chat')).toBe(false)
    expect(setup({ relay: false, online: ['d1'] }).ch.deliverable('owner_chat')).toBe(true)
  })
})

describe('makeAppChannel —— 记进主人对话(App 对话页读的同一张表)', () => {
  it('一行 CC 的话:direction=out、kind=text、source=phone;捅一下主题', async () => {
    const s = setup()
    expect(await s.ch.record('owner_chat', '前两天那个面试怎么样了?')).toBe(true)
    const rows = await s.store.listRange('owner_chat', { limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ chatId: 'owner_chat', direction: 'out', kind: 'text', text: '前两天那个面试怎么样了?', source: 'phone', ts: '2026-10-18T09:00:00.000Z' })
    expect(rows[0]!.id).toMatch(/^app:companion:/)
    expect(s.touched).toHaveBeenCalledOnce()
    // 同一毫秒两条也不撞 id
    expect(await s.ch.record('owner_chat', '第二条')).toBe(true)
    expect(await s.store.listRange('owner_chat', { limit: 10 })).toHaveLength(2)
    // 主人对话的入站时间不受影响(CC 说的话不算主人说话)
    expect(await s.store.latestInboundTs('owner_chat')).toBeNull()
  })
  it('写库失败 ⇒ false,不捅主题', async () => {
    const s = setup()
    s.db.close()
    expect(await s.ch.record('owner_chat', 'x')).toBe(false)
    expect(s.touched).not.toHaveBeenCalled()
  })
})

describe('companion 推送', () => {
  it('载荷过协议包的 PushPlaintext;kind=companion、没有 taskId', () => {
    const p = companionPushPayload('在吗')
    expect(p).toEqual({ kind: 'companion', title: 'CC', body: '在吗' })
    expect(PushPlaintext.safeParse({ ts: 1, ...p }).success).toBe(true)
  })
  it('正文按码点截到上限,超出加「…」', () => {
    const long = '好'.repeat(COMPANION_PUSH_BODY_MAX + 20)
    const body = companionPushPayload(long).body
    expect([...body]).toHaveLength(COMPANION_PUSH_BODY_MAX)
    expect(body.endsWith('…')).toBe(true)
    expect(companionPushPayload('好'.repeat(COMPANION_PUSH_BODY_MAX)).body).toBe('好'.repeat(COMPANION_PUSH_BODY_MAX))
  })
  it('push 交给 fanout;正文不进日志', () => {
    const s = setup()
    s.ch.push('秘密内容')
    expect(s.push).toHaveBeenCalledWith({ kind: 'companion', title: 'CC', body: '秘密内容' })
    expect(s.logs.join('\n')).not.toContain('秘密内容')
    expect(s.logs.some(l => l.includes('sent to 1'))).toBe(true)
  })
})

// 手机伙伴第 2 步(2026-10-18):附件记成一行(extras 同 App 轮的回复行),推送替它说几个字。
describe('makeAppChannel —— 附件', () => {
  it('recordAttachment:表情按标签解析成库里的文件名;语音保留成语音;文件只给名字上线', async () => {
    const s = setup()
    const db2 = openTestDb()
    const store = makeMessagesStore(db2)
    const ch = makeAppChannel({
      ownerChatId: () => 'owner_chat', pushDevices: () => ['d1'], onlineDevices: () => new Set(), relayOnline: () => true,
      append: r => store.append(r), touched: s.touched, push: s.push,
      stickerFile: tag => (tag === '开心' ? '/state/stickers/bear.png' : null),
      now: (() => { let t = Date.parse('2026-10-18T09:00:00.000Z'); return () => t++ })(), log: () => {},
    })
    expect(await ch.recordAttachment!('owner_chat', { kind: 'sticker', ref: { tag: '开心' } })).toBe('[表情:开心]')
    expect(await ch.recordAttachment!('owner_chat', { kind: 'voice', text: '晚安' })).toBe('晚安')
    expect(await ch.recordAttachment!('owner_chat', { kind: 'file', path: '/Users/me/周报.pdf' })).toBe('[周报.pdf]')
    const rows = await store.listRange('owner_chat', { limit: 10 })
    expect(rows.map(r => [r.kind, r.text, r.source])).toEqual([['sticker', '', 'phone'], ['voice', '', 'phone'], ['file', '', 'phone']])
    expect(rows.map(r => phoneExtrasFields(r.extras).attachments)).toEqual([
      [{ kind: 'sticker', label: '开心', file: 'bear.png' }], [{ kind: 'voice', text: '晚安' }], [{ kind: 'file', name: '周报.pdf' }],
    ])
    expect(JSON.stringify(rows.map(r => phoneExtrasFields(r.extras)))).not.toContain('/Users/me')
  })
  it('record 带附件 ⇒ 同一行(信的几页);写库失败 ⇒ null', async () => {
    const s = setup()
    expect(await s.ch.record('owner_chat', '', [{ kind: 'file', name: 'page-1.png', path: '/s/l/page-1.png' }, { kind: 'file', name: 'page-2.png', path: '/s/l/page-2.png' }])).toBe(true)
    const rows = await s.store.listRange('owner_chat', { limit: 10 })
    expect(rows).toHaveLength(1)
    expect(phoneExtrasFields(rows[0]!.extras)).toEqual({ attachments: [{ kind: 'file', name: 'page-1.png' }, { kind: 'file', name: 'page-2.png' }] })
    s.db.close()
    expect(await s.ch.recordAttachment!('owner_chat', { kind: 'voice', text: 'x' })).toBeNull()
  })
})
