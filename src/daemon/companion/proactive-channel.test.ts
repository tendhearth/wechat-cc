import { describe, it, expect, vi } from 'vitest'
import { chooseChannel, makeProactiveOutbound, type AppChannel, type ProactiveChannelDeps } from './proactive-channel'
import { openTestDb } from '../../lib/db'
import { makeRemindersStore } from '../reminders/store'
import { runReminderSweep } from '../reminders/sweeper'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeAppChannel } from './app-channel'

const OWNER = 'owner_chat'

function setup(o: { degraded?: boolean; closed?: boolean; wechatError?: string; app?: 'deliverable' | 'not_deliverable' | 'none'; recordOk?: boolean }) {
  const logs: string[] = []
  const sendWechat = vi.fn(async (_c: string, _t: string) => (o.wechatError ? { msgId: 'err:1', error: o.wechatError } : { msgId: 'sent:1' }))
  const app: AppChannel = {
    deliverable: vi.fn((c: string) => o.app === 'deliverable' && c === OWNER),
    record: vi.fn(async () => o.recordOk ?? true),
    push: vi.fn(),
  }
  const deps: ProactiveChannelDeps = {
    wechatDegraded: () => !!o.degraded,
    wechatClosedSince: () => (o.closed ? '2026-10-18T00:00:00.000Z' : null),
    sendWechat,
    app: () => (o.app === 'none' ? null : app),
    log: (t, l) => { logs.push(`${t}|${l}`) },
  }
  return { out: makeProactiveOutbound(deps), sendWechat, app, logs }
}

describe('chooseChannel —— 微信能用就微信;否则 App 送得到就 App;都不行 ⇒ null', () => {
  it('四种组合', () => {
    expect(chooseChannel({ wechatUsable: true, appDeliverable: true })).toBe('wechat')
    expect(chooseChannel({ wechatUsable: true, appDeliverable: false })).toBe('wechat')
    expect(chooseChannel({ wechatUsable: false, appDeliverable: true })).toBe('app')
    expect(chooseChannel({ wechatUsable: false, appDeliverable: false })).toBeNull()
  })
})

describe('一轮的出口(open)—— 选路矩阵', () => {
  it('微信能用、发成功 ⇒ 只走微信,App 不记不推(App 对话页本来就看得见 ilink 记的那一行)', async () => {
    const s = setup({ app: 'deliverable' })
    const t = s.out.open(OWNER)
    expect(await t.sendText(OWNER, '在忙吗')).toEqual({ msgId: 'sent:1' })
    t.finish()
    expect(t.channel()).toBe('wechat')
    expect(s.app.record).not.toHaveBeenCalled()
    expect(s.app.push).not.toHaveBeenCalled()
  })

  it('推送窗口已知关闭 + App 送得到 ⇒ 不碰微信,记进对话 + 整轮一条推送', async () => {
    const s = setup({ closed: true, app: 'deliverable' })
    const t = s.out.open(OWNER)
    expect((await t.sendText(OWNER, '第一条')).error).toBeUndefined()
    expect((await t.sendText(OWNER, '第二条')).error).toBeUndefined()
    t.finish()
    expect(s.sendWechat).not.toHaveBeenCalled()
    expect(s.app.record).toHaveBeenCalledTimes(2)
    expect(s.app.push).toHaveBeenCalledOnce()
    expect(s.app.push).toHaveBeenCalledWith('第一条\n\n第二条')
    expect(t.channel()).toBe('app')
    expect(t.textOnly()).toBe(true)
  })

  it('微信 degraded + App 送得到 ⇒ 落到 App', async () => {
    const s = setup({ degraded: true, app: 'deliverable' })
    const t = s.out.open(OWNER)
    await t.sendText(OWNER, 'x')
    t.finish()
    expect(s.sendWechat).not.toHaveBeenCalled()
    expect(s.app.push).toHaveBeenCalledOnce()
    expect(s.logs.some(l => l.includes('degraded'))).toBe(true)
  })

  it('微信看着能用但发失败(-2 / 别的错)+ App 送得到 ⇒ 微信只试一次,这一条和后面的都落 App', async () => {
    for (const err of ['ilink/sendmessage errcode=-2: prepare failed', 'fetch failed']) {
      const s = setup({ wechatError: err, app: 'deliverable' })
      const t = s.out.open(OWNER)
      expect((await t.sendText(OWNER, 'a')).error).toBeUndefined()
      expect((await t.sendText(OWNER, 'b')).error).toBeUndefined()
      t.finish()
      expect(s.sendWechat).toHaveBeenCalledOnce()
      expect(s.app.record).toHaveBeenCalledTimes(2)
      expect(s.app.push).toHaveBeenCalledWith('a\n\nb')
    }
  })

  it('两条都不通:窗口关了且 App 送不到 ⇒ 同改造前,照试微信一次、错误原样返回,不记不推', async () => {
    for (const app of ['not_deliverable', 'none'] as const) {
      const s = setup({ closed: true, wechatError: 'errcode=-2', app })
      const t = s.out.open(OWNER)
      expect((await t.sendText(OWNER, 'x')).error).toBe('errcode=-2')
      t.finish()
      expect(s.sendWechat).toHaveBeenCalledOnce()
      expect(s.app.record).not.toHaveBeenCalled()
      expect(s.app.push).not.toHaveBeenCalled()
      expect(t.channel()).toBeNull()
    }
  })

  it('微信能用、发失败、App 送不到 ⇒ 错误原样返回(不重试)', async () => {
    const s = setup({ wechatError: 'boom', app: 'not_deliverable' })
    const t = s.out.open(OWNER)
    expect((await t.sendText(OWNER, 'x')).error).toBe('boom')
    expect(s.sendWechat).toHaveBeenCalledOnce()
  })

  it('不是主人那条对话 ⇒ App 送不到(App 只看得见主人的对话)', async () => {
    const s = setup({ closed: true, wechatError: 'errcode=-2', app: 'deliverable' })
    expect(s.out.appDeliverable('friend')).toBe(false)
    const t = s.out.open('friend')
    expect((await t.sendText('friend', 'x')).error).toBe('errcode=-2')
    expect(s.app.record).not.toHaveBeenCalled()
  })

  it('落到 App 但记不进库 ⇒ 这一条算发失败(回复交付就此停),不推', async () => {
    const s = setup({ closed: true, app: 'deliverable', recordOk: false })
    const t = s.out.open(OWNER)
    expect((await t.sendText(OWNER, 'x')).error).toBe('app_record_failed')
    t.finish()
    expect(s.app.push).not.toHaveBeenCalled()
  })

  it('第一条在微信上成功就粘住微信:第二条微信失败也不换到 App(一段话不会一半在微信一半在手机)', async () => {
    const s = setup({ app: 'deliverable' })
    const t = s.out.open(OWNER)
    await t.sendText(OWNER, 'a')
    s.sendWechat.mockResolvedValueOnce({ msgId: 'err', error: 'boom' })
    expect((await t.sendText(OWNER, 'b')).error).toBe('boom')
    expect(s.app.record).not.toHaveBeenCalled()
  })
})

