import { describe, expect, it } from 'vitest'
import { untilHtml } from './workbench.js'

const u = (o: object) => ({ until: { command: 'bun run test', maxRounds: 3, rounds: 0, status: 'active', lastExit: null, stopReason: null, ...o } as never })

describe('untilHtml(对标 #9)', () => {
  it('nothing without a goal', () => { expect(untilHtml({})).toBe('') })
  it('shows the whole command, the round and the state', () => {
    expect(untilHtml(u({}))).toContain('直到 <code>bun run test</code> 通过 · 第 0/3 轮 · 这一轮做完就检查')
    expect(untilHtml(u({ rounds: 1, lastExit: 1 }))).toContain('第 1/3 轮 · 上次没过，在接着改')
    expect(untilHtml(u({ rounds: 2, lastExit: 0, status: 'passed' }))).toContain('通过了')
    expect(untilHtml(u({ rounds: 3, status: 'exhausted' }))).toContain('到上限还没过')
    expect(untilHtml(u({ status: 'stopped', stopReason: '你停下了这件事' }))).toContain('停了：你停下了这件事')
  })
  it('escapes the command', () => { expect(untilHtml(u({ command: '<b>x</b>' }))).toContain('&lt;b&gt;x&lt;/b&gt;') })
})
