import { describe, expect, it, vi } from 'vitest'
import type { SpawnContext } from './agent-provider'
import { TIER_PROFILES } from './user-tier'
import { createAcpProvider } from './acp-agent-provider'
import { ACP_CURSOR_CAPABILITIES, acpMcpServersFor, createAcpCursorChatProvider, DEFAULT_CURSOR_MODEL } from './acp-cursor-chat'

// 包住真实实现当观察点(与 bootstrap.test.ts 包 wireSelfRestart 同一姿势):
// 对话侧是不是真的按"逐会话 MCP + 按对话钉模型 + 失败回退新会话 + 不报 notice"接出去的,
// 除了在这儿看一眼选项,别处看不见 —— 真跑一次要起 cursor-agent。
vi.mock('./acp-agent-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./acp-agent-provider')>()
  return { ...actual, createAcpProvider: vi.fn(actual.createAcpProvider) }
})

describe('ACP cursor chat provider', () => {
  it('builds per-session MCP entries: CORE names get mcpEnv, PATH/HOME are carried, null specs are skipped', () => {
    const prevPath = process.env.PATH, prevHome = process.env.HOME
    process.env.PATH = '/usr/bin'; process.env.HOME = '/Users/me'
    try {
      const servers = acpMcpServersFor({ wechat: { command: '/cli', args: ['mcp-server', 'wechat'], env: { WECHAT_INTERNAL_API: 'http://127.0.0.1:1' } }, delegate: null }, { WECHAT_SESSION_TOKEN: 'tok', WECHAT_SESSION_TIER: 'admin' })
      expect(servers).toEqual([{ name: 'wechat', command: '/cli', args: ['mcp-server', 'wechat'], env: [
        { name: 'PATH', value: '/usr/bin' }, { name: 'HOME', value: '/Users/me' }, { name: 'WECHAT_INTERNAL_API', value: 'http://127.0.0.1:1' }, { name: 'WECHAT_SESSION_TOKEN', value: 'tok' }, { name: 'WECHAT_SESSION_TIER', value: 'admin' },
      ] }])
      const both = acpMcpServersFor({ wechat: { command: '/cli', args: ['a'] }, delegate: { command: '/cli', args: ['d'] } }, { WECHAT_SESSION_TOKEN: 'tok' })
      expect(both.map(s => s.name)).toEqual(['wechat', 'delegate'])
      expect(both[1]!.env.some(e => e.name === 'WECHAT_SESSION_TOKEN')).toBe(true)
      expect(acpMcpServersFor({ wechat: null, delegate: null })).toEqual([])
    } finally { process.env.PATH = prevPath; process.env.HOME = prevHome }
  })
  it('declares admin MCP tools, resume, no per-tool callback, claude as default peer', () => {
    expect(ACP_CURSOR_CAPABILITIES).toMatchObject({ perToolCallback: false, adminMcpTools: true, supportsDelegation: false, supportsResume: true, defaultPeer: 'claude' })
    // MCP 子进程按会话带 tier(adminMcpTools:true),但 Cursor 自己的工具面约束不住 ⇒ guest 一律拒。
    expect(ACP_CURSOR_CAPABILITIES.guestSafe).toBe(false)
    expect(ACP_CURSOR_CAPABILITIES.authFailHint).toContain('cursor-agent login')
    expect(DEFAULT_CURSOR_MODEL).toBe('auto')
  })
  it('wires the generic ACP provider with the chat-side options: mode permissions, one text per message, fallback resume, no notice', () => {
    vi.mocked(createAcpProvider).mockClear()
    const log = vi.fn()
    const spawn = vi.fn() as unknown as typeof import('node:child_process').spawn
    const mcpSpecs = { wechat: { command: '/cli', args: ['mcp-server', 'wechat'], env: { WECHAT_INTERNAL_API: 'http://127.0.0.1:1' } }, delegate: null }
    createAcpCursorChatProvider({ bin: '/cursor-agent', model: 'composer-2', log, mcpSpecs, spawn })
    expect(createAcpProvider).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(createAcpProvider).mock.calls[0]![0]
    expect(opts).toMatchObject({ command: '/cursor-agent', args: ['acp'], displayName: 'Cursor', permissions: 'mode', text: 'messages', resume: 'fallback', notice: null, log, spawn })
    const ctx = (extra: Partial<SpawnContext> = {}): SpawnContext => ({ tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'chat-1', mcpEnv: { WECHAT_SESSION_TOKEN: 'tok', WECHAT_SESSION_TIER: 'admin' }, ...extra })
    // MCP 逐会话:同一个 mcpEnv 进去,拿到的就是 acpMcpServersFor 的那份(含会话 token/tier)。
    expect(opts.mcpServers!(ctx())).toEqual(acpMcpServersFor(mcpSpecs, ctx().mcpEnv))
    expect(opts.mcpServers!(ctx())[0]!.env.some(e => e.name === 'WECHAT_SESSION_TOKEN' && e.value === 'tok')).toBe(true)
    // 模型:本对话钉的赢,没钉就用配置里的那个。
    expect(opts.model!(ctx({ model: 'gpt-5' }))).toBe('gpt-5')
    expect(opts.model!(ctx())).toBe('composer-2')
  })
  it('cheapEval/strongEval run the print one-shot and turn a login sentinel into auth_failed', async () => {
    const lines = ['{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in"}]}}', '{"type":"result","subtype":"success","is_error":false,"result":"x","session_id":"s"}']
    const evalSpawn = vi.fn(() => ({ stdout: (async function* () { for (const l of lines) yield l + '\n' })(), exited: Promise.resolve(0), stderr: async () => '', kill: () => {} }))
    const provider = createAcpCursorChatProvider({ bin: '/cursor-agent', model: 'auto', log: () => {}, mcpSpecs: { wechat: null, delegate: null }, evalSpawn })
    await expect(provider.cheapEval!('q')).rejects.toThrow('auth_failed')
    expect(provider.cheapEvalBudgetMs).toBe(20_000)
    expect(typeof provider.strongEval).toBe('function')
  })
})
