import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../lib/db'
import { makeWorkbenchStore } from './store'
import { makeWorkbenchService, type WorkbenchService } from './service'
import { createProviderRegistry } from '../provider-registry'
import type { AgentProvider } from '../agent-provider'
import { removeTempDir } from '../../lib/test-temp'
import { UNATTENDED_CAPABILITIES, MANAGED_NATIVE_CAPABILITIES } from './executor-capabilities'

// 每个用例可能建不止一个 service/db(如「没接 unattendedAck」那条另起炉灶),case 2
// 那条还会真跑一次 dispatch 且从不显式 shutdown —— afterEach 必须先 shutdown 全部
// service、再 close 全部 db,最后才删目录,否则删的是一个还在跑的 run 底下的目录。
const services: WorkbenchService[] = []
const dbs: Db[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown()
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) removeTempDir(dir)
})

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

/** root/state/project 分开:project 是传给 create 的任务目录,state 是 service 自己的
 *  附件/产物存储目录,两者本就是不同用途,混用一个目录只是碰巧能跑(照 service-capabilities.test.ts:26)。 */
function tempRoot(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  return { stateDir, project }
}

function setup(acked: number | null = null) {
  const { stateDir, project } = tempRoot('wb-unatt-')
  const db = openTestDb(); dbs.push(db)
  const store = makeWorkbenchStore(db)
  const registry = createProviderRegistry(), spawned: Array<{ permissionMode?: string }> = []
  registry.register('agy', fakeProvider(spawned), { displayName: 'agy', canResume: () => false, workbench: UNATTENDED_CAPABILITIES })
  registry.register('claude', fakeProvider(spawned), { displayName: 'Claude', canResume: () => false, workbench: MANAGED_NATIVE_CAPABILITIES })
  let ack = acked
  const service = makeWorkbenchService({ store, registry, stateDir, ownerChatId: () => 'owner', unattendedAck: { get: () => ack, set: at => { ack = at } } })
  services.push(service)
  return { service, project, spawned, ackValue: () => ack }
}
const input = (path: string, providerId: string) => ({ path, providerId, text: '做点事', execution: { defaults: 'provider' as const, model: null, reasoningEffort: null } })

describe('免审执行者门', () => {
  it('未确认 ⇒ create 抛 unattended_ack_required；claude 不受影响', () => {
    const { service, project } = setup()
    expect(() => service.create(input(project, 'agy'))).toThrow('unattended_ack_required')
    expect(() => service.create(input(project, 'claude'))).not.toThrow()
  })

  it('acknowledgeUnattended 写开关并返回时间；之后 create 通过；list 带 unattendedAcknowledgedAt', async () => {
    const { service, project, ackValue, spawned } = setup()
    expect(service.list().unattendedAcknowledgedAt).toBeNull()
    const at = service.acknowledgeUnattended()
    expect(ackValue()).toBe(at)
    expect(service.list().unattendedAcknowledgedAt).toBe(at)
    const task = service.create(input(project, 'agy'))
    await vi.waitFor(() => expect(service.detail(task.id).task.status).toBe('completed'))
    expect(spawned.at(-1)?.permissionMode).toBe('dangerously')
  })

  it('claude 的 spawn 仍是 strict', async () => {
    const { service, project, spawned } = setup(Date.now())
    const task = service.create(input(project, 'claude'))
    await vi.waitFor(() => expect(service.detail(task.id).task.status).toBe('completed'))
    expect(spawned.at(-1)?.permissionMode).toBe('strict')
  })

  it('没接 unattendedAck（老接线）⇒ 免审执行者一律 unattended_ack_required，acknowledgeUnattended 也拒绝', () => {
    const { stateDir, project } = tempRoot('wb-unatt-')
    const db = openTestDb(); dbs.push(db)
    const store = makeWorkbenchStore(db)
    const registry = createProviderRegistry()
    registry.register('agy', fakeProvider([]), { displayName: 'agy', canResume: () => false, workbench: UNATTENDED_CAPABILITIES })
    const service = makeWorkbenchService({ store, registry, stateDir, ownerChatId: () => 'owner' })
    services.push(service)
    expect(() => service.create(input(project, 'agy'))).toThrow('unattended_ack_required')
    expect(() => service.acknowledgeUnattended()).toThrow('unattended_ack_unavailable')
  })
})
