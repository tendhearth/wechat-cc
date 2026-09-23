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
})
