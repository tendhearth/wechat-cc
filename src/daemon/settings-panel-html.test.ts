import { describe, it, expect } from 'vitest'
import { pageHtml, phoneHtml } from './settings-panel-html'

/**
 * fix round 1/5 M1(2026-09-23,评审点名):手机「一天」页的 KIND_ICON 表
 * 没有 'recollection' 这一项,journal 里 kind='recollection' 的行(见
 * journal-store.ts 的 recordRecollection、mobile-feed.ts 的 FeedKind)会
 * 退化成通配符 "•"——不破版,但也不该一直没有自己的图标。这里只钉住内嵌
 * 的客户端 JS 字符串里确实有这一项;客户端逻辑本身(KIND_ICON[e.kind] ||
 * "•")在浏览器里跑,不在这套 node/vitest 里执行。
 */
describe('phoneHtml 的 KIND_ICON', () => {
  it('recollection 有自己的图标,不退化成 •', () => {
    expect(phoneHtml('token', null)).toContain('recollection: "📖"')
  })
})

// 梳理第 6 步(2026-09-29):「已配对设备」从一个数字变成逐台列表,能忘掉单台。
describe('pageHtml 的设备列表', () => {
  const html = pageHtml('token')
  it('逐台渲染并能按台撤销(revoke_device)', () => {
    expect(html).toContain('id="devices-list"')
    expect(html).toContain('op: "revoke_device"')
  })
  it('不再把 devices 当数字拼字符串', () => {
    expect(html).not.toContain('s.remote.devices + " 台')
    expect(html).not.toContain('s.remote.devices > 0')
  })
  it('标签是用户输入,只走 textContent,不进 innerHTML', () => {
    const js = html.slice(html.indexOf('function renderDevices'), html.indexOf('function renderDevices') + 1500)
    expect(js.length).toBeGreaterThan(100)
    expect(js).not.toMatch(/innerHTML/)
    expect(js).toContain('textContent')
  })
})
