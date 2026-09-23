import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {openDb, type Db} from '../../lib/db'
import {makeMatterStore, type MatterStore} from '../../core/matters/store'
import {makeReportOutboxStore, type ReportOutboxStore} from './outbox'
import {runReportSweep} from './sweeper'
import {RETRY_WINDOW_MS} from '../reminders/sweeper'

/**
 * 投递器(brief Step 6,分路按评审修复轮 1/2/3 收紧):读 status='pending' AND
 * next_at<=now 的行 → 按 origin_matter_id 的 wechat 绑定取 chat → 发送。
 *   - 找不到 wechat 绑定(chat 不存在)→ dropped,不重试。
 *   - 票据过期(errcode=-2)→ 保持 pending,指数退避,计入 `deferred`(跟
 *     reminders 的计数语义对齐),永不放弃——"不计入放弃窗口"brief 原话只管
 *     这一种失败,不管过了多久、attempts 多高都不例外;也从不写 first_fail_at。
 *   - 其它发送失败 → 保持 pending、退避,计入 `retried`,直到从这一行**第一次
 *     真的失败**(`first_fail_at`,evaluation round 3;不是 created_at)算起
 *     过了 `RETRY_WINDOW_MS`(照 reminders 同值 24h)。锚点必须是 first_fail_at
 *     而不是 created_at——评审修复轮 2 把锚点从 attempts 计数换成了 created_at
 *     时间窗口,但主人一整天不回微信时,这段时间全是 -2 deferral,created_at
 *     早就"过期"了,于是第一次真正的非 -2 失败照样会被误判成"早该放弃"(A 的
 *     原场景在修复轮 2 之后原封不动地活着)。first_fail_at 只在非 -2 失败时
 *     写一次(已有值不动),为 null 就说明从没真的失败过,不可能已经过了窗口。
 *   放弃时(仅时间窗口那一支,不含"没有绑定"那一支)额外调用
 *   `noteAbandoned(matterId, text)` 在那件事自己的事件流上留痕。
 * 退避沿用 reminders/sweeper.ts 的 backoffMs(不新发明退避规则,brief 明说)。
 */
const CHAT = 'c0000001', TASK = 'a0000001'

