import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMemoryNightlyRuntime, deliverPendingNotice, type NoticeDeps } from './nightly-runtime'
import { readNightlyState, writeNightlyState, type NightlyRunDeps } from './nightly'

const OWNER = 'owner@im.wechat'
let stateDir: string, root: string, now: number, sent: string[]
let n = 0

function deps(over: Partial<NightlyRunDeps & NoticeDeps> = {}): NightlyRunDeps & NoticeDeps {
  return {
    stateDir,
    ownerChatId: () => OWNER,
    config: () => ({ enabled: true, at: '04:00', timezone: 'UTC' }),
    sources: { observationsSince: async () => [], milestonesSince: async () => [], messagesSince: async () => ['主人:周五前给 X 回话'], projectMemory: () => '' },
    cheapEval: () => async () => JSON.stringify({ add: [{ section: '承诺', text: '周五前给 X 回话(期限 2026-09-26)' }], update: [], confirm: [], remove: [] }),
    ownerRecentlyActive: async () => false,
    now: () => now,
    newId: () => (0xa000 + n++).toString(16),
    log: () => {},
    careGate: () => ({ ok: true }),
    claim: vi.fn(),
    wechatSuspended: () => false,
    send: async (_c, t) => { sent.push(t); return {} },
    ...over,
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'nightly-rt-'))
  root = join(stateDir, 'memory', OWNER)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'profile.md'), '草稿\n')
  now = Date.parse('2026-09-25T04:05:00Z')
  sent = []
})

describe('memory nightly runtime', () => {
  it('tick at 04:05 writes the memory but holds the notice until 09:00', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.tick()
    expect(sent).toEqual([])
    now = Date.parse('2026-09-25T09:01:00Z')
    await rt.tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('整理成了一份记忆')
    expect(readNightlyState(stateDir).pendingNotice).toBeNull()
  })
  it('claims before sending, drops on care denial, waits on cooldown or a suspended WeChat link, expires after 24h', async () => {
    const claim = vi.fn()
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: 'x', createdAtMs: Date.parse('2026-09-25T04:00:00Z') } })
    now = Date.parse('2026-09-25T10:00:00Z')
    expect(await deliverPendingNotice(deps({ wechatSuspended: () => true }))).toBe('waiting')
    expect(await deliverPendingNotice(deps({ careGate: () => ({ ok: false, reason: 'memory_cooldown' }) }))).toBe('waiting')
    expect(await deliverPendingNotice(deps({ claim }))).toBe('sent')
    expect(claim).toHaveBeenCalledWith(OWNER, '2026-09-25T10:00:00.000Z')
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: 'y', createdAtMs: Date.parse('2026-09-25T04:00:00Z') } })
    expect(await deliverPendingNotice(deps({ careGate: () => ({ ok: false, reason: 'paused_no_reply' }) }))).toBe('dropped')
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: 'z', createdAtMs: Date.parse('2026-09-24T04:00:00Z') } })
    expect(await deliverPendingNotice(deps())).toBe('expired')
    expect(sent).toEqual(['x'])
  })
  it('readCurated shows the rendered memory with a header; curatedView marks last night changes and dues', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    expect(rt.readCurated()).toBeNull()
    await rt.runNow()
    const text = rt.readCurated()!
    expect(text.split('\n').slice(0, 2)).toEqual(['这是我眼中的你 🌙', '今天凌晨 4 点整理的,改了 1 处。'])
    expect(text).toContain('【承诺】\n· 周五前给 X 回话(明天)')
    const v = rt.curatedView()!
    expect(v.updated_at).toBe('2026-09-25T04:05:00.000Z')
    expect(v.sections.find(s => s.name === '承诺')!.items[0]).toMatchObject({ text: '周五前给 X 回话(期限 2026-09-26)', due: '2026-09-26', changed: true })
  })
  it('warns in the header after three failed nights', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.runNow()
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), failures: 3 })
    expect(rt.readCurated()!.split('\n')[0]).toBe('⚠️ 最近 3 次整理都没成功,下面可能是旧的。')
  })
  it('serializes concurrent runNow calls — the model is never called by two runs at once', async () => {
    let active = 0, maxActive = 0, calls = 0, msg = 0
    const rt = makeMemoryNightlyRuntime(deps({
      sources: { observationsSince: async () => [], milestonesSince: async () => [], messagesSince: async () => [`主人:第 ${msg++} 句`], projectMemory: () => '' },
      cheapEval: () => async () => {
        active++; calls++; maxActive = Math.max(maxActive, active)
        await new Promise(r => setTimeout(r, 20))
        active--
        return JSON.stringify({ add: [{ section: '近况', text: `第 ${calls} 次` }], update: [], confirm: [], remove: [] })
      },
    }))
    const [a, b] = await Promise.all([rt.runNow(), rt.runNow()])
    expect(a.status).toBe('written')
    expect(b.status).toBe('written')
    expect(calls).toBe(2)
    expect(maxActive).toBe(1)
  })
  it('a notice cleared by a delivery while a run is in flight is not resurrected', async () => {
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: '旧通知', createdAtMs: Date.parse('2026-09-25T04:00:00Z') } })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let entered!: () => void
    const inEval = new Promise<void>(r => { entered = r })
    const rt = makeMemoryNightlyRuntime(deps({
      cheapEval: () => async () => {
        entered()
        await gate
        return JSON.stringify({ add: [{ section: '近况', text: '在赶发版' }], update: [], confirm: [], remove: [] })
      },
    }))
    const run = rt.runNow()
    await inEval
    // a delivery sent the old notice and cleared it while the model was thinking
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: null })
    release()
    expect((await run).status).toBe('written')
    expect(readNightlyState(stateDir).pendingNotice).toBeNull()
  })
  it('logs a repeated skip reason once, not every tick', async () => {
    const log = vi.fn()
    const rt = makeMemoryNightlyRuntime(deps({ log, config: () => ({ enabled: false, at: '04:00', timezone: 'UTC' }) }))
    await rt.tick()
    await rt.tick()
    await rt.tick()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('MEMORY_NIGHTLY', 'tick: skipped (disabled)')
  })
  it('logs the same skip reason again after a non-skipped result in between', async () => {
    const log = vi.fn()
    let enabled = false
    const rt = makeMemoryNightlyRuntime(deps({ log, config: () => ({ enabled, at: '04:00', timezone: 'UTC' }) }))
    await rt.tick()
    enabled = true
    await rt.tick()   // written
    enabled = false
    await rt.tick()
    const tickLines = log.mock.calls.filter(c => String(c[1]).startsWith('tick:')).map(c => c[1])
    expect(tickLines).toEqual(['tick: skipped (disabled)', 'tick: written', 'tick: skipped (disabled)'])
  })
})

