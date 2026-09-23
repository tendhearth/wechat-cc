import { describe, it, expect, vi } from 'vitest'
import { makeSelfChangeGlue, type SelfChangeGlueDeps } from './self-change-glue'

type Resolver = (d: 'allow' | 'deny' | 'timeout' | 'undelivered') => void

function harness(over: Partial<SelfChangeGlueDeps> = {}) {
  let now = 1_000
  const sent: Array<[string, string]> = []
  const registered: Array<{ hash: string; timeoutMs: number; chatId: string; prompt: string }> = []
  const resolvers: Resolver[] = []
  const sweeps: number[] = []
  const logs: string[] = []
  const codes = new Map<string, string>()
  let n = 0
  const deps: SelfChangeGlueDeps = {
    ownerChatId: () => 'owner@chat',
    sendMessage: async (c, t) => { sent.push([c, t]); return { msgId: 'm1' } },
    registerPending: (hash, timeoutMs, meta) => {
      registered.push({ hash, timeoutMs, ...meta })
      // 照 PendingPermissions.register 的顺序:落表是同步的,所以码在返回 promise 前就有了。
      codes.set(hash, String(registered.length).padStart(2, '0'))
      return new Promise((res) => resolvers.push(res))
    },
    sweepPending: () => { sweeps.push(now) },
    codeOf: (h) => codes.get(h) ?? null,
    newHash: () => `h${++n}`,
    now: () => now,
    log: (l) => { logs.push(l) },
    ...over,
  }
  return {
    glue: makeSelfChangeGlue(deps),
    sent, registered, resolvers, sweeps, logs,
    advance: (ms: number) => { now += ms },
  }
}