describe('runReportSweep', () => {
  let db: Db, matters: MatterStore, outbox: ReportOutboxStore, logs: Array<[string, string]>
  // matters store 的可注入时钟(约定见 core/matters/store.test.ts 的 clock 用法)。
  // 默认设成远早于本文件里任何测试用的 nowMs(最大到 1_000+RETRY_WINDOW_MS*3
  // ≈ 2.6 亿 ms)的过去值,保证 matters.bind() 写下的 last_seen_at 对 Task 4
  // 的 shouldDisturb 粗闸恒为"很久没摸过"——不然默认走真实 Date.now()(现在是
  // ~1.8e12)而测试的 nowMs 都是几千,`now - lastSeenAt` 会是巨大负数,反而把
  // 所有已有用例都判成"刚被摸过"从而不发送。需要测"刚被摸过"该拦下的场景,
  // 单独在那条用例里把 matterClock 设到 nowMs 附近(见下面 shouldDisturb 相关用例)。
  let matterClock: number
  beforeEach(() => {
    db = openDb({path: ':memory:'})
    matterClock = -100_000_000
    matters = makeMatterStore(db, () => matterClock)
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
    expect(result).toEqual({delivered: 1, retried: 0, dropped: 0, deferred: 0, held: 0})
    expect(sent).toEqual([['user-1', '首页调整 · 已答复。']])
    expect(await outbox.listDue(1_000)).toEqual([])
  })

  it('origin matter 没有 wechat 绑定 → dropped 并 log,不重试', async () => {
    // CHAT 本身没有 bind 任何 wechat surface_key
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: true}), nowMs: 1_000, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 0, dropped: 1, deferred: 0, held: 0})
    expect(await outbox.listDue(1_000)).toEqual([])
    expect(logs.some(([tag, line]) => tag === 'REPORTS' && line.includes('dropped'))).toBe(true)
  })

  it('票据过期(errcode=-2)→ 保持 pending,退避重试,计入 deferred 不是 retried', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'ilink send failed: errcode=-2 errmsg=prepare failed'}), nowMs: 1_000, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 0, dropped: 0, deferred: 1, held: 0})
    // 1min 退避(backoffMs(1)),这次还没到
    expect(await outbox.listDue(1_000 + 59_000)).toEqual([])
    const dueLater = await outbox.listDue(1_000 + 60_000)
    expect(dueLater).toHaveLength(1)
    expect(dueLater[0]).toMatchObject({status: 'pending', attempts: 1})
    expect(logs.some(([tag, line]) => tag === 'REPORTS' && line.includes('推送窗口未开'))).toBe(true)
  })

  it('票据过期即便重试了很多次、过了(旧)放弃窗口时长也不放弃,也从不写 first_fail_at', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    const id = await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    // 手工把 attempts 推得很高,模拟"已经因为票据过期退避了很久很多次"。
    for (let i = 0; i < 40; i++) await outbox.recordAttempt(id, 1_000)
    const nowMs = 1_000 + RETRY_WINDOW_MS * 3
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'errcode=-2'}), nowMs, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 0, dropped: 0, deferred: 1, held: 0})
    // 退避封顶 60min(backoffMs 的上限),不是 dropped——attempts 再高、时间再久都还在 pending。
    const due = await outbox.listDue(nowMs + 60 * 60_000)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({status: 'pending', firstFailAt: null})
  })

  /**
   * 评审修复轮 3 ①的核心场景,brief 原话"A 的原场景",必须直接钉住:主人一整
   * 天(甚至更久)不回微信 ⇒ 这段时间全是 -2 deferral,created_at 早就"过期"
   * 了(锚在 created_at 会让下面这次立刻被误判成放弃)⇒ 接下来**第一次**真正
   * 的非 -2 失败(一次网络抖动)必须照常退避重试,不能被当场丢弃。
   */
  it('-2 攒过很久之后(远超放弃窗口的时长),第一次普通失败不会被丢 —— A 的原场景', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    const id = await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    for (let i = 0; i < 40; i++) await outbox.recordAttempt(id, 1_000) // 很多次 -2 退避,attempts 很高
    // 时间也早已超过放弃窗口时长——如果窗口锚在 created_at(修复轮 2 的做法),
    // 这里已经"过期"了;锚在 first_fail_at(还没写过)就不成立。
    const nowMs = 1_000 + RETRY_WINDOW_MS * 3
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'network timeout'}), nowMs, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 1, dropped: 0, deferred: 0, held: 0})
    const due = await outbox.listDue(nowMs + 60 * 60_000)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({status: 'pending', firstFailAt: nowMs}) // 这一次就是"第一次真失败",锚点从这里起算
  })

  it('其它网络失败 → 也保持 pending 退避重试(不是 dropped),计入 retried,写入 first_fail_at', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'network timeout'}), nowMs: 1_000, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 1, dropped: 0, deferred: 0, held: 0})
    const dueLater = await outbox.listDue(1_000 + 60_000)
    expect(dueLater).toHaveLength(1)
    expect(dueLater[0]).toMatchObject({status: 'pending', attempts: 1, firstFailAt: 1_000})
  })

  it('第二次非 -2 失败,还没过放弃窗口(从 first_fail_at 算)→ 照常重试,first_fail_at 不变', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'account disconnected'}), nowMs: 1_000, log: (t, l) => logs.push([t, l])}) // 第一次失败,first_fail_at=1_000
    const nowMs = 1_000 + RETRY_WINDOW_MS - 1_000 // 差一点点到放弃窗口(从 1_000 算)
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'account disconnected'}), nowMs, log: (t, l) => logs.push([t, l])})
    expect(result).toEqual({delivered: 0, retried: 1, dropped: 0, deferred: 0, held: 0})
    const due = await outbox.listDue(nowMs + 60 * 60_000)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({firstFailAt: 1_000}) // 没被第二次失败覆盖
  })

  it('非 -2 失败过了放弃窗口(first_fail_at + RETRY_WINDOW_MS)→ markDropped + log + noteAbandoned,不再是无限重试', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'account disconnected'}), nowMs: 1_000, log: (t, l) => logs.push([t, l])}) // 第一次失败,first_fail_at=1_000
    const nowMs = 1_000 + RETRY_WINDOW_MS + 1 // 从 first_fail_at 算,刚过放弃窗口
    const abandoned: Array<[string, string]> = []
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'account disconnected'}), nowMs, log: (t, l) => logs.push([t, l]), noteAbandoned: (m, t) => abandoned.push([m, t])})
    expect(result).toEqual({delivered: 0, retried: 0, dropped: 1, deferred: 0, held: 0})
    expect(await outbox.listDue(nowMs + 60 * 60_000)).toEqual([]) // dropped,不会再出现在 due 里
    expect(logs.some(([tag, line]) => tag === 'REPORTS' && line.includes('giving up after retry window'))).toBe(true)
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]![0]).toBe(TASK)
    expect(abandoned[0]![1]).toContain('这条回报没能送到微信')
  })

  it('noteAbandoned 抛错不影响放弃本身(best effort)', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'account disconnected'}), nowMs: 1_000, log: (t, l) => logs.push([t, l])})
    const nowMs = 1_000 + RETRY_WINDOW_MS + 1
    const result = await runReportSweep({store: outbox, matters, send: async () => ({ok: false, error: 'account disconnected'}), nowMs, log: (t, l) => logs.push([t, l]), noteAbandoned: () => { throw new Error('event write failed') }})
    expect(result).toEqual({delivered: 0, retried: 0, dropped: 1, deferred: 0, held: 0})
  })

  it('per-sweep 发送预算:超过的行留在 pending,不计尝试(deferred)', async () => {
    matters.bind(CHAT, 'wechat', 'user-1')
    matters.create({id: 'a0000002', kind: 'task', title: '另一件', originMatterId: CHAT})
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: null, text: 'a'}, 1_000)
    await outbox.insert({matterId: 'a0000002', originMatterId: CHAT, originMessageId: null, text: 'b'}, 1_000)
    let sends = 0
    const result = await runReportSweep({store: outbox, matters, send: async () => { sends++; return {ok: true} }, nowMs: 1_000, log: (t, l) => logs.push([t, l]), maxSendsPerSweep: 1})
    expect(result).toEqual({delivered: 1, retried: 0, dropped: 0, deferred: 1, held: 0})
    expect(sends).toBe(1)
    expect(await outbox.listDue(1_000)).toHaveLength(1) // 剩下那条下次 sweep 再来
  })

  /**
   * Task 4 粗闸(shouldDisturb)接线到发送分支:调用点在这里(sweeper 的发送
   * 循环),不在入队处;挡住 ≠ 失败——不发送、不 recordAttempt、不写
   * first_fail_at、不退避,原样留在 pending 等下一拍。origin 的 wechat 绑定
   * 刚被摸过(< 60s)时验证"拦下";过了粗闸窗口(same binding,时间往前走)
   * 验证"照常发送",证明拦截真的是判据算出来的,不是巧合出来的假绿。
   */
  it('origin 的 wechat 绑定刚被摸过(粗判据)⇒ 不发送,留在 pending,不算失败也不退避', async () => {
    matterClock = 1_000 - 10_000 // 绑定写下的 last_seen_at 比 sweep 的 nowMs 早 10s(< 60s 粗闸阈值)
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    let sends = 0
    const result = await runReportSweep({store: outbox, matters, send: async () => { sends++; return {ok: true} }, nowMs: 1_000, log: (t, l) => logs.push([t, l])})
    expect(sends).toBe(0)
    expect(result).toEqual({delivered: 0, retried: 0, dropped: 0, deferred: 0, held: 1})
    const due = await outbox.listDue(1_000)
    expect(due).toHaveLength(1) // 还在 pending,没被 dropped
    expect(due[0]).toMatchObject({status: 'pending', attempts: 0, firstFailAt: null, nextAt: 1_000}) // 没被当成失败:attempts/first_fail_at/next_at 都没被动过
    expect(logs.some(([tag, line]) => tag === 'REPORTS' && line.includes('held'))).toBe(true)
  })

  it('粗闸窗口过后(绑定没再被摸过)⇒ 下一拍照常发送', async () => {
    matterClock = 1_000 - 10_000 // 跟上一条用例同样"刚被摸过"的绑定
    matters.bind(CHAT, 'wechat', 'user-1')
    await outbox.insert({matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: 'x'}, 1_000)
    let sends = 0
    const nowMs2 = 1_000 + 60_000 // 粗闸阈值是 60_000,这时 now-lastSeenAt=70_000,过阈值了
    const result = await runReportSweep({store: outbox, matters, send: async () => { sends++; return {ok: true} }, nowMs: nowMs2, log: (t, l) => logs.push([t, l])})
    expect(sends).toBe(1)
    expect(result).toEqual({delivered: 1, retried: 0, dropped: 0, deferred: 0, held: 0})
    expect(await outbox.listDue(nowMs2)).toEqual([])
  })
})
