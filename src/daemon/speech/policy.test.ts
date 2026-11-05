import { describe, expect, it, vi } from 'vitest'
import { openTestDb } from '../../lib/db'
import type { ProactiveOutbound, ProactiveTurn } from '../companion/proactive-channel'
import { makeSpeechPolicy, type SpeechLedgerEntry } from './policy'

const OWNER = 'owner@im.wechat'
function fakeOutbound(deliverable = true) {
  const sent: string[] = []
  let finished = 0
  const turn: ProactiveTurn = {
    sendText: async (_c, t) => { sent.push(t); return { msgId: 'm' } },
    channel: () => (sent.length ? 'wechat' : null), textOnly: () => false,
    sendAttachment: async () => false, sendSticker: async () => false, finish: () => { finished++ },
  }
  const out: ProactiveOutbound = { appDeliverable: () => false, canDeliver: () => deliverable, open: vi.fn(() => turn), sendOnce: async () => ({ ok: true }) }
  return { out, sent, finished: () => finished }
}
function setup(o: { care?: 'off' | 'low'; quietEnds?: number | null; deliverable?: boolean } = {}) {
  const ob = fakeOutbound(o.deliverable ?? true)
  const ledger: SpeechLedgerEntry[] = []
  const policy = makeSpeechPolicy({
    care: () => o.care ?? 'low',
    quietEndsAt: () => o.quietEnds ?? null,
    outbound: ob.out, ledger: e => { ledger.push(e) }, log: () => {},
    now: () => Date.parse('2026-10-21T10:00:00.000Z'),
  })
  return { policy, ledger, ...ob }
}

