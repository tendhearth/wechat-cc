import { describe, expect, it } from 'vitest'
import { legacyStatus, legacyStatusOfTaskView, legacyTaskStatus } from './legacy-status'

/** 旧 status 现算(M6b):每一格都对应列的某一个写口,见 legacy-status.ts 文件头。 */
describe('legacyStatus', () => {
  it('归档 ⇒ archived,不管种类和状态', () => {
    for (const kind of ['chat', 'task', 'terminal', 'act'] as const)
      expect(legacyStatus({ kind, state: 'working', archivedAt: 5, latestTurn: 'running', taskStatus: kind === 'task' ? 'running' : null })).toBe('archived')
  })
  it('不是任务 ⇒ open:终端会话结束(state = done)、对话最近一轮已收,列都还是 open', () => {
    expect(legacyStatus({ kind: 'terminal', state: 'done', archivedAt: null, latestTurn: 'interrupted' })).toBe('open')
    expect(legacyStatus({ kind: 'chat', state: 'open', archivedAt: null, latestTurn: 'completed' })).toBe('open')
    expect(legacyStatus({ kind: 'act', state: 'failed', archivedAt: null, latestTurn: 'failed' })).toBe('open')
  })
  it('任务:中断 ⇒ open(哪怕 v92 把统一状态推成 failed、最近一轮已收)', () => {
    expect(legacyStatus({ kind: 'task', state: 'failed', archivedAt: null, latestTurn: 'completed', taskStatus: 'interrupted' })).toBe('open')
    expect(legacyStatus({ kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed', taskStatus: 'interrupted' })).toBe('open')
  })
  it('任务:做完 / 没做成 / 停了 ⇒ done,按任务自己的状态(交接没启动的那件事统一状态还停在 open)', () => {
    for (const taskStatus of ['completed', 'failed', 'cancelled'] as const)
      expect(legacyStatus({ kind: 'task', state: 'open', archivedAt: null, latestTurn: null, taskStatus })).toBe('done')
  })
  it('任务:还在跑、最近一轮已收、球在主人手里 ⇒ replied;排队 / 在停 / 在跑这一轮 / 等你 ⇒ open', () => {
    expect(legacyStatus({ kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed', taskStatus: 'running' })).toBe('replied')
    expect(legacyStatus({ kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed', taskStatus: 'queued' })).toBe('open')
    expect(legacyStatus({ kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed', taskStatus: 'cancelling' })).toBe('open')
    expect(legacyStatus({ kind: 'task', state: 'working', archivedAt: null, latestTurn: 'running', taskStatus: 'running' })).toBe('open')
    expect(legacyStatus({ kind: 'task', state: 'waiting', archivedAt: null, latestTurn: 'running', taskStatus: 'running' })).toBe('open')
    expect(legacyStatus({ kind: 'task', state: 'open', archivedAt: null, latestTurn: 'interrupted', taskStatus: 'running' })).toBe('open')
    expect(legacyStatus({ kind: 'task', state: 'open', archivedAt: null, latestTurn: null, taskStatus: 'queued' })).toBe('open')
  })
  it('任务那一行读不到 ⇒ 用统一状态', () => {
    for (const state of ['done', 'failed', 'cancelled'] as const) expect(legacyStatus({ kind: 'task', state, archivedAt: null, latestTurn: 'completed' })).toBe('done')
    expect(legacyStatus({ kind: 'task', state: 'open', archivedAt: null, latestTurn: 'completed' })).toBe('replied')
    expect(legacyStatus({ kind: 'task', state: 'working', archivedAt: null, latestTurn: 'running', taskStatus: null })).toBe('open')
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
  it('视图版本看 archivedAt 与 phase', () => {
    expect(legacyStatusOfTaskView({ archivedAt: 1, status: 'completed', phase: 'replied' })).toBe('archived')
    expect(legacyStatusOfTaskView({ archivedAt: null, status: 'running', phase: 'replied' })).toBe('replied')
    expect(legacyStatusOfTaskView({ status: 'queued', phase: 'queued' })).toBe('open')
  })
})