describe('self-change glue', () => {
  it('notice:发给主人;没有主人 chat ⇒ owner_chat_unknown', async () => {
    const h = harness()
    expect(await h.glue.notice('第 3 步跑完了')).toEqual({ ok: true })
    expect(h.sent).toEqual([['owner@chat', '第 3 步跑完了']])

    const none = harness({ ownerChatId: () => null })
    expect(await none.glue.notice('x')).toEqual({ ok: false, error: 'owner_chat_unknown' })
    expect(none.sent).toEqual([])
  })

  it('notice:sendMessage 抛错或回 { error } 都算 send_failed(别假装送到了)', async () => {
    const thrown = harness({ sendMessage: async () => { throw new Error('boom') } })
    expect(await thrown.glue.notice('x')).toEqual({ ok: false, error: 'send_failed' })
    const errored = harness({ sendMessage: async () => ({ msgId: '', error: 'errcode=-2' }) })
    expect(await errored.glue.notice('x')).toEqual({ ok: false, error: 'send_failed' })
  })

  it('ask:自己登记 + 自己发卡,回 hash / 码 / delivered;卡片带「怎么回」那一行', async () => {
    const h = harness()
    const r = await h.glue.ask('要不要把这版合进 dev?', 600_000)
    expect(r).toEqual({ ok: true, hash: 'h1', code: '01', delivered: true })
    expect(h.registered).toEqual([{ hash: 'h1', timeoutMs: 600_000, chatId: 'owner@chat', prompt: '要不要把这版合进 dev?' }])
    const [chatId, card] = h.sent[0]!
    expect(chatId).toBe('owner@chat')
    expect(card).toContain('要不要把这版合进 dev?')
    // 措辞跟工具权限卡共用 howToReplyLine —— 主人认的就是这一行。
    expect(card).toContain('回「y」放行、「n」拒绝')
    expect(card).toContain('「y 01」')
    expect(card).toContain('600 秒内有效')
  })

  it('没有码(登记处 99 条挤满了)⇒ 卡片退回带 hash 的那种写法', async () => {
    const h = harness({ codeOf: () => null })
    const r = await h.glue.ask('p', 60_000)
    expect(r).toMatchObject({ ok: true, code: null })
    expect(h.sent[0]![1]).toContain('回「y h1」放行')
  })

  it('ask:没有主人 chat ⇒ owner_chat_unknown,不登记也不发卡', async () => {
    const h = harness({ ownerChatId: () => null })
    expect(await h.glue.ask('p', 60_000)).toEqual({ ok: false, error: 'owner_chat_unknown' })
    expect(h.registered).toEqual([])
    expect(h.sent).toEqual([])
  })

  // 这一条是本轮改动的理由(2026-09-18 真机 errcode=-2):卡片送不到的时候,
  // 条目必须**留在登记处** —— 桌面权限卡 / `self change --approve` 还能拍。
  it('发卡失败 ⇒ delivered:false,但条目照样在,桌面拍板仍然算数', async () => {
    for (const bad of [
      async () => ({ msgId: '', error: 'ilink/sendmessage errcode=-2: prepare failed' }),
      async () => { throw new Error('socket hang up') },
    ] as Array<SelfChangeGlueDeps['sendMessage']>) {
      const h = harness({ sendMessage: bad })
      const r = await h.glue.ask('拍板卡', 600_000)
      expect(r).toEqual({ ok: true, hash: 'h1', code: '01', delivered: false })
      // 登记处里还有这一条 —— 没有 fail(hash)。
      expect(h.registered).toHaveLength(1)
      expect(h.glue.decision('h1')).toBe('pending')
      expect(h.logs).toHaveLength(1)
      // 桌面那边 consume 之后,登记处的 promise 落定 ⇒ CLI 查到 allow。
      h.resolvers[0]!('allow')
      await Promise.resolve()
      expect(h.glue.decision('h1')).toBe('allow')
    }
  })

  it('到点排一次 sweep(不然 promise 要等全局那 30 秒才落成 timeout)', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      await h.glue.ask('p', 60_000)
      expect(h.sweeps).toEqual([])
      vi.advanceTimersByTime(60_002)
      expect(h.sweeps).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('decision:pending → 主人拍板后变 allow;没问过的 hash 是 unknown', async () => {
    const h = harness()
    const r = await h.glue.ask('p', 60_000)
    expect(r.ok && h.glue.decision(r.hash)).toBe('pending')
    h.resolvers[0]!('allow')
    await Promise.resolve()
    expect(h.glue.decision('h1')).toBe('allow')
    expect(h.glue.decision('没问过')).toBe('unknown')
  })

  it('decision:timeout / undelivered 照样传出去(CLI 要据此收工,不能当成还在等)', async () => {
    const h = harness()
    await h.glue.ask('p', 60_000)
    await h.glue.ask('q', 60_000)
    h.resolvers[0]!('timeout')
    h.resolvers[1]!('undelivered')
    await Promise.resolve()
    expect(h.glue.decision('h1')).toBe('timeout')
    expect(h.glue.decision('h2')).toBe('undelivered')
  })

  it('落定的条目 retainMs 之后清掉 ⇒ unknown;还没落定的不清(主人可能想很久)', async () => {
    const h = harness({ retainMs: 60_000 })
    await h.glue.ask('p', 600_000)
    await h.glue.ask('q', 600_000)
    h.resolvers[0]!('deny')
    await Promise.resolve()
    expect(h.glue.decision('h1')).toBe('deny')
    h.advance(59_000)
    expect(h.glue.decision('h1')).toBe('deny')
    h.advance(2_000)
    expect(h.glue.decision('h1')).toBe('unknown')
    expect(h.glue.decision('h2')).toBe('pending')
  })

  it('registerPending 自己抛了 ⇒ 记成 undelivered,不会永远 pending', async () => {
    const registerPending = vi.fn(async () => { throw new Error('adapter gone') })
    const h = harness({ registerPending: registerPending as unknown as SelfChangeGlueDeps['registerPending'] })
    const r = await h.glue.ask('p', 60_000)
    expect(r.ok).toBe(true)
    await Promise.resolve(); await Promise.resolve()
    expect(h.glue.decision('h1')).toBe('undelivered')
  })
})