describe('policy.say —— CC 开口只有这一道门', () => {
  it('allow ⇒ 开一轮交给生产者,发完收尾;记一行账(只有种类和原因,没有正文)', async () => {
    const s = setup()
    const r = await s.policy.say({ kind: 'companion', chatId: OWNER }, async t => { await t.sendText(OWNER, '在忙吗') })
    expect(r).toEqual({ allow: true, channel: 'wechat' })
    expect(s.sent).toEqual(['在忙吗'])
    expect(s.finished()).toBe(1)
    expect(s.ledger).toEqual([{ kind: 'companion', origin: 'initiative', chatId: OWNER, outcome: 'allowed', reason: null, channel: 'wechat', ts: '2026-10-21T10:00:00.000Z' }])
    expect(JSON.stringify(s.ledger)).not.toContain('在忙吗')
  })
  it('**被拒 / 被推后 ⇒ 生产者根本不跑**(贵的事——调模型——放在判定之后),也不开通道', async () => {
    const s = setup({ care: 'off' })
    const produce = vi.fn(async () => {})
    expect(await s.policy.say({ kind: 'guest_visit', chatId: OWNER }, produce)).toEqual({ drop: true, reason: 'care_off' })
    expect(produce).not.toHaveBeenCalled()
    expect(s.out.open).not.toHaveBeenCalled()
    expect(s.ledger[0]).toMatchObject({ outcome: 'dropped', reason: 'care_off', channel: null })
    const q = setup({ quietEnds: Date.parse('2026-10-21T23:00:00.000Z') })
    expect(await q.policy.say({ kind: 'matter_report', chatId: OWNER }, produce)).toEqual({ defer: true, until: '2026-10-21T23:00:00.000Z', reason: 'quiet_hours' })
    expect(produce).not.toHaveBeenCalled()
    expect(q.ledger[0]).toMatchObject({ outcome: 'deferred', reason: 'quiet_hours' })
  })
  it('两条路都送不到 ⇒ defer,不开通道、不跑生产者(no-retry-storm)', async () => {
    const s = setup({ deliverable: false })
    const produce = vi.fn(async () => {})
    expect(await s.policy.say({ kind: 'permission_ask', chatId: OWNER }, produce)).toEqual({ defer: true, reason: 'undeliverable' })
    expect(produce).not.toHaveBeenCalled()
  })
  it('调用方带了这一拍的时刻 ⇒ 按它判免打扰、记账(伙伴一拍用的是自己的 nowIso,不是墙上的钟)', async () => {
    const seen: number[] = []
    const ob = fakeOutbound()
    const ledger: SpeechLedgerEntry[] = []
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: (_c, nowMs) => { seen.push(nowMs); return null }, outbound: ob.out, ledger: e => { ledger.push(e) }, log: () => {}, now: () => 0 })
    await policy.say({ kind: 'companion', chatId: OWNER, nowMs: Date.parse('2026-05-13T10:00:00.000Z') }, async () => {})
    expect(seen).toEqual([Date.parse('2026-05-13T10:00:00.000Z')])
    expect(ledger[0]!.ts).toBe('2026-05-13T10:00:00.000Z')
  })
  it('perKind / scheduled 原样交给判定', async () => {
    const s = setup({ quietEnds: Date.parse('2026-10-21T23:00:00.000Z') })
    expect(await s.policy.say({ kind: 'brief', chatId: OWNER, scheduled: true }, async () => {})).toEqual({ drop: true, reason: 'skipped:quiet' })
    const t = setup()
    expect(await t.policy.say({ kind: 'sticker', chatId: OWNER, perKind: { ok: false, reason: 'sticker_cooldown' } }, async () => {})).toEqual({ drop: true, reason: 'sticker_cooldown' })
  })
  it('生产者抛错 ⇒ 照样收尾、抛给调用方;账上记 failed', async () => {
    const s = setup()
    await expect(s.policy.say({ kind: 'letter', chatId: OWNER }, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(s.finished()).toBe(1)
    expect(s.ledger[0]).toMatchObject({ outcome: 'failed', reason: 'boom' })
  })
  it('**同一条话、同一个理由连着被推后 ⇒ 账一小时只记一次**;放行 / 被拒以后重新算(整合者评审 #521:一夜免打扰 × 每拍会把账淹掉)', async () => {
    let now = Date.parse('2026-10-21T15:00:00.000Z')
    let quiet = true
    const ob = fakeOutbound()
    const ledger: SpeechLedgerEntry[] = []
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => (quiet ? now + 8 * 3600_000 : null), outbound: ob.out, ledger: e => { ledger.push(e) }, log: () => {}, now: () => now })
    for (let i = 0; i < 20; i++) { await policy.say({ kind: 'matter_report', chatId: OWNER }, async () => {}); now += 60_000 }   // 20 分钟,每分钟一拍
    expect(ledger.map(e => e.outcome)).toEqual(['deferred'])
    await policy.say({ kind: 'memory_notice', chatId: OWNER }, async () => {})                                                  // 别的种类单独记
    expect(ledger).toHaveLength(2)
    now += 60 * 60_000
    await policy.say({ kind: 'matter_report', chatId: OWNER }, async () => {})                                                  // 过了一小时再记一次
    expect(ledger.filter(e => e.kind === 'matter_report').map(e => e.outcome)).toEqual(['deferred', 'deferred'])
    quiet = false
    await policy.say({ kind: 'matter_report', chatId: OWNER }, async () => {})                                                  // 放行照记
    quiet = true
    await policy.say({ kind: 'matter_report', chatId: OWNER }, async () => {})                                                  // 放行之后又被推后 ⇒ 重新算,马上记
    expect(ledger.filter(e => e.kind === 'matter_report').map(e => e.outcome)).toEqual(['deferred', 'deferred', 'allowed', 'deferred'])
  })
  it('带事件键(S3a):两件不同的事同一小时里被推后各记一行(键带上);同一件事连着推后照旧一小时一次', async () => {
    const now = Date.parse('2026-10-21T15:00:00.000Z')
    const ob = fakeOutbound()
    const ledger: SpeechLedgerEntry[] = []
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => now + 8 * 3600_000, outbound: ob.out, ledger: e => { ledger.push(e) }, log: () => {}, now: () => now })
    for (const ref of ['turn:a:1', 'turn:b:1', 'turn:a:1', 'turn:b:1']) await policy.say({ kind: 'matter_report', chatId: OWNER, ref }, async () => {})
    expect(ledger.map(e => [e.outcome, e.ref])).toEqual([['deferred', 'turn:a:1'], ['deferred', 'turn:b:1']])
    expect(policy.ask({ kind: 'matter_report', chatId: OWNER, ref: 'turn:c:1' }, { channel: 'app', deliverable: true })).toMatchObject({ defer: true })
    expect(ledger.at(-1)).toMatchObject({ outcome: 'deferred', ref: 'turn:c:1' })
  })
  it('带事件键的推后记录过了一小时就清(S3a):攒过上限时顺手清掉旧的,之后同一件事再被推后照样记', async () => {
    let now = Date.parse('2026-10-21T15:00:00.000Z')
    const ob = fakeOutbound()
    const ledger: SpeechLedgerEntry[] = []
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => now + 8 * 3600_000, outbound: ob.out, ledger: e => { ledger.push(e) }, log: () => {}, now: () => now })
    for (let i = 0; i < 300; i++) policy.ask({ kind: 'matter_report', chatId: OWNER, ref: `turn:x${i}:1` }, { channel: 'app', deliverable: true })
    expect(ledger).toHaveLength(300)
    now += 61 * 60_000
    policy.ask({ kind: 'matter_report', chatId: OWNER, ref: 'turn:fresh:1' }, { channel: 'app', deliverable: true })
    policy.ask({ kind: 'matter_report', chatId: OWNER, ref: 'turn:x0:1' }, { channel: 'app', deliverable: true })
    expect(ledger.slice(-2).map(e => e.ref)).toEqual(['turn:fresh:1', 'turn:x0:1'])
  })
  it('记账抛错不影响开口', async () => {
    const ob = fakeOutbound()
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => null, outbound: ob.out, ledger: () => { throw new Error('disk') }, log: () => {} })
    expect(await policy.say({ kind: 'companion', chatId: OWNER }, async t => { await t.sendText(OWNER, 'x') })).toMatchObject({ allow: true })
  })
})

