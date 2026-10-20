import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeJobsStore } from '../../core/scheduled-jobs-store'
import { makeJobsCommand, chainReplyHandlers } from './command'

function setup() {
  const store = makeJobsStore(mkdtempSync(join(tmpdir(), 'jobs-cmd-')))
  const said: Array<[string, string]> = []
  const cmd = makeJobsCommand({
    store, isOwner: (c) => c === 'owner', say: async (c, t) => { said.push([c, t]) },
    timezone: () => 'Asia/Shanghai', now: () => Date.parse('2026-10-20T00:00:00Z'), log: () => {},   // 上海 08:00 周二
  })
  return { store, said, cmd }
}

describe('定时 (WeChat)', () => {
  it('owner adds a job: stored, confirmed with next run and the quiet promise', async () => {
    const s = setup()
    expect(s.cmd.probe('定时 每周一 9:00 看 issue', 'owner')).toBe(true)
    expect(await s.cmd.handle('定时 每周一 9:00 看 issue', 'owner')).toBe(true)
    expect(s.store.list().jobs).toMatchObject([{ id: 'j1', text: '看 issue', schedule: { kind: 'weekly', weekday: 1, at: '09:00' } }])
    const reply = s.said[0]![1]
    expect(reply).toContain('j1')
    expect(reply).toContain('每周一 09:00(上海)')
    expect(reply).toContain('10月26日(周一)09:00')
    expect(reply).toContain('不吭声')
  })
  it('list shows id, schedule, text head, last result and paused', async () => {
    const s = setup()
    s.store.add({ kind: 'daily', at: '09:00' }, '看一下今天的天气和日程,有雨提醒我带伞', new Date())
    s.store.record('j1', '2026-10-19', '2026-10-19T01:00:00Z', 'silent', false)
    s.store.setPaused('j1', true)
    await s.cmd.handle('定时', 'owner')
    const t = s.said[0]![1]
    expect(t).toContain('j1')
    expect(t).toContain('每天 09:00(上海)')
    expect(t).toContain('看一下今天的天气')
    expect(t).toContain('没说话')
    expect(t).toContain('停着')
  })
  it('empty list explains how to add', async () => {
    const s = setup()
    await s.cmd.handle('定时', 'owner')
    expect(s.said[0]![1]).toContain('定时 每天')
  })
  it('pause / resume / remove; unknown id says so', async () => {
    const s = setup()
    s.store.add({ kind: 'daily', at: '09:00' }, 'x', new Date())
    await s.cmd.handle('定时 停 j1', 'owner'); expect(s.store.list().jobs[0]!.paused).toBe(true)
    await s.cmd.handle('定时 开 j1', 'owner'); expect(s.store.list().jobs[0]!.paused).toBe(false)
    await s.cmd.handle('定时 删 j9', 'owner'); expect(s.said.at(-1)![1]).toContain('j9')
    await s.cmd.handle('定时 删 j1', 'owner'); expect(s.store.list().jobs).toEqual([])
  })
  it('bad form ⇒ usage; non-owner ⇒ not a command at all', async () => {
    const s = setup()
    await s.cmd.handle('定时 每小时 x', 'owner')
    expect(s.said[0]![1]).toContain('定时的写法')
    expect(s.cmd.probe('定时 每天 9:00 x', 'guest')).toBe(false)
    expect(await s.cmd.handle('定时 每天 9:00 x', 'guest')).toBe(false)
    expect(s.store.list().jobs).toEqual([])
    expect(s.cmd.probe('你好', 'owner')).toBe(false)
  })
})

describe('chainReplyHandlers', () => {
  it('probe is any; handle goes only to a handler whose probe claims it', async () => {
    const a = { probe: vi.fn((t: string) => t === 'a'), handle: vi.fn(async (t: string) => t === 'a') }
    const b = { probe: vi.fn((t: string) => t === 'b'), handle: vi.fn(async (t: string) => t === 'b') }
    const c = chainReplyHandlers([a, b])
    expect(c.probe('b', 'x')).toBe(true)
    expect(c.probe('z', 'x')).toBe(false)
    expect(await c.handle('b', 'x')).toBe(true)
    expect(a.handle).not.toHaveBeenCalled()
    expect(await c.handle('z', 'x')).toBe(false)
    expect(b.handle).toHaveBeenCalledTimes(1)
  })
})

