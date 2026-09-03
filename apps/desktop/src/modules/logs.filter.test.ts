import { describe, it, expect } from 'vitest'
import { filterLogEntries } from './logs.js'

const E = (tag: string, message: string) => ({ timestamp: 1, tag, message })

// 2026-09-02:owner 要「app 里也可以查询」某条回答是不是联网查来的。
// 日志面板此前只能看,不能筛 —— 一屏几百行,`tools=search_web` 混在里面
// 等于没有。
describe('filterLogEntries —— 日志面板的筛选', () => {
  const rows = [
    E('TURN', 'chat=x provider=agy outcome=completed dur=39190ms tools=search_web'),
    E('TURN', 'chat=x provider=claude outcome=completed dur=800ms'),
    E('MAILBOX', 'poll relay=… 取不到信'),
    { timestamp: null, tag: null, message: '  续行:堆栈第二行' },
  ]

  it('空查询 = 原样返回', () => {
    expect(filterLogEntries(rows, '')).toHaveLength(4)
    expect(filterLogEntries(rows, '   ')).toHaveLength(4)
  })

  it('按正文筛 —— 这就是「查哪条回答联网了」', () => {
    const r = filterLogEntries(rows, 'tools=')
    expect(r).toHaveLength(1)
    expect(r[0]!.message).toContain('search_web')
  })

  it('按 tag 筛 —— 命中行 + 它的续行一起留下', () => {
    // 夹具里那条续行紧跟在 MAILBOX 后面,所以是 2 行。这是**对的**:
    // 只留命中行会筛出没头没尾的半截堆栈。
    const r = filterLogEntries(rows, 'MAILBOX')
    expect(r).toHaveLength(2)
    expect(r[0]!.tag).toBe('MAILBOX')
    expect(r[1]!.tag).toBeNull()
  })

  it('大小写不敏感(用户不会记得日志 tag 是全大写)', () => {
    expect(filterLogEntries(rows, 'mailbox')).toHaveLength(2)
    expect(filterLogEntries(rows, 'AGY')).toHaveLength(1)   // agy 那条后面没有续行
  })

  it('续行(没有 tag/时间戳的堆栈行)跟着它上面那条走', () => {
    // 否则筛出来的堆栈会没头没尾,或者头没了只剩尾。
    const r = filterLogEntries([E('ERROR', 'boom'), { timestamp: null, tag: null, message: '  at foo()' }], 'boom')
    expect(r).toHaveLength(2)
    expect(r[1]!.message).toContain('at foo()')
  })

  it('续行不会被单独匹出来(它的上文没命中时一起丢掉)', () => {
    expect(filterLogEntries(rows, '续行')).toHaveLength(0)
  })
})
