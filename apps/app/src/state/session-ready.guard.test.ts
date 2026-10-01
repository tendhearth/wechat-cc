import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

// 退旧位(spec §8)要拿「配对前」的记录:配对页在钥匙串读完之前不能出现,否则 prev 是 null、旧设备位被悄悄留下。
// 根布局在 session.ready 之前只画底色、不挂路由(连系统链接进来的 /pair 也一样);配对页在点「连接」那一刻读当时的 pairing。
const src = (f: string) => readFileSync(join(__dirname, '../app', f), 'utf8')

describe('配对页只在会话读完之后才挂上(Task 11 评审)', () => {
  it('根布局:!session.ready ⇒ 早退,Stack 在它之后', () => {
    const s = src('_layout.tsx')
    const gate = s.indexOf('if (!session.ready')
    expect(gate).toBeGreaterThan(-1)
    expect(s.slice(gate, s.indexOf('\n', gate))).toMatch(/return <View/)
    expect(s.indexOf('<Stack')).toBeGreaterThan(gate)
  })
  it('配对页在 connect() 里读 prev(不是挂载时存下的)', () => {
    const s = src('pair.tsx')
    const connect = s.indexOf('const connect = async')
    expect(connect).toBeGreaterThan(-1)
    const body = s.slice(connect, s.indexOf('const back = ', connect))
    expect(body).toMatch(/const prev = pairing\b/)
  })
})
