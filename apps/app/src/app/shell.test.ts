import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 设计稿 2026-10-31 U:此刻与一起做合成一个主页 —— 没有标签栏,旧的 /together 只剩重定向。
describe('一个主页', () => {
  it('没有 (tabs) 分组,没有标签栏', () => {
    expect(existsSync(join(__dirname, '(tabs)'))).toBe(false)
    expect(existsSync(join(__dirname, '../ui/TabBar.tsx'))).toBe(false)
  })
  it('/together 只剩重定向到「全部」', () => {
    const src = readFileSync(join(__dirname, 'together.tsx'), 'utf8')
    expect(src).toContain('<Redirect href="/all" />')
    expect(src).not.toMatch(/useWork|MatterRow|SectionList/)
  })
  it('主页和全部页的行都是 MatterRow,不手写行', () => {
    for (const f of ['../ui/HomeScreen.tsx', 'all.tsx']) {
      const src = readFileSync(join(__dirname, f), 'utf8')
      expect(src, f).not.toMatch(/minHeight: (64|78)/)
    }
    expect(readFileSync(join(__dirname, '../ui/WorkList.tsx'), 'utf8')).toContain('MatterRow')
  })
})
