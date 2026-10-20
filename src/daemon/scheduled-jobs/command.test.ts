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
    expect(reply).toContain('每周一 09:00')
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
    expect(t).toContain('每天 09:00')
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
