import { describe, it, expect } from 'vitest'
import { progressView } from './progress'

const detail = (over: any = {}) => ({
  matter: { id: 'a', kind: 'task', title: 'mt', projectPath: '/p', status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1 },
  bindings: [], sessions: [], events: [], artifacts: [], inputs: [], questions: [], permissions: [],
  task: { id: 'a', title: '作品集', status: 'running', phase: 'working', providerId: 'claude', path: '/p', error: null, updatedAt: 1 },
  ...over,
}) as any
const prog = { summary: '在整理', steps: [{ title: 's1', detail: 'd1' }, { title: 's2', detail: 'd2' }], source: 'model' as const }

describe('progressView', () => {
  it('summary 为空 ⇒ null(界面显示骨架),steps 为空', () => {
    const v = progressView(detail(), { progress: null }, null)
    expect(v).toMatchObject({ summary: null, steps: [], status: 'working', title: '作品集', pendingCount: 0, changedFiles: 0 })
    expect(progressView(detail(), null, null).summary).toBeNull()
  })
  it('没有待决定 ⇒ 所有步骤 done', () => {
    const v = progressView(detail(), { progress: prog }, null)
    expect(v.summary).toBe('在整理')
    expect(v.steps.map(s => s.done)).toEqual([true, true])
  })
  it('有待决定 ⇒ 状态 waiting,最后一步 done:false', () => {
    const d = detail({ permissions: [{ id: 'p', taskId: 'a', tool: 'Bash', description: 'ls', createdAt: 1 }], questions: [{ id: 'q', taskId: 'a', createdAt: 1, questions: [] }] })
    const v = progressView(d, { progress: prog }, null)
    expect(v.status).toBe('waiting')
    expect(v.pendingCount).toBe(2)
    expect(v.steps.map(s => s.done)).toEqual([true, false])
  })
  it('改动文件数', () => {
    const changes = { createdAt: 1, status: 'complete', files: [{ path: 'a', kind: 'added', truncated: false }, { path: 'b', kind: 'modified', truncated: false }], omittedFiles: 0, notes: [] } as any
    expect(progressView(detail(), null, changes).changedFiles).toBe(2)
  })
  it('没有 task ⇒ 用 matter 标题与状态', () => {
    const v = progressView(detail({ task: null }), null, null)
    expect(v).toMatchObject({ title: 'mt', status: 'working' })
    expect(progressView(detail({ task: null, matter: { ...detail().matter, status: 'done' } }), null, null).status).toBe('done')
  })
})