describe('定时 × 执行者(真机核对 10-20)', () => {
  function mk(executor: string | null) {
    const store = makeJobsStore(mkdtempSync(join(tmpdir(), 'jobs-exec-')))
    const said: string[] = []
    const cmd = makeJobsCommand({ store, isOwner: () => true, say: async (_c, t) => { said.push(t) }, timezone: () => 'Asia/Shanghai', now: () => Date.parse('2026-10-20T00:00:00Z'), log: () => {}, jobExecutor: () => executor })
    return { cmd, said }
  }
  it('says which executor runs it', async () => {
    const m = mk('claude')
    await m.cmd.handle('定时 每天 9:00 x', 'owner')
    expect(m.said[0]).toContain('用 Claude 跑')
  })
  it('no usable executor ⇒ says so right away, at add and in the list', async () => {
    const m = mk(null)
    await m.cmd.handle('定时 每天 9:00 x', 'owner')
    expect(m.said[0]).toContain('现在跑不了')
    await m.cmd.handle('定时', 'owner')
    expect(m.said[1]).toContain('现在跑不了')
  })
})

describe('早报 × 微信', () => {
  function mk() {
    const dir = mkdtempSync(join(tmpdir(), 'brief-cmd-'))
    const store = makeJobsStore(dir)
    const said: string[] = []
    const prefs: string[] = []
    const cmd = makeJobsCommand({
      store, isOwner: (c) => c === 'owner', say: async (_c, t) => { said.push(t) }, timezone: () => 'Asia/Shanghai',
      now: () => Date.parse('2026-10-20T00:00:00Z'), log: () => {}, jobExecutor: () => 'claude',
      briefPrefs: { read: () => [...prefs], add: (l) => { prefs.push(l); while (prefs.length > 10) prefs.shift() }, clear: () => { prefs.length = 0 } },
    })
    return { store, said, prefs, cmd }
  }
  it('adds one brief; a second one is refused with the existing id', async () => {
    const m = mk()
    await m.cmd.handle('定时 早报 8:00', 'owner')
    expect(m.store.list().jobs).toMatchObject([{ id: 'j1', brief: true, schedule: { at: '08:00' } }])
    expect(m.said[0]).toContain('早报')
    await m.cmd.handle('定时 早报 工作日 7:00', 'owner')
    expect(m.store.list().jobs).toHaveLength(1)
    expect(m.said[1]).toContain('j1')
  })
  it('口味: add / show / clear; non-owner falls through', async () => {
    const m = mk()
    expect(m.cmd.probe('早报 少点 技术细节', 'owner')).toBe(true)
    await m.cmd.handle('早报 少点 技术细节', 'owner')
    await m.cmd.handle('早报 多点 天气', 'owner')
    expect(m.prefs).toEqual(['少点:技术细节', '多点:天气'])
    await m.cmd.handle('早报 偏好', 'owner')
    expect(m.said.at(-1)).toContain('少点:技术细节')
    await m.cmd.handle('早报 偏好 清空', 'owner')
    expect(m.prefs).toEqual([])
    expect(m.cmd.probe('早报 少点 x', 'guest')).toBe(false)
    expect(await m.cmd.handle('早报 少点 x', 'guest')).toBe(false)
  })
  it('the list marks the brief', async () => {
    const m = mk()
    await m.cmd.handle('定时 早报 8:00', 'owner')
    await m.cmd.handle('定时', 'owner')
    expect(m.said.at(-1)).toContain('早报')
  })
})

describe('周报 × 微信', () => {
  it('adds one recap (Sunday by default); a second is refused; the list labels it 周报; the phone view flags it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recap-cmd-'))
    const store = makeJobsStore(dir)
    const said: string[] = []
    const cmd = makeJobsCommand({ store, isOwner: (c) => c === 'owner', say: async (_c, t) => { said.push(t) }, timezone: () => 'Asia/Shanghai', now: () => Date.parse('2026-10-20T00:00:00Z'), log: () => {}, jobExecutor: () => 'claude' })
    await cmd.handle('定时 周报 20:00', 'owner')
    expect(store.list().jobs).toMatchObject([{ id: 'j1', recap: true, schedule: { kind: 'weekly', weekday: 7, at: '20:00' } }])
    expect(said[0]).toContain('周报')
    expect(said[0]).toContain('这一周')
    await cmd.handle('定时 周报 周五 18:00', 'owner')
    expect(store.list().jobs).toHaveLength(1)
    expect(said[1]).toContain('已经有一份周报了(j1')
    await cmd.handle('定时', 'owner')
    expect(said[2]).toContain('j1 · 每周日 20:00(上海) · 周报')
    const { jobsView } = await import('./view')
    const v = jobsView({ store, timezone: 'Asia/Shanghai', executor: 'claude' })
    expect(v.ok && v.jobs[0]).toMatchObject({ recap: true, brief: false })
  })
})