describe('tell / flushPending —— 推后的 report 落盘待说,补说走 say 开的那一轮(降级时落到 App)', () => {
  it('**微信降级 + 补说 ⇒ 落到 App**(整合者评审:不能只发微信)', async () => {
    const { makeProactiveOutbound } = await import('../companion/proactive-channel')
    const { makePendingNotices } = await import('./pending-notices')
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const recorded: string[] = []
    let degraded = false, quiet = true
    const outbound = makeProactiveOutbound({
      wechatDegraded: () => degraded, wechatClosedSince: () => null,
      sendWechat: async () => ({ msgId: 'w' }),
      app: () => ({ deliverable: () => true, record: async (_c, t) => { recorded.push(t); return true }, push: () => {} }),
      log: () => {},
    })
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: (_c, n) => (quiet ? n + 3600_000 : null), outbound, log: () => {}, pending: makePendingNotices({ db: openTestDb(), log: () => {} }) })
    expect(await policy.tell('job_notice', OWNER, '定时 j1 连续失败,先停了')).toBe(false)   // 免打扰 ⇒ 推后、入队
    quiet = false; degraded = true
    await policy.flushPending()
    expect(recorded).toEqual(['定时 j1 连续失败,先停了'])
    await policy.flushPending()
    expect(recorded).toHaveLength(1)
  })
  it('initiative 推后不入队;report 推后入队;放行 ⇒ true', async () => {
    const { makePendingNotices } = await import('./pending-notices')
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const pending = makePendingNotices({ db: openTestDb(), log: () => {} })
    const ob = fakeOutbound()
    let quiet = true
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: (_c, n) => (quiet ? n + 3600_000 : null), outbound: ob.out, log: () => {}, pending })
    await policy.tell('companion', OWNER, '在忙吗')
    await policy.tell('boot_notice', OWNER, '开机有几样没起来')
    expect(pending.groups()).toEqual([expect.objectContaining({ chatId: OWNER, items: [expect.objectContaining({ kind: 'boot_notice' })] })])
    quiet = false
    expect(await policy.tell('upgrade_notice', OWNER, '升好了')).toBe(true)
  })
})

