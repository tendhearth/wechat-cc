import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from './store'
import { makeWorkbenchService } from './service'
import { createProviderRegistry } from '../provider-registry'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'

function setup() {
  const db = openTestDb(), store = makeWorkbenchStore(db), stateDir = mkdtempSync(join(tmpdir(), 'wb-live-'))
  const service = makeWorkbenchService({ store, registry: createProviderRegistry(), stateDir, ownerChatId: () => 'owner' })
  const task = store.create({ title: 't', path: stateDir, providerId: 'codex', ownerChatId: 'owner' })
  return { store, service, id: task.id }
}

describe('service 实时流面', () => {
  it('detail 带 version;since 只回变过的行', async () => {
    const { store, service, id } = setup()
    store.addEvent(id, 'user', '要求'); store.recordAgentEvent(id, 'r1', { kind: 'text', text: '你', itemId: 'i', textMode: 'append' })
    const full = await service.detail(id); expect(full.version).toBe(2); expect(full.events).toHaveLength(2)
    const part = await service.detail(id, { since: 1 }); expect(part.events.map(e => e.text)).toEqual(['你']); expect(part.version).toBe(2)
  })
  it('changes.wait:store 直接写不经 service 时 hub 不知道,但 wait 先看持久化 version 再挂', async () => {
    const { store, service, id } = setup()
    store.addEvent(id, 'user', '要求')             // version 1,hub 不知道
    await expect(service.changes.wait(id, 0, 1000)).resolves.toBe(1)   // wait 用 store.version 兜底
    const p = service.changes.wait(id, 1, 5000)
    store.addEvent(id, 'system', 'x'); await service.detail(id)        // detail 顺手 publish 当前 version
    await expect(p).resolves.toBe(2)
  })
  it('cancel 后 version 递增(cancelling 落库即 bump)', async () => {
    const { store, service, id } = setup()
    const v = store.version(id)
    await expect(service.cancel(id)).resolves.toMatchObject({ id })
    expect(store.version(id)).toBeGreaterThan(v)
  })
})
