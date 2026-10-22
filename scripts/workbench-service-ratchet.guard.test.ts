/**
 * core/workbench/service.ts 的棘轮守卫(spec 2026-09-27-workbench-service-split §5)。
 * makeWorkbenchService 内函数数只许降(行数上限 10-22 删了,见下);新域进 src/core/workbench/service/<domain>.ts。
 * 搬走一个域就把上限往下调 —— 棘轮只往一个方向转。
 * 另钉两条环:wechat-control.ts 不许回头 import ./service;service/*.ts 不许 import ../service。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WB = join(ROOT, 'src', 'core', 'workbench')
const src = readFileSync(join(WB, 'service.ts'), 'utf8')

// 拆分已完成(PR 1–10,2026-09-28):service.ts 只剩 Options、组装、public 对象、actions.set。这两个数只许降;
// 新逻辑一律进 src/core/workbench/service/<domain>.ts,别再往 makeWorkbenchService 里加内函数。
// 行数上限已删(3f,2026-10-22,理念 5「数违规条数,不数行数」):它把代码挤成一行两千字符(service.ts 的 ctx 那行 2133 字符),
// 量的是症状。留下的是结构上的数:makeWorkbenchService 内函数个数。新逻辑照旧进 service/<domain>.ts。
const MAX_INNER_FUNCTIONS = 3

/** makeWorkbenchService 体内两格缩进的 `function x(` / `async function x(` / `const x=(`/`const x = (` 箭头。 */
const innerFunctions = (s: string) => (s.match(/^  (?:async )?function \w+\(|^  const \w+ ?= ?(?:async ?)?\(/gm) ?? []).length

describe('core/workbench/service.ts 只许变小', () => {
  it(`makeWorkbenchService 内函数 ≤ ${MAX_INNER_FUNCTIONS}`, () => {
    expect(innerFunctions(src)).toBeLessThanOrEqual(MAX_INNER_FUNCTIONS)
  })
  it('wechat-control.ts 不 import ./service(那是 type-only 环,depcruise 一样算)', () => {
    const control = readFileSync(join(WB, 'wechat-control.ts'), 'utf8')
    expect(control).not.toMatch(/from '\.\/service'/)
  })
  it('service/*.ts 不 import ../service(域模块只认 ctx)', () => {
    const dir = join(WB, 'service')
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue
      const body = readFileSync(join(dir, f), 'utf8')
      expect(body, f).not.toMatch(/from '\.\.\/service'/)
    }
  })
})
