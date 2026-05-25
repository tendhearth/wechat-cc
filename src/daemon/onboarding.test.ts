import { describe, expect, it } from 'vitest'
import { makeOnboardingHandler, type OnboardingDeps } from './onboarding'
import type { InboundMsg } from '../core/prompt-format'

function mkMsg(opts: { chatId?: string; userId?: string; text: string }): InboundMsg {
  return {
    chatId: opts.chatId ?? 'u',
    userId: opts.userId ?? 'u',
    userName: undefined,
    accountId: 'a1',
    text: opts.text,
    msgType: 'text',
    createTimeMs: 0,
  }
}

function makeDeps(opts: {
  knownUsers?: Set<string>
  nowStart?: number
  admins?: Set<string>
  initialBotName?: string | null
} = {}): {
  deps: OnboardingDeps
  sent: string[]
  saved: Array<{ chatId: string; name: string }>
  dispatched: InboundMsg[]
  setNow: (ms: number) => void
  botNameSet: Array<string | null>
  getBotNameLive: () => string | null
} {
  const known = opts.knownUsers ?? new Set<string>()
  const admins = opts.admins ?? new Set<string>()
  let nowMs = opts.nowStart ?? 1_000_000
  let currentBotName: string | null = opts.initialBotName ?? null
  const sent: string[] = []
  const saved: Array<{ chatId: string; name: string }> = []
  const dispatched: InboundMsg[] = []
  const botNameSet: Array<string | null> = []
  const deps: OnboardingDeps = {
    isKnownUser: (uid) => known.has(uid),
    setUserName: async (chatId, name) => { saved.push({ chatId, name }); known.add(chatId) },
    sendMessage: async (_chatId, text) => { sent.push(text) },
    botName: () => 'cc',
    dispatchInbound: async (msg) => { dispatched.push(msg) },
    log: () => {},
    now: () => nowMs,
    isAdmin: (uid) => admins.has(uid),
    getBotName: () => currentBotName,
    setBotName: async (name) => { botNameSet.push(name); currentBotName = name },
  }
  return {
    deps, sent, saved, dispatched, botNameSet,
    setNow: (ms: number) => { nowMs = ms },
    getBotNameLive: () => currentBotName,
  }
}

