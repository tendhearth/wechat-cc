// 桌面 tokens.css 是生成物:与 packages/design-tokens 渲染结果逐字一致;手机色板就是同一个对象。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderTokensCss } from '../packages/design-tokens/src/index'

describe('one set of design tokens across desktop and phone', () => {
  it('apps/desktop/src/tokens.css is up to date (run: bun scripts/build-design-tokens.ts)', () => {
    expect(readFileSync(new URL('../apps/desktop/src/tokens.css', import.meta.url), 'utf8')).toBe(renderTokensCss())
  })
  // Task 3 把手机 tokens.ts 改成再导出 color 后,恢复为 it 并加回 import { color } / { palette }。
  it.todo('phone palette is the shared palette (no mirror to drift): expect(palette).toBe(color)')
})
