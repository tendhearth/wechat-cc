import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../../lib/db'
import { wirePermissions } from './wire-permissions'

const deps = (over: Partial<Parameters<typeof wirePermissions>[0]> = {}) => ({
  loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
  ilink: { askUser: vi.fn() } as any,
  ...over,
})
const ctx = () => ({ db: openTestDb(), stateDir: '/tmp/state', log: () => {} })

describe('wirePermissions', () => {
  it('resolve 用 projects.current;permissionMode 随 dangerouslySkipPermissions', () => {
    const s = wirePermissions(deps(), ctx())
    expect(s.resolve('any')).toEqual({ alias: 'P', path: '/p' })
    expect(s.permissionMode).toBe('strict')
    expect(wirePermissions(deps({ dangerouslySkipPermissions: true }), ctx()).permissionMode).toBe('dangerously')
  })
  it('注入的 conversationStore 原样返回;不注入则自己造一个', () => {
    const store = { get: () => undefined } as any
    expect(wirePermissions(deps({ conversationStore: store }), ctx()).conversationStore).toBe(store)
    expect(wirePermissions(deps(), ctx()).conversationStore).toBeDefined()
  })
  it('buildCanUseTool 每次给一个函数;busyRegistry 能 hold/release', () => {
    const s = wirePermissions(deps(), ctx())
    expect(typeof s.buildCanUseTool('chat-1')).toBe('function')
    const release = s.busyRegistry.hold('t')
    expect(s.busyRegistry.busy()).toBe(true)
    release()
    expect(s.busyRegistry.busy()).toBe(false)
  })
  describe('--dangerously 下访客不提权(2026-10-10 规矩)', () => {
    const prev = process.env.WECHAT_STATE_DIR
    let dir = ''
    afterEach(() => { if (prev === undefined) delete process.env.WECHAT_STATE_DIR; else process.env.WECHAT_STATE_DIR = prev; rmSync(dir, { recursive: true, force: true }) })
    const ask = async (chatId: string, tool: string, input: Record<string, unknown>) => {
      dir = mkdtempSync(join(tmpdir(), 'wire-perm-'))
      process.env.WECHAT_STATE_DIR = dir
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ allowFrom: ['owner', 'friend', 'visitor'], admins: ['owner'], trusted: ['friend'] }))
      const askUser = vi.fn(async () => 'deny')
      const fn = wirePermissions(deps({ dangerouslySkipPermissions: true, ilink: { askUser } as any }), { ...ctx(), stateDir: dir }).buildCanUseTool(chatId)
      return { res: await fn(tool, input, { signal: new AbortController().signal, toolUseID: 't1' } as any), askUser }
    }
    it('访客调插件 MCP(wxvault = 主人的微信记录)⇒ 拒,不按 admin 放', async () => {
      const { res } = await ask('visitor', 'mcp__wxvault__get_messages', { chat: 'x' })
      expect(res.behavior).toBe('deny')
    })
    it('trusted 在 --dangerously 下照旧按 admin', async () => {
      const { res, askUser } = await ask('friend', 'mcp__wxvault__get_messages', { chat: 'x' })
      expect(res.behavior).toBe('allow')
      expect(askUser).not.toHaveBeenCalled()
    })
  })
})
