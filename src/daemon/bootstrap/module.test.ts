import { it, expect, vi } from 'vitest'
import { bootstrapDependencies } from './module'
import { WECHAT_PORTS } from '../../ports/wechat'
import { PendingPermissions } from '../pending-permissions'
import { gateTool } from '../../adapters/executors/openai/openai-gate'
import { TIER_PROFILES } from '../../domain/user-tier'
import type { Foundation } from '../foundation'

it('production bootstrap assembly forwards revocation so stop removes the real pending card', async () => {
  const pending = new PendingPermissions()
  const permissions = {
    askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number) => pending.register(hash, timeoutMs, { chatId, prompt }),
    resolvePermission: (hash: string, decision: 'allow' | 'deny') => pending.consume(hash, decision),
  }
  const boot = bootstrapDependencies({ stateDir: '/tmp/offline-bootstrap-fixture', dangerously: false } as Foundation, { get: (name: string) => {
    if (name === WECHAT_PORTS.permissions) return permissions
    if (name === 'stickers') return { lib: {} }
    if (name === 'memory') return { promptReads: {} }
    if (name === 'network-gate') return { gate: {} }
    return {}
  }, late: () => () => null } as any)
  const ctl = new AbortController()
  const work = gateTool({ toolName: 'matter_handoff', mcpServer: 'wechat', input: {}, chatId: 'owner', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', signal: ctl.signal,
    approval: { askUser: boot.ilink.askUser, adminFor: () => 'owner', revoke: hash => { boot.ilink.resolvePermission?.(hash, 'deny') } },
  })
  await expect.poll(() => pending.size()).toBe(1)
  const old = pending.list()[0]!.hash
  ctl.abort()
  expect((await work).decision).toBe('deny')
  expect(pending.size()).toBe(0)
  expect(permissions.resolvePermission(old, 'allow')).toBe(false)
})
