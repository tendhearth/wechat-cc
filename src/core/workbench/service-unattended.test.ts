import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from './store'
import { makeWorkbenchService } from './service'
import { createProviderRegistry } from '../provider-registry'
import type { AgentProvider } from '../agent-provider'
import { removeTempDir } from '../../lib/test-temp'
import { UNATTENDED_CAPABILITIES, MANAGED_NATIVE_CAPABILITIES } from './executor-capabilities'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d) })

/** Minimal always-completing fake — mirrors service-capabilities.test.ts's `provider()` helper,
 *  recording each spawn's context so tests can assert on `permissionMode`. */
function fakeProvider(spawned: Array<{ permissionMode?: string }>): AgentProvider {
  return {
    async spawn(_project, context) {
      spawned.push(context)
      return {
        async *dispatch() {
          yield { kind: 'text' as const, text: '好了' }
          yield { kind: 'result' as const, sessionId: 's', numTurns: 1, durationMs: 1 }
        },
        async cancel() {},
        async close() {},
      }
    },
  }
}

function setup(acked: number | null = null) {
  const db = openTestDb(), store = makeWorkbenchStore(db)
  const stateDir = mkdtempSync(join(tmpdir(), 'wb-unatt-'))
  dirs.push(stateDir)
  const registry = createProviderRegistry(), spawned: Array<{ permissionMode?: string }> = []
  registry.register('agy', fakeProvider(spawned), { displayName: 'agy', canResume: () => false, workbench: UNATTENDED_CAPABILITIES })
  registry.register('claude', fakeProvider(spawned), { displayName: 'Claude', canResume: () => false, workbench: MANAGED_NATIVE_CAPABILITIES })
  let ack = acked
  const service = makeWorkbenchService({ store, registry, stateDir, ownerChatId: () => 'owner', unattendedAck: { get: () => ack, set: at => { ack = at } } })
  return { service, store, stateDir, spawned, ackValue: () => ack }
}
const input = (stateDir: string, providerId: string) => ({ path: stateDir, providerId, text: '做点事', execution: { defaults: 'provider' as const, model: null, reasoningEffort: null } })

describe('免审执行者门', () => {
  it('未确认 ⇒ create 抛 unattended_ack_required；claude 不受影响', () => {
    const { service, stateDir } = setup()
    expect(() => service.create(input(stateDir, 'agy'))).toThrow('unattended_ack_required')
    expect(() => service.create(input(stateDir, 'claude'))).not.toThrow()
  })

  it('acknowledgeUnattended 写开关并返回时间；之后 create 通过；list 带 unattendedAcknowledgedAt', async () => {
    const { service, stateDir, ackValue, spawned } = setup()
    expect(service.list().unattendedAcknowledgedAt).toBeNull()
    const at = service.acknowledgeUnattended()
    expect(ackValue()).toBe(at)
    expect(service.list().unattendedAcknowledgedAt).toBe(at)
    const task = service.create(input(stateDir, 'agy'))
    await vi.waitFor(() => expect(service.detail(task.id).task.status).toBe('completed'))
    expect(spawned.at(-1)?.permissionMode).toBe('dangerously')
    await service.shutdown()
  })

  it('claude 的 spawn 仍是 strict', async () => {
    const { service, stateDir, spawned } = setup(Date.now())
    const task = service.create(input(stateDir, 'claude'))
    await vi.waitFor(() => expect(service.detail(task.id).task.status).toBe('completed'))
    expect(spawned.at(-1)?.permissionMode).toBe('strict')
    await service.shutdown()
  })

  it('没接 unattendedAck（老接线）⇒ 免审执行者一律 unattended_ack_required', () => {
    const db = openTestDb(), store = makeWorkbenchStore(db)
    const stateDir = mkdtempSync(join(tmpdir(), 'wb-unatt-'))
    dirs.push(stateDir)
    const registry = createProviderRegistry()
    registry.register('agy', fakeProvider([]), { displayName: 'agy', canResume: () => false, workbench: UNATTENDED_CAPABILITIES })
    const service = makeWorkbenchService({ store, registry, stateDir, ownerChatId: () => 'owner' })
    expect(() => service.create(input(stateDir, 'agy'))).toThrow('unattended_ack_required')
  })
})
