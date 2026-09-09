import { describe, expect, it, vi } from 'vitest'
import { makeModeCommands } from './mode-commands'
import type { Mode, ProviderId } from '../core/conversation'
import type { InboundMsg } from '../core/prompt-format'
import type { UserTier } from '../core/user-tier'

function inbound(text: string, chatId = 'chat-1'): InboundMsg {
  return { chatId, userId: chatId, text, msgType: 'text', createTimeMs: 0, accountId: 'a' }
}

function setup(opts: {
  registered?: ProviderId[]
  defaultProviderId?: ProviderId
  initialMode?: Mode
  initialUserName?: string
  isAdmin?: (userId: string) => boolean
  tier?: UserTier
  config?: { openaiBaseUrl?: string; openaiModel?: string; openaiAliases?: Record<string, string>; cheapEvalProvider?: string; trusted_providers?: string[] }
  models?: { models: string[]; error?: string; fromCache?: boolean }
  notes?: Partial<Record<ProviderId, string>>
} = {}) {
  const registered = opts.registered ?? ['claude', 'codex']
  const set = vi.fn<(chatId: string, mode: Mode) => void>()
  let stored: Mode | null = opts.initialMode ?? null
  let storedName: { chat: string; name: string } | null = null
  const sentMessages: Array<[string, string]> = []
  const sendMessage = vi.fn(async (chatId: string, text: string) => {
    sentMessages.push([chatId, text])
    return { msgId: 'm-1' }
  })
  // /api list · alias · /set cheap 的读写面(内存版 agent-config)
  const cfg: { openaiBaseUrl?: string; openaiModel?: string; openaiAliases?: Record<string, string>; cheapEvalProvider?: string; trusted_providers?: string[] } = { ...(opts.config ?? {}) }
  const setOpenaiAlias = vi.fn((alias: string, model: string | null) => {
    const next = { ...(cfg.openaiAliases ?? {}) }
    if (model === null) delete next[alias]; else next[alias] = model
    cfg.openaiAliases = next
  })
  const setConfig = vi.fn(async (key: string, value: string) => {
    if (key === 'cheap_eval_provider') { if (value === 'auto') delete cfg.cheapEvalProvider; else cfg.cheapEvalProvider = value; return { ok: true as const } }
    if (key === 'trusted_providers') { if (value === 'all' || value.trim() === '') delete cfg.trusted_providers; else cfg.trusted_providers = value.split(',').map(x => x.trim()).filter(Boolean); return { ok: true as const } }
    return { ok: false as const, error: 'unknown_key' }
  })
  const openaiModels = { list: vi.fn(async () => opts.models ?? { models: ['DeepSeek', 'KIMI', 'Qwen3.8'] }) }
  // 旧的 pinModel 已删(/api <model> 现在按对话钉);留个永不该被调的哨兵,
  // 老测试断言 not.toHaveBeenCalled 仍成立。
  const pinModel = vi.fn()
  const prefsData = new Map<string, { split?: boolean; care?: 'off' | 'low' | 'high'; stickers?: boolean; hunt?: boolean }>()
  const chatPrefs = {
    get: (c: string) => prefsData.get(c) ?? {},
    set: (c: string, p: { split?: boolean; care?: 'off' | 'low' | 'high'; stickers?: boolean; hunt?: boolean }) => { const n = { ...(prefsData.get(c) ?? {}), ...p }; prefsData.set(c, n); return n },
  }
  const cmds = makeModeCommands({
    coordinator: {
      getMode: () => stored ?? { kind: 'solo', provider: opts.defaultProviderId ?? 'claude' },
      setMode: (chatId, mode) => { stored = mode; set(chatId, mode) },
      cancel: () => false,
    },
    registry: {
      has: (id: string) => registered.includes(id),
      get: (id: string) => registered.includes(id)
        ? { provider: {} as never, opts: { displayName: id[0]!.toUpperCase() + id.slice(1), canResume: () => true } }
        : null,
      list: () => registered,
    },
    defaultProviderId: opts.defaultProviderId ?? 'claude',
    agentConfig: { provider: 'claude' as const, dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false },
    sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
    setUserName: vi.fn(async (chat: string, name: string) => { storedName = { chat, name } }),
    getUserName: vi.fn(() => opts.initialUserName ?? null),
    readConfig: () => cfg,
    providerNotes: () => opts.notes ?? {},
    setOpenaiAlias,
    setConfig,
    openaiModels,
    chatPrefs,
    log: () => {},
    isAdmin: opts.isAdmin,
    resolveTier: () => opts.tier ?? 'admin',
  })
  return { cmds, set, sendMessage, sentMessages, pinModel, chatPrefs, prefsData, cfg, setOpenaiAlias, setConfig, openaiModels, getStored: () => stored, getStoredName: () => storedName }
}

