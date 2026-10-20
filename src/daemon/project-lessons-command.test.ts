import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeProjectLessons } from '../core/workbench/project-lessons'
import { makeProjectLessonsCommand } from './project-lessons-command'

function setup() {
  const lessons = makeProjectLessons(mkdtempSync(join(tmpdir(), 'pl-')))
  const said: string[] = []
  const projects = [{ name: 'wechat-cc', path: '/w/wechat-cc' }, { name: 'rici', path: '/w/rici' }, { name: 'Rici', path: '/x/Rici' }]
  const cmd = makeProjectLessonsCommand({ isOwner: c => c === 'owner', say: async (_c, t) => { said.push(t) }, projects: () => projects, lessons })
  const send = async (t: string, c = 'owner') => (cmd.probe(t, c) ? cmd.handle(t, c) : false)
  return { lessons, said, send }
}

describe('经验 (WeChat)', () => {
  it('add / list / delete by project name; owner only', async () => {
    const s = setup()
    expect(await s.send('经验 wechat-cc 这个仓库用 bun,不要 npm')).toBe(true)
    expect(s.said.at(-1)).toContain('记下了')
    expect(s.said.at(-1)).toContain('所有执行者')
    await s.send('经验 wechat-cc 测试用 bun run test')
    await s.send('经验 wechat-cc')
    expect(s.said.at(-1)).toContain('1. 这个仓库用 bun,不要 npm')
    expect(s.said.at(-1)).toContain('2. 测试用 bun run test')
    await s.send('经验 wechat-cc 删 1')
    expect(s.lessons.list('/w/wechat-cc').map(x => x.text)).toEqual(['测试用 bun run test'])
    expect(await s.send('经验 wechat-cc 用 bun', 'guest')).toBe(false)
  })
  it('unknown / ambiguous project names are explained, nothing written', async () => {
    const s = setup()
    await s.send('经验 nope 用 bun')
    expect(s.said.at(-1)).toContain('没找到叫 nope 的项目')
    await s.send('经验 RICI 用 bun')
    expect(s.said.at(-1)).toContain('有好几个')
    expect(s.lessons.list('/w/rici')).toEqual([])
    expect(s.lessons.list('/x/Rici')).toEqual([])
    await s.send('经验 rici 用 bun')   // 大小写对得上的那一个优先
    expect(s.lessons.list('/w/rici').map(x => x.text)).toEqual(['用 bun'])
  })
  it('bare 经验 explains usage; 经验真好 is not a command', async () => {
    const s = setup()
    await s.send('经验')
    expect(s.said.at(-1)).toContain('经验 <项目> <一句话>')
    expect(await s.send('经验真好')).toBe(false)
  })
  it('workbench not wired yet (daemon still starting) ⇒ says so, writes nothing (评审 #443)', async () => {
    const lessons = makeProjectLessons(mkdtempSync(join(tmpdir(), 'pl-')))
    const said: string[] = []
    const cmd = makeProjectLessonsCommand({ isOwner: () => true, say: async (_c, t) => { said.push(t) }, projects: () => null, lessons })
    expect(await cmd.handle('经验 wechat-cc 用 bun', 'owner')).toBe(true)
    expect(said[0]).toContain('还在启动')
  })
})
