/**
 * bootstrap/index.ts 的棘轮守卫(spec 2026-09-27-bootstrap-split §6)。
 * `let x: T | null = null` 晚绑定的个数只许降(行数上限 10-22 删了,见下);新接线进 wire-*.ts,
 * 晚绑定用 src/lib/lifecycle.ts 的 Ref。搬走一块就把上限往下调。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'src', 'daemon', 'bootstrap', 'index.ts'), 'utf8')

// 行数上限已删(3f,2026-10-22,理念 5「数违规条数,不数行数」):它把代码挤成一行两千字符(service.ts 的 ctx 那行 2133 字符),
// 量的是症状。留下的是结构上的数:晚绑定个数。新接线照旧进 wire-*.ts(不是因为行数,是因为 index 只负责组装)。
const MAX_LET_NULL = 0   // 全部改成 Ref 或 const 了(spec §3 规矩 1)

describe('bootstrap/index.ts 只许变小', () => {
  it(`\`let x: T | null = null\` 晚绑定 ≤ ${MAX_LET_NULL}(用 src/lib/lifecycle.ts 的 Ref)`, () => {
    const n = (src.match(/^\s*let \w+: [^=]*\| null = null/gm) ?? []).length
    expect(n).toBeLessThanOrEqual(MAX_LET_NULL)
  })
})

// 复查 10-21(第三批 3b):yi 的 ws、知识库定时器、空闲清扫三样起了没人停。规矩是「谁起谁登记」——
// bootstrap/ 下每个文件里,起一个定时器 / 监听,就要在同一个文件里 `teardown.add` 一次(./teardown.ts)。
describe('bootstrap/ 谁起谁登记', () => {
  const dir = join(ROOT, 'src', 'daemon', 'bootstrap')
  const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  it('每个 setInterval / .start() 起的东西都在同一个文件里登记了收尾', () => {
    const missing: string[] = []
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8')
      const started = (text.match(/\bsetInterval\(/g) ?? []).length + (text.match(/\b(?:yiServer|yiClient)\.start\(\)/g) ?? []).length
      const registered = (text.match(/\bteardown\.add\(/g) ?? []).length
      if (started > registered) missing.push(`${f}: 起了 ${started} 样、登记 ${registered} 样`)
    }
    expect(missing).toEqual([])
  })
})