describe('makeOnboardingHandler', () => {
  it('passes through messages from already-known users (no consume, no send)', async () => {
    const { deps, sent } = makeDeps({ knownUsers: new Set(['u1']) })
    const handler = makeOnboardingHandler(deps)
    const consumed = await handler.handle(mkMsg({ userId: 'u1', chatId: 'u1', text: 'hello' }))
    expect(consumed).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('first contact → consumes message + sends greeting', async () => {
    const { deps, sent } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    const consumed = await handler.handle(mkMsg({ userId: 'u-new', chatId: 'u-new', text: '帮我查个东西' }))
    expect(consumed).toBe(true)
    expect(sent[0]).toMatch(/你好/)
    expect(sent[0]).toMatch(/称呼你/)
    // Mode-aware bot name should appear in the greeting.
    expect(sent[0]).toMatch(/cc/)
  })

  it('second message (within window) → saves nickname + confirms', async () => {
    const { deps, sent, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle(mkMsg({ text: 'first message' }))
    const consumed = await handler.handle(mkMsg({ text: '丸子' }))
    expect(consumed).toBe(true)
    expect(saved).toEqual([{ chatId: 'u', name: '丸子' }])
    expect(sent[1]).toMatch(/好的 丸子/)
    expect(sent[1]).toMatch(/刚才你说「first message」/)
  })

  it('rejects empty / whitespace-only nicknames', async () => {
    const { deps, sent, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle(mkMsg({ text: 'hi' }))
    await handler.handle(mkMsg({ text: '   ' }))
    expect(saved).toHaveLength(0)
    expect(sent[1]).toMatch(/不能为空/)
  })

  it('rejects nicknames over the length cap', async () => {
    const { deps, sent, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle(mkMsg({ text: 'hi' }))
    await handler.handle(mkMsg({ text: 'a'.repeat(50) }))
    expect(saved).toHaveLength(0)
    expect(sent[1]).toMatch(/太长/)
  })

  it('rejects nicknames with disallowed chars', async () => {
    const { deps, sent, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle(mkMsg({ text: 'hi' }))
    await handler.handle(mkMsg({ text: 'hax<script>' }))
    expect(saved).toHaveLength(0)
    expect(sent[1]).toMatch(/只支持/)
  })

  it('after the 30-min window, treats next message as first contact again (re-greet)', async () => {
    const { deps, sent, setNow } = makeDeps({ nowStart: 1_000_000 })
    const handler = makeOnboardingHandler(deps)
    await handler.handle(mkMsg({ text: 'hi' }))
    setNow(1_000_000 + 31 * 60_000)  // 31 min later
    const consumed = await handler.handle(mkMsg({ text: '丸子' }))
    expect(consumed).toBe(true)
    // Second message after timeout = a fresh greeting, not a name accept.
    expect(sent[1]).toMatch(/你好/)
  })

  it('accepts a valid nickname containing CJK + hyphen + alphanumeric', async () => {
    const { deps, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle(mkMsg({ text: 'hi' }))
    await handler.handle(mkMsg({ text: '丸子-2' }))
    expect(saved[0]!.name).toBe('丸子-2')
  })

  it('drops a duplicate inbound with the same trigger text within 1.5s window', async () => {
    let nameSet: string | null = null
    const sent: string[] = []
    let clock = 1_000_000

    const handler = makeOnboardingHandler({
      isKnownUser: () => false,
      setUserName: async (_chat, name) => { nameSet = name },
      sendMessage: async (_chat, text) => { sent.push(text) },
      botName: () => 'cc',
      dispatchInbound: async () => {},
      log: () => {},
      now: () => clock,
      isAdmin: () => false,
      getBotName: () => null,
      setBotName: async () => {},
    })

    const r1 = await handler.handle(mkMsg({ userId: 'u1', chatId: 'c1', text: '你好' }))
    expect(r1).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('称呼你')

    clock += 100
    const r2 = await handler.handle(mkMsg({ userId: 'u1', chatId: 'c1', text: '你好' }))
    expect(r2).toBe(true)
    expect(nameSet).toBeNull()
    expect(sent).toHaveLength(1)
  })

  it('still accepts a different text as nickname within the 1.5s window', async () => {
    let nameSet: string | null = null
    const sent: string[] = []
    let clock = 1_000_000

    const handler = makeOnboardingHandler({
      isKnownUser: () => false,
      setUserName: async (_chat, name) => { nameSet = name },
      sendMessage: async (_chat, text) => { sent.push(text) },
      botName: () => 'cc',
      dispatchInbound: async () => {},
      log: () => {},
      now: () => clock,
      isAdmin: () => false,
      getBotName: () => null,
      setBotName: async () => {},
    })

    await handler.handle(mkMsg({ userId: 'u1', chatId: 'c1', text: '你好' }))
    clock += 100
    const r2 = await handler.handle(mkMsg({ userId: 'u1', chatId: 'c1', text: 'Nate' }))
    expect(r2).toBe(true)
    expect(nameSet).toBe('Nate')
  })

  it('echoes + dispatches the first message after nickname is captured', async () => {
    const dispatched: InboundMsg[] = []
    const sent: string[] = []
    const handler = makeOnboardingHandler({
      isKnownUser: () => false,
      setUserName: async () => {},
      sendMessage: async (_c, t) => { sent.push(t) },
      botName: () => 'cc',
      dispatchInbound: async (msg) => { dispatched.push(msg) },
      log: () => {},
      isAdmin: () => false,
      getBotName: () => null,
      setBotName: async () => {},
    })

    await handler.handle({
      chatId: 'c1', userId: 'u1', userName: undefined, accountId: 'a1',
      text: '为什么天空是蓝色的', msgType: 'text', createTimeMs: 0,
    })
    await handler.handle({
      chatId: 'c1', userId: 'u1', userName: undefined, accountId: 'a1',
      text: 'Nate', msgType: 'text', createTimeMs: 0,
    })

    // Allow the void-dispatch promise to flush.
    await new Promise(r => setTimeout(r, 10))

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.text).toBe('为什么天空是蓝色的')
    expect(sent.at(-1)).toContain('刚才你说「为什么天空是蓝色的」')
  })

  describe('admin two-step flow', () => {
    it('fresh admin: user_name → bot_name → ack + redispatch', async () => {
      const { deps, sent, saved, botNameSet, dispatched, getBotNameLive } = makeDeps({
        admins: new Set(['admin-1']),
      })
      const handler = makeOnboardingHandler(deps)

      // turn 1: admin sends greeting → ask user_name
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '你好' }))
      expect(sent[0]).toMatch(/你好/)
      expect(sent[0]).toMatch(/称呼你/)

      // turn 2: admin replies with user_name → store, ask bot_name
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'Nate' }))
      expect(saved).toEqual([{ chatId: 'admin-1', name: 'Nate' }])
      expect(sent[1]).toMatch(/好的 Nate/)
      expect(sent[1]).toMatch(/怎么叫我|称呼我/)
      // bot_name not yet stored
      expect(botNameSet).toHaveLength(0)

      // turn 3: admin replies with bot_name → store, ack with original trigger, redispatch
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '小希' }))
      expect(botNameSet).toEqual(['小希'])
      expect(getBotNameLive()).toBe('小希')
      expect(sent[2]).toMatch(/刚才你说「你好」/)
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0]!.text).toBe('你好')
    })

    it('fresh non-admin: only user_name asked, no bot_name turn', async () => {
      const { deps, sent, saved, botNameSet, dispatched } = makeDeps()
      const handler = makeOnboardingHandler(deps)

      await handler.handle(mkMsg({ userId: 'guest-1', chatId: 'guest-1', text: '在吗' }))
      await handler.handle(mkMsg({ userId: 'guest-1', chatId: 'guest-1', text: 'Alex' }))

      expect(saved).toEqual([{ chatId: 'guest-1', name: 'Alex' }])
      expect(botNameSet).toHaveLength(0)
      // sent[0] = greeting, sent[1] = ack-with-quote. No third turn.
      expect(sent).toHaveLength(2)
      expect(sent[1]).toMatch(/刚才你说「在吗」/)
      expect(dispatched).toHaveLength(1)
    })

    it('admin already has bot_name set → skips bot_name ask', async () => {
      const { deps, saved, botNameSet, dispatched } = makeDeps({
        admins: new Set(['admin-1']),
        initialBotName: '小希',
      })
      const handler = makeOnboardingHandler(deps)

      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '你好' }))
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'Nate' }))

      expect(saved).toEqual([{ chatId: 'admin-1', name: 'Nate' }])
      expect(botNameSet).toHaveLength(0)
      expect(dispatched).toHaveLength(1)
    })

    it('admin says skip word at bot_name turn → setBotName(null) + fallback ack', async () => {
      const { deps, sent, botNameSet, dispatched } = makeDeps({
        admins: new Set(['admin-1']),
      })
      const handler = makeOnboardingHandler(deps)

      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '你好' }))
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'Nate' }))
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '跳过' }))

      expect(botNameSet).toEqual([null])
      expect(sent[2]).toMatch(/继续用|默认/)
      expect(dispatched).toHaveLength(1)
    })

    it('admin sends invalid bot_name → retry, no setBotName, state preserved', async () => {
      const { deps, sent, botNameSet } = makeDeps({
        admins: new Set(['admin-1']),
      })
      const handler = makeOnboardingHandler(deps)

      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '你好' }))
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'Nate' }))
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '🌸' }))

      expect(botNameSet).toHaveLength(0)
      expect(sent[2]).toMatch(/不行|再发一次/)
      // Now a valid name resolves the turn.
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '小希' }))
      expect(botNameSet).toEqual(['小希'])
    })

    it('bot_name set mid-flow via /name → next inbound clears awaiting + redispatches', async () => {
      const { deps, sent, dispatched, botNameSet } = makeDeps({
        admins: new Set(['admin-1']),
      })
      const handler = makeOnboardingHandler(deps)

      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '你好' }))
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'Nate' }))
      // Simulate /name being handled by mw-admin (deps.setBotName called outside onboarding).
      await deps.setBotName('小希')
      // Next inbound: onboarding should detect getBotName() !== null and exit awaiting cleanly.
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'whatever' }))

      expect(botNameSet).toEqual(['小希'])  // only the /name call, not a second setBotName from onboarding
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0]!.text).toBe('你好')
      expect(sent.at(-1)).toMatch(/刚才你说「你好」/)
    })

    it('admin sends bot_name matching their turn-1 trigger text (within dedup window) → still consumed properly', async () => {
      const { deps, sent, botNameSet, dispatched } = makeDeps({
        admins: new Set(['admin-1']),
        nowStart: 1_000_000,
      })
      const handler = makeOnboardingHandler(deps)

      // Turn 1: admin sends '你好' → ask user_name
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '你好' }))
      // Turn 2: admin replies 'Nate' → ask bot_name (phase reset to NOW)
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: 'Nate' }))
      // Turn 3 IMMEDIATELY (within DEDUP_WINDOW_MS): admin names the bot '你好'.
      // Should NOT be eaten by dedup as a "duplicate trigger" — the trigger
      // for the bot_name phase is 'Nate', not '你好'.
      await handler.handle(mkMsg({ userId: 'admin-1', chatId: 'admin-1', text: '你好' }))

      expect(botNameSet).toEqual(['你好'])
      expect(dispatched).toHaveLength(1)
      expect(sent.at(-1)).toMatch(/刚才你说「你好」/)
    })
  })
})
