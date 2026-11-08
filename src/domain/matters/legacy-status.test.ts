import { describe, expect, it } from 'vitest'
import { legacyStatus, legacyTaskStatus, lifecycleOfTaskView, taskLifecycle, wireMatter } from './legacy-status'

/** 旧 status 现算(M6b):每一格都对应列的某一个写口,见 legacy-status.ts 文件头。 */
describe('legacyStatus', () => {
  it('归档 ⇒ archived,不管种类和状态', () => {
    for (const kind of ['chat', 'task', 'terminal', 'act'] as const)
      expect(legacyStatus({ latestReady: true, kind, state: 'working', archivedAt: 5, latestTurn: 'running', taskStatus: kind === 'task' ? 'running' : null })).toBe('archived')
  })
  it('不是任务 ⇒ open:终端会话结束(state = done)、对话最近一轮已收,列都还是 open', () => {
    expect(legacyStatus({ latestReady: true, kind: 'terminal', state: 'done', archivedAt: null, latestTurn: 'interrupted' })).toBe('open')
    expect(legacyStatus({ latestReady: true, kind: 'chat', state: 'open', archivedAt: null, latestTurn: 'completed' })).toBe('open')
    expect(legacyStatus({ latestReady: true, kind: 'act', state: 'failed', archivedAt: null, latestTurn: 'failed' })).toBe('open')
  })
  it('任务:中断 ⇒ open(哪怕 v92 把统一状态推成 failed、最近一轮已收)', () => {
    expect(legacyStatus({ latestReady: true, kind: 'task', state: 'failed', archivedAt: null, latestTurn: 'completed', taskStatus: 'interrupted' })).toBe('open')
    expect(legacyStatus({ latestReady: true, kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed', taskStatus: 'interrupted' })).toBe('open')
  })
  it('任务:做完 / 没做成 / 停了 ⇒ done,按任务自己的状态(交接没启动的那件事统一状态还停在 open)', () => {
    for (const taskStatus of ['completed', 'failed', 'cancelled'] as const)
      expect(legacyStatus({ latestReady: true, kind: 'task', state: 'open', archivedAt: null, latestTurn: null, taskStatus })).toBe('done')
  })
  it('任务:还在跑、最近一轮已收、球在主人手里、最近一轮上有 ready 步 ⇒ replied;排队 / 在停 / 在跑这一轮 / 等你 ⇒ open', () => {
    expect(legacyStatus({ latestReady: true, kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed', taskStatus: 'running' })).toBe('replied')
    expect(legacyStatus({ latestReady: true, kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed', taskStatus: 'queued' })).toBe('open')
    expect(legacyStatus({ latestReady: true, kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed', taskStatus: 'cancelling' })).toBe('open')
    expect(legacyStatus({ latestReady: true, kind: 'task', state: 'working', archivedAt: null, latestTurn: 'running', taskStatus: 'running' })).toBe('open')
    expect(legacyStatus({ latestReady: true, kind: 'task', state: 'waiting', archivedAt: null, latestTurn: 'running', taskStatus: 'running' })).toBe('open')
    expect(legacyStatus({ latestReady: true, kind: 'task', state: 'open', archivedAt: null, latestTurn: 'interrupted', taskStatus: 'running' })).toBe('open')
    expect(legacyStatus({ latestReady: true, kind: 'task', state: 'open', archivedAt: null, latestTurn: null, taskStatus: 'queued' })).toBe('open')
  })
  it('replied 这一位读 ready 步(Codex P2):执行者交了结果、后台还在干 ⇒ 轮已收、state 回 open,但 settleQuiet 没写 ready 步 ⇒ open', () => {
    expect(legacyStatus({ kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed', taskStatus: 'running', latestReady: false })).toBe('open')
    expect(legacyStatus({ kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed', latestReady: false })).toBe('open')
    // 有过 ready 步但这件事已经往前走了(新一轮在跑 / 中断 / 做完)⇒ 按现算的
    expect(legacyStatus({ kind: 'task', state: 'working', archivedAt: null, latestTurn: 'running', taskStatus: 'running', latestReady: true })).toBe('open')
    expect(legacyStatus({ kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed', taskStatus: 'interrupted', latestReady: true })).toBe('open')
    expect(legacyStatus({ kind: 'task', state: 'done', archivedAt: null, latestTurn: 'completed', taskStatus: 'completed', latestReady: true })).toBe('done')
  })
  it('任务那一行读不到 ⇒ 用统一状态', () => {
    for (const state of ['done', 'failed', 'cancelled'] as const) expect(legacyStatus({ latestReady: true, kind: 'task', state, archivedAt: null, latestTurn: 'completed' })).toBe('done')
    expect(legacyStatus({ latestReady: true, kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed' })).toBe('replied')
    expect(legacyStatus({ latestReady: true, kind: 'task', state: 'working', archivedAt: null, latestTurn: 'running', taskStatus: null })).toBe('open')
  })
})

describe('「任务 → 旧状态」只有一份式子', () => {
  it('归档在先,中断 ⇒ open,终态 ⇒ done,phase replied ⇒ replied', () => {
    expect(legacyTaskStatus({ archived: true, status: 'running', replied: true })).toBe('archived')
    expect(legacyTaskStatus({ archived: false, status: 'interrupted', replied: true })).toBe('open')
    expect(legacyTaskStatus({ archived: false, status: 'completed', replied: true })).toBe('done')
    expect(legacyTaskStatus({ archived: false, status: 'running', replied: true })).toBe('replied')
    expect(legacyTaskStatus({ archived: false, status: 'running', replied: false })).toBe('open')
  })
  it('归档 / 结局(以前写列的那几处):归档在先,终态 ⇒ done,其余(在跑、排队、中断)⇒ open', () => {
    expect(taskLifecycle({ archived: true, status: 'running' })).toBe('archived')
    for (const status of ['completed', 'failed', 'cancelled']) expect(taskLifecycle({ archived: false, status })).toBe('done')
    for (const status of ['running', 'queued', 'cancelling', 'interrupted']) expect(taskLifecycle({ archived: false, status })).toBe('open')
    expect(lifecycleOfTaskView({ archivedAt: 1, status: 'completed' })).toBe('archived')
    expect(lifecycleOfTaskView({ archivedAt: null, status: 'running' })).toBe('open')
    expect(lifecycleOfTaskView({ status: 'completed' })).toBe('done')
  })
})

describe('wireMatter:线上的旧 status 插回它以前的位置', () => {
  it('projectPath 之后、state 之前;别的键原样、顺序不变', () => {
    const m = { id: '0000000a', kind: 'task' as const, title: 't', projectPath: '/w', state: 'open' as const, archivedAt: null, ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 2, agents: ['codex'] }
    const w = wireMatter(m, 'replied')
    expect(Object.keys(w)).toEqual(['id', 'kind', 'title', 'projectPath', 'status', 'state', 'archivedAt', 'ownerChatId', 'originMatterId', 'originMessageId', 'createdAt', 'updatedAt', 'agents'])
    expect(w.status).toBe('replied')
    expect(m).not.toHaveProperty('status')
  })
})