describe('canDeliver —— 伙伴那一拍的闸:微信没断,或 App 收得到', () => {
  it('矩阵', () => {
    expect(setup({ app: 'none' }).out.canDeliver(OWNER)).toBe(true)
    expect(setup({ degraded: true, app: 'none' }).out.canDeliver(OWNER)).toBe(false)
    expect(setup({ degraded: true, app: 'not_deliverable' }).out.canDeliver(OWNER)).toBe(false)
    expect(setup({ degraded: true, app: 'deliverable' }).out.canDeliver(OWNER)).toBe(true)
  })
  it('App 那头抛了 ⇒ 当送不到,记一行', () => {
    const logs: string[] = []
    const out = makeProactiveOutbound({
      wechatDegraded: () => true, wechatClosedSince: () => null, sendWechat: async () => ({ msgId: '1' }),
      app: () => { throw new Error('boom') }, log: (t, l) => logs.push(`${t}|${l}`),
    })
    expect(out.canDeliver(OWNER)).toBe(false)
    expect(logs.some(l => l.includes('boom'))).toBe(true)
  })
})

describe('sendOnce(提醒)—— 同一条规矩,单条', () => {
  it('微信成功 ⇒ ok channel=wechat;不推', async () => {
    const s = setup({ app: 'deliverable' })
    expect(await s.out.sendOnce(OWNER, '吃药')).toEqual({ ok: true, channel: 'wechat' })
    expect(s.app.push).not.toHaveBeenCalled()
  })
  it('-2 + App 送得到 ⇒ ok channel=app,推一次', async () => {
    const s = setup({ wechatError: 'errcode=-2: prepare failed', app: 'deliverable' })
    expect(await s.out.sendOnce(OWNER, '吃药')).toEqual({ ok: true, channel: 'app' })
    expect(s.app.push).toHaveBeenCalledWith('吃药')
  })
  it('都不通 ⇒ 微信的错误原样回(sweeper 认 -2 继续退避等主人回来)', async () => {
    const s = setup({ wechatError: 'errcode=-2: prepare failed', app: 'none' })
    expect(await s.out.sendOnce(OWNER, '吃药')).toEqual({ ok: false, error: 'errcode=-2: prepare failed' })
  })
})

