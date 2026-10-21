import { describe, it, expect } from 'vitest'
import { progressView, changesCoverage } from './progress'

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
  it('聊天类 / 没有任务 ⇒ summaryState none(不再永远转骨架屏)', () => {
    expect(progressView(detail({ task: null }), { progress: null }, null).summaryState).toBe('none')
    expect(progressView(detail({ task: null }), null, null).summaryState).toBe('none')
  })
  it('任务:还没拉到 loading;拉到 ready;失败 failed;拉到但没有 none', () => {
    expect(progressView(detail(), null, null).summaryState).toBe('loading')
    expect(progressView(detail(), null, null, true).summaryState).toBe('failed')
    expect(progressView(detail(), { progress: { summary: 's', steps: [], source: 'raw' } }, null).summaryState).toBe('ready')
    expect(progressView(detail(), { progress: null }, null).summaryState).toBe('none')
  })
})

describe('canStop — 手机上的「停止这一轮」(2026-10-06)', () => {
  it('only while a run is queued or working', async () => {
    const { canStop } = await import('./progress')
    const task = (phase: string) => ({ id: 'deadbeef', title: 't', status: 'running', phase } as never)
    expect(canStop({ runId: 'r1', task: task('working') })).toBe(true)
    expect(canStop({ runId: 'r1', task: task('queued') })).toBe(true)
    expect(canStop({ runId: 'r1', task: task('replied') })).toBe(false)
    expect(canStop({ task: task('working') })).toBe(false)
    expect(canStop({ runId: 'r1', task: undefined } as never)).toBe(false)
  })
})

describe('changesCoverage(只审了一部分要看得出来,2026-10-20)', () => {
  const turn = (over: any = {}) => ({ createdAt: 1, status: 'complete', files: [], omittedFiles: 0, notes: [], ...over }) as any
  it('查全了 ⇒ 不加话,可以说「还没有文件改动」', () => {
    expect(changesCoverage(turn(), 'zh-Hans')).toEqual({ lines: [], showEmpty: true })
    expect(changesCoverage(null, 'zh-Hans')).toEqual({ lines: [], showEmpty: true })
  })
  it('partial ⇒ 先说只检查了一部分,再跟电脑写的原因(带 N / M);不说「还没有文件改动」', () => {
    const note = '读取超时，只检查了 90 / 100 个文件，其余尚未检查。'
    const v = changesCoverage(turn({ status: 'partial', notes: [note], files: [{ path: 'a', kind: 'modified', truncated: false }] }), 'zh-Hans')
    expect(v.lines).toEqual(['这一轮只检查了一部分，没列出来的文件不代表没改。', note])
    expect(v.showEmpty).toBe(false)
    expect(changesCoverage(turn({ status: 'partial', notes: [note] }), 'en').lines[0]).toMatch(/^Only part of this round was checked/)
  })
  it('unavailable ⇒ 记录不完整,不能说没改', () => {
    const v = changesCoverage(turn({ status: 'unavailable', notes: ['结束时的项目状态无法读取，不能据此判断有没有修改。'] }), 'zh-Hans')
    expect(v.lines[0]).toBe('这一轮的改动记录不完整，不能据此判断有没有修改。')
    expect(v.showEmpty).toBe(false)
  })
  it('手机放不下的文件 ⇒ 说还有几个;标题的文件数也算上', () => {
    const t = turn({ omittedFiles: 7, files: [{ path: 'a', kind: 'modified', truncated: false }] })
    expect(changesCoverage(t, 'zh-Hans').lines).toEqual(['还有 7 个文件这里放不下，回电脑上看。'])
    expect(progressView(detail(), null, t).changedFiles).toBe(8)
  })
})
