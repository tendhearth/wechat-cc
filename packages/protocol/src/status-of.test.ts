import { describe, it, expect } from 'vitest'
import { statusOfMatter, terminalStatusKey } from './status-of'
import { RosterItem } from './roster'

// 判定的完整用例在 apps/app/src/view/status.test.ts(经再导出跑这份代码);这里钉 daemon 名单用到的几条。
describe('status-of(协议包)', () => {
  it('终端会话四态并进同一套词', () => {
    expect(terminalStatusKey('waiting')).toBe('waiting')
    expect(terminalStatusKey('running')).toBe('working')
    expect(terminalStatusKey('idle')).toBe('replied')
    expect(terminalStatusKey('ended')).toBe('done')
  })
  it('已完成的任务事还挂着待批 ⇒ waiting', () => {
    expect(statusOfMatter({ state: 'done', kind: 'task', archivedAt: null }, null, 1)).toBe('waiting')
  })
})

describe('RosterItem', () => {
  const ok = { key: 'matter:abcd1234', kind: 'matter', id: 'abcd1234', title: '备份检查', group: 'working', status: 'working', agents: [{ id: 'codex', current: true }], quiet: false, updatedAt: 1, unseen: false }
  it('最小合法行能解析', () => { expect(RosterItem.safeParse(ok).success).toBe(true) })
  it('group 只有三组', () => { expect(RosterItem.safeParse({ ...ok, group: 'done' }).success).toBe(false) })
})
