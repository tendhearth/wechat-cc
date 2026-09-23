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
  let db: Db, matters: MatterStore, outbox: ReportOutboxStore
  beforeEach(() => {
    db = openDb({path: ':memory:'})
    matters = makeMatterStore(db)
    outbox = makeReportOutboxStore(db)
    matters.create({id: CHAT, kind: 'chat', title: '聊天'})
    matters.create({id: FROM_CHAT, kind: 'task', title: '首页调整', originMatterId: CHAT, originMessageId: 'msg-7'})
    matters.create({id: HANDMADE, kind: 'task', title: '手动派的'})
  })
  afterEach(() => db.close())

  it('从聊天交办的事:enqueue 写进 outbox,文本带标题与成果数', async () => {
    const sink = makeReportSink({matters, outbox, taskTitle: () => '首页调整', artifactCount: () => 2, now: () => 1_000})
    sink.enqueue(FROM_CHAT)
    const due = await outbox.listDue(1_000)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({matterId: FROM_CHAT, originMatterId: CHAT, originMessageId: 'msg-7'})
    expect(due[0]!.text).toContain('首页调整')
    expect(due[0]!.text).toContain('生成了2份成果。')
  })

  it('没有出生地(桌面手动派的):不写进 outbox', async () => {
    const sink = makeReportSink({matters, outbox, taskTitle: () => '手动派的', artifactCount: () => 0, now: () => 1_000})
    sink.enqueue(HANDMADE)
    expect(await outbox.listDue(1_000)).toEqual([])
  })

  it('matter 不存在(防御性):不写、不抛', async () => {
    const sink = makeReportSink({matters, outbox, taskTitle: () => 'x', artifactCount: () => 0, now: () => 1_000})
    expect(() => sink.enqueue('deadbeef')).not.toThrow()
    expect(await outbox.listDue(1_000)).toEqual([])
  })
})
