import { describe, it, expect } from 'vitest'
import { parseVisitCommand } from './visit-command'

describe('parseVisitCommand', () => {
  it('裸「串门」和几个口语变体', () => {
    for (const t of ['串门', '去串门', '出去串个门', '串门!', '/visit']) expect(parseVisitCommand(t)).toEqual({})
  })
  it('带通道前缀', () => {
    expect(parseVisitCommand('串门 seek-1')).toEqual({ channel: 'seek-1' })
    expect(parseVisitCommand('/visit ab12')).toEqual({ channel: 'ab12' })
  })
  it('普通话里提到串门不触发 —— 「我明天去我妈家串门」是聊天,不是命令', () => {
    expect(parseVisitCommand('我明天去我妈家串门')).toBeNull()
    expect(parseVisitCommand('串门是什么意思')).toBeNull()
  })
})
