import { describe, expect, it } from 'vitest'

import { formatRoadmapItems, roadmapOpenItems } from './self-discover-roadmap'

const MD = [
  '# roadmap',
  '## 现状',
  '- 这节不收',
  '## 欠的真机账(发版前该销掉)',
  '- ~~桌面连开两件事~~ 2026-09-28 真机核对通过',
  '- **手机真机**:仍需人手扫码',
  '- 已经 ✅ 验过的一条',
  '- 🟡 有人在验的一条',
  '## 对标三类产品挖出的任务',
  '| # | 任务 | 谁有 |',
  '|---|---|---|',
  '| 1 | 🟡 #406 **独立工作区脚本** | Conductor |',
  '| 2 | **回到某一轮** | Conductor |',
  '| 3 | ✅ #449 行评论 | Orca |',
  '| 4 | 记忆带出处(#405) | Claude |',
  '## 有意推迟 / 已否决',
  '- 也不收',
].join('\r\n')

describe('roadmapOpenItems', () => {
  it('只收欠账 / 对标 / 已定未做几节里没标完成的;划掉的、✅ 的、表头、带 PR 号又不在做的都不收', () => {
    const items = roadmapOpenItems(MD)
    expect(items.map(i => [i.section.slice(0, 4), i.text, i.inFlight])).toEqual([
      ['欠的真机', '手机真机:仍需人手扫码', false],
      ['欠的真机', '🟡 有人在验的一条', true],
      ['对标三类', '🟡 #406 独立工作区脚本', true],
      ['对标三类', '回到某一轮', false],
    ])
    expect(items[0]!.line).toBe(6)
  })

  it('输出照实说「没标完成」,不说「没做」', () => {
    const text = formatRoadmapItems(roadmapOpenItems(MD))
    expect(text).toContain('没标完成')
    expect(text).toContain('要对代码核')
    expect(text).toContain('[在做]')
    expect(text).toContain('roadmap.md:6')
    expect(formatRoadmapItems([])).toContain('没有没标完成的条目')
  })
})
