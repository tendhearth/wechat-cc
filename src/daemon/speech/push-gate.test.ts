import { describe, expect, it, vi } from 'vitest'
import type { ProactiveOutbound } from '../companion/proactive-channel'
import type { PushPayload } from '../../features/phone/phone-push'
import { makeSpeechPolicy, type SpeechLedgerEntry } from './policy'
import { makePushGate } from './push-gate'
import { makeHeldPushes } from './held-pushes'
import { openTestDb } from '../../lib/db'

const OWNER = 'owner@im.wechat'
const T0 = Date.parse('2026-10-21T15:00:00.000Z')
const QUIET_END = Date.parse('2026-10-21T23:00:00.000Z')

function setup(o: { care?: 'off' | 'low'; quiet?: boolean; owner?: string | null; wechatDown?: boolean; db?: ReturnType<typeof openTestDb>; ready?: () => boolean; quietFn?: () => boolean; seen?: (m: string, since: number) => string | null } = {}) {
  let t = T0
  const db = o.db ?? openTestDb()
  const ledger: SpeechLedgerEntry[] = []
  // 微信断了、App 也「送不到」—— 推送照样问得过门:推送送不送得到是推送自己的事
  const outbound: ProactiveOutbound = { appDeliverable: () => false, canDeliver: () => !o.wechatDown, open: vi.fn(), sendOnce: async () => ({ ok: true }) }
  const speech = makeSpeechPolicy({
    care: () => o.care ?? 'low',
    quietEndsAt: (_c, now) => ((o.quietFn ? o.quietFn() : o.quiet) && now < QUIET_END ? QUIET_END : null),
    outbound, ledger: e => { ledger.push(e) }, log: () => {}, now: () => t,
  })
  const pushed: PushPayload[] = []
  const timers: Array<{ cb: () => void; ms: number }> = []
  const gate = makePushGate({
    speech, ownerChatId: () => (o.owner === undefined ? OWNER : o.owner),
    push: (p) => { pushed.push(p); return { sent: 1, online: 0 } },
    held: makeHeldPushes(db), ...(o.ready ? { ready: o.ready } : {}), ...(o.seen ? { seen: o.seen } : {}),
    log: () => {}, now: () => t,
    setTimer: (cb, ms) => { const h = { cb, ms }; timers.push(h); return h },
    clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1) },
  })
  return { gate, speech, pushed, ledger, timers, db, advance: (ms: number) => { t += ms }, open: outbound.open }
}

const perm: PushPayload = { kind: 'permission', title: '需要你批准', body: 'Bash: ls', taskId: 't1', requestId: 'p1' }
const done: PushPayload = { kind: 'task_done', title: '做完了', body: '修登录', taskId: 't1' }

describe('App 原生推送也问 CC 开口那道门', () => {
  it('平常 ⇒ 跟以前一样照推,结果原样回;记一行账(channel=app),不开 proactive 那一轮', () => {
    const s = setup()
    expect(s.gate.push(perm)).toEqual({ sent: 1, online: 0 })
    expect(s.gate.push(done)).toEqual({ sent: 1, online: 0 })
    expect(s.pushed).toEqual([perm, done])
    expect(s.ledger.map(e => [e.kind, e.outcome, e.channel])).toEqual([['permission_ask', 'allowed', 'app'], ['matter_report', 'allowed', 'app']])
    expect(s.open).not.toHaveBeenCalled()
  })

  it('别烦我 ⇒ 批准(blocking)和做完了(report)都照推', () => {
    const s = setup({ care: 'off' })
    s.gate.push(perm); s.gate.push(done)
    expect(s.pushed.map(p => p.kind)).toEqual(['permission', 'task_done'])
  })

  it('免打扰 ⇒ 批准照推;做完了先压着,时段结束再推一次', () => {
    const s = setup({ quiet: true })
    expect(s.gate.push(perm)).toEqual({ sent: 1, online: 0 })
    expect(s.gate.push(done)).toEqual({ sent: 0, online: 0 })
    expect(s.pushed.map(p => p.kind)).toEqual(['permission'])
    expect(s.timers).toHaveLength(1)
    expect(s.timers[0]!.ms).toBe(QUIET_END - T0)
    s.advance(QUIET_END - T0)
    s.timers.shift()!.cb()
    expect(s.pushed.map(p => p.kind)).toEqual(['permission', 'task_done'])
    expect(s.timers).toHaveLength(0)
  })

  it('微信断了 ⇒ 推送照样问得过门(它本身就是 App 那条路)', () => {
    const s = setup({ wechatDown: true })
    s.gate.push(done)
    expect(s.pushed).toEqual([done])
  })

  it('companion 不经这里问(它只在 say 开的那一轮收尾时推,已经过了门)', () => {
    const s = setup({ quiet: true })
    const c: PushPayload = { kind: 'companion', title: 'CC', body: '在吗' }
    s.gate.push(c)
    expect(s.pushed).toEqual([c])
    expect(s.ledger).toEqual([])
  })

  it('停了 ⇒ 计时器清掉,再推回 null;**压着的留在表里**(S2b:重启不丢)', () => {
    const s = setup({ quiet: true })
    s.gate.push(done)
    s.gate.stop()
    expect(s.timers).toHaveLength(0)
    expect(s.gate.push(perm)).toBeNull()
    expect(s.db.query("SELECT kind FROM speech_pending WHERE lane='push'").all()).toEqual([{ kind: 'matter_report' }])
  })
})