describe('待说队列不丢话(整合者评审 #531)', () => {
  const mk = async (o: { sendErr: () => string | undefined; onSend?: () => void | Promise<void> }) => {
    const { makePendingNotices } = await import('./pending-notices')
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const sent: string[] = []
    let now = Date.parse('2026-10-21T10:00:00.000Z')
    const outbound = { appDeliverable: () => false, canDeliver: () => true, sendOnce: async () => ({ ok: true }),
      open: () => ({ sendText: async (_c: string, t: string) => { await o.onSend?.(); const e = o.sendErr(); if (e) return { msgId: '', error: e }; sent.push(t); return { msgId: 'm' } }, channel: () => 'wechat' as const, textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }) }
    const pending = makePendingNotices({ db: openTestDb(), log: () => {} })
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => null, outbound, log: () => {}, pending, now: () => now })
    return { policy, pending, sent, advance: (ms: number) => { now += ms } }
  }
  it('① 门放行、发失败(回 error)⇒ 入队;下一拍说出来;外层照旧拿到 false', async () => {
    let err: string | undefined = 'network down'
    const t = await mk({ sendErr: () => err })
    expect(await t.policy.tell('job_notice', OWNER, '定时 j1 停了')).toBe(false)
    expect(t.pending.groups()[0]!.items.map(i => i.text)).toEqual(['定时 j1 停了'])
    err = undefined
    t.advance(10 * 60_000)
    await t.policy.flushPending()
    expect(t.sent).toEqual(['定时 j1 停了'])
  })
  it('① initiative 发失败 ⇒ 不入队(没声明 keepMs 的那些)', async () => {
    const t = await mk({ sendErr: () => 'down' })
    await t.policy.tell('companion', OWNER, '在忙吗')
    expect(t.pending.groups()).toEqual([])
  })
  it('② flush 发送途中又进来一条 ⇒ 那条留在队列里,下一拍说', async () => {
    let addDuringSend: (() => void) | null = null
    const t = await mk({ sendErr: () => undefined, onSend: () => { addDuringSend?.(); addDuringSend = null } })
    t.pending.add({ id: 'a', kind: 'job_notice', chatId: OWNER, text: '第一条', at: 'x' })
    addDuringSend = () => t.pending.add({ id: 'b', kind: 'boot_notice', chatId: OWNER, text: '路上进来的', at: 'y' })
    await t.policy.flushPending()
    expect(t.sent).toEqual(['第一条'])
    expect(t.pending.groups()[0]!.items.map(i => i.text)).toEqual(['路上进来的'])
    await t.policy.flushPending()
    expect(t.sent).toEqual(['第一条', '路上进来的'])
  })
  it('补说一直失败 ⇒ 按对话指数退避,用的是共用那一份 backoffMs(1 → 2 → 4 分钟 …,封顶 60 分钟;S2a),不每拍都撞', async () => {
    let tries = 0
    const t = await mk({ sendErr: () => { tries++; return 'still down' } })
    t.pending.add({ id: 'a', kind: 'job_notice', chatId: OWNER, text: 'x', at: 'x' })
    await t.policy.flushPending(); expect(tries).toBe(1)
    t.advance(59_000); await t.policy.flushPending(); expect(tries).toBe(1)        // 退避中(1 分钟)
    t.advance(1_000); await t.policy.flushPending(); expect(tries).toBe(2)         // 满 1 分钟
    t.advance(119_000); await t.policy.flushPending(); expect(tries).toBe(2)       // 第二次退避 2 分钟
    t.advance(1_000); await t.policy.flushPending(); expect(tries).toBe(3)
    for (let i = 0; i < 10; i++) { t.advance(3_600_000); await t.policy.flushPending() }
    expect(tries).toBe(13)                                                          // 封顶 60 分钟:每小时最多一次
    t.advance(3_599_000); await t.policy.flushPending(); expect(tries).toBe(13)
  })
})

