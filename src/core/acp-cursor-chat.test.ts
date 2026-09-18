import { describe, expect, it, vi } from 'vitest'
import { ACP_CURSOR_CAPABILITIES, acpMcpServersFor, createAcpCursorChatProvider, DEFAULT_CURSOR_MODEL } from './acp-cursor-chat'

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
    expect(ACP_CURSOR_CAPABILITIES.authFailHint).toContain('cursor-agent login')
    expect(DEFAULT_CURSOR_MODEL).toBe('auto')
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
