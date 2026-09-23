import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {openDb, type Db} from '../../lib/db'
import {makeMatterStore, type MatterStore} from '../../core/matters/store'
import {makeJournal, type Journal} from '../../core/journal-store'
import {makeRecollectSink} from './recollect-sink'

/**
 * RecollectSink 的 daemon 侧实现:maybeTrigger(taskId, turns) 查 matter
 * (标题 + 算 overnight)、拿便宜模型、交给纯逻辑(src/core/matters/
 * recollection.ts 的 maybeRecollect)判该不该问、该不该写,写就落
 * journal.recordRecollection。
 *
 * `returned` 目前恒传 RETURNED_SIGNAL_UNAVAILABLE(=0,见 recollection.ts
 * 的注释)——「turns 不够格 + overnight 不够格」这组输入如果 returned 真
 * 的接了什么数据源、且那份数据源恰好 ≥1,场景就会够格;这里专门有一条
 * 用例钉住它现在**不会**够格,证明这个常量确实原样传下去、没被悄悄接成
 * 别的东西(fix round 1 的硬要求)。
 */
const TASK = 'a0000001'
const DAY1 = Date.parse('2026-09-23T10:00:00.000Z')
const DAY1_LATER = Date.parse('2026-09-23T22:00:00.000Z')
const DAY2 = Date.parse('2026-09-24T02:00:00.000Z')

describe('makeRecollectSink', () => {
  let db: Db, matters: MatterStore, journal: Journal, logs: Array<[string, string]>
  beforeEach(() => {
    db = openDb({path: ':memory:'})
    matters = makeMatterStore(db, () => DAY1)
    journal = makeJournal(db)
    logs = []
    matters.create({id: TASK, kind: 'task', title: '改首页'})
  })
  afterEach(() => db.close())

  it('turns 不够格 + overnight 不够格(returned 恒 0,不会被单独撬开):不问模型、不写 journal', async () => {
    const cheapEval = vi.fn(async () => '不该被叫到')
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 1) // turns:1 < STORY_SIGNALS.turns(2);同一天 ⇒ overnight:false
    await vi.waitFor(() => expect(cheapEval).not.toHaveBeenCalled())
    expect(journal.list()).toEqual([])
    expect(logs).toEqual([])
  })

  it('turns 够格(2):问便宜模型,写进 journal(chatId 用主人默认聊天)', async () => {
    const cheapEval = vi.fn(async (prompt: string) => { expect(prompt).toContain('改首页'); return '那天你让我改首页,我改错了两次。' })
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner-chat', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(cheapEval).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))
    expect(journal.list()[0]).toMatchObject({kind: 'recollection', chat_id: 'owner-chat', note: '那天你让我改首页,我改错了两次。'})
    expect(logs).toEqual([])
  })

  it('overnight 单独够格(跨了 UTC 日历日)也触发,即便 turns 是 0', async () => {
    const cheapEval = vi.fn(async () => '第二天早上才通。')
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY2, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 0)
    await vi.waitFor(() => expect(cheapEval).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))
  })

  it('matter 不存在(防御性):不问、不写、不抛', () => {
    const cheapEval = vi.fn(async () => 'x')
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1})
    expect(() => sink.maybeTrigger('deadbeef', 5)).not.toThrow()
    expect(cheapEval).not.toHaveBeenCalled()
    expect(journal.list()).toEqual([])
  })

  it('没有主人聊天(还没配好主人):不问、不写、不抛', () => {
    const cheapEval = vi.fn(async () => 'x')
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => null, now: () => DAY1})
    expect(() => sink.maybeTrigger(TASK, 5)).not.toThrow()
    expect(cheapEval).not.toHaveBeenCalled()
    expect(journal.list()).toEqual([])
  })

  it('没有便宜模型可用(cheapEval() 返回 null):不写、不抛、不算错误(不留痕)', async () => {
    const sink = makeRecollectSink({matters, journal, cheapEval: () => null, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await new Promise(resolve => setImmediate(resolve))
    expect(journal.list()).toEqual([])
    expect(logs).toEqual([])
  })

  it('便宜模型真的调用失败:留痕(MATTER_RECOLLECT,带 taskId),不写 journal,不抛出', async () => {
    const cheapEval = vi.fn(async () => { throw new Error('gateway_timeout') })
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(logs.length).toBeGreaterThan(0))
    expect(logs.some(([tag, line]) => tag === 'MATTER_RECOLLECT' && line.includes(TASK) && line.includes('gateway_timeout'))).toBe(true)
    expect(journal.list()).toEqual([])
  })

  it('写成功一次之后,同一个 taskId 再触发(哪怕又够格)不会再问、再写第二条', async () => {
    const cheapEval = vi.fn(async () => '第一段回忆。')
    const sink = makeRecollectSink({matters, journal, cheapEval: () => cheapEval, ownerChatId: () => 'owner', now: () => DAY1_LATER, log: (t, l) => logs.push([t, l])})
    sink.maybeTrigger(TASK, 2)
    await vi.waitFor(() => expect(journal.list()).toHaveLength(1))
    sink.maybeTrigger(TASK, 3) // 又一轮,又够格
    await new Promise(resolve => setImmediate(resolve))
    expect(cheapEval).toHaveBeenCalledTimes(1)
    expect(journal.list()).toHaveLength(1)
  })
})