describe('补说一次只跑一拍(S2a,沙盒抓到的)', () => {
  it('上一拍的补说还在发(线上那一层 1 秒 × 3 次要 2 秒多)⇒ 这一拍不再起一份,不叠着撞线', async () => {
    const { makePendingNotices } = await import('./pending-notices')
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    let sends = 0
    let release!: () => void
    const inFlight = new Promise<void>(r => { release = r })
    const outbound = { appDeliverable: () => false, canDeliver: () => true, sendOnce: async () => ({ ok: true }),
      open: () => ({ sendText: async () => { sends++; await inFlight; return { msgId: '', error: 'down' } }, channel: () => 'wechat' as const, textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }) }
    const pending = makePendingNotices({ db: openTestDb(), log: () => {} })
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => null, outbound, log: () => {}, pending })
    pending.add({ id: 'a', kind: 'job_notice', chatId: OWNER, text: 'x', at: 'x' })
    const first = policy.flushPending()
    await vi.waitFor(() => expect(sends).toBe(1))
    for (let i = 0; i < 5; i++) await Promise.race([policy.flushPending(), new Promise(r => setTimeout(r, 10))])
    expect(sends).toBe(1)
    release(); await first
    await policy.flushPending()
    expect(sends).toBe(1)   // 失败了 ⇒ 进退避,下一拍也不撞
  })
})

describe('待说队列在主库(S2b):过期作废、每拍上限、退避重启不归零', () => {
  const mk = async (o: { sendErr?: () => string | undefined; db?: ReturnType<typeof openTestDb>; start?: number } = {}) => {
    const { makePendingNotices } = await import('./pending-notices')
    const sent: Array<[string, string]> = []
    const ledger: SpeechLedgerEntry[] = []
    let now = o.start ?? Date.parse('2026-11-04T10:00:00.000Z')
    let tries = 0
    const outbound = { appDeliverable: () => false, canDeliver: () => true, sendOnce: async () => ({ ok: true }),
      open: () => ({ sendText: async (c: string, t: string) => { tries++; const e = o.sendErr?.(); if (e) return { msgId: '', error: e }; sent.push([c, t]); return { msgId: 'm' } }, channel: () => 'wechat' as const, textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }) }
    const db = o.db ?? openTestDb()
    const pending = makePendingNotices({ db, log: () => {}, now: () => now })
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => null, outbound, ledger: e => { ledger.push(e) }, log: () => {}, pending, now: () => now })
    return { policy, pending, sent, ledger, db, tries: () => tries, now: () => now, advance: (ms: number) => { now += ms } }
  }
  it('过期了 ⇒ 不说,记一行账「过期作废」(outcome=dropped、reason=expired,不记正文)', async () => {
    const t = await mk()
    t.pending.add({ id: 'a', kind: 'job_notice', chatId: OWNER, text: '定时 j1 停了', expiresAt: t.now() + 1000 })
    t.advance(1000)
    await t.policy.flushPending()
    expect(t.sent).toEqual([])
    expect(t.ledger).toEqual([expect.objectContaining({ kind: 'job_notice', origin: 'report', chatId: OWNER, outcome: 'dropped', reason: 'expired', channel: null })])
    expect(JSON.stringify(t.ledger)).not.toContain('定时 j1')
    await t.policy.flushPending()
    expect(t.ledger).toHaveLength(1)   // 只记一次
  })
  it('每一拍最多补说 3 条对话(每条对话合成一句),剩下的下一拍', async () => {
    const t = await mk()
    for (let i = 1; i <= 5; i++) t.pending.add({ id: `n${i}`, kind: 'social_mail', chatId: `chat-${i}`, text: `信 ${i}`, at: new Date(t.now() + i).toISOString() })
    t.pending.add({ id: 'n1b', kind: 'social_result', chatId: 'chat-1', text: '介绍成了', at: new Date(t.now() + 9).toISOString() })
    await t.policy.flushPending()
    expect(t.sent.map(([c]) => c)).toEqual(['chat-1', 'chat-2', 'chat-3'])
    expect(t.sent[0]![1]).toContain('刚才没顾上跟你说的几件事')
    await t.policy.flushPending()
    expect(t.sent.map(([c]) => c)).toEqual(['chat-1', 'chat-2', 'chat-3', 'chat-4', 'chat-5'])
  })
  it('补说失败的退避记在行上:daemon 重启以后(新的一份门)不会马上又撞一次', async () => {
    const a = await mk({ sendErr: () => 'down' })
    a.pending.add({ id: 'a', kind: 'job_notice', chatId: OWNER, text: 'x' })
    await a.policy.flushPending()
    expect(a.tries()).toBe(1)
    const b = await mk({ sendErr: () => undefined, db: a.db, start: a.now() + 30_000 })   // 重启,半分钟后
    await b.policy.flushPending()
    expect(b.tries()).toBe(0)
    b.advance(30_000)
    await b.policy.flushPending()
    expect(b.sent).toEqual([[OWNER, 'x']])
  })
})

