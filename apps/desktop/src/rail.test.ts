// 侧栏只放导航(spec 2026-10-01 §6.2)。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const start = html.indexOf('id="dash-global-rail"')
const rail = html.slice(start, html.indexOf('</aside>', start))

describe('desktop rail', () => {
  it('has the wordmark and nav only', () => {
    expect(rail).toContain('<p class="dash-wordmark">tendhearth</p>')
    expect(rail).not.toMatch(/一起生活|cc-brand|dash-version|data-hg-icon|dash-rail-foot|v\d+\.\d+/)
  })
  it('keeps every pane reachable and the e2e hooks', () => {
    for (const p of ['overview', 'recollections', 'atelier', 'memory', 'todos', 'a2a-agents', 'sessions']) expect(rail).toContain(`data-pane="${p}"`)
    expect(rail).toContain('cc-life-nav-more')
    expect(rail).toContain('id="settings-open"')
    expect(rail).toContain('data-backstage-entry')
  })
  it('一个主页(设计稿 2026-10-31 U4):没有单独的「一起做」导航项,一件件事从此刻的行或「全部 →」进', () => {
    expect(rail).not.toContain('data-pane="workbench"')
    expect(html).toContain('id="now-all"')
    expect(html).toMatch(/id="workbench-home"[^>]*data-life-pane="overview"/)
  })
  it('the CC bubble is the chat entry; no separate 跟 CC 说 nav', () => {
    expect(rail).not.toContain('data-pane="converse"')
  })
  it('index.html 里每个 id 只出现一次(2026-11-01:新加的「带回来的」组撞了聊天态的 #now-back,单元测试看不出)', () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
    expect(dupes).toEqual([])
  })
})
