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
    for (const p of ['overview', 'workbench', 'recollections', 'atelier', 'aquarium', 'memory', 'todos', 'a2a-agents', 'sessions']) expect(rail).toContain(`data-pane="${p}"`)
    expect(rail).toContain('cc-life-nav-more')
    expect(rail).toContain('id="settings-open"')
    expect(rail).toContain('data-backstage-entry')
  })
  it('the CC bubble is the chat entry; no separate 跟 CC 说 nav', () => {
    expect(rail).not.toContain('data-pane="converse"')
  })
})
