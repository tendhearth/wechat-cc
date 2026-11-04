import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../../lib/db'
import { makeMatterStore } from './matters-store'
import { makeMatterLog } from './matter-log'
import { ccActMatterId, makeCcActs } from './cc-acts'
import type { MatterLog, MatterStore } from '../../ports/matters'

/** CC 自己做的事(M5a):每个发起方一件 act,每做一次一轮。 */
let db: Db, matters: MatterStore, log: MatterLog
beforeEach(() => { db = openDb({ path: ':memory:' }); matters = makeMatterStore(db); log = makeMatterLog(db) })
afterEach(() => db.close())

describe('cc-acts', () => {
  it('第一次做 ⇒ 建这件事(id 由名字定、act、initiator=cc、标题中文名);之后同一件,每做一次一轮', () => {
    const acts = makeCcActs({ db, log, matters })
    const a = acts.begin('letters', { startedAt: 1_000 })
    a.step('artifact', { chars: 420, firstLine: '今天想跟你说' })
    a.step('delivery', { channel: 'wechat', page: 1 })
    a.finish('completed', { endedAt: 2_000 })
    acts.begin('letters', { startedAt: 3_000 }).finish('failed', { errorCode: 'blocked', endedAt: 3_500 })
    const id = ccActMatterId('letters')
    expect(acts.matterIdOf('letters')).toBe(id)
    expect(id).toMatch(/^[a-f0-9]{8}$/)
    expect(matters.get(id)).toMatchObject({ kind: 'act', title: '信', origin: 'companion' })
    expect(db.query<{ initiator: string }, [string]>('SELECT initiator FROM matters WHERE id=?').get(id)!.initiator).toBe('cc')
    expect(log.turns(id)).toMatchObject([
      { executor: 'cc', status: 'completed', startedAt: 1_000, endedAt: 2_000, policy: { who: 'letters' } },
      { status: 'failed', errorCode: 'blocked' },
    ])
    expect(log.items(id).map(i => [i.kind, i.payload])).toEqual([['artifact', { chars: 420, firstLine: '今天想跟你说' }], ['delivery', { channel: 'wechat', page: 1 }]])
    expect(ccActMatterId('memory')).not.toBe(id)
  })

  it('收过的轮再写步照样能写(记忆整理的通知几小时后才送);finish 只收一次', () => {
    const acts = makeCcActs({ db, log, matters })
    const t = acts.begin('memory')
    t.finish('completed', { endedAt: 5 })
    t.finish('failed')
    t.step('delivery', { channel: 'wechat' })
    const id = ccActMatterId('memory')
    expect(log.turns(id)).toMatchObject([{ status: 'completed' }])
    expect(log.items(id).map(i => i.kind)).toEqual(['delivery'])
  })

  it('M6e:「答完了、闲着」那一步(ready:<turnId>)不进 runs / stepsOf;别的 system 步照旧', () => {
    const acts = makeCcActs({ db, log, matters })
    const t = acts.begin('memory', { startedAt: 10 }); t.step('system', { applied: { add: 1 } }); t.finish('completed', { endedAt: 20 })
    log.writeItem({ matterId: ccActMatterId('memory'), turnId: t.id!, kind: 'system', status: 'completed', key: `ready:${t.id}`, payload: { ready: true } })
    expect(acts.runs('memory')[0]!.steps.map(s => s.payload)).toEqual([{ applied: { add: 1 } }])
    expect(acts.stepsOf('memory', 'system').map(s => s.payload)).toEqual([{ applied: { add: 1 } }])
  })
  it('runs(M5d):新的在前、带步;按结局筛;steps:false 不读步;没建过 / 读不出 ⇒ []', () => {
    const errs: string[] = []
    const acts = makeCcActs({ db, log, matters, onError: (w) => errs.push(w) })
    expect(acts.runs('letters')).toEqual([])
    const a = acts.begin('letters', { startedAt: 1_000, policy: { trigger: 'owner' } })
    a.step('artifact', { letter: 'x' }); a.step('delivery', { letter: 'x', result: 'sent' }); a.finish('completed', { endedAt: 1_500 })
    acts.begin('letters', { startedAt: 2_000 }).finish('failed', { errorCode: 'waiting', endedAt: 2_100 })
    acts.begin('memory', { startedAt: 3_000 }).finish('completed')
    expect(acts.runs('letters')).toMatchObject([
      { status: 'failed', errorCode: 'waiting', startedAt: 2_000, endedAt: 2_100, steps: [] },
      { status: 'completed', startedAt: 1_000, policy: { who: 'letters', trigger: 'owner' }, steps: [{ kind: 'artifact', payload: { letter: 'x' } }, { kind: 'delivery', status: 'completed', payload: { letter: 'x', result: 'sent' } }] },
    ])
    expect(acts.runs('letters', { status: 'completed' }).map(t => t.startedAt)).toEqual([1_000])
    expect(acts.runs('letters', { limit: 1 }).map(t => t.startedAt)).toEqual([2_000])
    expect(acts.runs('letters', { status: 'completed', steps: false })[0]!.steps).toEqual([])
    // 某一种步、不限轮数,新的在前
    expect(acts.stepsOf('letters', 'delivery')).toMatchObject([{ turnId: acts.runs('letters', { status: 'completed' })[0]!.id, payload: { letter: 'x', result: 'sent' } }])
    // step / finish 回「真写进去了没有」:再收 ⇒ false
    const c = acts.begin('letters')
    expect(c.step('system', {})).toBe(true)
    expect(c.finish('completed')).toBe(true)
    expect(c.finish('failed')).toBe(false)
    const d = acts.begin('letters')
    db.close()
    expect(d.step('system', {})).toBe(false)
    expect(acts.runs('letters')).toEqual([])
    expect(acts.stepsOf('letters', 'delivery')).toEqual([])
    expect(errs).toEqual(['step letters system', 'runs letters', 'stepsOf letters'])
    db = openDb({ path: ':memory:' })
  })

  it('写不上(库关了)⇒ 不抛,给一个什么都不做的把手;记一行', () => {
    const errs: string[] = []
    const acts = makeCcActs({ db, log, matters, onError: (w) => errs.push(w) })
    db.close()
    const t = acts.begin('hunt')
    expect(() => { t.step('artifact', {}); t.finish('completed') }).not.toThrow()
    expect(errs).toEqual(['begin hunt'])
    db = openDb({ path: ':memory:' })
  })

  it('步的 key 只在这一轮里认:下一轮用同一把 key 不会改掉上一轮的步(Codex 评审)', () => {
    const acts = makeCcActs({ db, log, matters })
    const a = acts.begin('letters'); a.step('delivery', { try: 1 }, { key: 'send', status: 'started' }); a.step('delivery', { try: 1, ok: true }, { key: 'send' }); a.finish('completed')
    const b = acts.begin('letters'); b.step('delivery', { try: 2 }, { key: 'send' }); b.finish('completed')
    const id = ccActMatterId('letters'), [t1, t2] = log.turns(id)
    expect(log.items(id).map(i => [i.turnId, i.payload])).toEqual([[t1!.id, { try: 1, ok: true }], [t2!.id, { try: 2 }]])
  })

  it('toTurn:补在指定的那一轮上(早收了也行,后面又开了新轮也不挪);不是这件事的轮 / 不存在 ⇒ 什么都不做', () => {
    const acts = makeCcActs({ db, log, matters })
    const t1 = acts.begin('memory'); t1.finish('completed')
    acts.begin('memory').finish('completed')
    acts.toTurn('memory', t1.id!, 'delivery', { channel: 'wechat' })
    acts.toTurn('memory', 'nope', 'delivery', { x: 1 })
    const other = acts.begin('letters'); other.finish('completed')
    acts.toTurn('memory', other.id!, 'delivery', { x: 2 })
    const id = ccActMatterId('memory')
    expect(log.items(id).map(i => [i.turnId, i.payload])).toEqual([[t1.id, { channel: 'wechat' }]])
  })

  it('开机 interruptAll:没收的 act 轮记中断;别的种类不碰', () => {
    const acts = makeCcActs({ db, log, matters })
    acts.begin('stickers')
    const task = matters.create({ kind: 'task', title: 't' })
    log.startTurn({ matterId: task.id, executor: 'codex' })
    acts.interruptAll()
    expect(log.turns(ccActMatterId('stickers'))).toMatchObject([{ status: 'interrupted', errorCode: 'daemon_restarted' }])
    expect(log.turns(task.id)).toMatchObject([{ status: 'running' }])
  })
})