describe('压着的推送落在主库 speech_pending(S2b,主人 11-04:重启不丢)', () => {
  it('免打扰里压着一条「做完了」、daemon 重启 ⇒ 新的一份开机就按表里的到点时刻起计时器,时段结束照样推', () => {
    const a = setup({ quiet: true })
    a.gate.push(done)
    a.gate.stop()                                   // 关机
    const b = setup({ quiet: true, db: a.db })      // 同一个库再开机
    expect(b.timers).toHaveLength(1)
    expect(b.timers[0]!.ms).toBe(QUIET_END - T0)
    b.advance(QUIET_END - T0)
    b.timers.shift()!.cb()
    expect(b.pushed).toEqual([done])
    expect(b.db.query("SELECT COUNT(*) AS n FROM speech_pending WHERE lane='push'").get()).toEqual({ n: 0 })
  })

  it('同一件事只留最新那一条', () => {
    const s = setup({ quiet: true })
    s.gate.push(done)
    s.gate.push({ ...done, body: '修登录(第二次)' })
    s.advance(QUIET_END - T0)
    s.timers.at(-1)!.cb()
    expect(s.pushed.map(p => p.body)).toEqual(['修登录(第二次)'])
  })

  it('过期了(24 小时)⇒ 不推,记一行账「过期作废」', () => {
    const s = setup({ quiet: true })
    s.gate.push(done)
    s.db.query("UPDATE speech_pending SET next_at = ?, expires_at = ? WHERE lane='push'").run(T0 + 25 * 3600_000, T0 + 24 * 3600_000)
    s.advance(25 * 3600_000)
    s.timers.at(-1)!.cb()
    expect(s.pushed).toEqual([])
    expect(s.ledger.at(-1)).toMatchObject({ kind: 'matter_report', outcome: 'dropped', reason: 'expired', channel: 'app' })
    expect(s.db.query("SELECT COUNT(*) AS n FROM speech_pending WHERE lane='push'").get()).toEqual({ n: 0 })
  })

  it('到点了但中继还没连上(刚开机)⇒ 先不放,30 秒后再看;连上了再放', () => {
    let ready = false
    const s = setup({ quiet: true, ready: () => ready })
    s.gate.push(done)
    s.advance(QUIET_END - T0)
    s.timers.shift()!.cb()
    expect(s.pushed).toEqual([])
    expect(s.timers.at(-1)!.ms).toBe(30_000)
    ready = true
    s.advance(30_000)
    s.timers.shift()!.cb()
    expect(s.pushed).toEqual([done])
  })

  it('一拍最多放 5 条,剩下的一秒后接着放(静音一结束不一口气响一串)', () => {
    const s = setup({ quiet: true })
    for (let i = 0; i < 7; i++) s.gate.push({ ...done, taskId: `t${i}` })
    s.advance(QUIET_END - T0)
    s.timers.shift()!.cb()
    expect(s.pushed).toHaveLength(5)
    expect(s.timers.at(-1)!.ms).toBe(1_000)
    s.advance(1_000)
    s.timers.shift()!.cb()
    expect(s.pushed).toHaveLength(7)
  })

  it('主人提前关了免打扰 ⇒ 「待说」那一拍顺手再问一次门,压着的不必等到原来的时段结束', async () => {
    let quiet = true
    const s = setup({ quietFn: () => quiet })
    s.gate.push(done)
    s.advance(60_000)
    await s.speech.flushPending()
    expect(s.pushed).toEqual([])          // 还在免打扰里:照旧压着
    quiet = false
    await s.speech.flushPending()
    expect(s.pushed).toEqual([done])
  })

  it('带事件键(S3a):问门带上它;压着时一起存,重启后放出来问门还是同一个键(账并成一行),推出去的推送里没有它', () => {
    const db = openTestDb()
    const s = setup({ quiet: true, db })
    s.gate.push(done, 'turn:t1:2')
    expect(s.ledger.map(e => [e.outcome, e.ref])).toEqual([['deferred', 'turn:t1:2']])
    s.gate.stop()
    // 重启:新的门,同一个库
    const again = setup({ db })
    again.advance(QUIET_END - T0 + 1)
    again.timers.shift()!.cb()
    expect(again.pushed).toEqual([done])
    expect(again.ledger.map(e => [e.outcome, e.channel, e.ref])).toEqual([['allowed', 'app', 'turn:t1:2']])
  })

  it('带事件键、压到过期 ⇒ 过期那一行也带同一个键', () => {
    const s = setup({ quiet: true })
    s.gate.push(done, 'turn:t1:3')
    s.advance(25 * 3600_000)
    s.timers.shift()!.cb()
    expect(s.ledger.map(e => [e.outcome, e.reason, e.ref])).toEqual([['deferred', 'quiet_hours', 'turn:t1:3'], ['dropped', 'expired', 'turn:t1:3']])
  })

  it('v101 起压着的老行(body 只有推送本身)照样认得,放的时候不带键', () => {
    const db = openTestDb()
    db.query(`INSERT INTO speech_pending(id,lane,chat_id,kind,body,ref,created_at,next_at,expires_at) VALUES('old','push',?,'matter_report',?,'task_done:t1:',?,?,?)`)
      .run(OWNER, JSON.stringify(done), T0 - 1000, T0 - 1, T0 + 3600_000)
    const s = setup({ db })
    s.timers.shift()!.cb()
    expect(s.pushed).toEqual([done])
    expect(s.ledger.map(e => [e.outcome, e.ref])).toEqual([['allowed', undefined]])
  })

  it('later(S3b):到点没人看 ⇒ 照常问门、推一次(账带同一个键);重启不丢', () => {
    const db = openTestDb()
    const s = setup({ db, seen: () => null })
    s.gate.later(done, { at: T0 + 600_000, since: T0, matterId: 't1', ref: 'turn:t1:2' })
    expect(s.pushed).toEqual([])
    expect(s.ledger).toEqual([])
    s.gate.stop()
    const again = setup({ db, seen: () => null })
    again.advance(600_000)
    again.timers.shift()!.cb()
    expect(again.pushed).toEqual([done])
    expect(again.ledger.map(e => [e.outcome, e.channel, e.ref])).toEqual([['allowed', 'app', 'turn:t1:2']])
    expect(db.query("SELECT 1 FROM speech_pending WHERE lane='push'").all()).toEqual([])
  })

  it('later:到点这件事看过了 ⇒ 不推、不记账,那一条清掉;问「看过没有」用的是事件那一刻', () => {
    const asked: Array<[string, number]> = []
    const s = setup({ seen: (m, since) => { asked.push([m, since]); return 'desktop' } })
    s.gate.later(done, { at: T0 + 600_000, since: T0, matterId: 't1', ref: 'turn:t1:2' })
    s.advance(600_000)
    s.timers.shift()!.cb()
    expect(s.pushed).toEqual([])
    expect(s.ledger).toEqual([])
    expect(asked).toEqual([['t1', T0]])
    expect(s.db.query("SELECT 1 FROM speech_pending WHERE lane='push'").all()).toEqual([])
  })

  it("later:「待说」那一拍顺手再问门时不提前放它(它在等人看,不是被门压着);被门压着的照旧提前放", async () => {
    const s = setup({ seen: () => null, quietFn: () => false })
    s.gate.later(done, { at: T0 + 600_000, since: T0, matterId: 't1' })
    s.db.query(`INSERT INTO speech_pending(id,lane,chat_id,kind,body,ref,created_at,next_at,expires_at) VALUES('q','push',?,'matter_report',?,'task_done:t2:',?,?,?)`)
      .run(OWNER, JSON.stringify({ ...done, taskId: 't2' }), T0, T0 + 3600_000, T0 + 86_400_000)
    await s.speech.flushPending()
    expect(s.pushed.map(p => p.taskId)).toEqual(['t2'])
  })

  it('later 在免打扰里到点 ⇒ 照 S2 压到时段结束(不丢)', () => {
    const s = setup({ seen: () => null, quiet: true })
    s.gate.later(done, { at: T0 + 600_000, since: T0, matterId: 't1', ref: 'turn:t1:2' })
    s.advance(600_000)
    s.timers.shift()!.cb()
    expect(s.pushed).toEqual([])
    expect(s.ledger.map(e => [e.outcome, e.ref])).toEqual([['deferred', 'turn:t1:2']])
    s.advance(QUIET_END - T0)
    s.timers.shift()!.cb()
    expect(s.pushed).toEqual([done])
  })

  it('later:同一件事来了新的回报(人走了,当场推了;或者又一轮做完 / 没做成)⇒ 等着升级的旧那条作废,不会到点再推一次', () => {
    const s = setup({ seen: () => null })
    s.gate.later(done, { at: T0 + 600_000, since: T0, matterId: 't1' })
    s.gate.push({ ...done, body: '第二轮' })
    expect(s.pushed.map(p => p.body)).toEqual(['第二轮'])
    expect(s.db.query("SELECT 1 FROM speech_pending WHERE lane='push'").all()).toEqual([])
    const failed: PushPayload = { kind: 'task_failed', title: '没做成', body: '修登录', taskId: 't1' }
    s.gate.later(done, { at: T0 + 600_000, since: T0, matterId: 't1' })
    s.gate.later(failed, { at: T0 + 700_000, since: T0, matterId: 't1' })
    expect(s.db.query<{ ref: string }, []>("SELECT ref FROM speech_pending WHERE lane='push'").all().map(r => r.ref)).toEqual(['later:task_failed:t1:'])
  })
})
