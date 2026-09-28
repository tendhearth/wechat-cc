import { describe, it, expect, vi } from 'vitest'
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
})