describe('makeModeCommands', () => {
  it('returns false for non-slash messages (passes through to next handler)', async () => {
    const { cmds, sendMessage } = setup()
    const consumed = await cmds.handle(inbound('hello, this is just a normal message'))
    expect(consumed).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('/cc switches mode to solo+claude and replies', async () => {
    const { cmds, set, sentMessages } = setup({ defaultProviderId: 'codex' })
    const consumed = await cmds.handle(inbound('/cc'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'claude' })
    expect(sentMessages[0]?.[1]).toContain('Claude')
    expect(sentMessages[0]?.[1]).toContain('solo')
  })

  it('/codex switches mode to solo+codex', async () => {
    const { cmds, set } = setup()
    await cmds.handle(inbound('/codex'))
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'codex' })
  })

  it('/cursor switches mode to solo+cursor', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
    const consumed = await cmds.handle(inbound('/cursor'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'cursor' })
    expect(sentMessages[0]?.[1]).toContain('Cursor')
    expect(sentMessages[0]?.[1]).toContain('solo')
  })

  it('/api switches mode to solo+openai (the OpenAI-compatible backend)', async () => {
    const { cmds, set, sentMessages, pinModel } = setup({ registered: ['claude', 'codex', 'openai'] })
    const consumed = await cmds.handle(inbound('/api'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'openai' })
    expect(sentMessages[0]?.[1]).toContain('solo')
    // Bare /api (no model tail) does NOT pin a model — only switches provider.
    expect(pinModel).not.toHaveBeenCalled()
  })

  it('/api replies 未注册 when the openai provider is not configured', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    const consumed = await cmds.handle(inbound('/api'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('未注册')
  })

  // ── /api <model> — switch + pin the openai-compatible model in one go ──

  it('/mode shows the per-chat pinned model', async () => {
    const { cmds, sentMessages } = setup({ registered: ['claude', 'openai'], initialMode: { kind: 'solo', provider: 'openai', model: 'DeepSeek' } })
    await cmds.handle(inbound('/mode'))
    expect(sentMessages[0]?.[1]).toContain('solo · openai · 模型 DeepSeek')
  })

  it('/api deepseek-chat pins the model AND switches to solo+openai', async () => {
    const { cmds, set, sentMessages, pinModel } = setup({ registered: ['claude', 'codex', 'openai'] })
    const consumed = await cmds.handle(inbound('/api deepseek-chat'))
    expect(consumed).toBe(true)
    // 按对话钉:写进 Mode.solo.model,不再动全局 agent-config(pinModel)。
    expect(pinModel).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'openai', model: 'deepseek-chat' })
    expect(sentMessages[0]?.[1]).toContain('deepseek-chat')
    expect(sentMessages[0]?.[1]).toContain('只对这个对话')
  })

  it('/api Kimi accepts a bare model name with no version digit', async () => {
    // Unlike /v1/model (which rejects bare aliases), the openai-compatible
    // backends this feature targets DO have bare names like `Kimi` /
    // `DeepSeek` — the digit requirement would wrongly reject those.
    const { cmds, set, pinModel, sentMessages } = setup({ registered: ['claude', 'codex', 'openai'] })
    const consumed = await cmds.handle(inbound('/api Kimi'))
    expect(consumed).toBe(true)
    expect(pinModel).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'openai', model: 'Kimi' })
    expect(sentMessages[0]?.[1]).toContain('Kimi')
  })

  it('/api bad name rejects a model id containing a space — no switch, no pin', async () => {
    const { cmds, set, pinModel, sentMessages } = setup({ registered: ['claude', 'codex', 'openai'] })
    const consumed = await cmds.handle(inbound('/api bad name'))
    expect(consumed).toBe(true)
    expect(pinModel).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('无效')
  })

  it('/api <model> replies 未注册 when the openai provider is not configured — no pin', async () => {
    const { cmds, set, pinModel, sentMessages } = setup({ registered: ['claude', 'codex'] })
    const consumed = await cmds.handle(inbound('/api deepseek-chat'))
    expect(consumed).toBe(true)
    expect(pinModel).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('未注册')
  })

  it('/cc deepseek-chat (non-openai provider with a non-"+peer" tail) keeps the existing unsupported-argument error, does NOT pin', async () => {
    const { cmds, set, pinModel, sentMessages } = setup({ registered: ['claude', 'codex'] })
    const consumed = await cmds.handle(inbound('/cc deepseek-chat'))
    expect(consumed).toBe(true)
    expect(pinModel).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('不支持参数')
  })

  it('/cursor rejects with helpful message when cursor is not registered', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    const consumed = await cmds.handle(inbound('/cursor'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('未注册')
    expect(sentMessages[0]?.[1]).toContain('cursor')
  })

  it('/cc and /codex are case-insensitive on the slash word', async () => {
    const { cmds, set } = setup()
    await cmds.handle(inbound('/CC'))
    expect(set).toHaveBeenLastCalledWith('chat-1', { kind: 'solo', provider: 'claude' })
    await cmds.handle(inbound('/Codex'))
    expect(set).toHaveBeenLastCalledWith('chat-1', { kind: 'solo', provider: 'codex' })
  })

  it('/cc rejects with helpful message when claude is not registered', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['codex'] })
    const consumed = await cmds.handle(inbound('/cc'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('未注册')
    expect(sentMessages[0]?.[1]).toContain('codex')
  })

  it('/solo reverts to default provider', async () => {
    const { cmds, set, sentMessages } = setup({ defaultProviderId: 'claude' })
    await cmds.handle(inbound('/solo'))
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'claude' })
    expect(sentMessages[0]?.[1]).toContain('恢复默认')
  })

  it('/mode shows current mode + registered providers + default', async () => {
    const { cmds, sentMessages } = setup({
      defaultProviderId: 'codex',
      initialMode: { kind: 'solo', provider: 'claude' },
    })
    await cmds.handle(inbound('/mode'))
    const text = sentMessages[0]?.[1] ?? ''
    expect(text).toContain('solo · claude')   // current
    expect(text).toContain('claude, codex')   // registered
    expect(text).toContain('默认: codex')      // default
  })

  it('/both switches to parallel mode (RFC 03 P3)', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    const consumed = await cmds.handle(inbound('/both'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'parallel' })
    expect(sentMessages[0]?.[1]).toContain('并行模式开启')
    expect(sentMessages[0]?.[1]).toContain('[Claude]')
    expect(sentMessages[0]?.[1]).toContain('[Codex]')
  })

  it('/both surfaces validation error when one provider missing', async () => {
    // Mock setMode to throw — simulates coordinator's validateMode rejecting
    const sentMessages: Array<[string, string]> = []
    const sendMessage = vi.fn(async (chatId: string, text: string) => {
      sentMessages.push([chatId, text]); return { msgId: 'm' }
    })
    const cmds = makeModeCommands({
      coordinator: {
        getMode: () => ({ kind: 'solo', provider: 'claude' }),
        setMode: () => { throw new Error("mode 'parallel' requires providers claude, codex; missing: codex") },
        cancel: () => false,
      },
      registry: {
        has: (id: string) => id === 'claude',
        get: () => ({ provider: {} as never, opts: { displayName: 'Claude', canResume: () => true } }),
        list: () => ['claude'],
      },
      defaultProviderId: 'claude',
      agentConfig: { provider: 'claude' as const, dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false },
      sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
      setUserName: async () => {},
      getUserName: () => null,
      chatPrefs: { get: () => ({}), set: (_c: string, p: { split?: boolean }) => p },
      log: () => {},
      resolveTier: () => 'admin' as const,
    })
    await cmds.handle(inbound('/both'))
    expect(sentMessages[0]?.[1]).toContain('启用失败')
    expect(sentMessages[0]?.[1]).toContain('missing: codex')
  })

  // ── /chat — chatroom mode (RFC 03 P5) ─────────────────────────────────

  it('/chat switches to chatroom mode', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    const consumed = await cmds.handle(inbound('/chat'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'chatroom' })
    // v0.5.10 — confirmation describes persistent chatroom (no longer
    // mentions 4-round limit / @-tag protocol; that was v0.5.7-era).
    expect(sentMessages[0]?.[1]).toContain('聊天室')
    expect(sentMessages[0]?.[1]).toContain('Claude')
    expect(sentMessages[0]?.[1]).toContain('Codex')
  })

  it('/chat surfaces validation error when one provider missing', async () => {
    const sentMessages: Array<[string, string]> = []
    const sendMessage = vi.fn(async (chatId: string, text: string) => {
      sentMessages.push([chatId, text]); return { msgId: 'm' }
    })
    const cmds = makeModeCommands({
      coordinator: {
        getMode: () => ({ kind: 'solo', provider: 'claude' }),
        setMode: () => { throw new Error("mode 'chatroom' requires providers claude, codex; missing: codex") },
        cancel: () => false,
      },
      registry: {
        has: (id: string) => id === 'claude',
        get: () => ({ provider: {} as never, opts: { displayName: 'Claude', canResume: () => true } }),
        list: () => ['claude'],
      },
      defaultProviderId: 'claude',
      agentConfig: { provider: 'claude' as const, dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false },
      sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
      setUserName: async () => {},
      getUserName: () => null,
      chatPrefs: { get: () => ({}), set: (_c: string, p: { split?: boolean }) => p },
      log: () => {},
      resolveTier: () => 'admin' as const,
    })
    await cmds.handle(inbound('/chat'))
    expect(sentMessages[0]?.[1]).toContain('启用失败')
    expect(sentMessages[0]?.[1]).toContain('missing: codex')
  })

  // ── /stop — exit any mode, revert to default ──────────────────────────

  it('/stop reverts to default solo (alias for /solo)', async () => {
    const { cmds, set, sentMessages } = setup({
      defaultProviderId: 'codex',
      initialMode: { kind: 'chatroom' },
    })
    const consumed = await cmds.handle(inbound('/stop'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'codex' })
    expect(sentMessages[0]?.[1]).toContain('已退出当前模式')
    expect(sentMessages[0]?.[1]).toContain('Codex')
  })

  it('/stop also calls coordinator.cancel and notifies on an in-flight turn (RFC 03 review #11; generic copy — not chatroom-specific, since cancel() also fires for solo/parallel)', async () => {
    const sentMessages: Array<[string, string]> = []
    const sendMessage = vi.fn(async (chatId: string, text: string) => {
      sentMessages.push([chatId, text]); return { msgId: 'm' }
    })
    const cancel = vi.fn(() => true)  // signals an in-flight loop
    const cmds = makeModeCommands({
      coordinator: {
        getMode: () => ({ kind: 'chatroom' }),
        setMode: () => {},
        cancel,
      },
      registry: {
        has: () => true,
        get: () => ({ provider: {} as never, opts: { displayName: 'Claude', canResume: () => true } }),
        list: () => ['claude', 'codex'],
      },
      defaultProviderId: 'claude',
      agentConfig: { provider: 'claude' as const, dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false },
      sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
      setUserName: async () => {},
      getUserName: () => null,
      chatPrefs: { get: () => ({}), set: (_c: string, p: { split?: boolean }) => p },
      log: () => {},
      resolveTier: () => 'admin' as const,
    })
    await cmds.handle(inbound('/stop'))
    expect(cancel).toHaveBeenCalledWith('chat-1')
    expect(sentMessages[0]?.[1]).toContain('已请求中止 in-flight 回合')
    expect(sentMessages[0]?.[1]).not.toContain('chatroom')
  })

  it('/stop without in-flight loop does NOT mention cancel suffix', async () => {
    const sentMessages: Array<[string, string]> = []
    const sendMessage = vi.fn(async (chatId: string, text: string) => {
      sentMessages.push([chatId, text]); return { msgId: 'm' }
    })
    const cmds = makeModeCommands({
      coordinator: {
        getMode: () => ({ kind: 'solo', provider: 'claude' }),
        setMode: () => {},
        cancel: () => false,  // nothing in flight
      },
      registry: {
        has: () => true,
        get: () => ({ provider: {} as never, opts: { displayName: 'Claude', canResume: () => true } }),
        list: () => ['claude', 'codex'],
      },
      defaultProviderId: 'claude',
      agentConfig: { provider: 'claude' as const, dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false },
      sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
      setUserName: async () => {},
      getUserName: () => null,
      chatPrefs: { get: () => ({}), set: (_c: string, p: { split?: boolean }) => p },
      log: () => {},
      resolveTier: () => 'admin' as const,
    })
    await cmds.handle(inbound('/stop'))
    expect(sentMessages[0]?.[1]).not.toContain('已中止')
  })

  it('/mode lists /chat and /stop as available now', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/mode'))
    expect(sentMessages[0]?.[1]).toContain('/chat')
    expect(sentMessages[0]?.[1]).toContain('/stop')
  })

  it('/mode lists /both and /cc + codex as available', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/mode'))
    expect(sentMessages[0]?.[1]).toContain('/both')
    expect(sentMessages[0]?.[1]).toContain('/cc + codex')
    expect(sentMessages[0]?.[1]).toContain('/codex + cc')
  })

  // ── /cc + codex / /codex + cc — primary_tool (RFC 03 P4) ─────────────

  it('/cc + codex switches to primary_tool with claude primary', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    const consumed = await cmds.handle(inbound('/cc + codex'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'primary_tool', primary: 'claude' })
    expect(sentMessages[0]?.[1]).toContain('主从模式开启')
    expect(sentMessages[0]?.[1]).toContain('Claude')
    expect(sentMessages[0]?.[1]).toContain('delegate_codex')
  })

  it('/codex + cc switches to primary_tool with codex primary', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    await cmds.handle(inbound('/codex + cc'))
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'primary_tool', primary: 'codex' })
    expect(sentMessages[0]?.[1]).toContain('Codex')
    expect(sentMessages[0]?.[1]).toContain('delegate_claude')
  })

  it('/cc + codex tolerates whitespace variations', async () => {
    const { cmds, set } = setup({ registered: ['claude', 'codex'] })
    await cmds.handle(inbound('/cc +codex'))
    expect(set).toHaveBeenLastCalledWith('chat-1', { kind: 'primary_tool', primary: 'claude' })
    await cmds.handle(inbound('/cc +   codex   '))
    expect(set).toHaveBeenLastCalledWith('chat-1', { kind: 'primary_tool', primary: 'claude' })
  })

  it('/cc + cc rejects same-provider self-delegation', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    await cmds.handle(inbound('/cc + cc'))
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('不能是同一个 provider')
  })

  it('/cc + foo rejects unknown peer with hint', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    await cmds.handle(inbound('/cc + foo'))
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('未知的 peer')
  })

  it('/cc + codex surfaces validation error when peer missing from registry', async () => {
    const sentMessages: Array<[string, string]> = []
    const sendMessage = vi.fn(async (chatId: string, text: string) => {
      sentMessages.push([chatId, text]); return { msgId: 'm' }
    })
    const cmds = makeModeCommands({
      coordinator: {
        getMode: () => ({ kind: 'solo', provider: 'claude' }),
        setMode: () => { throw new Error("mode 'primary_tool' requires both providers claude, codex; missing: codex") },
        cancel: () => false,
      },
      registry: {
        has: (id: string) => id === 'claude',
        get: () => ({ provider: {} as never, opts: { displayName: 'Claude', canResume: () => true } }),
        list: () => ['claude'],
      },
      defaultProviderId: 'claude',
      agentConfig: { provider: 'claude' as const, dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false },
      sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
      setUserName: async () => {},
      getUserName: () => null,
      chatPrefs: { get: () => ({}), set: (_c: string, p: { split?: boolean }) => p },
      log: () => {},
      resolveTier: () => 'admin' as const,
    })
    await cmds.handle(inbound('/cc + codex'))
    expect(sentMessages[0]?.[1]).toContain('启用失败')
    expect(sentMessages[0]?.[1]).toContain('missing: codex')
  })

  it('/cc + cursor is rejected — delegate peer is wired to codex, not cursor (asymmetric bootstrap wiring)', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
    const consumed = await cmds.handle(inbound('/cc + cursor'))
    expect(consumed).toBe(true)
    // setMode must NOT be called — would silently substitute the wrong peer.
    expect(set).not.toHaveBeenCalled()
    // Reply explains the wired peer.
    expect(sentMessages[0]?.[1]).toContain('codex')
    expect(sentMessages[0]?.[1]).toContain('cursor')
  })

  it('/codex + cursor is rejected — same asymmetry (codex session has delegate_claude)', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
    const consumed = await cmds.handle(inbound('/codex + cursor'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('claude')
  })

  it('/cursor + cc is rejected — cursor cannot delegate (B2, supportsDelegation=false)', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
    const consumed = await cmds.handle(inbound('/cursor + cc'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('不支持主从模式')
  })

  it('/cursor + codex is rejected — cursor cannot delegate (B2, supportsDelegation=false)', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
    const consumed = await cmds.handle(inbound('/cursor + codex'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('不支持主从模式')
  })

  it('/gemini switches mode to solo+gemini', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'gemini'] })
    const consumed = await cmds.handle(inbound('/gemini'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'gemini' })
    expect(sentMessages[0]?.[1]).toContain('Gemini')
    expect(sentMessages[0]?.[1]).toContain('solo')
  })

  it('/gemini rejects with helpful message when gemini is not registered', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    const consumed = await cmds.handle(inbound('/gemini'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('未注册')
    expect(sentMessages[0]?.[1]).toContain('gemini')
  })

  it('/gemini + cc is rejected — gemini cannot delegate (B2, supportsDelegation=false)', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'gemini'] })
    const consumed = await cmds.handle(inbound('/gemini + cc'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('不支持主从模式')
  })

  it('/gemini + codex is rejected — gemini cannot delegate (B2, supportsDelegation=false)', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'gemini'] })
    const consumed = await cmds.handle(inbound('/gemini + codex'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('不支持主从模式')
  })

  // ── /agy — tier-C guest gate (spec 2026-08-17-agy-provider-design.md §3) ──

  it('/agy switches mode to solo+agy for an admin/trusted chat', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'agy'], tier: 'admin' })
    const consumed = await cmds.handle(inbound('/agy'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'agy' })
    expect(sentMessages[0]?.[1]).toContain('Agy')
    expect(sentMessages[0]?.[1]).toContain('solo')
  })

  it('/agy <model> pins the model AND switches to solo+agy for a trusted chat', async () => {
    const { cmds, set, sentMessages, pinModel } = setup({ registered: ['claude', 'codex', 'agy'], tier: 'trusted' })
    const consumed = await cmds.handle(inbound('/agy gemini-3.7-flash-high'))
    expect(consumed).toBe(true)
    expect(pinModel).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'agy', model: 'gemini-3.7-flash-high' })
    expect(sentMessages[0]?.[1]).toContain('gemini-3.7-flash-high')
  })

  it('/agy is rejected for a guest chat (bare form) — MCP token has no per-session isolation', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'agy'], tier: 'guest' })
    const consumed = await cmds.handle(inbound('/agy'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toBe('❌ /agy 目前仅管理员/信任聊天可用（工具通道暂无法按会话隔离权限）。')
  })

  it('/agy <model> is rejected for a guest chat (model-pin form) — no pin, no switch', async () => {
    const { cmds, set, sentMessages, pinModel } = setup({ registered: ['claude', 'codex', 'agy'], tier: 'guest' })
    const consumed = await cmds.handle(inbound('/agy gemini-3.7-flash-high'))
    expect(consumed).toBe(true)
    expect(pinModel).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toBe('❌ /agy 目前仅管理员/信任聊天可用（工具通道暂无法按会话隔离权限）。')
  })

  it('/agy replies 未注册 when the agy provider is not configured (non-guest chat)', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'], tier: 'admin' })
    const consumed = await cmds.handle(inbound('/agy'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('未注册')
    expect(sentMessages[0]?.[1]).toContain('agy')
  })

  it('/agy + codex is rejected — agy cannot delegate (B2, supportsDelegation=false)', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'agy'], tier: 'admin' })
    const consumed = await cmds.handle(inbound('/agy + codex'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('不支持主从模式')
  })

  // A3 (spec §A3): mw-admin runs BEFORE mw-mode in the real pipeline (see
  // src/daemon/inbound/build.ts), so a real /health message never reaches
  // mode-commands at all — admin-commands always claims it first, even for
  // non-admins (it replies "not an admin", but still consumes). Called in
  // isolation here (as every other test in this file does), mode-commands
  // genuinely doesn't recognise `/health` — the unknown-command catch below
  // now surfaces a hint instead of silently falling through to the LLM.
  it('/health (unrecognised by mode-commands itself) is caught by the unknown-command hint', async () => {
    const { cmds, sentMessages } = setup()
    const consumed = await cmds.handle(inbound('/health'))
    expect(consumed).toBe(true)
    expect(sentMessages[0]?.[1]).toBe('❓ 不认识 /health。看全部命令发 /help。')
  })

  // ── unknown pure-slash commands (A3 — spec §A3) ───────────────────────
  // Deliberately narrow: only a bare ASCII word (no args, no Chinese, 2-16
  // letters) that isn't one of this file's known commands gets the hint.
  // Everything else — arguments, Chinese, length outside the range, known
  // commands — falls through unchanged (the user might be talking, not
  // commanding).

  it('/foobar (unknown bare slash word) is consumed with the exact hint copy', async () => {
    const { cmds, sentMessages } = setup()
    const consumed = await cmds.handle(inbound('/foobar'))
    expect(consumed).toBe(true)
    expect(sentMessages[0]?.[1]).toBe('❓ 不认识 /foobar。看全部命令发 /help。')
  })

  it('/foobar with an argument falls through unchanged (not consumed)', async () => {
    const { cmds, sendMessage } = setup()
    const consumed = await cmds.handle(inbound('/foobar 参数'))
    expect(consumed).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('/中文 (non-ASCII slash word) falls through unchanged', async () => {
    const { cmds, sendMessage } = setup()
    const consumed = await cmds.handle(inbound('/中文'))
    expect(consumed).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('/cc (a known command) is unaffected by the unknown-command catch', async () => {
    const { cmds, sentMessages } = setup()
    const consumed = await cmds.handle(inbound('/cc'))
    expect(consumed).toBe(true)
    expect(sentMessages[0]?.[1]).not.toContain('不认识')
  })

  // ── /name <nick> — user self-rename (PR2 #17) ────────────────────────

  it('/name <nick> sets the nickname and confirms', async () => {
    const { cmds, sentMessages, getStoredName } = setup()
    const consumed = await cmds.handle(inbound('/name Nate'))
    expect(consumed).toBe(true)
    expect(getStoredName()).toEqual({ chat: 'chat-1', name: 'Nate' })
    expect(sentMessages[0]?.[1]).toContain('Nate')
  })

  it('/name accepts multi-word nicknames', async () => {
    const { cmds, getStoredName } = setup()
    await cmds.handle(inbound('/name 张 三'))
    expect(getStoredName()).toEqual({ chat: 'chat-1', name: '张 三' })
  })

  it('/name with empty arg replies usage', async () => {
    const { cmds, sentMessages, getStoredName } = setup()
    const consumed = await cmds.handle(inbound('/name'))
    expect(consumed).toBe(true)
    expect(getStoredName()).toBeNull()
    expect(sentMessages[0]?.[1]).toMatch(/用法|usage/i)
  })

  it('/name rejects an over-long nickname (does NOT persist)', async () => {
    const { cmds, sentMessages, getStoredName } = setup()
    const consumed = await cmds.handle(inbound('/name ' + 'x'.repeat(25)))  // > NICKNAME_MAX_LEN (24)
    expect(consumed).toBe(true)
    expect(getStoredName()).toBeNull()
    expect(sentMessages[0]?.[1]).toMatch(/太长|最多|long/)
  })

  it('/name rejects a nickname with disallowed characters (does NOT persist)', async () => {
    const { cmds, sentMessages, getStoredName } = setup()
    const consumed = await cmds.handle(inbound('/name <script>'))
    expect(consumed).toBe(true)
    expect(getStoredName()).toBeNull()
    expect(sentMessages[0]?.[1]).toMatch(/只支持|字符/)
  })

  // ── /whoami — identity dump (PR2 #17) ────────────────────────────────

  it('/whoami dumps nickname + WeChat identity + bot name + chat id', async () => {
    const { cmds, sentMessages } = setup({ initialUserName: 'Nate', defaultProviderId: 'claude' })
    const consumed = await cmds.handle({
      chatId: 'chat1234567890',
      userId: 'wxid_abc123def',
      userName: '张三',
      accountId: '8ca10d158998-im-bot',
      text: '/whoami',
      msgType: 'text',
      createTimeMs: 0,
    })
    expect(consumed).toBe(true)
    const reply = sentMessages[0]?.[1] ?? ''
    expect(reply).toContain('Nate')
    expect(reply).toContain('张三')
    expect(reply).toContain('wxid_abc123')   // userId truncated prefix visible
    expect(reply).toContain('8ca10d158998')  // accountId truncated prefix visible
    expect(reply).toContain('cc')            // bot name from solo+claude default
    expect(reply).toContain('chat12345')     // chatId truncated prefix visible
  })

  it('/whoami without nickname hints at /name', async () => {
    const { cmds, sentMessages } = setup()  // no initialUserName → null
    await cmds.handle({
      chatId: 'c1', userId: 'u1', userName: undefined,
      accountId: 'a1', text: '/whoami',
      msgType: 'text', createTimeMs: 0,
    })
    expect(sentMessages[0]?.[1]).toMatch(/还没.*昵称|尚未.*告诉|\/name/)
  })

  // ── /help (= /帮助) — user-facing command reference ──────────────────

  it('/help is consumed (returns true)', async () => {
    const { cmds } = setup()
    const consumed = await cmds.handle(inbound('/help'))
    expect(consumed).toBe(true)
  })

  it('/help from non-admin contains mode-switch section but NOT admin section', async () => {
    const { cmds, sentMessages } = setup({ isAdmin: () => false })
    await cmds.handle(inbound('/help'))
    const text = sentMessages[0]?.[1] ?? ''
    expect(text).toContain('模式切换')
    expect(text).not.toContain('管理员命令')
  })

  // A3 (spec §A3): /help's mode-switch line had fallen behind /mode's list
  // by two providers (/gemini /agy missing) — pin both providers present so
  // that regression can't silently recur.
  it('/help mode-switch line includes /gemini and /agy (aligned with /mode)', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/help'))
    const text = sentMessages[0]?.[1] ?? ''
    expect(text).toContain('/gemini')
    expect(text).toContain('/agy')
  })

  it('/help from admin contains both mode-switch and admin sections', async () => {
    const { cmds, sentMessages } = setup({ isAdmin: () => true })
    await cmds.handle(inbound('/help'))
    const text = sentMessages[0]?.[1] ?? ''
    expect(text).toContain('模式切换')
    expect(text).toContain('管理员命令')
    expect(text).toContain('/health')
    expect(text).toContain('/reset')
    // Memory + delegation features are discoverable from /help, not just docs.
    expect(text).toContain('整理记忆')
    expect(text).toContain('让<名字>执行')
  })

  it('/帮助 is an alias for /help and produces the same output', async () => {
    const { cmds: cmdsAdmin, sentMessages: msgsAdmin } = setup({ isAdmin: () => true })
    const { cmds: cmdsUser, sentMessages: msgsUser } = setup({ isAdmin: () => false })
    await cmdsAdmin.handle(inbound('/帮助'))
    await cmdsUser.handle(inbound('/帮助'))
    expect(msgsAdmin[0]?.[1]).toContain('管理员命令')
    expect(msgsUser[0]?.[1]).not.toContain('管理员命令')
    expect(msgsUser[0]?.[1]).toContain('模式切换')
  })

  // ── /help tiering (spec §5): resolveTier === 'guest', NOT isAdmin ────

  it('/help for a guest tier chat shows only the guest-usable blocks (whoami/name, /set split, files) — asserts the hidden blocks are absent', async () => {
    const { cmds, sentMessages } = setup({ tier: 'guest' })
    await cmds.handle(inbound('/help'))
    const text = sentMessages[0]?.[1] ?? ''
    // Present: opening blurb, identity, /set split, files.
    expect(text).toContain('这里是微信通道')
    expect(text).toContain('/whoami')
    expect(text).toContain('/name <昵称>')
    expect(text).toContain('/set split')
    expect(text).toContain('拖图片/文件给我即可')
    // Absent: provider switching, /set care (and the rest of /set), 陪伴/配对.
    expect(text).not.toContain('模式切换')
    expect(text).not.toContain('/cc ')
    expect(text).not.toContain('/codex')
    expect(text).not.toContain('/cursor')
    expect(text).not.toContain('/both')
    expect(text).not.toContain('/chat ')
    expect(text).not.toContain('/mode')
    expect(text).not.toContain('主动关心档位')
    expect(text).not.toContain('care')
    expect(text).not.toContain('关心')
    expect(text).not.toContain('表情包')
    expect(text).not.toContain('打猎')
    expect(text).not.toContain('陪伴')
    expect(text).not.toContain('配对')
    expect(text).not.toContain('切到 <alias>')
    // Guest is never admin — admin section stays hidden even if isAdmin
    // somehow said true for this chat's userId (defense-in-depth).
    expect(text).not.toContain('管理员命令')
  })

  it('/help for a guest tier chat is consumed even when isAdmin(userId) reports true (resolveTier wins, not isAdmin)', async () => {
    const { cmds, sentMessages } = setup({ tier: 'guest', isAdmin: () => true })
    await cmds.handle(inbound('/help'))
    const text = sentMessages[0]?.[1] ?? ''
    expect(text).not.toContain('管理员命令')
    expect(text).not.toContain('模式切换')
  })

  it('/help for admin tier is byte-identical to the pre-tiering output (snapshot-style assertion)', async () => {
    const { cmds, sentMessages } = setup({ tier: 'admin', isAdmin: () => true })
    await cmds.handle(inbound('/help'))
    expect(sentMessages[0]?.[1]).toMatchSnapshot()
  })

  it('/help for trusted tier (non-admin) is byte-identical to the pre-tiering output, and matches admin\'s output minus the admin section', async () => {
    const { cmds: cmdsTrusted, sentMessages: msgsTrusted } = setup({ tier: 'trusted', isAdmin: () => false })
    const { cmds: cmdsAdmin, sentMessages: msgsAdmin } = setup({ tier: 'admin', isAdmin: () => true })
    await cmdsTrusted.handle(inbound('/help'))
    await cmdsAdmin.handle(inbound('/help'))
    const trustedText = msgsTrusted[0]?.[1] ?? ''
    const adminText = msgsAdmin[0]?.[1] ?? ''
    expect(trustedText).toMatchSnapshot()
    // Same core content as admin's — admin's output is exactly the trusted
    // output plus the appended admin section.
    expect(adminText.startsWith(trustedText)).toBe(true)
    expect(adminText.slice(trustedText.length)).toContain('管理员命令')
  })

  describe('N-way grammar', () => {
    it('/chat claude codex cursor sets chatroom with 3 participants', async () => {
      const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
      const consumed = await cmds.handle(inbound('/chat claude codex cursor'))
      expect(consumed).toBe(true)
      expect(set).toHaveBeenCalledWith('chat-1', {
        kind: 'chatroom', participants: ['claude', 'codex', 'cursor'],
      })
      expect(sentMessages[0]?.[1]).toContain('claude')
      expect(sentMessages[0]?.[1]).toContain('cursor')
    })

    it('/chat claude codex sets explicit 2-way chatroom', async () => {
      const { cmds, set } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/chat claude codex'))
      expect(set).toHaveBeenCalledWith('chat-1', {
        kind: 'chatroom', participants: ['claude', 'codex'],
      })
    })

    it('/parallel claude cursor sets parallel with explicit participants', async () => {
      const { cmds, set } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/parallel claude cursor'))
      expect(set).toHaveBeenCalledWith('chat-1', {
        kind: 'parallel', participants: ['claude', 'cursor'],
      })
    })

    it('/both claude cursor also sets parallel with explicit participants (alias)', async () => {
      const { cmds, set } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/both claude cursor'))
      expect(set).toHaveBeenCalledWith('chat-1', {
        kind: 'parallel', participants: ['claude', 'cursor'],
      })
    })

    it('/chat with no args remains bare chatroom (no participants property)', async () => {
      const { cmds, set } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/chat'))
      expect(set).toHaveBeenCalledWith('chat-1', { kind: 'chatroom' })
    })

    it('/both with no args remains bare parallel (no participants property)', async () => {
      const { cmds, set } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/both'))
      expect(set).toHaveBeenCalledWith('chat-1', { kind: 'parallel' })
    })

    it('/chat with single arg is rejected (≥2 required) — does NOT call setMode', async () => {
      const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/chat claude'))
      expect(set).not.toHaveBeenCalled()
      expect(sentMessages[0]?.[1]).toMatch(/≥2|至少|need.*2/)
    })

    it('/chat with the same provider twice is rejected (dedupes below the ≥2 minimum)', async () => {
      // Regression: the ≥2 check ran on the RAW token count, but dedup happened
      // after — so `/chat claude claude` (2 tokens, 1 distinct) passed the check
      // then collapsed to a single-participant chatroom, violating the advertised
      // ≥2 contract (it silently degraded to solo).
      const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/chat claude claude'))
      expect(set).not.toHaveBeenCalled()
      expect(sentMessages[0]?.[1]).toMatch(/≥2|至少|不同|distinct/)
    })

    it('/chat with unknown provider is rejected with helpful message', async () => {
      const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/chat claude gemini'))
      expect(set).not.toHaveBeenCalled()
      expect(sentMessages[0]?.[1]).toContain('gemini')
      // Registered list is surfaced.
      expect(sentMessages[0]?.[1]).toContain('claude')
    })

    it('/parallel with single arg is rejected (≥2 required)', async () => {
      const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/parallel claude'))
      expect(set).not.toHaveBeenCalled()
      expect(sentMessages[0]?.[1]).toMatch(/≥2|至少|need.*2/)
    })

    it('/chat dedupes repeated tokens silently', async () => {
      const { cmds, set } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/chat claude claude codex'))
      expect(set).toHaveBeenCalledWith('chat-1', {
        kind: 'chatroom', participants: ['claude', 'codex'],
      })
    })

    // ── agy final-review CRITICAL 1 — agy excluded from parallel/chatroom
    // (shared tier-C 'trusted' MCP token, spec §7 non-goal). Must be
    // rejected with user-facing copy BEFORE setMode is ever called, from
    // ANY chat (mode commands are deliberately ungated — this is not the
    // /agy admin/trusted gate, it's a structural exclusion).

    it('/both claude agy is rejected — agy cannot join parallel (shared-token channel)', async () => {
      const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'agy'], tier: 'admin' })
      const consumed = await cmds.handle(inbound('/both claude agy'))
      expect(consumed).toBe(true)
      expect(set).not.toHaveBeenCalled()
      expect(sentMessages[0]?.[1]).toBe('❌ agy 不能加入 both/chat 模式（共享工具通道），可用 /agy 单独使用（仅管理员/信任聊天）。')
    })

    it('/chat codex agy is rejected — agy cannot join chatroom (shared-token channel)', async () => {
      const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'agy'], tier: 'admin' })
      const consumed = await cmds.handle(inbound('/chat codex agy'))
      expect(consumed).toBe(true)
      expect(set).not.toHaveBeenCalled()
      expect(sentMessages[0]?.[1]).toBe('❌ agy 不能加入 both/chat 模式（共享工具通道），可用 /agy 单独使用（仅管理员/信任聊天）。')
    })
  })

  // ── /set — per-chat preferences (settings layer seed) ────────────────

  it('/set shows current prefs for this chat', async () => {
    const { cmds, sentMessages } = setup()
    expect(await cmds.handle(inbound('/set'))).toBe(true)
    expect(sentMessages[0]?.[1]).toContain('split')
    expect(sentMessages[0]?.[1]).toContain('on') // default ON when unset
  })

  it('/set split off persists and confirms', async () => {
    const { cmds, sentMessages, prefsData } = setup()
    expect(await cmds.handle(inbound('/set split off'))).toBe(true)
    expect(prefsData.get('chat-1')).toEqual({ split: false })
    expect(sentMessages[0]?.[1]).toContain('关闭')
  })

  it('/set 拆分 开 (Chinese alias) turns it on', async () => {
    const { cmds, prefsData } = setup()
    await cmds.handle(inbound('/set 拆分 开'))
    expect(prefsData.get('chat-1')).toEqual({ split: true })
  })

  it('/set with an unknown key replies usage, does not write', async () => {
    const { cmds, sentMessages, prefsData } = setup()
    await cmds.handle(inbound('/set volume 11'))
    expect(prefsData.size).toBe(0)
    expect(sentMessages[0]?.[1]).toContain('split')
  })

  // ── /set care|关心 — proactive care level (Task 3) ────────────────────

  it('/set care high persists {care:"high"} and confirms', async () => {
    const { cmds, sentMessages, prefsData } = setup()
    expect(await cmds.handle(inbound('/set care high'))).toBe(true)
    expect(prefsData.get('chat-1')).toEqual({ care: 'high' })
    expect(sentMessages[0]?.[1]).toContain('high')
  })

  it('/set 关心 关 (Chinese alias + value) maps to {care:"off"}', async () => {
    const { cmds, prefsData } = setup()
    await cmds.handle(inbound('/set 关心 关'))
    expect(prefsData.get('chat-1')).toEqual({ care: 'off' })
  })

  it('/set 关心 低 maps to {care:"low"}', async () => {
    const { cmds, prefsData } = setup()
    await cmds.handle(inbound('/set 关心 低'))
    expect(prefsData.get('chat-1')).toEqual({ care: 'low' })
  })

  it('/set care maybe is a usage error and does not write', async () => {
    const { cmds, sentMessages, prefsData } = setup()
    await cmds.handle(inbound('/set care maybe'))
    expect(prefsData.size).toBe(0)
    expect(sentMessages[0]?.[1]).toContain('care')
  })

  it('/set care on is a usage error (care is 3-level, not on/off) and does not write', async () => {
    const { cmds, sentMessages, prefsData } = setup()
    await cmds.handle(inbound('/set care on'))
    expect(prefsData.size).toBe(0)
    expect(sentMessages[0]?.[1]).toContain('care')
  })

  it('bare /set output contains both split and 关心 states', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/set'))
    const text = sentMessages[0]?.[1] ?? ''
    expect(text).toContain('split')
    expect(text).toContain('关心')
  })

  it('bare /set shows 未设置 when care is unset, and the raw stored value when set', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/set'))
    expect(sentMessages[0]?.[1]).toContain('未设置')
    await cmds.handle(inbound('/set care low'))
    await cmds.handle(inbound('/set'))
    expect(sentMessages[2]?.[1]).toContain('low')
  })

  // ── /set stickers|表情 — sticker-reply toggle (Task 4) ────────────────

  it('/set stickers off persists {stickers:false} and confirms', async () => {
    const { cmds, sentMessages, prefsData } = setup()
    expect(await cmds.handle(inbound('/set stickers off'))).toBe(true)
    expect(prefsData.get('chat-1')).toEqual({ stickers: false })
    expect(sentMessages[0]?.[1]).toContain('关闭')
  })

  it('/set stickers on persists {stickers:true} and confirms', async () => {
    const { cmds, sentMessages, prefsData } = setup()
    expect(await cmds.handle(inbound('/set stickers on'))).toBe(true)
    expect(prefsData.get('chat-1')).toEqual({ stickers: true })
    expect(sentMessages[0]?.[1]).toContain('开启')
  })

  it('/set 表情 开 (Chinese alias) turns it on', async () => {
    const { cmds, prefsData } = setup()
    await cmds.handle(inbound('/set 表情 开'))
    expect(prefsData.get('chat-1')).toEqual({ stickers: true })
  })

  it('/set 表情 关 (Chinese alias) turns it off', async () => {
    const { cmds, prefsData } = setup()
    await cmds.handle(inbound('/set 表情 关'))
    expect(prefsData.get('chat-1')).toEqual({ stickers: false })
  })

  it('/set stickers maybe is a usage error and does not write', async () => {
    const { cmds, sentMessages, prefsData } = setup()
    await cmds.handle(inbound('/set stickers maybe'))
    expect(prefsData.size).toBe(0)
    expect(sentMessages[0]?.[1]).toContain('stickers')
  })

  it('bare /set output contains 表情', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/set'))
    expect(sentMessages[0]?.[1]).toContain('表情')
  })

  it('bare /set shows 未设置 when stickers is unset, and the raw on|off when set', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/set'))
    expect(sentMessages[0]?.[1]).toContain('未设置')
    await cmds.handle(inbound('/set stickers off'))
    await cmds.handle(inbound('/set'))
    expect(sentMessages[2]?.[1]).toContain('表情包: off')
  })

  // ── /set hunt|打猎 — daily hunt toggle (Task 2) ────────────────────────

  it('/set hunt off persists {hunt:false} and confirms', async () => {
    const { cmds, sentMessages, prefsData } = setup()
    expect(await cmds.handle(inbound('/set hunt off'))).toBe(true)
    expect(prefsData.get('chat-1')).toEqual({ hunt: false })
    expect(sentMessages[0]?.[1]).toContain('关闭')
  })

  it('/set hunt on persists {hunt:true} and confirms', async () => {
    const { cmds, sentMessages, prefsData } = setup()
    expect(await cmds.handle(inbound('/set hunt on'))).toBe(true)
    expect(prefsData.get('chat-1')).toEqual({ hunt: true })
    expect(sentMessages[0]?.[1]).toContain('开启')
  })

  it('/set 打猎 开 (Chinese alias) turns it on', async () => {
    const { cmds, prefsData } = setup()
    await cmds.handle(inbound('/set 打猎 开'))
    expect(prefsData.get('chat-1')).toEqual({ hunt: true })
  })

  it('/set 打猎 关 (Chinese alias) turns it off', async () => {
    const { cmds, prefsData } = setup()
    await cmds.handle(inbound('/set 打猎 关'))
    expect(prefsData.get('chat-1')).toEqual({ hunt: false })
  })

  it('/set hunt maybe is a usage error and does not write', async () => {
    const { cmds, sentMessages, prefsData } = setup()
    await cmds.handle(inbound('/set hunt maybe'))
    expect(prefsData.size).toBe(0)
    expect(sentMessages[0]?.[1]).toContain('hunt')
  })

  it('bare /set output contains 打猎', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/set'))
    expect(sentMessages[0]?.[1]).toContain('打猎')
  })

  it('bare /set shows 未设置 when hunt is unset, and the raw on|off when set', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/set'))
    expect(sentMessages[0]?.[1]).toContain('未设置')
    await cmds.handle(inbound('/set hunt off'))
    await cmds.handle(inbound('/set'))
    expect(sentMessages[2]?.[1]).toContain('每日打猎: off')
  })

  it('/help line mentions 每日打猎', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/help'))
    expect(sentMessages[0]?.[1]).toContain('每日打猎')
  })
})

