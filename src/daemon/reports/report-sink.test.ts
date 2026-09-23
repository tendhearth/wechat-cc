import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {openDb, type Db} from '../../lib/db'
import {makeMatterStore, type MatterStore} from '../../core/matters/store'
import {makeReportOutboxStore, type ReportOutboxStore} from './outbox'
import {makeReportSink} from './report-sink'

/**
 * ReportSink 的 daemon 侧实现:enqueue(matterId) 把 matter + 标题 + 成果数拼成
 * renderReport 的输入,该不该报交给纯逻辑(src/core/matters/report.ts)判,有
 * 报就写进 outbox。「没有出生地 ⇒ 不报」不在这里另设判断——matter 没有
 * originMatterId 时 renderReport 自己返回 null,这里只是不写而已。
 */
const CHAT = 'c0000001', FROM_CHAT = 'a0000001', HANDMADE = 'a0000002'

describe('makeReportSink', () => {
  let db: Db, matters: MatterStore, outbox: ReportOutboxStore, logs: Array<[string, string]>
  beforeEach(() => {
    db = openDb({path: ':memory:'})
    matters = makeMatterStore(db)
    outbox = makeReportOutboxStore(db)
    logs = []
    matters.create({id: CHAT, kind: 'chat', title: '聊天'})
    matters.create({id: FROM_CHAT, kind: 'task', title: '首页调整', originMatterId: CHAT, originMessageId: 'msg-7'})
    matters.create({id: HANDMADE, kind: 'task', title: '手动派的'})
  })
  afterEach(() => db.close())

  it('从聊天交办的事:enqueue 写进 outbox,文本带标题与成果数', async () => {
    const sink = makeReportSink({matters, outbox, taskTitle: () => '首页调整', artifactCount: () => 2, notificationsEnabled: () => true, now: () => 1_000})
    sink.enqueue(FROM_CHAT, 0)
    const due = await outbox.listDue(1_000)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({matterId: FROM_CHAT, originMatterId: CHAT, originMessageId: 'msg-7'})
    expect(due[0]!.text).toContain('首页调整')
    expect(due[0]!.text).toContain('累计生成了2份成果。')
  })

  it('没有出生地(桌面手动派的):不写进 outbox', async () => {
    const sink = makeReportSink({matters, outbox, taskTitle: () => '手动派的', artifactCount: () => 0, notificationsEnabled: () => true, now: () => 1_000})
    sink.enqueue(HANDMADE, 0)
    expect(await outbox.listDue(1_000)).toEqual([])
  })

  it('matter 不存在(防御性):不写、不抛,但要留痕(终审 Important:这不是预期路径)', async () => {
    const sink = makeReportSink({matters, outbox, taskTitle: () => 'x', artifactCount: () => 0, notificationsEnabled: () => true, now: () => 1_000, log: (t, l) => logs.push([t, l])})
    expect(() => sink.enqueue('deadbeef', 0)).not.toThrow()
    expect(await outbox.listDue(1_000)).toEqual([])
    expect(logs.some(([tag, line]) => tag === 'MATTER_REPORT' && line.includes('deadbeef') && line.includes('no matter row'))).toBe(true)
  })

  /**
   * 终审 Critical:「任务 <id> 静音」(`wechat-control.ts` 的 `setWechatWatch`,
   * 落在 `workbench_wechat_subscriptions.enabled=0`)之后回报照发,而机器
   * 人明说「已关闭这项任务的微信提醒。」——这条路以前从不读这张表,而且
   * 没有任何开关能关掉。闸放在 enqueue 这一侧(不是发送侧,静音就是不产
   * 噪音),不进 outbox,留一条日志说明为什么这轮没报。
   */
  it('静音之后:enqueue 不写进 outbox,留一条日志说明为什么', async () => {
    const sink = makeReportSink({matters, outbox, taskTitle: () => '首页调整', artifactCount: () => 2, notificationsEnabled: () => false, now: () => 1_000, log: (t, l) => logs.push([t, l])})
    sink.enqueue(FROM_CHAT, 0)
    expect(await outbox.listDue(1_000)).toEqual([])
    expect(logs.some(([tag, line]) => tag === 'MATTER_REPORT' && line.includes(FROM_CHAT) && line.includes('muted'))).toBe(true)
  })

  it('静音只挡这个 taskId,不误伤没静音的其它任务', async () => {
    matters.create({id: 'b0000003', kind: 'task', title: '另一件事', originMatterId: CHAT, originMessageId: 'msg-8'})
    const muted = new Set([FROM_CHAT])
    const sink = makeReportSink({matters, outbox, taskTitle: () => 'x', artifactCount: () => 0, notificationsEnabled: id => !muted.has(id), now: () => 1_000})
    sink.enqueue(FROM_CHAT, 0)
    sink.enqueue('b0000003', 0)
    const due = await outbox.listDue(1_000)
    expect(due.map(d => d.matterId)).toEqual(['b0000003'])
  })

  /**
   * 终审第 6 项:enqueue 的第二个参数(turn,来自 service.ts 的
   * Active.turnSeq)要真的传给 renderReport,不是摆设——sink 这一层验证
   * 参数确实穿透过去,措辞本身的用例在 report.test.ts。
   */
  it('turn 参数穿透给 renderReport:同一个 matter 不同 turn,文案能区分', async () => {
    const sink = makeReportSink({matters, outbox, taskTitle: () => '首页调整', artifactCount: () => 0, notificationsEnabled: () => true, now: () => 1_000})
    sink.enqueue(FROM_CHAT, 0)
    await outbox.markSent((await outbox.listDue(1_000))[0]!.id) // 清空 pending,免得第二次 insert 被合并成同一行
    sink.enqueue(FROM_CHAT, 3)
    const due = await outbox.listDue(1_000)
    expect(due).toHaveLength(1)
    expect(due[0]!.text).toContain('第4轮')
    expect(due[0]!.text).not.toContain('第1轮')
  })
})
