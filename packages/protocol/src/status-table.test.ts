import { describe, expect, it } from 'vitest'
import { STATUS_KEYS, STATUS_TABLE } from './status-table'

describe('状态表(三端共用的一张:状态 ⇒ 词条 / 图标 / 色调 / 分组)', () => {
  it('每个状态都有一行,词条键是 status.<key>', () => {
    expect(Object.keys(STATUS_TABLE).sort()).toEqual([...STATUS_KEYS].sort())
    for (const k of STATUS_KEYS) expect(STATUS_TABLE[k].word).toBe(`status.${k}`)
  })
  it('强调色只给「等你」', () => {
    expect(STATUS_KEYS.filter(k => STATUS_TABLE[k].tone === 'accent')).toEqual(['waiting'])
  })
  it('分组:等你 ⇒ 等你;在做 ⇒ 在做;其余四个 ⇒ 带回来的', () => {
    expect(STATUS_TABLE.waiting.group).toBe('waiting')
    expect(STATUS_TABLE.working.group).toBe('working')
    for (const k of ['replied', 'done', 'failed', 'stopped'] as const) expect(STATUS_TABLE[k].group).toBe('back')
  })
  it('在做不画图标(行里留空位),其余各有一个', () => {
    expect(STATUS_TABLE.working.icon).toBeNull()
    expect(STATUS_TABLE.waiting.icon).toBe('shield')
    expect(STATUS_TABLE.done.icon).toBe('done')
    expect(STATUS_TABLE.failed.icon).toBe('alert')
    expect(STATUS_TABLE.replied.icon).toBe('message')
    expect(STATUS_TABLE.stopped.icon).toBe('pause')
  })
})
