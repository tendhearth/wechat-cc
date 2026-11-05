/**
 * write-hints.test.ts —— 不进 MatterLog 游标的写口给手机主题的提示(P2 第二步)。
 * 钉两件事:提示本身的规矩(微任务、同拍合并、按作用域、没人订不做事),以及五个写口真的会提示。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, type Db } from './db'
import { hintWrite, onWriteHint, type WriteHint } from './write-hints'
import { makeMessagesStore } from './messages-store'
import { makeMatterStore } from '../adapters/store/matters-store'
import { makeJournal } from '../adapters/store/journal-store'
import { writeJournalSeen } from '../adapters/store/journal-seen'
import { appendPlanLog } from '../features/companion/plan-memory'

const tick = () => new Promise<void>(r => setTimeout(r, 0))

let db: Db
let dir: string
beforeEach(() => { db = openDb({ path: ':memory:' }); dir = mkdtempSync(join(tmpdir(), 'write-hints-')) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const collect = (scope: Db | string) => {
  const got: WriteHint[] = []
  const off = onWriteHint(scope, h => got.push(h))
  return { got, off }
}

describe('write-hints', () => {
  it('落笔之后一个微任务才发,不在写口的栈里;同一拍里同样的提示只发一次', async () => {
    const { got } = collect(db)
    hintWrite(db, { kind: 'messages', chatId: 'a' })
    hintWrite(db, { kind: 'messages', chatId: 'a' })
    hintWrite(db, { kind: 'messages', chatId: 'b' })
    expect(got).toEqual([])
    await tick()
    expect(got).toEqual([{ kind: 'messages', chatId: 'a' }, { kind: 'messages', chatId: 'b' }])
  })

  it('按作用域分:别的库 / 别的 stateDir 的写不提示;退订之后不再收', async () => {
    const other = openDb({ path: ':memory:' })
    const { got, off } = collect(db)
    const files = collect(dir)
    hintWrite(other, { kind: 'journal' })
    hintWrite(join(dir, 'x'), { kind: 'plan-log' })
    await tick()
    expect(got).toEqual([])
    expect(files.got).toEqual([])
    off()
    hintWrite(db, { kind: 'journal' })
    await tick()
    expect(got).toEqual([])
    other.close()
  })

  it('一个订的人抛错,别的照收', async () => {
    onWriteHint(db, () => { throw new Error('boom') })
    const { got } = collect(db)
    hintWrite(db, { kind: 'journal' })
    await tick()
    expect(got).toEqual([{ kind: 'journal' }])
  })
})

describe('写口', () => {
  it('messages:真插进去一行才提示(INSERT OR IGNORE 撞了 id 不算)', async () => {
    const { got } = collect(db)
    const store = makeMessagesStore(db)
    const rec = { id: 'm1', chatId: 'owner@im', ts: '2026-11-04T00:00:00.000Z', direction: 'in' as const, kind: 'text', text: 'hi', source: 'live' }
    expect(await store.append(rec)).toBe(1)
    await tick()
    expect(got).toEqual([{ kind: 'messages', chatId: 'owner@im' }])
    got.length = 0
    expect(await store.append(rec)).toBe(0)
    await tick()
    expect(got).toEqual([])
  })

  it('matters:新建 / 改状态 / 改名 / touch 都提示那件事', async () => {
    const { got } = collect(db)
    const store = makeMatterStore(db)
    const m = store.create({ id: 'cccc0001', kind: 'chat', title: '闲聊' })
    await tick()
    store.setLifecycle(m.id, 'open'); await tick()
    store.rename(m.id, '新名字'); await tick()
    store.touch(m.id); await tick()
    expect(got).toEqual(Array(4).fill({ kind: 'matter', matterId: 'cccc0001' }))
  })

  it('journal:新条目、改状态、删掉都提示', async () => {
    const { got } = collect(db)
    const j = makeJournal(db)
    const id = j.recordVisit({ chatId: 'owner@im', text: '去串门了', peerLabel: '小熊' })!
    await tick()
    j.setStatus(id, 'tried'); await tick()
    j.remove(id); await tick()
    expect(got).toEqual(Array(3).fill({ kind: 'journal' }))
  })

  it('journal-seen 与 plan-log 两份文件按 stateDir 提示', async () => {
    const { got } = collect(dir)
    writeJournalSeen(dir, '2026-11-04T00:00:00.000Z')
    await tick()
    appendPlanLog(dir, '2026-11-04', { at: '2026-11-04T00:00:00.000Z', chatId: 'owner@im', candidates: [], decision: 'skip', why: '', source: 'model' } as never)
    await tick()
    expect(got).toEqual([{ kind: 'journal-seen' }, { kind: 'plan-log' }])
  })
})
