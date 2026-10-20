import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeProjectLessons, LESSONS_MAX, lessonsBlock } from './project-lessons'

const dir = () => mkdtempSync(join(tmpdir(), 'lessons-'))
describe('project lessons', () => {
  it('add / list / remove per project path; one line, ≤200 chars, no tags; capped', () => {
    const l = makeProjectLessons(dir())
    expect(l.add('/p/a', '这个仓库用 bun,不要 npm')).toMatchObject({ ok: true })
    expect(l.add('/p/a', '  这个仓库用 bun,不要 npm  ')).toEqual({ ok: false, error: 'duplicate' })
    expect(l.add('/p/a', 'a\nb')).toEqual({ ok: false, error: 'invalid' })
    expect(l.add('/p/a', '<b>x</b>')).toEqual({ ok: false, error: 'invalid' })
    expect(l.add('/p/a', '字'.repeat(201))).toEqual({ ok: false, error: 'invalid' })
    l.add('/p/a', '测试用 bun run test')
    expect(l.list('/p/a').map(x => x.text)).toEqual(['这个仓库用 bun,不要 npm', '测试用 bun run test'])
    expect(l.list('/p/b')).toEqual([])
    expect(l.remove('/p/a', 1)).toBe(true)
    expect(l.list('/p/a').map(x => x.text)).toEqual(['测试用 bun run test'])
    expect(l.remove('/p/a', 9)).toBe(false)
    for (let i = 0; i < LESSONS_MAX + 2; i++) l.add('/p/c', `经验 ${i}`)
    expect(l.list('/p/c')).toHaveLength(LESSONS_MAX)
    expect(l.add('/p/c', '再一条')).toEqual({ ok: false, error: 'full' })
  })
  it('block for instructions: titled as owner-written; none ⇒ null', () => {
    expect(lessonsBlock([])).toBeNull()
    expect(lessonsBlock([{ id: 'a', text: '用 bun', at: 1 }])).toBe('这个项目的经验(主人写的,所有执行者都照着做):\n- 用 bun')
  })
  it('survives a restart (file-backed)', () => {
    const d = dir()
    makeProjectLessons(d).add('/p/a', '用 bun')
    expect(makeProjectLessons(d).list('/p/a').map(x => x.text)).toEqual(['用 bun'])
  })
})
