import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const start = html.indexOf('id="dash-global-rail"')
const topbar = html.slice(start, html.indexOf('</header>', start))
describe('desktop topbar', () => {
  it('CC 与搜索直接挂在桌面左栏', () => {
    expect(html).toMatch(/<html[^>]*\bdata-desk-wide\s/)
    expect(html).toContain('<header id="dash-global-rail" class="dash-topbar">')
    expect(topbar).toContain('id="topbar-cc"')
    expect(topbar).toContain('topbar-cc-light')
    expect(topbar).toContain('topbar-cc-dark')
    expect(topbar).toContain('id="topbar-search"')
    expect(topbar).toMatch(/id="topbar-cc"[^>]*class="[^"]*\bactive\b/)
    expect(topbar).toContain('id="desk-cc-presence"')
    expect(topbar).toContain('id="now-connections"')
  })
  it('七个目的页与设置后厨都可达', () => {
    for (const pane of ['overview','memory','recollections','atelier','todos','a2a-agents','sessions']) expect(topbar).toContain(`data-pane="${pane}"`)
    expect(topbar).toContain('id="settings-open"')
    expect(topbar).toContain('data-backstage-entry')
  })
  it('保持一段对话和唯一事项层', () => {
    expect(topbar).not.toContain('data-pane="workbench"')
    expect(html.match(/id="converse-root"/g)).toHaveLength(1)
    expect(html).toContain('id="conversation-matter-layer"')
    expect(html).toMatch(/id="workbench-home"[^>]*data-life-pane="overview"/)
  })
  it('撤掉旧导航与大形象', () => {
    expect(html).not.toContain('cc-life-nav-more')
    expect(html).not.toContain('class="now-hero"')
    expect(topbar).not.toContain('data-pane="converse"')
    expect(html).not.toContain('id="now-all"')
  })
  it('所有 id 唯一', () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1])
    expect(ids.filter((id,i)=>ids.indexOf(id)!==i)).toEqual([])
  })
})
it('晚加载的样式仍把主内容留在页头下方左列',()=>{
 const life=readFileSync(new URL('./cc-life.css',import.meta.url),'utf8')
 const rule=life.match(/\.dashboard \.dash-main\s*\{([^}]+)\}/)?.[1]
 expect(rule).toMatch(/grid-column:\s*1(?:;|\s)/)
 expect(rule).toMatch(/grid-row:\s*2(?:;|\s)/)
})
