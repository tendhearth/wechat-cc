import { describe, expect, it } from 'vitest'
import { collectActivity } from './cc-activity-source'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const m = (n: number) => NOW - n * 60_000

describe('collectActivity', () => {
  it('turns each source into one-line items; only CC-done things; owner only; no bodies', () => {
    const src = collectActivity({
      now: () => NOW, ownerChatId: () => 'owner',
      decisions: () => [
        { id: 1, at: m(1), surface: 'terminal', provider: 'claude', project: 'wechat-cc', tool: 'Bash', summary: 'touch rules-check.txt', verdict: 'allow', by: 'rule', ruleId: '1', reason: 'r', scope: 's' },
        { id: 2, at: m(2), surface: 'terminal', provider: 'claude', project: 'x', tool: 'Bash', summary: 'rm -rf /', verdict: 'deny', by: 'floor', ruleId: null, reason: 'red line', scope: 's' },
      ],
      tasks: () => [
        { id: 'aaaa1111', title: '修测试', status: 'completed', updatedAt: m(3), ownerChatId: 'owner' },
        { id: 'bbbb2222', title: '别人的', status: 'completed', updatedAt: m(3), ownerChatId: 'guest' },
        { id: 'cccc3333', title: '还在跑', status: 'running', updatedAt: m(3), ownerChatId: 'owner' },
      ],
      terminal: () => [{ session_id: 's1', status: 'idle', project: 'rici', last_event_at: m(4) }, { session_id: 's2', status: 'running', project: 'x', last_event_at: m(4) }],
      letters: () => [{ id: '2026-10-19-abcdef', sentAt: m(5), opening: '最近天凉了,早上出门记得多穿一件。还有一件事想跟你说', via: 'wechat' }],
      memoryLog: () => [{ at: new Date(m(6)).toISOString(), ops: [{ kind: 'add' }, { kind: 'add' }, { kind: 'update' }, { kind: 'expire' }] }],   // memory-log.jsonl 里真实的形状:AppliedOp.kind
      log: () => [
        { at: m(7), kind: 'proactive', status: 'sent' }, { at: m(8), kind: 'proactive', status: 'deferred' },
        { at: m(9), kind: 'job', status: 'sent', ref: 'j2' }, { at: m(10), kind: 'job', status: 'sent', ref: 'j3' },
        { at: m(11), kind: 'reminder', status: 'sent', ref: 'r1' },
      ],
      jobs: () => [{ id: 'j2', text: '看一下 rici 的 issue', brief: false }, { id: 'j3', text: '早报', brief: true }],
      reminderText: (id) => id === 'r1' ? '吃药' : null,
      cliUpgrades: () => [{ cli: 'codex', last: { from: '0.159.0', to: '0.160.0', at: new Date(m(12)).toISOString(), result: 'upgraded' } }],
    })
    const titles = Object.values(src).flat().filter(Boolean).flatMap(x => x!).map(i => i.title)
    expect(titles).toEqual(expect.arrayContaining([
      '按规则替你批了 Bash:touch rules-check.txt(规则 1)',
      '红线拦下了 Bash:rm -rf /',
      '一起做「修测试」做完了',
      '终端 rici 这一轮做完了',
      '给你寄了一封信:最近天凉了,早上出门记得多穿一件。还有一件事想跟…',
      '整理了记忆:新增 2 条、改 1 条、删 1 条',
      '主动跟你说了一句',
      '想跟你说一句,没发出去',
      '定时 j2「看一下 rici 的 issue」:说了',
      '早报:说了',
      '提醒了你:吃药',
      'Codex 升级到 0.160.0,自检通过',
    ]))
    expect(titles.some(t => t.includes('别人的') || t.includes('还在跑'))).toBe(false)
    expect(titles).toHaveLength(12)
    const ids = Object.values(src).flat().flatMap(x => x ?? []).map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('a throwing source becomes null (degraded); missing deps are just absent', () => {
    const src = collectActivity({ now: () => NOW, ownerChatId: () => 'owner', letters: () => { throw new Error('disk') } })
    expect(src.letters).toBeNull()
    expect(src.decisions).toBeUndefined()
  })
  it('without an owner, owner-scoped sources are empty (never guess)', () => {
    const src = collectActivity({ now: () => NOW, ownerChatId: () => null, tasks: () => [{ id: 'a', title: 't', status: 'completed', updatedAt: m(1), ownerChatId: 'x' }] })
    expect(src.together).toEqual([])
  })
})