describe('CC 自己的那几样推后也补(S2c):新贴纸 6 小时、见闻 24 小时、一次最多一条见闻', () => {
  const mk = async (o: { care?: () => 'off' | 'low'; quiet?: () => boolean; sendFile?: (c: string, p: string) => Promise<boolean> } = {}) => {
    const { makePendingNotices } = await import('./pending-notices')
    const out: string[] = []
    const ledger: SpeechLedgerEntry[] = []
    const now = Date.parse('2026-11-04T10:00:00.000Z')
    const outbound = { appDeliverable: () => false, canDeliver: () => true, sendOnce: async () => ({ ok: true }),
      open: () => ({ sendText: async (_c: string, t: string) => { out.push(`text:${t}`); return { msgId: 'm' } }, channel: () => 'wechat' as const, textOnly: () => false, sendAttachment: async () => false, sendSticker: async (_c: string, tag: string) => { out.push(`sticker:${tag}`); return true }, finish: () => {} }) }
    const db = openTestDb()
    const pending = makePendingNotices({ db, log: () => {}, now: () => now })
    const policy = makeSpeechPolicy({ care: o.care ?? (() => 'low'), quietEndsAt: (_c, n) => (o.quiet?.() ? n + 3600_000 : null), outbound, ledger: e => { ledger.push(e) }, log: () => {}, pending, now: () => now, ...(o.sendFile ? { sendFile: o.sendFile } : {}) })
    return { policy, pending, out, ledger, db }
  }
  it('keep 只收声明了留多久的:sticker 6 小时、social_story 24 小时;companion / 带码的卡不收', async () => {
    const t = await mk()
    expect(t.policy.keep({ kind: 'sticker', chatId: OWNER, text: 's' })).toBe(true)
    expect(t.policy.keep({ kind: 'social_story', chatId: OWNER, text: 'v' })).toBe(true)
    expect(t.policy.keep({ kind: 'companion', chatId: OWNER, text: 'c' })).toBe(false)
    expect(t.policy.keep({ kind: 'permission_ask', chatId: OWNER, text: 'y 07' })).toBe(false)
    const base = Date.parse('2026-11-04T10:00:00.000Z')
    expect(t.db.query('SELECT kind, expires_at - ? AS ttl FROM speech_pending ORDER BY rowid').all(base)).toEqual([{ kind: 'sticker', ttl: 6 * 3600_000 }, { kind: 'social_story', ttl: 24 * 3600_000 }])
  })
  it('跟回报同一条对话 ⇒ 回报照旧合成一句;CC 自己的各按自己的种类问门、各自发(带图的先发图)', async () => {
    const t = await mk()
    t.pending.add({ id: 'r', kind: 'job_notice', chatId: OWNER, text: '定时停了' })
    t.policy.keep({ kind: 'sticker', chatId: OWNER, text: '我画了张新表情', attach: { sticker: { mood: '开心', path: '/lib/happy.png' } } })
    await t.policy.flushPending()
    expect(t.out).toEqual(['text:定时停了', 'sticker:开心', 'text:我画了张新表情'])
    expect(t.ledger.filter(e => e.outcome === 'allowed').map(e => e.kind)).toEqual(['job_notice', 'sticker'])
  })
  it('见闻一次最多一条:留最新那条补说,更早的记 dropped / story_limit、不补', async () => {
    const t = await mk()
    t.pending.add({ id: 'a', kind: 'social_story', chatId: OWNER, text: '去老王家', at: '2026-11-04T09:00:00.000Z' })
    t.pending.add({ id: 'b', kind: 'social_story', chatId: OWNER, text: '去小李家', at: '2026-11-04T09:30:00.000Z' })
    await t.policy.flushPending(); await t.policy.flushPending()
    expect(t.out).toEqual(['text:去小李家'])
    expect(t.ledger.find(e => e.reason === 'story_limit')).toMatchObject({ kind: 'social_story', outcome: 'dropped' })
  })
  it('补的时候别烦我开着 ⇒ CC 自己的那几样作罢(不留着等),回报照说', async () => {
    let care: 'off' | 'low' = 'low'
    const t = await mk({ care: () => care })
    t.pending.add({ id: 'r', kind: 'job_notice', chatId: OWNER, text: '定时停了' })
    t.policy.keep({ kind: 'social_story', chatId: OWNER, text: '去老王家' })
    care = 'off'
    await t.policy.flushPending()
    expect(t.out).toEqual(['text:定时停了'])
    expect(t.db.query('SELECT COUNT(*) AS n FROM speech_pending').get()).toEqual({ n: 0 })
  })
  it('一条对话只压着 CC 自己的那几样、而且挤掉过一些 ⇒ 不单说「还有 N 件更早的」;发失败也照样按行退避(Codex 评审)', async () => {
    let fail = true
    const { makePendingNotices } = await import('./pending-notices')
    const db = openTestDb()
    let now = Date.parse('2026-11-04T10:00:00.000Z')
    let tries = 0
    const outbound = { appDeliverable: () => false, canDeliver: () => true, sendOnce: async () => ({ ok: true }),
      open: () => ({ sendText: async () => { tries++; return fail ? { msgId: '', error: 'down' } : { msgId: 'm' } }, channel: () => 'wechat' as const, textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => true, finish: () => {} }) }
    const pending = makePendingNotices({ db, log: () => {}, now: () => now })
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => null, outbound, log: () => {}, pending, now: () => now })
    for (let i = 0; i < 22; i++) policy.keep({ kind: 'sticker', chatId: OWNER, text: `新表情 ${i}` })
    await policy.flushPending()
    expect(tries).toBe(1)                     // 只试了第一样 CC 自己的,失败 ⇒ 这一拍停
    now += 30_000
    await policy.flushPending()
    expect(tries).toBe(1)                     // 退避记在行上:不每拍都撞
    fail = false
    now += 30_000
    await policy.flushPending()
    expect(tries).toBe(4)                     // 每拍上限 3 句,没有单说「还有 N 件更早的」那一句
  })
  it('明信片(只有图):补的时候走 sendFile;发不出去 ⇒ 作罢(背包里照样有)', async () => {
    const files: string[] = []
    const t = await mk({ sendFile: async (_c, p) => { files.push(p); return true } })
    t.policy.keep({ kind: 'social_story', chatId: OWNER, text: '', attach: { file: '/tmp/postcard.png' } })
    await t.policy.flushPending()
    expect(files).toEqual(['/tmp/postcard.png'])
    expect(t.out).toEqual([])
    const u = await mk({ sendFile: async () => false })
    u.policy.keep({ kind: 'social_story', chatId: OWNER, text: '', attach: { file: '/tmp/postcard.png' } })
    await u.policy.flushPending()
    expect(u.db.query('SELECT COUNT(*) AS n FROM speech_pending').get()).toEqual({ n: 0 })
  })
})

