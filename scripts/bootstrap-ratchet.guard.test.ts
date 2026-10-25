/**
 * bootstrap/index.ts 的棘轮守卫(spec 2026-09-27-bootstrap-split §6)。
 * `let x: T | null = null` 晚绑定为零(行数上限 10-22 删了,见下);新接线进 wire-*.ts,
 * 晚到的东西经模块容器的 lazy / ctx.late 拿(架构终态 A2:bootstrap 是一组模块,不再有 Ref)。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'src', 'daemon', 'bootstrap', 'index.ts'), 'utf8')

// 行数上限已删(3f,2026-10-22,理念 5「数违规条数,不数行数」):它把代码挤成一行两千字符(service.ts 的 ctx 那行 2133 字符),
// 量的是症状。留下的是结构上的数:晚绑定个数。新接线照旧进 wire-*.ts(不是因为行数,是因为 index 只负责组装)。
const MAX_LET_NULL = 0

describe('bootstrap/index.ts 只许变小', () => {
  it(`\`let x: T | null = null\` 晚绑定 ≤ ${MAX_LET_NULL}(晚到的经容器的 lazy / late)`, () => {
    const n = (src.match(/^\s*let \w+: [^=]*\| null = null/gm) ?? []).length
    expect(n).toBeLessThanOrEqual(MAX_LET_NULL)
  })
})

// 复查 10-21(第三批 3b):yi 的 ws、知识库定时器、空闲清扫三样起了没人停。架构终态 A2 起 bootstrap 是一组模块:
// 定时器只经 ctx.interval(bootstrap/ 下不许裸 setInterval),起的监听 / 连接在同一个文件里经 ctx.own 登记停法。
describe('bootstrap/ 谁起谁登记', () => {
  const dir = join(ROOT, 'src', 'daemon', 'bootstrap')
  const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  it('没有裸 setInterval;每个 .start() 起的监听 / 连接都在同一个文件里经 own 登记了停法', () => {
    const missing: string[] = []
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8')
      if (/\bsetInterval\(/.test(text)) missing.push(`${f}: 裸 setInterval(用 ctx.interval)`)
      const started = (text.match(/\b(?:yiServer|yiClient)\.start\(\)/g) ?? []).length
      const owned = (text.match(/\.own\(/g) ?? []).length
      if (started > owned) missing.push(`${f}: 起了 ${started} 样、登记 ${owned} 样`)
    }
    expect(missing).toEqual([])
  })
})