describe('提醒 sweeper 接 sendOnce(main.ts 的接法)—— 微信不通时落到 App 并标记已送', () => {
  it('-2 + App 送得到 ⇒ 送达(sent),不再退避;App 送不到 ⇒ 照旧 deferred 等主人回来', async () => {
    for (const app of ['deliverable', 'none'] as const) {
      const db = openTestDb()
      const store = makeRemindersStore(db)
      await store.schedule({ chat_id: OWNER, due_at: '2026-10-18T10:00:00Z', text: '吃药' })
      const s = setup({ wechatError: 'ilink/sendmessage errcode=-2: prepare failed', app })
      const send = async (c: string, t: string) => {
        const r = await s.out.sendOnce(c, t)
        return r.ok ? { ok: true } : { ok: false, ...(r.error ? { error: r.error } : {}) }
      }
      const res = await runReminderSweep({ store, send, nowIso: '2026-10-18T10:01:00Z', log: () => {} })
      if (app === 'deliverable') {
        expect(res.delivered).toBe(1)
        expect((await store.list(OWNER))[0]!.status).toBe('sent')
        expect(s.app.push).toHaveBeenCalledWith('吃药')
      } else {
        expect(res.deferred).toBe(1)
        expect((await store.list(OWNER))[0]!.status).toBe('pending')
      }
      expect(s.sendWechat).toHaveBeenCalledOnce()
      db.close()
    }
  })
})

// 评审 #6(2026-10-19):中继断着、只有登记推送的设备 ⇒ App 送不到 —— 不再「记进 App 历史、没推送、却标 sent」。
describe('提醒 sweeper × 真 App 通道 —— 中继离线 + 微信也不通', () => {
  it('只有推送设备、中继断着 ⇒ ok:false,不记进 App、不推、提醒留 pending', async () => {
    const db = openTestDb()
    const store = makeRemindersStore(db)
    const messages = makeMessagesStore(db)
    await store.schedule({ chat_id: OWNER, due_at: '2026-10-18T10:00:00Z', text: '吃药' })
    const push = vi.fn(() => ({ sent: 0, online: 0 }))
    const app = makeAppChannel({
      ownerChatId: () => OWNER, pushDevices: () => ['d1'], onlineDevices: () => new Set(), relayOnline: () => false,
      append: r => messages.append(r), touched: () => {}, push, log: () => {},
    })
    const sendWechat = vi.fn(async () => ({ msgId: 'err:1', error: 'ilink/sendmessage errcode=-2: prepare failed' }))
    const out = makeProactiveOutbound({ wechatDegraded: () => false, wechatClosedSince: () => null, sendWechat, app: () => app, log: () => {} })
    const send = async (c: string, t: string) => {
      const r = await out.sendOnce(c, t)
      return r.ok ? { ok: true } : { ok: false, ...(r.error ? { error: r.error } : {}) }
    }
    const res = await runReminderSweep({ store, send, nowIso: '2026-10-18T10:01:00Z', log: () => {} })
    expect(res.deferred).toBe(1)
    expect((await store.list(OWNER))[0]!.status).toBe('pending')
    expect(await messages.listRange(OWNER, { limit: 10 })).toEqual([])
    expect(push).not.toHaveBeenCalled()
    db.close()
  })
})

// 手机伙伴第 2 步(2026-10-18):落在 App 的那一轮,附件也记进 App 对话页;推送替附件说几个字。
describe('一轮的出口 —— 附件(sendAttachment)', () => {
  function withMedia(o: Parameters<typeof setup>[0], said: string | null = '[表情:开心]') {
    const s = setup(o)
    s.app.recordAttachment = vi.fn(async () => said)
    return s
  }
  it('落在 App ⇒ 附件交给 App 记;推送带上它替附件说的话', async () => {
    const s = withMedia({ closed: true, app: 'deliverable' })
    const t = s.out.open(OWNER)
    await t.sendText(OWNER, '想你了')
    expect(await t.sendAttachment(OWNER, { kind: 'sticker', ref: { tag: '开心' } })).toBe(true)
    t.finish()
    expect(s.app.recordAttachment).toHaveBeenCalledWith(OWNER, { kind: 'sticker', ref: { tag: '开心' } })
    expect(s.app.push).toHaveBeenCalledWith('想你了\n\n[表情:开心]')
  })
  it('落在微信 / 还没落定 / App 不认附件 / 记失败 ⇒ false(调用方退回第 1 步)', async () => {
    const w = withMedia({ app: 'deliverable' })
    const tw = w.out.open(OWNER)
    expect(await tw.sendAttachment(OWNER, { kind: 'voice', text: 'x' })).toBe(false)
    await tw.sendText(OWNER, 'hi')
    expect(await tw.sendAttachment(OWNER, { kind: 'voice', text: 'x' })).toBe(false)
    expect(w.app.recordAttachment).not.toHaveBeenCalled()
    const plain = setup({ closed: true, app: 'deliverable' })
    const tp = plain.out.open(OWNER)
    await tp.sendText(OWNER, 'hi')
    expect(await tp.sendAttachment(OWNER, { kind: 'voice', text: 'x' })).toBe(false)
    const failed = withMedia({ closed: true, app: 'deliverable' }, null)
    const tf = failed.out.open(OWNER)
    await tf.sendText(OWNER, 'hi')
    expect(await tf.sendAttachment(OWNER, { kind: 'voice', text: 'x' })).toBe(false)
    tf.finish()
    expect(failed.app.push).toHaveBeenCalledWith('hi')
  })
})