describe('带会过期码的卡不进待说队列(整合者评审 #533)', () => {
  it('permission_ask / self_change_ask 没送到 ⇒ 不入队;social_ask(介绍一直有效)照样入队', async () => {
    const { makePendingNotices } = await import('./pending-notices')
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const pending = makePendingNotices({ db: openTestDb(), log: () => {} })
    const ob = fakeOutbound(false)   // 两条路都送不到 ⇒ 门推后
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => null, outbound: ob.out, log: () => {}, pending })
    await policy.tell('permission_ask', OWNER, '要不要放行?回 y 07')
    await policy.tell('self_change_ask', OWNER, '合进 dev?回 y 08')
    await policy.tell('social_ask', OWNER, '老王的朋友想认识你')
    expect(pending.groups()[0]!.items.map(i => i.kind)).toEqual(['social_ask'])
  })
})

describe('tell 的自带 send 回 false ⇒ 算没说出去(sendAssistantText 发不出去时回 false,不抛)', () => {
  it('回 false ⇒ tell 回 false、report 入队;回 true / 不回东西 ⇒ 算说了', async () => {
    const { makePendingNotices } = await import('./pending-notices')
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
    const pending = makePendingNotices({ db: openTestDb(), log: () => {} })
    const ob = fakeOutbound()
    const policy = makeSpeechPolicy({ care: () => 'low', quietEndsAt: () => null, outbound: ob.out, log: () => {}, pending })
    expect(await policy.tell('social_mail', OWNER, '来信了', async () => false)).toBe(false)
    expect(pending.groups()[0]!.items.map(i => i.text)).toEqual(['来信了'])
    expect(await policy.tell('social_mail', OWNER, 'a', async () => true)).toBe(true)
    expect(await policy.tell('social_mail', OWNER, 'b', async () => undefined)).toBe(true)
  })
})

