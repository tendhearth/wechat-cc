import { describe, it, expect } from 'vitest'
import { color } from '@wechat-cc/design-tokens'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { palette } from './tokens'
import { OFL_TEXT } from './ofl-text'

describe('设计 token', () => {
  it('只有一套色板,就是共用包里那一份(没有深色)', () => {
    expect(palette).toBe(color)
    expect('dark' in (palette as object)).toBe(false)
  })
})

describe('原生配置与随包许可证不漂', () => {
  const root = join(__dirname, '../..')
  it('app.json 里写死的纸色(启动屏)就是 color.paper', () => {
    const app = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'))
    const splash = app.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-splash-screen')
    expect(splash[1].backgroundColor).toBe(color.paper)
  })
  it('设置里显示的字体许可证文本 = assets/fonts/OFL.txt', () => {
    expect(OFL_TEXT).toBe(readFileSync(join(root, 'assets/fonts/OFL.txt'), 'utf8'))
  })
})
