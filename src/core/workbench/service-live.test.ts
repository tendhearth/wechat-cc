import { describe, it, expect, afterEach } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from './store'
import { makeWorkbenchService } from './service'
import { createProviderRegistry } from '../provider-registry'
import { makeTaskChangeHub, type TaskChangeHub } from './task-changes'
import { MANAGED_NATIVE_CAPABILITIES } from './executor-capabilities'
import { removeTempDir } from '../../lib/test-temp'
import { mkdtempSync, realpathSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d) })

/** registerCodex:only the continueTask row dispatches a real run and needs a resolvable provider. */
function setup(opts: { registerCodex?: boolean } = {}) {
  // realpathSync:canonicalProject 要求 task.path 已经是真实路径;macOS 上 tmpdir() 经 /tmp 符号链接。
  const db = openTestDb(), store = makeWorkbenchStore(db), stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-live-')))
  dirs.push(stateDir)
  const hub: TaskChangeHub = makeTaskChangeHub()
  const registry = createProviderRegistry()
  if (opts.registerCodex) {
    // spawn 永不落地:这些行只关心「同步落库那一刻 hub 有没有被通知」,不关心执行者真跑完。
    registry.register('codex', { async spawn() { return new Promise<never>(() => {}) } }, { displayName: 'Codex', canResume: () => false, workbench: MANAGED_NATIVE_CAPABILITIES })
  }
  const service = makeWorkbenchService({ store, registry, stateDir, ownerChatId: () => 'owner', changes: hub })
  const task = store.create({ title: 't', path: stateDir, providerId: 'codex', ownerChatId: 'owner' })
  return { store, service, hub, id: task.id }
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

describe('service 实时流面 · 无需真执行者的写点都经 hub 发布', () => {
  type Ctx = ReturnType<typeof setup>
  const rows: Array<{ name: string; registerCodex?: boolean; run: (ctx: Ctx) => Promise<void> | void }> = [
    { name: 'detail(读到一条绕过 service 的新写)', run: async ({ store, service, id }) => { store.addEvent(id, 'user', '要求'); await service.detail(id) } },
    { name: 'cancel(排队中、还没派发)', run: async ({ service, id }) => { await service.cancel(id) } },
    // withdrawInput/submitInput 是同一对 liveInputs 状态机:submitInput 要求 runsByTask 里有一条
    // session.steer/workbenchRuntime 活着的 running,这在没有真执行者时构造不出来,只能在真跑
    // 通道的测试里覆盖;withdrawInput 只要求一条 pending 的 liveInput,能直接造出来。
    { name: 'withdrawInput', run: ({ store, service, id }) => { store.liveInputs.add({ id: 'req-1', taskId: id, runId: 'r1', text: 'x' }); service.withdrawInput(id, 'req-1') } },
    { name: 'setArchived(archivedAt 落库但 store.setArchived 自己不 bump)', run: ({ store, service, id }) => { store.update(id, 'completed'); service.setArchived(id, true) } },
    { name: 'continueTask(terminal 任务:写 user 事件 + 转 queued)', registerCodex: true, run: ({ store, service, id }) => { store.update(id, 'completed'); service.continueTask(id, '继续') } },
  ]
  for (const row of rows) {
    it(`${row.name} → hub.seq(id) 增加`, async () => {
      const ctx = setup({ registerCodex: row.registerCodex })
      const before = ctx.hub.seq(ctx.id)
      await row.run(ctx)
      expect(ctx.hub.seq(ctx.id)).toBeGreaterThan(before)
      await ctx.service.shutdown()
    })
  }
})

describe('service 实时流面 · shutdown 与并发 wait', () => {
  it('shutdown() 唤醒挂起的 changes.wait(hub.dispose)', async () => {
    const { service, id } = setup()
    const p = service.changes.wait(id, 999, 30_000)
    let settled = false; void p.then(() => { settled = true })
    await new Promise(r => setTimeout(r, 5))
    expect(settled).toBe(false)
    await service.shutdown()
    await expect(p).resolves.toBe(0)
  })
  it('两个并发 changes.wait:没变化的 detail 不叫醒;真写了一条才一起醒,拿到同一个新 version', async () => {
    const { store, service, id } = setup()
    const a = service.changes.wait(id, 0, 5000), b = service.changes.wait(id, 0, 5000)
    let aSettled = false, bSettled = false
    void a.then(() => { aSettled = true }); void b.then(() => { bSettled = true })
    await new Promise(r => setTimeout(r, 5))
    expect(aSettled).toBe(false); expect(bSettled).toBe(false)
    // 第三方查询详情,但任务什么都没变:不该叫醒任何一个 waiter。
    await service.detail(id)
    await new Promise(r => setTimeout(r, 5))
    expect(aSettled).toBe(false); expect(bSettled).toBe(false)
    // 真写了一条,再 detail 一次:两个 waiter 都该醒,拿到同一个新 version。
    store.addEvent(id, 'system', 'x')
    const d = await service.detail(id)
    await expect(a).resolves.toBe(d.version)
    await expect(b).resolves.toBe(d.version)
  })
})
