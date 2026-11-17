import { describe, expect, it, vi } from 'vitest'
import { makeMwRoute, type RouteMwDeps } from './mw-route'
import { makeCheapAnswerJudge } from './answer-fallback'
import { makeMwTaskReference } from './mw-task-reference'
import type { InboundCtx } from './types'

const providers = () => [
  { id: 'codex', names: ['Codex'], available: true },
  { id: 'claude', names: ['Claude', '克劳德'], available: true },
]
function harness(extra: Partial<RouteMwDeps> = {}) {
  let time = 1, sequence = 0
  const notices: string[] = [], submitted: InboundCtx['msg'][] = []
  const mw = makeMwRoute({ providers, probes: {}, now: () => time, sendMessage: async (_c, text) => { notices.push(text) }, log: () => {}, ...extra })
  const send = async (text: string, origin?: 'desktop', sent = true, consumedDownstream = false) => {
    const ctx: InboundCtx = { msg: { chatId: 'owner', userId: 'owner', text, msgType: 'text', createTimeMs: time, msgId: `m${++sequence}`, accountId: 'test' }, requestId: `r${sequence}`, receivedAtMs: time, ...(origin ? { origin } : {}) }
    await mw(ctx, () => mw.consume(ctx, async () => {
      // 路由之后的别的步骤接住了(降级拦下、额度询问…):不进协调器。
      if (consumedDownstream) { ctx.consumedBy = 'health'; return }
      if (ctx.msg.answerRoute) ctx.msg.answerRoute.enqueued = true
      submitted.push(ctx.msg)
      if (sent && ctx.msg.answerRoute) ctx.msg.answerRoute.state = 'sent'
    }))
    return ctx
  }
  return { send, notices, submitted, advance: (ms: number) => { time += ms } }
}

describe('评审修复', () => {
  it('原句被下游接住没进协调器 ⇒「换成 X 答」如实说不会生效,不假装改好', async () => {
    const h = harness()
    await h.send('让 Codex 回答这个问题：为什么慢', undefined, false, true)
    await h.send('换成 Claude 答')
    expect(h.notices.at(-1)).toContain('请把要回答的原句再说一次')
    expect(h.submitted).toHaveLength(0)
  })

  it('候选按主人说出的先后编号;「X 你帮我说说」也过前置筛', async () => {
    const h = harness()
    await h.send('让 Claude 还是 Codex 来答：1+1')
    expect(h.notices[0]).toMatch(/Claude（1）.*Codex（2）/)
    const h2 = harness()
    await h2.send('让 Codex 还是 Claude 来答：1+1')
    expect(h2.notices[0]).toMatch(/Codex（1）.*Claude（2）/)
  })

  it('「总结 A 和 B 回答失败的原因」不问交给谁', async () => {
    const h = harness()
    await h.send('请总结 Codex 和 Claude 回答失败的原因')
    expect(h.notices.join('')).not.toContain('交给')
    expect(h.submitted).toHaveLength(1)
    expect(h.submitted[0]!.answerTarget?.kind).toBe('cc')
  })
})

describe('共用歧义原句与纠正', () => {
  it.each([undefined, 'desktop'] as const)('两入口歧义问一句，跨入口答名字只交原句一次：%s', async origin => {
    const h = harness()
    await h.send('请 Codex 或 Claude 回答：为什么天空蓝？', origin)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]).toContain('Codex')
    expect(h.notices[0]).toContain('Claude')
    expect(h.notices[0]).toContain('还是我来答')
    expect(h.submitted).toHaveLength(0)
    const selected = await h.send('克劳德', origin ? undefined : 'desktop')
    expect(selected.msg.text).toBe('请 Codex 或 Claude 回答：为什么天空蓝？')
    expect(selected.msg.answerTarget).toMatchObject({ kind: 'oneoff', provider: 'claude', requestId: 'r1' })
    await h.send('Claude')
    expect(h.submitted.filter(m => m.text === '请 Codex 或 Claude 回答：为什么天空蓝？')).toHaveLength(1)
  })
  it.each([['2', 'claude'], ['你来', null]] as const)('选择 %s 绑定原句', async (choice, provider) => {
    const h = harness()
    await h.send('Codex 还是 Claude 说说这个问题')
    const chosen = await h.send(choice)
    expect(chosen.msg.text).toBe('Codex 还是 Claude 说说这个问题')
    expect(chosen.target).toMatchObject(provider ? { kind: 'oneoff', provider } : { kind: 'cc' })
  })
  it('到期与答非所问只处理新句，不回放旧句', async () => {
    for (const expired of [false, true]) {
      const h = harness()
      await h.send('Codex 还是 Claude 说说这个问题')
      if (expired) h.advance(10 * 60_000)
      await h.send(expired ? 'Claude' : '今天有点累')
      await h.send('Claude')
      expect(h.submitted.map(m => m.text)).toEqual([expired ? 'Claude' : '今天有点累', 'Claude'])
    }
  })
  it('选择时人选不可用，原句不交给任何人', async () => {
    let online = true
    const h = harness({ providers: () => providers().map(p => ({ ...p, available: online })) })
    await h.send('Codex 还是 Claude 说说这个问题')
    online = false
    await h.send('Claude')
    expect(h.submitted).toHaveLength(0)
    expect(h.notices.at(-1)).toContain('不可用')
  })
  it('未送出换成 X 答只改原句，下一句回 CC', async () => {
    const h = harness()
    await h.send('Codex 还是 Claude 说说这个问题')
    await h.send('换成 Claude 答')
    expect(h.submitted[0]?.answerTarget).toMatchObject({ kind: 'oneoff', provider: 'claude' })
    expect((await h.send('今天如何')).target?.kind).toBe('cc')
  })
  it('已送出后不是这件 / 换成 X 答不重放，显示已送达', async () => {
    const h = harness()
    await h.send('让 Codex 回答：2+2？')
    await h.send('不是这件')
    await h.send('换成 Claude 答')
    expect(h.submitted).toHaveLength(1)
    expect(h.notices.some(n => n.includes('已送达'))).toBe(true)
  })
  it('跟 CC 说清掉 20 分钟事项焦点及待选，后续普通话回 CC', async () => {
    const ref = makeMwTaskReference({ ownerChatId: () => 'owner', candidates: () => [{ id: 'deadbeef', project: 'sample-project', title: '整理 TODO', path: '/fixture', providerId: 'claude', phase: 'running', updatedAt: 1 }], handleWechat: async () => '已补充', sendMessage: async () => {}, now: () => 1, log: () => {} })
    const mw = makeMwRoute({ providers, probes: { 'task-reference': ref.probe }, clearFocus: ref.clearFocus, sendMessage: async () => {}, log: () => {} })
    const send = async (text: string) => {
      const ctx: InboundCtx = { msg: { chatId: 'owner', userId: 'owner', accountId: 'test', text, msgType: 'text', createTimeMs: 1 }, requestId: text === '跟 CC 说' ? 'correction' : 'original', receivedAtMs: 1 }
      await mw(ctx, () => mw.consume(ctx, () => ref(ctx, async () => {})))
      return ctx
    }
    await send('接下来说整理 TODO 那件')
    expect((await send('再补一行')).target?.kind).toBe('matter')
    await send('跟 CC 说')
    expect((await send('今天有点累')).target?.kind).toBe('cc')
  })
  it('模型只在结构与事项都未定时调用一次，结果仍核当前可用目录', async () => {
    let calls = 0, online = true
    const h = harness({ providers: () => providers().map(p => ({ ...p, available: online })), judge: makeCheapAnswerJudge(async () => { calls++; online = false; return '1' }) })
    expect((await h.send('我想请 Codex 看看这个问题')).target?.kind).toBe('cc')
    expect(calls).toBe(1)
    await h.send('Codex 的额度呢')
    expect(calls).toBe(1)
  })
  it('已有控制响应优先，结构明确不调模型', async () => {
    const judge = vi.fn(async () => 'codex')
    const h = harness({ judge, probes: { command: ctx => ctx.msg.text === '2' } })
    await h.send('让 Codex 回答：2+2？')
    expect(judge).not.toHaveBeenCalled()
    expect((await h.send('2')).intent?.kind).toBe('command')
  })
})

