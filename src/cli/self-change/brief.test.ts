import { describe, expect, it } from 'vitest'

import { fixPrompt, implementBrief, parseReviewVerdict, reviewPrompt } from './brief'
import { FORBIDDEN_GLOBS } from './policy'

describe('implementBrief', () => {
  const text = implementBrief({ id: 'ab12cd34', branch: 'self/ab12cd34', forbidden: FORBIDDEN_GLOBS })

  it('说清身份:哪次自改、哪个分支、在专用克隆里', () => {
    expect(text).toContain('ab12cd34')
    expect(text).toContain('self/ab12cd34')
    expect(text).toContain('克隆')
  })

  it('先读 AGENTS.md 与维护者手册', () => {
    expect(text).toContain('AGENTS.md')
    expect(text).toContain('docs/maintainer/README.md')
  })

  it('禁改清单逐条写进去', () => {
    for (const glob of FORBIDDEN_GLOBS) expect(text).toContain(glob)
  })

  it('提交规矩:自己 commit、可多次、不 push、不切分支', () => {
    expect(text).toContain('git commit')
    expect(text).toContain('多次')
    expect(text).toContain('不要 `git push`')
    expect(text).toContain('不要切分支')
  })

  it('禁止发微信、禁止碰主人的通道目录', () => {
    expect(text).toContain('不要发微信')
    expect(text).toContain('~/.claude/channels')
  })

  it('点名 superpowers 的三套流程', () => {
    expect(text).toContain('brainstorming')
    expect(text).toContain('writing-plans')
    expect(text).toContain('subagent-driven-development')
  })

  it('收尾要一段话说清改了什么、怎么验的', () => {
    expect(text).toContain('一段话')
    expect(text).toContain('怎么验')
  })
})

describe('reviewPrompt', () => {
  const text = reviewPrompt({ request: '给 flake 表加一行', branch: 'self/ab12', baseRef: 'origin/dev' })

  it('带上需求、diff 范围', () => {
    expect(text).toContain('给 flake 表加一行')
    expect(text).toContain('git diff origin/dev...HEAD')
    expect(text).toContain('self/ab12')
  })

  it('讲清楚只读:不许改文件、不许提交', () => {
    expect(text).toContain('只读')
    expect(text).toContain('不要编辑')
  })

  it('输出契约写死了 verdict / severity 的取值', () => {
    expect(text).toContain('```json')
    expect(text).toContain('"verdict"')
    expect(text).toContain('approve')
    expect(text).toContain('changes')
    expect(text).toContain('critical')
    expect(text).toContain('important')
    expect(text).toContain('minor')
  })

  it('自己举的例子就能被 parseReviewVerdict 解出来', () => {
    expect(parseReviewVerdict(text).parsed).toBe(true)
  })
})

describe('fixPrompt', () => {
  it('三种来源各有一句抬头,失败细节原样带上', () => {
    expect(fixPrompt('tests', 'FAIL src/x.test.ts')).toContain('FAIL src/x.test.ts')
    expect(fixPrompt('tests', 'x')).toContain('测试')
    expect(fixPrompt('review', 'x')).toContain('评审')
    expect(fixPrompt('ci', 'x')).toContain('CI')
  })

  it('每一种都重申:别把测试改绿了事、改完自己提交、仍然不要 push', () => {
    for (const kind of ['tests', 'review', 'ci'] as const) {
      const t = fixPrompt(kind, 'detail')
      expect(t).toContain('git commit')
      expect(t).toContain('不要 `git push`')
      expect(t).toContain('真因')
    }
  })
})

describe('parseReviewVerdict', () => {
  it('approve + 空 findings', () => {
    const r = parseReviewVerdict('看过了。\n```json\n{"verdict":"approve","findings":[]}\n```\n')
    expect(r).toEqual({ verdict: 'approve', findings: [], parsed: true })
  })

  it('多个 json 块时取最后一个(前面的多半是例子或思考过程)', () => {
    const text = '```json\n{"verdict":"approve","findings":[]}\n```\n再看一遍:\n```json\n{"verdict":"changes","findings":[{"severity":"critical","file":"a.ts","line":3,"summary":"空指针"}]}\n```'
    const r = parseReviewVerdict(text)
    expect(r.verdict).toBe('changes')
    expect(r.findings).toEqual([{ severity: 'critical', file: 'a.ts', line: 3, summary: '空指针' }])
    expect(r.parsed).toBe(true)
  })

  it('severity 写了个不认识的值 ⇒ 当 minor(不因为一个词把闸门抬高)', () => {
    const r = parseReviewVerdict('```json\n{"verdict":"changes","findings":[{"severity":"blocker","summary":"x"}]}\n```')
    expect(r.findings[0]!.severity).toBe('minor')
    expect(r.findings[0]!.file).toBeUndefined()
    expect(r.findings[0]!.line).toBeUndefined()
  })

  it('verdict 不是 approve 的一律当 changes', () => {
    expect(parseReviewVerdict('```json\n{"findings":[]}\n```').verdict).toBe('changes')
    expect(parseReviewVerdict('```json\n{"verdict":"APPROVE"}\n```').verdict).toBe('changes')
  })

  it('findings 不是数组 / 条目不是对象 ⇒ 丢掉,不崩', () => {
    expect(parseReviewVerdict('```json\n{"verdict":"approve","findings":"none"}\n```').findings).toEqual([])
    expect(parseReviewVerdict('```json\n{"verdict":"approve","findings":[1,null]}\n```').findings).toEqual([])
  })

  it('没有 json 块 ⇒ changes + parsed:false,原文前 20 行进 summary', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `第 ${i} 行`)
    const r = parseReviewVerdict(lines.join('\n'))
    expect(r.parsed).toBe(false)
    expect(r.verdict).toBe('changes')
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.severity).toBe('important')
    expect(r.findings[0]!.summary).toContain('第 19 行')
    expect(r.findings[0]!.summary).not.toContain('第 20 行')
  })

  it('json 块里是坏 JSON ⇒ 同样走「解析不出」那条路', () => {
    const r = parseReviewVerdict('```json\n{"verdict": oops}\n```')
    expect(r.parsed).toBe(false)
    expect(r.verdict).toBe('changes')
  })
})
