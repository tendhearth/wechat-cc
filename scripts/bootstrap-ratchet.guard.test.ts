/**
 * bootstrap/index.ts 的棘轮守卫(spec 2026-09-27-bootstrap-split §6)。
 * 行数与 `let x: T | null = null` 晚绑定的个数只许降;新接线进 wire-*.ts,
 * 晚绑定用 src/lib/lifecycle.ts 的 Ref。搬走一块就把上限往下调。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'src', 'daemon', 'bootstrap', 'index.ts'), 'utf8')

const MAX_LINES = 994
const MAX_LET_NULL = 2   // cachedOperatorChatId, a2aServer

describe('bootstrap/index.ts 只许变小', () => {
  it(`行数 ≤ ${MAX_LINES}(新接线进 src/daemon/bootstrap/wire-*.ts)`, () => {
    // 按 wc -l 的口径(末尾换行不算一行)。
    const lines = src.split('\n').length - (src.endsWith('\n') ? 1 : 0)
    expect(lines).toBeLessThanOrEqual(MAX_LINES)
  })
  it(`\`let x: T | null = null\` 晚绑定 ≤ ${MAX_LET_NULL}(用 src/lib/lifecycle.ts 的 Ref)`, () => {
    const n = (src.match(/^\s*let \w+: [^=]*\| null = null/gm) ?? []).length
    expect(n).toBeLessThanOrEqual(MAX_LET_NULL)
  })
})