describe('policy.ask —— 只问门、不开一轮(App 原生推送)', () => {
  it('放行 ⇒ 记 allowed + 调用方给的通道,不开 proactive 那一轮;免打扰里 report 推后、blocking 照放', () => {
    const s = setup()
    expect(s.policy.ask({ kind: 'matter_report', chatId: OWNER }, { channel: 'app', deliverable: true })).toEqual({ allow: true, channel: 'app' })
    expect(s.out.open).not.toHaveBeenCalled()
    expect(s.ledger[0]).toMatchObject({ outcome: 'allowed', channel: 'app' })
    const q = setup({ quietEnds: Date.parse('2026-10-21T23:00:00.000Z') })
    expect(q.policy.ask({ kind: 'matter_report', chatId: OWNER }, { channel: 'app', deliverable: true })).toMatchObject({ defer: true, reason: 'quiet_hours' })
    expect(q.policy.ask({ kind: 'permission_ask', chatId: OWNER }, { channel: 'app', deliverable: true })).toEqual({ allow: true, channel: 'app' })
  })
  it('deliverable 用调用方给的,不看微信', () => {
    const s = setup({ deliverable: false })
    expect(s.policy.ask({ kind: 'matter_report', chatId: OWNER }, { channel: 'app', deliverable: true })).toEqual({ allow: true, channel: 'app' })
    expect(s.policy.ask({ kind: 'matter_report', chatId: OWNER }, { channel: 'app', deliverable: false })).toMatchObject({ defer: true, reason: 'undeliverable' })
  })
})

describe('policy.peek —— 只判不记账、不开一轮(S1:花钱之前先问一声)', () => {
  it('和 say 同一套判法:关心档关 ⇒ drop;免打扰 ⇒ defer;送不到 ⇒ defer;都好 ⇒ allow。一行账都不记、一轮都不开', () => {
    expect(setup({ care: 'off' }).policy.peek({ kind: 'companion', chatId: OWNER })).toEqual({ drop: true, reason: 'care_off' })
    expect(setup({ quietEnds: Date.parse('2026-10-21T22:00:00.000Z') }).policy.peek({ kind: 'companion', chatId: OWNER })).toEqual({ defer: true, until: '2026-10-21T22:00:00.000Z', reason: 'quiet_hours' })
    expect(setup({ deliverable: false }).policy.peek({ kind: 'companion', chatId: OWNER })).toEqual({ defer: true, reason: 'undeliverable' })
    const s = setup()
    expect(s.policy.peek({ kind: 'companion', chatId: OWNER })).toEqual({ allow: true })
    expect(s.ledger).toEqual([])
    expect(s.out.open).not.toHaveBeenCalled()
  })
})