describe('rich view + WeChat letter', () => {
  it('first: no memory.md yet', () => {
    const v = makeMemoryNightlyRuntime(deps()).curatedView()!
    expect(v).toMatchObject({ mood: 'first', updated_at: null, when_label: null, changes: [], sections: [] })
  })
  it('changed: derived display fields, order, labels', async () => {
    const rt = makeMemoryNightlyRuntime(deps({
      cheapEval: () => async () => JSON.stringify({ add: [
        { section: '承诺', text: '周五回话(期限 2026-09-26)' },
        { section: '身边的人', text: '猪大哥 —— 女友,最亲' },
      ], update: [], confirm: [], remove: [] }),
    }))
    await rt.runNow()
    const v = rt.curatedView()!
    expect(v.mood).toBe('changed')
    expect(v.when_label).toBe('今天凌晨 4 点')
    expect(v.sections.map(s => s.name)).toEqual(['承诺', '身边的人'])
    expect(v.sections[0]!.items[0]).toMatchObject({ display: '周五回话', due: '2026-09-26', due_label: '明天', person: null, changed: true })
    expect(v.sections[1]!.items[0]).toMatchObject({ person: { name: '猪大哥', rel: '女友,最亲' } })
    expect(v.changes.map(c => c.label)).toEqual(['新记下', '记下'])
  })
  it('steady after the changed window; WeChat letter uses the new format', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.runNow()
    now = Date.parse('2026-09-27T20:00:00Z')   // > 36h later
    expect(rt.curatedView()!.mood).toBe('steady')
    const text = rt.readCurated()!
    expect(text.split('\n')[0]).toBe('这是我眼中的你 🌙')
    expect(text).toContain('最近没有新变化。')
    expect(text).toContain('【承诺】')
  })
})
