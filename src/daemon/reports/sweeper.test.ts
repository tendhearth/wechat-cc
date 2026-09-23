import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {openDb, type Db} from '../../lib/db'
import {makeMatterStore, type MatterStore} from '../../core/matters/store'
import {makeReportOutboxStore, type ReportOutboxStore} from './outbox'
import {runReportSweep} from './sweeper'

/**
 * 投递器(brief Step 6):读 status='pending' AND next_at<=now 的行 → 按
 * origin_matter_id 的 wechat 绑定取 chat → 发送。三条分路:
 *   - 找不到 wechat 绑定(chat 不存在)→ dropped,不重试。
 *   - 票据过期(errcode=-2)→ 保持 pending,指数退避(不计入放弃窗口——这条
 *     队列压根没有放弃窗口,跟提醒那条路不一样,人回来即送)。
 *   - 其它发送失败 → 同样保持 pending、指数退避。
 * 退避沿用 reminders/sweeper.ts 的 backoffMs(不新发明退避规则,brief 明说)。
 */
const CHAT = 'c0000001', TASK = 'a0000001'

describe('runReportSweep', () => {
  let db: Db, matters: MatterStore, outbox: ReportOutboxStore, logs: Array<[string, string]>
  beforeEach(() => {
    db = openDb({path: ':memory:'})
    matters = makeMatterStore(db)
    outbox = makeReportOutboxStore(db)
    logs = []
    matters.create({id: CHAT, kind: 'chat', title: '聊天'})
    matters.create({id: TASK, kind: 'task', title: '首页调整', originMatterId: CHAT, originMessageId: 'msg-7'})
    matters.bind(TASK, 'wechat', 'not-the-chat') // 任务自己的绑定不该被用来找 chat——投递器要看 origin 的绑定
  })
  afterEach(() => db.close())

  it('按 origin_matter_id 的 wechat 绑定发送成功 → markSent', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: '首页调整 · 已答复。'}, 1_000)
    const sent: Array<[string, string]> = []
    const result = await runReportSweep({store: outbox, matters, send: async (chatId, text) => { sent.push([chatId, text]); return {ok: true} }, nowMs: 1_000, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 1, retried: 0, dropped: 0, deferred: 0})
    expect(sent).toEqual([['user-1', '首页调整 · 已答复。']])
    expect(await outbox.listDue(1_000)).toEqual([])
  })

  it('origin matter 没有 wechat 绑定 → dropped 并 log,不重试', async () => {
    // CHAT 本身没有 bind 任何 wechat surface_key
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: true}), nowMs: 1_000, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 0, dropped: 1, deferred: 0})
    expect(await outbox.listDue(1_000)).toEqual([])
    expect(logs.some(([tag, line]) => tag === 'REPORTS' && line.includes('dropped'))).toBe(true)
  })

  it('票据过期(errcode=-2)→ 保持 pending,退避重试,不计入放弃窗口', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'ilink send failed: errcode=-2 errmsg=prepare failed'}), nowMs: 1_000, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 1, dropped: 0, deferred: 0})
    // 1min 退避(backoffMs(1)),这次还没到
    expect(await outbox.listDue(1_000 + 59_000)).toEqual([])
    const dueLater = await outbox.listDue(1_000 + 60_000)
    expect(dueLater).toHaveLength(1)
    expect(dueLater[0]).toMatchObject({status: 'pending', attempts: 1})
    expect(logs.some(([tag, line]) => tag === 'REPORTS' && line.includes('推送窗口未开'))).toBe(true)
  })

  it('其它网络失败 → 也保持 pending 退避重试(不是 dropped)', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'network timeout'}), nowMs: 1_000, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 1, dropped: 0, deferred: 0})
    const dueLater = await outbox.listDue(1_000 + 60_000)
    expect(dueLater).toHaveLength(1)
    expect(dueLater[0]).toMatchObject({status: 'pending', attempts: 1})
  })

  it('per-sweep 发送预算:超过的行留在 pending,不计尝试(deferred)', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    matters.create({id: 'a0000002', kind: 'task', title: '另一件', originMatterId: CHAT})
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: null, text: 'a'}, 1_000)
    await outbox.insert({matterId: 'a0000002', originMatterId: CHAT, originMessageId: null, text: 'b'}, 1_000)
    let sends = 0
    const result = await runReportSweep({store: outbox, matters, send: async () => { sends++; return {ok: true} }, nowMs: 1_000, log: (t, l) => logs.push([t, l]), maxSendsPerSweep: 1})
    expect(result).toEqual({delivered: 1, retried: 0, dropped: 0, deferred: 1})
    expect(sends).toBe(1)
    expect(await outbox.listDue(1_000)).toHaveLength(1) // 剩下那条下次 sweep 再来
  })
})
