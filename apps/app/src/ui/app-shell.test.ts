import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 设计稿 2026-10-31 U:此刻与一起做合成一个主页 —— 没有标签栏,旧的 /together 只剩重定向。
describe('一个主页', () => {
  it('src/app 里只有路由:测试文件放进去会被 expo-router 当页面打包(node:fs 进了手机包)', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
    expect(walk(join(__dirname, '../app')).filter(f => /\.test\.tsx?$/.test(f))).toEqual([])
  })
  it('没有 (tabs) 分组,没有标签栏', () => {
    expect(existsSync(join(__dirname, '../app/(tabs)'))).toBe(false)
    expect(existsSync(join(__dirname, 'TabBar.tsx'))).toBe(false)
  })
  it('/together 只剩重定向到对话搜索', () => {
    const src = readFileSync(join(__dirname, '../app/together.tsx'), 'utf8')
    expect(src).toContain('<Redirect href="/chat-search?scope=work" />')
    expect(src).not.toMatch(/useWork|MatterRow|SectionList/)
  })
  it('主页和全部页的行都是 MatterRow,不手写行', () => {
    for (const f of ['ConversationScreen.tsx', '../app/all.tsx']) {
      const src = readFileSync(join(__dirname, f), 'utf8')
      expect(src, f).not.toMatch(/minHeight: (64|78)/)
    }
    expect(readFileSync(join(__dirname, 'WorkList.tsx'), 'utf8')).toContain('MatterRow')
  })
  it('index renders the owner conversation and old chat cannot mount another copy', () => {
    expect(readFileSync(join(__dirname, '../app/index.tsx'), 'utf8')).toContain("../ui/ConversationScreen")
    expect(readFileSync(join(__dirname, '../app/chat.tsx'), 'utf8')).toContain('router.dismissTo')
    expect(readFileSync(join(__dirname, '../app/all.tsx'), 'utf8')).toContain('/chat-search?scope=work')
    expect(existsSync(join(__dirname, 'HomeScreen.tsx'))).toBe(false)
  })
  it('cold private browsing routes retain the welcome/identity gate', () => {
    for (const route of ['all', 'together', 'chat-search', 'topic', 'topics', 'cc-activity']) {
      expect(readFileSync(join(__dirname, `../app/${route}.tsx`), 'utf8'), route).toContain('<WelcomeGate>')
    }
  })
  it('批准是一件事的一步:/approval 只剩重定向到 /matter/<id>/decide', () => {
    const src = readFileSync(join(__dirname, '../app/approval/[id].tsx'), 'utf8')
    expect(src).toContain('<Redirect')
    expect(src).toContain('/decide')
    expect(src).not.toMatch(/useSubmit|backend\.decide|backend\.answer/)
    const decide = readFileSync(join(__dirname, '../app/matter/[id]/decide.tsx'), 'utf8')
    expect(decide).toContain('answersTooLong')
    expect(decide).toContain('!detail.fresh')
    expect(decide).not.toMatch(/`\/approval\//)
  })
})
