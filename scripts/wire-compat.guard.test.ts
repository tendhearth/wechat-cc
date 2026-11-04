/**
 * 冻结的旧线上字段只许变少(M6b,设计稿 docs/superpowers/specs/2026-11-05-m6-read-side-design.md「定案」)。
 *
 * `packages/protocol/src/wire-compat.ts` 一行 = 一个老客户端还在读、daemon 现算的旧字段。新的旧形状不许再加进来
 * (src 里只剩步一种读形状);按退休条件删掉一行,就把下面的上限往下调 —— 棘轮只往一个方向转。
 */
import { describe, expect, it } from 'vitest'
import { WIRE_COMPAT } from '../packages/protocol/src/wire-compat'

// @debt 冻结在线上、由 daemon 现算的旧字段(按退休条件逐行删;降到 0 = 线上只剩新形状)
const MAX_WIRE_COMPAT_ROWS = 5

describe('wire-compat 兼容表只许变少', () => {
  it(`行数 ≤ ${MAX_WIRE_COMPAT_ROWS}`, () => {
    expect(WIRE_COMPAT.length, '新加旧形状不行;删了一行就把 MAX_WIRE_COMPAT_ROWS 调成新的行数').toBeLessThanOrEqual(MAX_WIRE_COMPAT_ROWS)
  })
  it('上限跟实际一样(删了行忘了把上限调下来 ⇒ 红,棘轮不留空档)', () => {
    expect(WIRE_COMPAT.length).toBe(MAX_WIRE_COMPAT_ROWS)
  })
  it('每行都写清:字段、谁读、从哪推、什么时候删;字段不重复', () => {
    for (const row of WIRE_COMPAT) {
      expect(row.field.trim(), JSON.stringify(row)).not.toBe('')
      expect(row.readers.length, row.field).toBeGreaterThan(0)
      expect(row.derivedFrom.trim(), row.field).not.toBe('')
      expect(row.retireWhen.trim(), row.field).not.toBe('')
    }
    expect(new Set(WIRE_COMPAT.map(r => r.field)).size).toBe(WIRE_COMPAT.length)
  })
})
