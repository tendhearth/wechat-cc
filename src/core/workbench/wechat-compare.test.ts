import { describe, expect, it } from 'vitest'
import { compareSide, compareReply } from './wechat-compare'

const turn = (files: Array<{ path: string; diff?: string; kind?: string }>, extra: Record<string, unknown> = {}) => ({ artifactId: 'a', sha256: 's', name: 'n', createdAt: 1, status: 'complete', headBefore: null, headAfter: null, preexistingPaths: [], notes: [], files: files.map(f => ({ preexisting: false, kind: 'modified', ...f })), ...extra }) as never
const diff = (plus: number, minus: number) => ['--- a/x', '+++ b/x', '@@ -1 +1 @@', ...Array(minus).fill('-old'), ...Array(plus).fill('+new')].join('\n')

describe('两家对比的对照', () => {
  it('sums +/- over non-discarded turns; counts files once; ignores ---/+++ headers', () => {
    const s = compareSide([turn([{ path: 'a.ts', diff: diff(3, 1) }]), turn([{ path: 'a.ts', diff: diff(2, 0) }, { path: 'b.ts', diff: diff(1, 1) }]), turn([{ path: 'c.ts', diff: diff(9, 9) }], { discarded: true })])
    expect(s).toEqual({ turns: 2, files: ['a.ts', 'b.ts'], added: 6, removed: 2 })
  })
  it('reply: one block per side with status; paths only in one side are called out; no review ⇒ says so', () => {
    const r = compareReply(
      { id: 'aaaa1111', title: '修登录 · @claude', status: '这一轮已完成', turns: [turn([{ path: 'login.ts', diff: diff(5, 2) }, { path: 'util.ts', diff: diff(1, 0) }])] },
      { id: 'bbbb2222', title: '修登录 · @codex', status: '正在处理', turns: [turn([{ path: 'login.ts', diff: diff(8, 1) }])] })
    expect(r).toContain('修登录 · @claude · aaaa1111')
    expect(r).toContain('这一轮已完成 · 1 轮 · 2 个文件 · +6 −2')
    expect(r).toContain('正在处理 · 1 轮 · 1 个文件 · +8 −1')
    expect(r).toContain('只有 aaaa1111 改了:util.ts')
    expect(r).toContain('两边都改了:login.ts')
    expect(r).toContain('任务 aaaa1111 改动')
    expect(compareReply({ id: 'aaaa1111', title: 't', status: 's', turns: null }, { id: 'bbbb2222', title: 't', status: 's', turns: [] })).toContain('还没有改动可比')
  })
})