// ── /api list · alias · unalias — 网关一整面模型,让人记得住 ─────────────
describe('/api list / alias / unalias', () => {
  const reg = ['claude', 'openai']
  it('/api list shows this chat\'s pin, the global default, aliases, and what the gateway has', async () => {
    const { cmds, sentMessages } = setup({
      registered: reg,
      initialMode: { kind: 'solo', provider: 'openai', model: 'Qwen3.8' },
      config: { openaiBaseUrl: 'https://llm.example/v1', openaiModel: 'DeepSeek', openaiAliases: { ds: 'DeepSeek', kimi: 'kimi-k2.7-code' } },
    })
    expect(await cmds.handle(inbound('/api list'))).toBe(true)
    const t = sentMessages[0]![1]
    expect(t).toContain('https://llm.example/v1')
    expect(t).toContain('本对话当前:Qwen3.8')
    expect(t).toContain('全局默认 DeepSeek')
    expect(t).toContain('ds → DeepSeek')
    expect(t).toContain('kimi → kimi-k2.7-code')
    expect(t).toContain('网关上有(3):DeepSeek, KIMI, Qwen3.8')
    expect(t).toContain('/api alias')
  })
  it('/api list degrades gracefully: gateway unreachable → says so, still lists aliases; provider unregistered → says what\'s missing', async () => {
    const { cmds, sentMessages } = setup({ registered: ['claude'], config: { openaiAliases: { ds: 'DeepSeek' } }, models: { models: [], error: '连不上网关:ECONNREFUSED' } })
    await cmds.handle(inbound('/api list'))
    const t = sentMessages[0]![1]
    expect(t).toContain('未注册')
    expect(t).toContain('WECHAT_OPENAI_API_KEY')
    expect(t).toContain('网关列表拿不到:连不上网关:ECONNREFUSED')
    expect(t).toContain('ds → DeepSeek')
  })
  it('/api alias ds=DeepSeek persists; /api ds then resolves the alias into the per-chat pin', async () => {
    const { cmds, set, sentMessages, cfg } = setup({ registered: reg })
    await cmds.handle(inbound('/api alias ds=DeepSeek'))
    expect(cfg.openaiAliases).toEqual({ ds: 'DeepSeek' })
    expect(sentMessages[0]![1]).toContain('ds')
    await cmds.handle(inbound('/api ds'))
    expect(set).toHaveBeenLastCalledWith('chat-1', { kind: 'solo', provider: 'openai', model: 'DeepSeek' })
    expect(sentMessages[1]![1]).toContain('DeepSeek(别名 ds)')
  })
  it('/api alias accepts `a = b` and `a b` spellings; rejects a subcommand name as alias', async () => {
    const { cmds, cfg, sentMessages } = setup({ registered: reg })
    await cmds.handle(inbound('/api alias qwen = Qwen3.8-Instruct'))
    await cmds.handle(inbound('/api alias k kimi-k2.7-code'))
    expect(cfg.openaiAliases).toEqual({ qwen: 'Qwen3.8-Instruct', k: 'kimi-k2.7-code' })
    await cmds.handle(inbound('/api alias list=DeepSeek'))
    expect(sentMessages[2]![1]).toContain('子命令')
    expect(cfg.openaiAliases).not.toHaveProperty('list')
  })
  it('/api unalias removes; unknown alias is reported with the existing ones', async () => {
    const { cmds, cfg, sentMessages } = setup({ registered: reg, config: { openaiAliases: { ds: 'DeepSeek', k: 'kimi' } } })
    await cmds.handle(inbound('/api unalias ds'))
    expect(cfg.openaiAliases).toEqual({ k: 'kimi' })
    await cmds.handle(inbound('/api unalias nope'))
    expect(sentMessages[1]![1]).toContain('没有叫')
    expect(sentMessages[1]![1]).toContain('k')
  })
  it('an unaliased name still passes through verbatim (gateway原名照样能用)', async () => {
    const { cmds, set } = setup({ registered: reg, config: { openaiAliases: { ds: 'DeepSeek' } } })
    await cmds.handle(inbound('/api GLM-FLASH'))
    expect(set).toHaveBeenLastCalledWith('chat-1', { kind: 'solo', provider: 'openai', model: 'GLM-FLASH' })
  })
})

