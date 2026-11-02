import { describe, it, expect, afterEach } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from '../../adapters/store/workbench/store'
import { makeWorkbenchService } from './service'
import { createProviderRegistry } from '../../app/provider-registry'
import { MANAGED_NATIVE_CAPABILITIES } from '../../domain/workbench/executor-capabilities'
import { removeTempDir } from '../../lib/test-temp'
import { mkdtempSync, realpathSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d) })

/** registerCodex:only the continueTask row dispatches a real run and needs a resolvable provider. */
function setup(opts: { registerCodex?: boolean } = {}) {
  // realpathSync:canonicalProject 要求 task.path 已经是真实路径;macOS 上 tmpdir() 经 /tmp 符号链接。
  const db = openTestDb(), store = makeWorkbenchStore(db), stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-live-')))
  dirs.push(stateDir)
  const registry = createProviderRegistry()
  if (opts.registerCodex) {
    // spawn 永不落地:这些行只关心「同步落库那一刻这件事的游标有没有前进」,不关心执行者真跑完。
    registry.register('codex', { async spawn() { return new Promise<never>(() => {}) } }, { displayName: 'Codex', canResume: () => false, workbench: MANAGED_NATIVE_CAPABILITIES })
  }
  const service = makeWorkbenchService({ store, registry, stateDir, ownerChatId: () => 'owner' })
  const task = store.create({ title: 't', path: stateDir, providerId: 'codex', ownerChatId: 'owner' })
  return { store, service, id: task.id, stateDir }
}

describe('service 实时流面', () => {
  it('detail 带 version;since 只回变过的行', async () => {
    const { store, service, id } = setup()
    store.addEvent(id, 'user', '要求'); store.recordAgentEvent(id, 'r1', { kind: 'text', text: '你', itemId: 'i', textMode: 'append' })
    const full = await service.detail(id); expect(full.version).toBe(2); expect(full.events).toHaveLength(2)
    const part = await service.detail(id, { since: 1 }); expect(part.events.map(e => e.text)).toEqual(['你']); expect(part.version).toBe(2)
  })
  it('detail 带 cursor;sinceCursor 只回这之后写过的步 —— 改过的步(工具调用做完)也再来一次(P1b)', async () => {
    const { store, service, id } = setup()
    store.addEvent(id, 'user', '要求')
    store.recordAgentEvent(id, 'r1', { kind: 'tool_call', itemId: 'c1', text: '跑测试', activity: { id: 'c1', type: 'exec', status: 'running', label: '跑测试' } } as never)
    const first = await service.detail(id)
    expect(first.cursor).toBeGreaterThan(0)
    expect((await service.detail(id, { sinceCursor: first.cursor })).events).toEqual([])
    store.recordAgentEvent(id, 'r1', { kind: 'tool_call', itemId: 'c1', text: '跑测试', activity: { id: 'c1', type: 'exec', status: 'completed', label: '跑测试' } } as never)
    const next = await service.detail(id, { sinceCursor: first.cursor })
    expect(next.events.map(e => [e.kind, e.activity?.status])).toEqual([['tool_call', 'completed']])
    expect(next.cursor).toBeGreaterThan(first.cursor)
    // 只动了非步的状态(比如回执、状态):游标前进、事件为空 —— 桌面照样整份换掉非事件那部分
    store.update(id, 'running')
    const third = await service.detail(id, { sinceCursor: next.cursor })
    expect(third.events).toEqual([]); expect(third.cursor).toBeGreaterThan(next.cursor)
    // 按游标等:已经超过 ⇒ 马上回;没有 ⇒ 等到下一笔
    await expect(service.changes.waitCursor(id, next.cursor, 1000)).resolves.toBe(third.cursor)
    const p = service.changes.waitCursor(id, third.cursor, 5000)
    store.addEvent(id, 'system', 'x')
    await expect(p).resolves.toBeGreaterThan(third.cursor)
  })
  it('changes.wait:store 直接写不经 service 也叫醒(信号来自 MatterLog,P1a);已经超过 since 的马上返回', async () => {
    const { store, service, id } = setup()
    store.addEvent(id, 'user', '要求')             // version 1
    await expect(service.changes.wait(id, 0, 1000)).resolves.toBe(1)
    const p = service.changes.wait(id, 1, 5000)
    store.addEvent(id, 'system', 'x')               // 不经 service、不读详情:光写库就该叫醒
    await expect(p).resolves.toBe(2)
  })
  it('cancel 后 version 递增(cancelling 落库即 bump)', async () => {
    const { store, service, id } = setup()
    const v = store.version(id)
    await expect(service.cancel(id)).resolves.toMatchObject({ id })
    expect(store.version(id)).toBeGreaterThan(v)
  })
})

describe('service 实时流面 · 无需真执行者的写点都推进这件事的游标', () => {
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
    it(`${row.name} → 这件事的游标增加`, async () => {
      const ctx = setup({ registerCodex: row.registerCodex })
      const before = ctx.store.feed.cursor(ctx.id)
      await row.run(ctx)
      expect(ctx.store.feed.cursor(ctx.id)).toBeGreaterThan(before)
      await ctx.service.shutdown()
    })
  }
})

describe('service 实时流面 · shutdown 与并发 wait', () => {
  it('shutdown() 唤醒挂起的 changes.wait(feed.wakeAll)', async () => {
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
    // 真写了一条:两个 waiter 都该醒,拿到同一个新 version。
    store.addEvent(id, 'system', 'x')
    await expect(a).resolves.toBe(store.version(id))
    await expect(b).resolves.toBe(store.version(id))
  })
  it('回滚了的写不叫醒任何人(通知要等提交、确认落了库才发 —— 没有「幻影前进」,也就不用回落纠偏)', async () => {
    const { store, service, id } = setup()
    const v = store.version(id), heard: string[] = []
    const off = service.changes.onChange(taskId => heard.push(taskId))
    const parked = service.changes.wait(id, v, 60)
    expect(() => store.atomic(() => { store.addEvent(id, 'system', '会回滚'); throw new Error('boom') })).toThrow('boom')
    const started = Date.now()
    await expect(parked).resolves.toBe(v)
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)   // 等到了超时,不是被叫醒
    expect(heard).toEqual([])
    store.addEvent(id, 'system', '这条提交了')
    await Promise.resolve()
    expect(heard).toEqual([id])
    off()
  })
  it('service.changes.onChange:create 提交以后回调该任务和它的新游标(同一轮同步代码里的多笔合成一次)', async () => {
    const { store, service, stateDir } = setup({ registerCodex: true })
    const calls: Array<[string, number]> = []
    const off = service.changes.onChange((taskId, cursor) => calls.push([taskId, cursor]))
    const created = service.create({ path: stateDir, providerId: 'codex', text: '新任务' })
    expect(calls).toEqual([])   // 还在同步代码里:没确认提交前不发
    await Promise.resolve()
    expect(calls.filter(([taskId]) => taskId === created.id)).toEqual([[created.id, store.feed.cursor(created.id)]])
    expect(calls.some(([taskId]) => taskId === created.id)).toBe(true)
    off()
  })
})
