import { describe, it, expect } from 'vitest'
import { todoActionNote, todosView } from './todos'
import type { TodoRowT } from '../backend/types'

const row = (id: number, value: string, display: string, time_ref: string | null): TodoRowT =>
  ({ id, contact: `c${id}`, predicate: 'obligation', value, time_ref, updated_at: 1_760_000_000, display })

describe('todosView', () => {
  it('在办 / 最近了结:一行 = 要做的事 + 「跟谁 · 什么时候」;没有时间只写人', () => {
    const v = todosView({ active: [row(1, '周末回家吃饭', '妈妈', '周六'), row(2, '发作品集链接', '小林', null)], settled: [row(3, '预约体检', '妈妈', '这周')] }, 'zh-Hans')
    expect(v.active).toEqual([{ id: 1, text: '周末回家吃饭', meta: '妈妈 · 周六' }, { id: 2, text: '发作品集链接', meta: '小林' }])
    expect(v.settled).toEqual([{ id: 3, text: '预约体检', meta: '妈妈 · 这周' }])
    expect(v.empty).toBeNull()
    expect(v.settledToggle).toBe('最近了结（1）')
  })
  it('一条在办都没有 ⇒ 网页那两句;没有了结的 ⇒ 不画折叠行', () => {
    const v = todosView({ active: [], settled: [] }, 'zh-Hans')
    expect(v.empty).toEqual({ line: '都了结了', hint: '聊天里出现新约定会自己长出来' })
    expect(v.settledToggle).toBeNull()
    expect(todosView({ active: [], settled: [row(3, 'x', 'y', null)] }, 'en').settledToggle).toBe('Recently settled (1)')
  })
})

describe('todoActionNote', () => {
  it('成了 ⇒ 划掉了 / 捞回来了;busy ⇒ 不说', () => {
    expect(todoActionNote('resolved', 'ok')).toBe('todos.doneNote')
    expect(todoActionNote('active', 'ok')).toBe('todos.restoredNote')
    expect(todoActionNote('resolved', 'busy')).toBeNull()
  })
  it('超时 ⇒ 不确定(绝不说成了,也不说没改成);别的错 ⇒ 没改成', () => {
    expect(todoActionNote('resolved', { error: 'uncertain' })).toBe('todos.uncertain')
    for (const e of ['offline', 'unavailable', 'unknown', 'invalid', 'revoked']) expect(todoActionNote('active', { error: e })).toBe('todos.failed')
  })
})