// ── /set cheap — 后台评估用哪家(全局,管理员) ─────────────────────────
describe('/set cheap', () => {
  it('admin: writes cheap_eval_provider through the config surface and confirms; auto clears it', async () => {
    const { cmds, cfg, sentMessages, setConfig } = setup({ registered: ['claude', 'agy'], isAdmin: () => true })
    await cmds.handle(inbound('/set cheap agy'))
    expect(setConfig).toHaveBeenCalledWith('cheap_eval_provider', 'agy')
    expect(cfg.cheapEvalProvider).toBe('agy')
    expect(sentMessages[0]![1]).toContain('agy')
    expect(sentMessages[0]![1]).toContain('不用重启')
    await cmds.handle(inbound('/set cheap auto'))
    expect(cfg.cheapEvalProvider).toBeUndefined()
    expect(sentMessages[1]![1]).toContain('偏好序')
  })
  it('non-admin is refused (it is a global knob)', async () => {
    const { cmds, setConfig, sentMessages } = setup({ isAdmin: () => false })
    await cmds.handle(inbound('/set cheap agy'))
    expect(setConfig).not.toHaveBeenCalled()
    expect(sentMessages[0]![1]).toContain('仅管理员')
  })
  it('/set overview shows the global cheap line to admins only', async () => {
    const a = setup({ isAdmin: () => true, config: { cheapEvalProvider: 'agy' } })
    await a.cmds.handle(inbound('/set'))
    expect(a.sentMessages[0]![1]).toContain('后台评估(全局): agy')
    const g = setup({ isAdmin: () => false, config: { cheapEvalProvider: 'agy' } })
    await g.cmds.handle(inbound('/set'))
    expect(g.sentMessages[0]![1]).not.toContain('后台评估')
  })
})

