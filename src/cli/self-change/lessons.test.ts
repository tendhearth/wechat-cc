import { describe, expect, it } from 'vitest'

import { fakeState } from './pipeline.fixture'
import { formatLessonCandidates, lessonCandidates, lessonsFor, type LessonRow } from './lessons'

const NOW = Date.parse('2026-10-24T02:00:00Z')

describe('lessonsFor', () => {
  it('修复轮的原因照记;没做成的结局再记一条;只记还没记过的修复轮', () => {
    const s = fakeState({ id: 'r1' })
    s.fixLog = [{ kind: 'tests', at: NOW - 1000, detail: 'FAIL src/a.test.ts > x' }, { kind: 'review', at: NOW - 500, detail: '- [important] a.ts: 没测' }]
    s.lessonsWritten = 1
    const rows = lessonsFor(s, 'ci_exhausted', 'CI 红了三轮', NOW)
    expect(rows.map(r => [r.kind, r.result ?? ''])).toEqual([['review', ''], ['outcome', 'ci_exhausted']])
  })

  it('正常收场 / 主人说不要 / 等超时 ⇒ 不记结局那一条(修复轮照记)', () => {
    for (const result of ['done', 'declined', 'approval_timeout', 'abandoned']) {
      const s = fakeState({ id: 'r1' })
      s.fixLog = [{ kind: 'tests', at: NOW, detail: 'FAIL x' }]
      expect(lessonsFor(s, result, '', NOW).map(r => r.kind)).toEqual(['tests'])
    }
  })
})

describe('lessonCandidates', () => {
  const row = (run: string, kind: LessonRow['kind'], detail: string, result?: string): string =>
    JSON.stringify({ at: '2026-10-24T01:00:00Z', run, kind, detail, ...(result ? { result } : {}) })

  it('按种类 + 第一行的签名分组;跨几条运行的排前面;不到两次的不收;坏行跳过', () => {
    const jsonl = [
      row('r1', 'tests', 'FAIL src/cli/cli.test.ts > 子命令表 12\nexpected …'),
      row('r2', 'tests', 'FAIL src/cli/cli.test.ts > 子命令表 13\nexpected …'),
      row('r3', 'review', '- [important] a.ts: 新错误码没进那张表'),
      row('r3', 'review', '- [important] a.ts: 新错误码没进那张表'),
      row('r4', 'outcome', 'rebase 冲突', 'merge_conflict'),
      '{坏行',
    ].join('\n')
    const c = lessonCandidates(jsonl)
    expect(c.map(x => [x.kind, x.count, x.runs.length])).toEqual([['tests', 2, 2], ['review', 2, 1]])
    expect(c[0]!.signature).toContain('子命令表')
  })

  it('人读版:没有就说没有;有就带次数、运行数、种类', () => {
    expect(formatLessonCandidates([])).toContain('还没有反复出现的')
    const t = formatLessonCandidates(lessonCandidates([row('a', 'ci', 'node 作业红'), row('b', 'ci', 'node 作业红')].join('\n')))
    expect(t).toMatch(/2 次 \/ 2 条运行 {2}\[CI 红\] node 作业红/)
    expect(t).toContain('practices.md')
  })
})
