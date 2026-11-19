import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from '../../adapters/store/workbench/store'
import { gatherRoster, makeRosterReader, type RosterReaderDeps } from './reader'
import { rosterRoutes } from './routes'
import type { Matter } from '../../ports/matters'
import type { InternalApiDeps } from '../../daemon/internal-api/types'

// 名单以前一次向工作台要 500 件任务,而工作台真实的列表一页最多 100 件、超了直接抛错;
// 别的测试用的工作台替身不查这个上限,所以一直是绿的,真机上 /v1/roster 和 /v1/places 却一直 503。
// 这里用真的工作台存储来读,让上限是真的那一个。
const matter = (id: string): Matter => ({ id, kind: 'task', title: '备份', state: 'working', archivedAt: null, projectPath: '/work/project', ownerChatId: null,
  originMatterId: null, originMessageId: null, lastActivityAt: 90, createdAt: 1, updatedAt: 90 } as Matter)

function realWorkbench(taskCount: number) {
  const store = makeWorkbenchStore(openTestDb())
  const ids: string[] = []
  for (let i = 0; i < taskCount; i++) ids.push(store.create({ title: `t${i}`, path: '/work/project', providerId: 'codex', ownerChatId: null }).id)
  const limits: number[] = []
  const workbench: NonNullable<RosterReaderDeps['workbench']> = {
    list: query => { limits.push(query.limit); return store.listPage(query) },
    attention: () => ({ tasks: [] }),
    detail: () => ({ permissions: [], questions: [] }),
  }
  return { workbench, ids, limits }
}
const deps = (workbench: RosterReaderDeps['workbench'], rows: Matter[]): RosterReaderDeps => ({ matters: { list: () => rows }, terminals: () => [], seen: () => null, now: () => 100, workbench })

describe('名单读真的工作台存储', () => {
  it('不超过工作台一页的上限:读得出来,路由回 200', async () => {
    const wb = realWorkbench(3)
    const roster = makeRosterReader(deps(wb.workbench, [matter(wb.ids[0]!)]))
    expect(() => roster.read('operator')).not.toThrow()
    expect(Math.max(...wb.limits)).toBeLessThanOrEqual(100)
    const route = rosterRoutes({ roster } as InternalApiDeps)['GET /v1/roster']!
    const out = await route(new URLSearchParams(), null, { tier: 'admin', origin: 'operator' }, { signal: new AbortController().signal } as never)
    expect(out.status).toBe(200)
  })

  it('任务多于一页时接着往后翻,排在后面的那件的状态也拿得到', () => {
    const wb = realWorkbench(130)
    const gathered = gatherRoster(deps(wb.workbench, wb.ids.map(matter)), 'operator', 100, 24 * 3_600_000)
    expect(wb.limits.length).toBeGreaterThan(1)
    expect(Math.max(...wb.limits)).toBeLessThanOrEqual(100)
    expect(gathered.input.tasks.size).toBe(130)
    for (const id of wb.ids) expect(gathered.input.tasks.has(id), id).toBe(true)
  })
})

describe('读名单出错时日志里留一行', () => {
  it('记错误码,不记报错文字里可能带的内容', async () => {
    const lines: string[] = []
    const roster = { read: () => { throw Error('invalid_request') } }
    const route = rosterRoutes({ roster, log: (tag: string, line: string) => { lines.push(`${tag} ${line}`) } } as unknown as InternalApiDeps)['GET /v1/roster']!
    const out = await route(new URLSearchParams(), null, { tier: 'admin', origin: 'operator' }, { signal: new AbortController().signal } as never)
    expect(out).toEqual({ status: 503, body: { error: 'unavailable' } })
    expect(lines).toEqual(['ROSTER read failed: invalid_request'])
    lines.length = 0
    const secret = { read: () => { throw new TypeError('cannot read 主人写的一句话 SECRET-7781') } }
    await rosterRoutes({ roster: secret, log: (tag: string, line: string) => { lines.push(`${tag} ${line}`) } } as unknown as InternalApiDeps)['GET /v1/roster']!(
      new URLSearchParams(), null, { tier: 'admin', origin: 'operator' }, { signal: new AbortController().signal } as never)
    expect(lines).toEqual(['ROSTER read failed: TypeError'])
  })
})
