import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {openDb, type Db} from '../../lib/db'
import {makeMatterStore} from '../../core/matters/store'
import {makeReportOutboxStore, type ReportOutboxStore} from './outbox'
import type {PendingReport} from '../../core/matters/report'

/**
 * matter_report_outbox(v65)的原始 CRUD 面,风格照 reminders/store.ts:pending →
 * sent / dropped,attempts + next_at 供退避。没有 last_error 列(schema 里就没
 * 有——dropped 的理由只进日志,不进表,brief 的迁移片段照原文)。
 * matter_id / origin_matter_id 都是 matters(id) 的外键,测试先用 MatterStore
 * 建两行真实的 matter 再入队,不然 FOREIGN KEY 约束会拒。
 */
const CHAT = 'c0000001', TASK = 'a0000001', LATE = 'a0000002', EARLY = 'a0000003'
const report: PendingReport = {matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: `首页调整 · 已答复。\n看:任务 ${TASK} · 接着说:任务 ${TASK} 补充 …`}

describe('report outbox store', () => {
  let db: Db, store: ReportOutboxStore
  beforeEach(() => {
    db = openDb({path: ':memory:'})
    const matters = makeMatterStore(db)
    matters.create({id: CHAT, kind: 'chat', title: '聊天'})
    matters.create({id: TASK, kind: 'task', title: '首页调整', originMatterId: CHAT, originMessageId: 'msg-7'})
    matters.create({id: LATE, kind: 'task', title: '晚一点', originMatterId: CHAT})
    matters.create({id: EARLY, kind: 'task', title: '早一点', originMatterId: CHAT})
    store = makeReportOutboxStore(db)
  })
  afterEach(() => db.close())

  it('inserts a pending row immediately due', async () => {
    const id = await store.insert(report, 1_000)
    const due = await store.listDue(1_000)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({id, matterId: TASK, originMatterId: CHAT, originMessageId: 'msg-7', text: report.text, status: 'pending', attempts: 0, nextAt: 1_000})
  })

  it('listDue only returns rows whose next_at has passed', async () => {
    await store.insert(report, 5_000)
    expect(await store.listDue(1_000)).toEqual([])
    expect(await store.listDue(5_000)).toHaveLength(1)
  })

  it('markSent flips status; sent rows drop out of listDue', async () => {
    const id = await store.insert(report, 1_000)
    await store.markSent(id)
    expect(await store.listDue(1_000)).toEqual([])
  })

  it('markDropped flips status; dropped rows drop out of listDue', async () => {
    const id = await store.insert(report, 1_000)
    await store.markDropped(id)
    expect(await store.listDue(1_000)).toEqual([])
  })

  it('recordAttempt bumps attempts and reschedules next_at; stays pending', async () => {
    const id = await store.insert(report, 1_000)
    await store.recordAttempt(id, 2_000)
    const due = await store.listDue(1_000)
    expect(due).toEqual([]) // not due yet
    const dueLater = await store.listDue(2_000)
    expect(dueLater).toHaveLength(1)
    expect(dueLater[0]).toMatchObject({attempts: 1, nextAt: 2_000, status: 'pending'})
  })

  it('listDue orders oldest-due first', async () => {
    await store.insert({...report, matterId: LATE}, 3_000)
    await store.insert({...report, matterId: EARLY}, 1_000)
    const due = await store.listDue(5_000)
    expect(due.map(r => r.matterId)).toEqual([EARLY, LATE])
  })

  /**
   * 评审修复轮 1 ②:入队侧没有量控——同一 matter 反复入队(同一轮里抖好几次
   * quiet↔busy,或主人一整天不回微信、多轮各答复一次)必须落成同一行,不是
   * 无上限累积。insert() 已有 pending 行就更新它(文本 + next_at),不插新行。
   */
  it('insert() 对同一 matter 的已有 pending 行合并:更新文本,不插新行,id 不变', async () => {
    const firstId = await store.insert(report, 1_000)
    const secondText = `${report.text}\n(第二次)`
    const mergedId = await store.insert({...report, text: secondText}, 5_000)
    expect(mergedId).toBe(firstId)
    const due = await store.listDue(5_000)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({id: firstId, text: secondText, nextAt: 5_000})
  })

  it('合并会把 next_at 拨回「立即」,但不动 attempts(不能靠反复入队绕开放弃上限)', async () => {
    const id = await store.insert(report, 1_000)
    await store.recordAttempt(id, 60_000) // 之前失败过,正在退避
    await store.insert({...report, text: '更新后的文本'}, 2_000)
    const due = await store.listDue(2_000)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({id, attempts: 1, nextAt: 2_000, text: '更新后的文本'})
  })

  it('已经 sent 的行不会被"合并"——同一 matter 再报一次是新的一行', async () => {
    const firstId = await store.insert(report, 1_000)
    await store.markSent(firstId)
    const secondId = await store.insert(report, 2_000)
    expect(secondId).not.toBe(firstId)
    const due = await store.listDue(2_000)
    expect(due).toHaveLength(1)
    expect(due[0]!.id).toBe(secondId)
  })

  it('已经 dropped 的行同样不会被合并——新报一次是新的一行', async () => {
    const firstId = await store.insert(report, 1_000)
    await store.markDropped(firstId)
    const secondId = await store.insert(report, 2_000)
    expect(secondId).not.toBe(firstId)
    expect(await store.listDue(2_000)).toHaveLength(1)
  })
})
