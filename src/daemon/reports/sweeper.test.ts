import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {openDb, type Db} from '../../lib/db'
import {makeMatterStore, type MatterStore} from '../../core/matters/store'
import {makeReportOutboxStore, type ReportOutboxStore} from './outbox'
import {runReportSweep} from './sweeper'
import {RETRY_WINDOW_MS} from '../reminders/sweeper'

/**
 * 投递器(brief Step 6,分路按评审修复轮 1/2 收紧):读 status='pending' AND
 * next_at<=now 的行 → 按 origin_matter_id 的 wechat 绑定取 chat → 发送。
 *   - 找不到 wechat 绑定(chat 不存在)→ dropped,不重试。
 *   - 票据过期(errcode=-2)→ 保持 pending,指数退避,计入 `deferred`(跟
 *     reminders 的计数语义对齐),永不放弃——"不计入放弃窗口"brief 原话只管
 *     这一种失败,不管过了多久、attempts 多高都不例外。
 *   - 其它发送失败 → 保持 pending、退避,计入 `retried`,直到从这一行第一次
 *     入队(created_at)算起过了 `RETRY_WINDOW_MS`(照 reminders 同值 24h,
 *     时间窗口而不是 attempts 计数——评审修复轮 2 ①:attempts 是 -2 与非 -2
 *     两种失败共用的同一个字段,用它当放弃计数会把"攒了很多次票据过期"误判
 *     成"已经失败很多次",导致 -2 攒够次数后紧接着一次普通失败被错误放弃)。
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

  it('票据过期(errcode=-2)→ 保持 pending,退避重试,计入 deferred 不是 retried', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'ilink send failed: errcode=-2 errmsg=prepare failed'}), nowMs: 1_000, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 0, dropped: 0, deferred: 1})
    // 1min 退避(backoffMs(1)),这次还没到
    expect(await outbox.listDue(1_000 + 59_000)).toEqual([])
    const dueLater = await outbox.listDue(1_000 + 60_000)
    expect(dueLater).toHaveLength(1)
    expect(dueLater[0]).toMatchObject({status: 'pending', attempts: 1})
    expect(logs.some(([tag, line]) => tag === 'REPORTS' && line.includes('推送窗口未开'))).toBe(true)
  })

  it('票据过期即便重试了很多次、过了放弃窗口时长也不放弃 —— "不计入放弃窗口"只管这一种', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    const id = await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    // 手工把 attempts 推得很高,模拟"已经因为票据过期退避了很久很多次"。
    for (let i = 0; i < 40; i++) await outbox.recordAttempt(id, 1_000)
    // 时间也早已超过非 -2 那条路的放弃窗口(RETRY_WINDOW_MS,从 created_at 算)。
    const nowMs = 1_000 + RETRY_WINDOW_MS * 3
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'errcode=-2'}), nowMs, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 0, dropped: 0, deferred: 1})
    // 退避封顶 60min(backoffMs 的上限),不是 dropped——attempts 再高、时间再久都还在 pending。
    const due = await outbox.listDue(nowMs + 60 * 60_000)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({status: 'pending'})
  })

  /**
   * 评审修复轮 2 ①的核心场景:-2 的重试会推高 attempts,但 attempts 不再是
   * 放弃判据——所以票据过期攒了很多次之后紧接着来的一次普通失败,不会因为
   * "attempts 已经很高"就被误判成"早该放弃了"。放弃只看时间窗口,而这次
   * 是刚入队不久(created_at 就是 1_000,离放弃窗口还早),该正常退避重试。
   */
  it('-2 攒到很高的 attempts 之后,紧接着一次普通失败不会被误判成"早该放弃"', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    const id = await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    for (let i = 0; i < 40; i++) await outbox.recordAttempt(id, 1_000) // 模拟很多次 -2 退避,attempts 远超旧版的"上限"
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'network timeout'}), nowMs: 1_000, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 1, dropped: 0, deferred: 0})
    const due = await outbox.listDue(1_000 + 60 * 60_000)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({status: 'pending'})
  })

  it('其它网络失败 → 也保持 pending 退避重试(不是 dropped),计入 retried', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'network timeout'}), nowMs: 1_000, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 1, dropped: 0, deferred: 0})
    const dueLater = await outbox.listDue(1_000 + 60_000)
    expect(dueLater).toHaveLength(1)
    expect(dueLater[0]).toMatchObject({status: 'pending', attempts: 1})
  })

  it('非 -2 失败过了放弃窗口(created_at + RETRY_WINDOW_MS)→ markDropped + log,不再是无限重试', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    const nowMs = 1_000 + RETRY_WINDOW_MS + 1 // 刚过放弃窗口
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'account disconnected'}), nowMs, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 0, dropped: 1, deferred: 0})
    expect(await outbox.listDue(nowMs + 60 * 60_000)).toEqual([]) // dropped,不会再出现在 due 里
    expect(logs.some(([tag, line]) => tag === 'REPORTS' && line.includes('giving up after retry window'))).toBe(true)
  })

  it('非 -2 失败还没过放弃窗口时(即便刚好是第一次失败)照常退避重试,不放弃', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    const nowMs = 1_000 + RETRY_WINDOW_MS - 1_000 // 差一点点到放弃窗口
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'account disconnected'}), nowMs, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 1, dropped: 0, deferred: 0})
    expect(await outbox.listDue(nowMs + 60 * 60_000)).toHaveLength(1)
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
