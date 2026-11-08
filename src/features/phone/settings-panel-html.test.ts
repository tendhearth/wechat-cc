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

describe('网页设置的入口说明', () => {
  it('只承诺当前网页能看的状态,保留中继、下载和局域网限制说明', () => {
    const html = pageHtml('token')
    expect(html).toContain('出门也能查看 CC 和事情的状态')
    expect(html).toContain('首次需下载约 5GB')
    expect(html).toContain('经加密中继回家')
    expect(html).toContain('和电脑同一网络')
    expect(html).not.toContain('出门也能看待办和 CC 画的你')
  })
})
