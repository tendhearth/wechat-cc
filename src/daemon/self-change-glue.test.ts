import { describe, it, expect, vi } from 'vitest'
import { makeSelfChangeGlue, type SelfChangeGlueDeps } from './self-change-glue'

type Resolver = (d: 'allow' | 'deny' | 'timeout' | 'undelivered') => void

function harness(over: Partial<SelfChangeGlueDeps> = {}) {
  let now = 1_000
  const sent: Array<[string, string]> = []
  const asked: Array<{ chatId: string; prompt: string; hash: string; timeoutMs: number }> = []
  const resolvers: Resolver[] = []
  const codes = new Map<string, string>()
  let n = 0
  const deps: SelfChangeGlueDeps = {
    ownerChatId: () => 'owner@chat',
    sendMessage: async (c, t) => { sent.push([c, t]); return { msgId: 'm1' } },
    askUser: (chatId, prompt, hash, timeoutMs) => {
      asked.push({ chatId, prompt, hash, timeoutMs })
      // 照 ilink-glue.ts:417 的顺序:register 是同步第一句,所以码在返回 promise 前就有了。
      codes.set(hash, String(asked.length).padStart(2, '0'))
      return new Promise((res) => resolvers.push(res))
    },
    codeOf: (h) => codes.get(h) ?? null,
    newHash: () => `h${++n}`,
    now: () => now,
    ...over,
  }
  return {
    glue: makeSelfChangeGlue(deps),
    sent, asked, resolvers,
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

  it('ask:返回 hash + 码(码在 askUser 同步 register 之后立刻可读),timeoutMs 原样传下去', async () => {
    const h = harness()
    const r = await h.glue.ask('要不要把这版合进 dev?', 600_000)
    expect(r).toEqual({ ok: true, hash: 'h1', code: '01' })
    expect(h.asked).toEqual([{ chatId: 'owner@chat', prompt: '要不要把这版合进 dev?', hash: 'h1', timeoutMs: 600_000 }])
  })

  it('ask:没有主人 chat ⇒ owner_chat_unknown,不发卡', async () => {
    const h = harness({ ownerChatId: () => null })
    expect(await h.glue.ask('p', 60_000)).toEqual({ ok: false, error: 'owner_chat_unknown' })
    expect(h.asked).toEqual([])
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

  it('askUser 自己抛了 ⇒ 记成 undelivered,不会永远 pending', async () => {
    const askUser = vi.fn(async () => { throw new Error('adapter gone') })
    const h = harness({ askUser: askUser as unknown as SelfChangeGlueDeps['askUser'] })
    const r = await h.glue.ask('p', 60_000)
    expect(r.ok).toBe(true)
    await Promise.resolve(); await Promise.resolve()
    expect(h.glue.decision('h1')).toBe('undelivered')
  })
})