it('事项消费者等待开提醒期间纠正到 CC，原句不再送入旧事项', async () => {
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>(r => { entered = r }), hold = new Promise<void>(r => { release = r })
  const delivered: string[] = [], ordinary: string[] = []
  const ref = makeMwTaskReference({ ownerChatId: () => 'owner', candidates: () => [{ id: 'deadbeef', project: 'sample-project', title: '整理 TODO', path: '/fixture', providerId: 'claude', phase: 'running', updatedAt: 1 }], watchTask: async () => { entered(); await hold }, handleWechat: async (_c, text) => { delivered.push(text); return '已补充' }, sendMessage: async () => {}, now: () => 1, log: () => {} })
  const mw = makeMwRoute({ providers, probes: { 'task-reference': ref.probe }, clearFocus: ref.clearFocus, sendMessage: async () => {}, log: () => {} })
  const send = (text: string) => {
    const ctx: InboundCtx = { msg: { chatId: 'owner', userId: 'owner', accountId: 'test', text, msgType: 'text', createTimeMs: 1 }, requestId: 'fixture', receivedAtMs: 1 }
    return mw(ctx, () => mw.consume(ctx, () => ref(ctx, async () => { ordinary.push(ctx.msg.text) })))
  }
  const original = send('整理 TODO 那件再加一行')
  await ready
  await send('跟 CC 说')
  release(); await original
  expect(delivered).toEqual([])
  expect(ordinary).toEqual(['整理 TODO 那件再加一行'])
})

it('事项探针等模型时说不是这件，过时结果不投递、不重建事项焦点', async () => {
  let resolveJudge!: (r: { taskId: string | null; confident: boolean }) => void, entered!: () => void
  const ready = new Promise<void>(r => { entered = r })
  const delivered: string[] = [], sent: string[] = []
  const ref = makeMwTaskReference({ ownerChatId: () => 'owner', candidates: () => [{ id: 'deadbeef', project: 'sample-project', title: '整理 TODO', path: '/fixture', providerId: 'claude', phase: 'running', updatedAt: 1 }], judge: async () => { entered(); return new Promise(r => { resolveJudge = r }) }, handleWechat: async (_c, text) => { delivered.push(text); return '已补充' }, sendMessage: async () => {}, now: () => 1, log: () => {} })
  const mw = makeMwRoute({ providers, probes: { 'task-reference': ref.probe }, clearFocus: ref.clearFocus, sendMessage: async () => {}, log: () => {} })
  const send = async (text: string) => {
    const ctx: InboundCtx = { msg: { chatId: 'owner', userId: 'owner', accountId: 'test', text, msgType: 'text', createTimeMs: 1 }, requestId: 'fixture', receivedAtMs: 1 }
    await mw(ctx, () => mw.consume(ctx, () => ref(ctx, async () => { if (ctx.msg.answerRoute?.state !== 'cancelled') sent.push(ctx.msg.text) })))
    return ctx
  }
  const original = send('这件继续一下')
  await ready
  await send('不是这件')
  resolveJudge({ taskId: 'deadbeef', confident: true })
  await original
  expect(delivered).toEqual([])
  expect(sent).toEqual([])
  expect((await send('今天有点累')).target?.kind).toBe('cc')
})
