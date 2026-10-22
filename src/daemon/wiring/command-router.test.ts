import { describe, expect, it, vi } from 'vitest'
import { makeCommandRouter, type CommandRouterDeps } from './command-router'
import type { InboundMsg } from '../../core/prompt-format'
import { COMMAND_EXAMPLES, CHAT } from '../inbound/command-corpus'

function msg(text: string, chatId = 'owner@im.wechat'): InboundMsg {
  return { chatId, userId: chatId, text, msgType: 'text', createTimeMs: 0, accountId: 'acct' }
}

function baseDeps(over: Partial<CommandRouterDeps> = {}): CommandRouterDeps {
  return {
    isAdmin: () => true,
    loadAccess: () => ({ admins: ['owner@im.wechat'] }),
    appendAllowFrom: vi.fn(),
    sendAssistantText: vi.fn(),
    guestRequests: {
      resolve: vi.fn(() => null),
      listPending: vi.fn(() => []),
      createInvite: vi.fn(() => ({ code: '999999', expiresAt: 0 })),
    } as never,
    hydrateRoute: vi.fn(),
    sendMessage: vi.fn(async () => ({})),
    redispatch: vi.fn(async () => {}),
    log: vi.fn(),
    now: () => 1_000_000,
    ...over,
  }
}

describe('command-router', () => {
  it('a non-admin chat handles nothing (falls through)', async () => {
    const r = makeCommandRouter(baseDeps({ isAdmin: () => false }))
    expect(await r.tryHandle(msg('允许 123456'))).toBe(false)
    expect(await r.tryHandle(msg('派 a1b2c3'))).toBe(false)
  })

  it('a plain message (no command) falls through', async () => {
    const r = makeCommandRouter(baseDeps())
    expect(await r.tryHandle(msg('今天天气不错'))).toBe(false)
  })

  // 派 / 取消 心愿 (spec 2026-09-04-wish-postcard) — the router resolves the
  // ref against `social.wish` and renders EVERY outcome itself.
  function wishDeps(over: {
    resolve?: ReturnType<typeof vi.fn>
    send?: ReturnType<typeof vi.fn>
    cancel?: ReturnType<typeof vi.fn>
  } = {}) {
    const resolveRef = over.resolve ?? vi.fn(() => ({ ok: true, id: 'w-full-id' }))
    const send = over.send ?? vi.fn(async () => ({ ok: true, sentTo: 3 }))
    const cancel = over.cancel ?? vi.fn(() => ({ ok: true, status: 'cancelled' }))
    const sendAssistantText = vi.fn()
    const deps = baseDeps({
      sendAssistantText,
      social: { wish: { resolveRef, send, cancel }, penpal: { startVisit: vi.fn() } } as never,
    })
    return { deps, resolveRef, send, cancel, sendAssistantText }
  }
  const said = (fn: ReturnType<typeof vi.fn>): string => String(fn.mock.calls[0]?.[1] ?? '')

  it('派 <ref> resolves among draft, sends, and reports how many friends got it', async () => {
    const { deps, resolveRef, send, sendAssistantText } = wishDeps()
    const r = makeCommandRouter(deps)
    expect(await r.tryHandle(msg('派 a1b2c3'))).toBe(true)
    expect(resolveRef).toHaveBeenCalledWith('a1b2c3', ['draft'])
    expect(send).toHaveBeenCalledWith('w-full-id')
    expect(said(sendAssistantText)).toBe('已派给 3 个朋友,等回音…')
  })

  it('派 with no open channels / too many open wishes renders each reason', async () => {
    const noCh = wishDeps({ send: vi.fn(async () => ({ ok: false, reason: 'no_channels' })) })
    expect(await makeCommandRouter(noCh.deps).tryHandle(msg('派 a1b2c3'))).toBe(true)
    expect(said(noCh.sendAssistantText)).toBe('你还没有开着信道的朋友,先配对')

    const tooMany = wishDeps({ send: vi.fn(async () => ({ ok: false, reason: 'too_many_open' })) })
    expect(await makeCommandRouter(tooMany.deps).tryHandle(msg('派 a1b2c3'))).toBe(true)
    expect(said(tooMany.sendAssistantText)).toBe('同时最多 3 条心愿,先取消一条')
  })

  it('取消 <ref> resolves among draft+open and renders 已作废 / 已关掉', async () => {
    const dropped = wishDeps({ cancel: vi.fn(() => ({ ok: true, status: 'cancelled' })) })
    expect(await makeCommandRouter(dropped.deps).tryHandle(msg('取消 a1b2c3'))).toBe(true)
    expect(dropped.resolveRef).toHaveBeenCalledWith('a1b2c3', ['draft', 'open'])
    expect(dropped.cancel).toHaveBeenCalledWith('w-full-id')
    expect(said(dropped.sendAssistantText)).toBe('已作废')

    const closed = wishDeps({ cancel: vi.fn(() => ({ ok: true, status: 'closed' })) })
    expect(await makeCommandRouter(closed.deps).tryHandle(msg('取消 a1b2c3'))).toBe(true)
    expect(said(closed.sendAssistantText)).toBe('已关掉,之后的回音还会进背包')
  })

  it('an ambiguous / unknown ref never reaches send, and says so', async () => {
    const amb = wishDeps({ resolve: vi.fn(() => ({ ok: false, reason: 'ambiguous' })) })
    expect(await makeCommandRouter(amb.deps).tryHandle(msg('派 a1b2c3'))).toBe(true)
    expect(amb.send).not.toHaveBeenCalled()
    expect(said(amb.sendAssistantText)).toBe('有多条心愿匹配这个开头,请给更长的编号')

    const gone = wishDeps({ resolve: vi.fn(() => ({ ok: false, reason: 'not_found' })) })
    expect(await makeCommandRouter(gone.deps).tryHandle(msg('取消 a1b2c3'))).toBe(true)
    expect(gone.cancel).not.toHaveBeenCalled()
    expect(said(gone.sendAssistantText)).toBe('这条心愿不存在或已处理')
  })

  it('派 is inert without boot.social, and a delegate command never matches', async () => {
    const noSocial = makeCommandRouter(baseDeps({ social: undefined }))
    expect(await noSocial.tryHandle(msg('派 a1b2c3'))).toBe(false)
    // id-charset guard: 派 <hand> 跑 <task> is the delegate imperative.
    const { deps, resolveRef } = wishDeps()
    expect(await makeCommandRouter(deps).tryHandle(msg('派 家里 跑 拉日志'))).toBe(false)
    expect(resolveRef).not.toHaveBeenCalled()
  })

  it('回信 sends a letter via boot.penpal', async () => {
    const sendLetter = vi.fn(async () => ({ ok: true }))
    const r = makeCommandRouter(baseDeps({ penpal: { sendLetter } }))
    expect(await r.tryHandle(msg('回信 ch1 你好呀'))).toBe(true)
    expect(sendLetter).toHaveBeenCalledWith('ch1', '你好呀')
  })

  it('guest 允许 resolves the code, allowlists, hydrates, welcomes, redispatches', async () => {
    const resolve = vi.fn(() => ({ chatId: 'guest@im.wechat', accountId: 'acct', contextToken: 'ctx', firstMsg: msg('在吗', 'guest@im.wechat') }))
    const appendAllowFrom = vi.fn()
    const hydrateRoute = vi.fn()
    const sendMessage = vi.fn(async () => ({}))
    const redispatch = vi.fn(async () => {})
    const deps = baseDeps({
      guestRequests: { resolve, listPending: vi.fn(() => []), createInvite: vi.fn() } as never,
      appendAllowFrom, hydrateRoute, sendMessage, redispatch,
    })
    const r = makeCommandRouter(deps)
    expect(await r.tryHandle(msg('允许 123456'))).toBe(true)
    expect(resolve).toHaveBeenCalledWith('123456', 'allowed')
    expect(appendAllowFrom).toHaveBeenCalledWith('guest@im.wechat')
    expect(hydrateRoute).toHaveBeenCalledWith('guest@im.wechat', 'acct', 'ctx')
    expect(sendMessage).toHaveBeenCalledWith('guest@im.wechat', '主人同意啦!')
    expect(redispatch).toHaveBeenCalledTimes(1)
  })

  it('guest path is closed on an admins-empty install (escalation guard)', async () => {
    // legacy install: admins empty → isAdmin may be true via allowFrom, but
    // the guest-command block must NOT fire (an approved guest could else
    // mint invites / approve others). Falls through instead.
    const resolve = vi.fn(() => null)
    const r = makeCommandRouter(baseDeps({
      loadAccess: () => ({ admins: [] }),
      guestRequests: { resolve, listPending: vi.fn(() => []), createInvite: vi.fn() } as never,
    }))
    expect(await r.tryHandle(msg('允许 123456'))).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('待批准 lists pending requests', async () => {
    const send = vi.fn()
    const r = makeCommandRouter(baseDeps({
      sendAssistantText: send,
      guestRequests: {
        resolve: vi.fn(), createInvite: vi.fn(),
        listPending: vi.fn(() => [{ code: '111111', chatId: 'g@im.wechat', firstMsg: msg('借钱', 'g@im.wechat'), createdAt: 1_000_000 }]),
      } as never,
    }))
    expect(await r.tryHandle(msg('待批准'))).toBe(true)
    expect(send).toHaveBeenCalled()
    expect(String(send.mock.calls[0]![1])).toContain('111111')
  })
})

describe('command-router — 认识 / 同意 / 不了', () => {
  const mkIntro = () => ({ request: vi.fn(), accept: vi.fn(), decline: vi.fn() })
  const run = async (text: string, intro: ReturnType<typeof mkIntro>) => {
    const say = vi.fn()
    const deps = baseDeps({ sendAssistantText: say, social: { wish: { resolveRef: vi.fn(), send: vi.fn(), cancel: vi.fn() }, penpal: { startVisit: vi.fn() }, intro } as never })
    const handled = await makeCommandRouter(deps).tryHandle(msg(text))
    return { handled, said: say.mock.calls.map(c => c[1]) }
  }
  it('认识:ok / not_found / ambiguous / already_requested / send_failed 各一句', async () => {
    const intro = mkIntro()
    intro.request.mockResolvedValueOnce({ ok: true, replyId: 'ab12cd34' })
    expect((await run('认识 ab12', intro)).said).toEqual(['已经托朋友去问了,对方点头我就告诉你'])
    for (const [reason, copy] of [['not_found', '没有这张明信片'], ['ambiguous', '有多张匹配,请给更长的编号'], ['already_requested', '已经在问了,等对方点头'], ['send_failed', '没送出去,稍后再试']] as const) {
      intro.request.mockResolvedValueOnce({ ok: false, reason })
      expect((await run('认识 ab12', intro)).said).toEqual([copy])
    }
  })
  it('同意 / 不了', async () => {
    const intro = mkIntro()
    intro.accept.mockResolvedValueOnce({ ok: true, replyId: 'x' })
    expect((await run('同意 ab', intro)).said).toEqual(['好,我把名片递过去了'])
    intro.decline.mockResolvedValueOnce({ ok: true, replyId: 'x' })
    expect((await run('不了 ab', intro)).said).toEqual(['好,我回了不了'])
    intro.accept.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    expect((await run('同意 ab', intro)).said).toEqual(['没有这条邀约(可能过期了)'])
  })
  it('非管理员 / social 没接 → 不处理(落回普通对话)', async () => {
    const intro = mkIntro()
    const deps = baseDeps({ social: undefined as never })
    expect(await makeCommandRouter(deps).tryHandle(msg('认识 ab12'))).toBe(false)
    expect(intro.request).not.toHaveBeenCalled()
  })
})

// 重构第二批步 2:router 进 CommandRegistry,要一个只读的 probe —— 它认领的必须恰好是 tryHandle 会处理的。
describe('command-router · probe(只读,与 tryHandle 一致)', () => {
  const ok = () => vi.fn(async () => ({ ok: true, id: 'x', channel: 'c', sentTo: 1, status: 'cancelled', code: '123456', expiresAt: 0, peer: { name: 'p' } }))
  const social = { wish: { send: ok(), cancel: vi.fn(() => ({ ok: true, status: 'cancelled' })), resolveRef: vi.fn(() => ({ ok: true, id: 'w' })) }, penpal: { startVisit: ok() }, intro: { request: ok(), accept: ok(), decline: ok() } } as never
  const cases = ['串门', '派 a1b2c3', '取消 a1b2c3', '认识 ab12', '回信 ch1 你好', '配对', '配对 123456', '允许 123456', '邀请码', '待批准', '今天天气不错', '同意你的看法']
  it('with every feature wired: probe(msg) === (tryHandle handled it), and probe has no side effects', async () => {
    const deps = baseDeps({ social, penpal: { sendLetter: vi.fn(async () => ({ ok: true })) }, pairing: new Proxy({}, { get: () => ok() }) as never })
    const r = makeCommandRouter(deps)
    for (const t of cases) {
      const claimed = r.probe(msg(t))
      expect(deps.sendAssistantText, `probe(${t}) 不许说话`).not.toHaveBeenCalled()
      expect(claimed, t).toBe(await makeCommandRouter(baseDeps({ social, penpal: { sendLetter: vi.fn(async () => ({ ok: true })) }, pairing: new Proxy({}, { get: () => ok() }) as never })).tryHandle(msg(t)))
    }
  })
  it('unwired features and non-admins: probe is false exactly when tryHandle falls through', async () => {
    for (const over of [{}, { isAdmin: () => false }, { loadAccess: () => ({ admins: [] }) }] as Partial<CommandRouterDeps>[]) {
      for (const t of cases) expect(makeCommandRouter(baseDeps(over)).probe(msg(t)), `${JSON.stringify(Object.keys(over))} ${t}`).toBe(await makeCommandRouter(baseDeps(over)).tryHandle(msg(t)))
    }
  })
})

// 评审 #472:probe 与 tryHandle 的闸门是手抄成一致的,漂了就会「probe 说不认、tryHandle 本来会认」⇒ 这句话进了模型,没人报错。
// 用整份命令语料 × 几种接线组合过一遍:probe 为 false 时 tryHandle 一定也是 false(反过来也要一致)。
describe('command-router · probe / tryHandle 不漂(整份语料)', () => {
  it('for every corpus sentence and wiring combo, probe === tryHandle', async () => {
    const ok = () => vi.fn(async () => ({ ok: true, id: 'x', channel: 'c', sentTo: 1, status: 'cancelled', code: '123456', expiresAt: 0, peer: { name: 'p' } }))
    const wired = () => ({ social: { wish: { send: ok(), cancel: vi.fn(() => ({ ok: true, status: 'cancelled' })), resolveRef: vi.fn(() => ({ ok: true, id: 'w' })) }, penpal: { startVisit: ok() }, intro: { request: ok(), accept: ok(), decline: ok() } } as never, penpal: { sendLetter: ok() } as never, pairing: new Proxy({}, { get: () => ok() }) as never })
    const combos: Array<() => Partial<CommandRouterDeps>> = [() => ({}), () => wired(), () => ({ ...wired(), isAdmin: () => false }), () => ({ ...wired(), loadAccess: () => ({ admins: [] }) })]
    for (const combo of combos) for (const t of [...COMMAND_EXAMPLES, ...CHAT]) {
      const claimed = makeCommandRouter(baseDeps(combo())).probe(msg(t))
      expect(claimed, `${t}`).toBe(await makeCommandRouter(baseDeps(combo())).tryHandle(msg(t)))
    }
  })
})

describe('社交不在时明说(第三批 3b 第 3 步 3-2):不再悄悄落成普通对话', () => {
  const said = (d: CommandRouterDeps) => (d.sendAssistantText as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1])
  it('关着 ⇒ 「社交现在关着,去设置里打开」;串门 / 派 / 认识 / 回信 都是', async () => {
    // 命令的写法取自 inbound/command-corpus.ts(真实例句)
    // 派 / 取消 的心愿引用只认十六进制(parseSeekCommand 的字符集,挡住「派 家里 跑 …」这种委派命令)
    for (const t of ['串门', '/visit', '派 ab12', '取消 ab12', '认识 ab12', '不了 ab12', '回信 ch1 你好']) {
      const d = baseDeps({ socialState: () => 'off' })
      const r = makeCommandRouter(d)
      expect(r.probe(msg(t))).toBe(true)
      expect(await r.tryHandle(msg(t))).toBe(true)
      expect(said(d)).toEqual(['社交现在关着,去设置里打开。'])
    }
  })
  it('**开着却没起来 ⇒ 说没起来、去哪看原因,不劝他去开**(坏了 ≠ 关了)', async () => {
    const d = baseDeps({ socialState: () => 'degraded' })
    expect(await makeCommandRouter(d).tryHandle(msg('串门'))).toBe(true)
    expect(said(d)).toEqual(['社交开着,但现在没起来,原因在「CC 现在怎么样」里。'])
  })
  it('刚打开、还没重启 ⇒ 说重启后才生效(不说「没起来」)', async () => {
    const d = baseDeps({ socialState: () => 'pending' })
    expect(await makeCommandRouter(d).tryHandle(msg('串门'))).toBe(true)
    expect(said(d)).toEqual(['社交刚打开,重启 CC 后才生效。'])
  })
  it('不是社交命令 ⇒ 不拦,也不去读社交状态(probe 每条消息都过)', async () => {
    const socialState = vi.fn(() => 'off' as const)
    const r = makeCommandRouter(baseDeps({ socialState }))
    // 普通句子,包括提到串门的(command-corpus 里「不该当命令」的那几句)
    for (const t of ['今天天气怎么样', '串门好玩吗', '配对成功了吗', '派 家里 跑 拉日志']) expect(r.probe(msg(t))).toBe(false)
    expect(socialState).not.toHaveBeenCalled()
  })
  it('**「同意 07」不拦**:「同意」也是权限卡的放行词;社交不在时不会有待回的介绍,这句只可能是在批权限', () => {
    const r = makeCommandRouter(baseDeps({ socialState: () => 'off' }))
    expect(r.probe(msg('同意 07'))).toBe(false)
    expect(r.probe(msg('同意 ab12'))).toBe(false)
  })
  it('不是主人 ⇒ 不拦', () => {
    expect(makeCommandRouter(baseDeps({ isAdmin: () => false, socialState: () => 'off' })).probe(msg('串门'))).toBe(false)
  })
  it('没接 socialState ⇒ 老行为(落成普通对话)', () => {
    expect(makeCommandRouter(baseDeps()).probe(msg('串门'))).toBe(false)
  })
})

describe('控制命令一条一行(第三批 3d):任何一句话最多一行认领 —— 先后顺序因此无关紧要', () => {
  const social = { wish: { send: vi.fn(), cancel: vi.fn(), resolveRef: vi.fn() }, penpal: { startVisit: vi.fn() }, intro: { request: vi.fn(), accept: vi.fn(), decline: vi.fn() } } as unknown as CommandRouterDeps['social']
  const penpal = { sendLetter: vi.fn() } as unknown as CommandRouterDeps['penpal']
  const pairing = { start: vi.fn(), accept: vi.fn() } as unknown as CommandRouterDeps['pairing']
  const setups: Array<[string, Partial<CommandRouterDeps>]> = [
    ['社交开着', { social, penpal, pairing, socialState: () => 'ok' }],
    ['社交关着', { pairing, socialState: () => 'off' }],
    ['社交坏了', { socialState: () => 'degraded' }],
    ['什么都没接', {}],
  ]
  it('语料里的每一句,在每种状态下,认领它的控制命令行不超过一行(以后加一行跟别的抢同一句话,这里红)', async () => {
    const { makeControlCommands } = await import('./command-router')
    const overlaps: string[] = []
    for (const [label, over] of setups) {
      const rows = makeControlCommands(baseDeps(over))
      for (const text of [...COMMAND_EXAMPLES, ...CHAT]) {
        const claimed = rows.filter(r => { try { return r.probe(msg(text)) } catch { return false } }).map(r => r.id)
        if (claimed.length > 1) overlaps.push(`${label}:「${text}」 ⇒ ${claimed.join(', ')}`)
      }
    }
    expect(overlaps).toEqual([])
  })
  it('id 都是 control.*、group 都是 control(trace / consumedBy 读的不变)', async () => {
    const { makeControlCommands } = await import('./command-router')
    const rows = makeControlCommands(baseDeps())
    expect(rows.map(r => r.id)).toEqual(['control.social-off', 'control.visit', 'control.letter', 'control.pair', 'control.wish', 'control.intro', 'control.guest'])
    expect(new Set(rows.map(r => r.group))).toEqual(new Set(['control']))
  })
})
