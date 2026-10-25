import { describe, it, expect } from 'vitest'
import { pageHtml } from './settings-panel-html'

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
