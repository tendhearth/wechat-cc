import { describe, it, expect } from 'vitest'
import { approvalView, buildAnswers } from './approval'

const base = {
  matter: { id: 'ab12cd34', kind: 'task', title: 'x', projectPath: '/p', status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1 },
  bindings: [], sessions: [], events: [], artifacts: [], inputs: [], questions: [],
  task: { id: 'ab12cd34', title: '作品集', status: 'running', phase: 'working', providerId: 'claude', path: '/Users/me/portfolio', error: null, updatedAt: 1 },
  runId: 'run-1',
  permissions: [{ id: 'p1', taskId: 'ab12cd34', tool: 'Bash', description: 'rm -rf ~/Documents/old\n# cleanup', createdAt: 1 }],
} as any
const model = { title: '可以清理旧文件吗?', what: '清理临时缓存', scope: '作品集', effect: '删除一些文件', source: 'model' as const }

describe('approvalView', () => {
  it('模型说明 ⇒ 原始命令首行与目录直接可见(aiSummary + showRawInline)', () => {
    const v = approvalView(base, { p1: model })
    expect(v).toMatchObject({ kind: 'card', requestId: 'p1', runId: 'run-1', aiSummary: true, showRawInline: true, rawFirstLine: 'rm -rf ~/Documents/old', workingDir: '/Users/me/portfolio', rawFull: 'rm -rf ~/Documents/old\n# cleanup', title: '可以清理旧文件吗?' })
  })
  it('没有说明 ⇒ 用原文,不是 AI 概括', () => {
    const v = approvalView(base, {})
    expect(v).toMatchObject({ kind: 'card', title: 'Bash', what: 'rm -rf ~/Documents/old\n# cleanup', scope: '/Users/me/portfolio', effect: '', aiSummary: false, showRawInline: false })
  })
  it('raw 来源的说明不算 AI 概括', () => {
    const v = approvalView(base, { p1: { ...model, source: 'raw' } })
    expect(v).toMatchObject({ aiSummary: false, showRawInline: false })
  })
  it('同一件事两条、没指定 ⇒ 让用户选', () => {
    const d = { ...base, permissions: [...base.permissions, { id: 'p2', taskId: 'ab12cd34', tool: 'Bash', description: 'ls', createdAt: 2 }] }
    expect(approvalView(d, {})).toEqual({ kind: 'choose', items: [{ requestId: 'p1', kind: 'permission', summary: 'Bash: rm -rf ~/Documents/old' }, { requestId: 'p2', kind: 'permission', summary: 'Bash: ls' }] })
  })
  it('多条但指定了 ⇒ 那一条', () => {
    const d = { ...base, permissions: [...base.permissions, { id: 'p2', taskId: 'ab12cd34', tool: 'Bash', description: 'ls', createdAt: 2 }] }
    expect(approvalView(d, {}, 'p2')).toMatchObject({ kind: 'card', requestId: 'p2', rawFirstLine: 'ls' })
  })
  it('指定了但已不存在 / 没有待处理 / 没有 runId ⇒ none', () => {
    expect(approvalView(base, {}, 'gone')).toEqual({ kind: 'none' })
    expect(approvalView({ ...base, permissions: [] }, {})).toEqual({ kind: 'none' })
    expect(approvalView({ ...base, runId: undefined }, {})).toEqual({ kind: 'none' })
  })
  it('首行最多 120 字,choose 摘要最多 80 字', () => {
    const long = 'x'.repeat(300)
    const d = { ...base, permissions: [{ ...base.permissions[0], description: long }] }
    expect((approvalView(d, {}) as any).rawFirstLine).toHaveLength(120)
    const d2 = { ...base, permissions: [d.permissions[0], { ...d.permissions[0], id: 'p2' }] }
    expect((approvalView(d2, {}) as any).items[0].summary).toHaveLength(80)
  })

  describe('questions', () => {
    const q = { id: 'q1', taskId: 'ab12cd34', createdAt: 1, questions: [{ id: 'a', header: '方案', question: '用哪个?', options: [{ label: 'A', description: 'da' }], multiSelect: false, allowOther: true }] }
    const onlyQ = { ...base, permissions: [], questions: [q] }
    it('只有问题 ⇒ question,不是 none', () => {
      expect(approvalView(onlyQ, {})).toEqual({ kind: 'question', requestId: 'q1', runId: 'run-1', items: [{ id: 'a', header: '方案', question: '用哪个?', options: [{ label: 'A', description: 'da' }], multiSelect: false, allowOther: true }] })
    })
    it('一条批准 + 一个问题、没指定 ⇒ choose 含两种 kind', () => {
      const v = approvalView({ ...base, questions: [q] }, {}) as any
      expect(v.kind).toBe('choose')
      expect(v.items.map((i: any) => [i.requestId, i.kind])).toEqual([['p1', 'permission'], ['q1', 'question']])
    })
    it('requestId 指向问题 ⇒ question', () => {
      expect(approvalView({ ...base, questions: [q] }, {}, 'q1')).toMatchObject({ kind: 'question', requestId: 'q1' })
    })
    it('问题没有 runId ⇒ none', () => {
      expect(approvalView({ ...onlyQ, runId: undefined }, {})).toEqual({ kind: 'none' })
    })
  })
})

describe('buildAnswers', () => {
  const single = { id: 'a', header: 'H', question: 'Q', options: [{ label: 'x', description: '' }, { label: 'y', description: '' }], multiSelect: false, allowOther: true }
  const multi = { ...single, id: 'b', multiSelect: true, allowOther: false }
  it('单选取选中项;其他填字时顶替', () => {
    expect(buildAnswers([single], { a: ['x'] }, {})).toEqual({ a: 'x' })
    expect(buildAnswers([single], { a: ['x'] }, { a: '  周三 ' })).toEqual({ a: '周三' })
  })
  it('多选给数组;不允许其他时忽略其他文本', () => {
    expect(buildAnswers([multi], { b: ['x', 'y'] }, { b: 'z' })).toEqual({ b: ['x', 'y'] })
  })
  it('有一题没答 ⇒ null;空白其他不算答', () => {
    expect(buildAnswers([single, multi], { a: ['x'] }, {})).toBeNull()
    expect(buildAnswers([single], {}, { a: '   ' })).toBeNull()
  })
  it('不在选项里的标签不算', () => {
    expect(buildAnswers([single], { a: ['nope'] }, {})).toBeNull()
  })
})
