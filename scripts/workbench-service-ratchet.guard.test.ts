/**
 * core/workbench/service.ts 的棘轮守卫(spec 2026-09-27-workbench-service-split §5)。
 * 行数与 makeWorkbenchService 内函数数只许降;新域进 src/core/workbench/service/<domain>.ts。
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
const MAX_LINES = 171
const MAX_INNER_FUNCTIONS = 3

const lineCount = (s: string) => s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
/** makeWorkbenchService 体内两格缩进的 `function x(` / `async function x(` / `const x=(`/`const x = (` 箭头。 */
const innerFunctions = (s: string) => (s.match(/^  (?:async )?function \w+\(|^  const \w+ ?= ?(?:async ?)?\(/gm) ?? []).length

describe('core/workbench/service.ts 只许变小', () => {
  it(`行数 ≤ ${MAX_LINES}(新域进 src/core/workbench/service/<domain>.ts)`, () => {
    expect(lineCount(src)).toBeLessThanOrEqual(MAX_LINES)
  })
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