// ── provider policy(core/provider-policy.ts)——共享钥匙拒 guest;管理员限定非管理员 ──
describe('provider policy in slash commands', () => {
  it('/cursor is rejected for a guest chat — same shared-token shape as /agy (this gate did not exist before)', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'cursor'], tier: 'guest' })
    await cmds.handle(inbound('/cursor'))
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]![1]).toBe('❌ /cursor 目前仅管理员/信任聊天可用（工具通道暂无法按会话隔离权限）。')
  })
  it('trusted chat: providers outside the admin allowlist are refused with the allowed list; inside is fine', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'agy', 'openai'], tier: 'trusted', config: { trusted_providers: ['claude', 'openai'] } })
    await cmds.handle(inbound('/agy'))
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]![1]).toContain('没把 /agy 开放给非管理员')
    expect(sentMessages[0]![1]).toContain('claude, openai')
    await cmds.handle(inbound('/api'))
    expect(set).toHaveBeenLastCalledWith('chat-1', { kind: 'solo', provider: 'openai' })
  })
  it('admin ignores the allowlist', async () => {
    const { cmds, set } = setup({ registered: ['claude', 'agy'], tier: 'admin', config: { trusted_providers: ['claude'] } })
    await cmds.handle(inbound('/agy'))
    expect(set).toHaveBeenLastCalledWith('chat-1', { kind: 'solo', provider: 'agy' })
  })
  it('/set providers (admin) writes trusted_providers; all clears; non-admin refused', async () => {
    const a = setup({ registered: ['claude', 'agy'], isAdmin: () => true })
    await a.cmds.handle(inbound('/set providers claude,openai'))
    expect(a.setConfig).toHaveBeenCalledWith('trusted_providers', 'claude,openai')
    expect(a.sentMessages[0]![1]).toContain('非管理员对话现在只能用')
    await a.cmds.handle(inbound('/set providers all'))
    expect(a.sentMessages[1]![1]).toContain('全部已注册')
    const g = setup({ isAdmin: () => false })
    await g.cmds.handle(inbound('/set providers claude'))
    expect(g.setConfig).not.toHaveBeenCalled()
    expect(g.sentMessages[0]![1]).toContain('仅管理员')
  })
  it('/mode says which providers share one key and what non-admins may use; /help lists what is actually registered', async () => {
    const { cmds, sentMessages } = setup({ registered: ['claude', 'agy'], config: { trusted_providers: ['claude'] } })
    await cmds.handle(inbound('/mode'))
    expect(sentMessages[0]![1]).toContain('共用一把 trusted 钥匙')
    expect(sentMessages[0]![1]).toContain('非管理员可用(管理员设定): claude')
    await cmds.handle(inbound('/help'))
    expect(sentMessages[1]![1]).toContain('当前可用: /cc /agy')
    expect(sentMessages[1]![1]).toContain('订阅 CLI')
  })
})

describe('/mode provider notes', () => {
  it('shows per-provider status lines from bootstrap (codex version gap + probe result)', async () => {
    const { cmds, sentMessages } = setup({ registered: ['claude', 'codex'], notes: { codex: '你的 CLI 0.153.4(与 SDK 0.144.4 不同版,首次使用时真跑一句探测) · 未探测' } })
    await cmds.handle(inbound('/mode'))
    expect(sentMessages[0]![1]).toContain('codex: 你的 CLI 0.153.4')
    expect(sentMessages[0]![1]).toContain('未探测')
  })
})
