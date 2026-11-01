import { describe, expect, it } from 'vitest'
import type { CliSessionRowT } from '../backend/types'
import { t } from '../i18n'
import { homeView, type HomeInput } from './home'
import { terminalStatusKey } from './status'

const NOW = 100 * 3_600_000
const H = 3_600_000
const m = (id: string, updatedAt: number, status = 'open', over: Record<string, unknown> = {}) =>
  ({ id, kind: 'task', title: `t${id}`, projectPath: null, status, ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt, ...over }) as any
const term = (over: Partial<CliSessionRowT> = {}): CliSessionRowT => ({
  session_id: 's1', code: 's1', source: 'claude', status: 'idle', stale: false, project: 'blog', machine: null,
  last_summary: 'done', last_event_at: NOW - 5 * 60_000, last_prompt_at: null, created_at: 1, pending: null, ...over,
})
const input = (over: Partial<HomeInput> = {}): HomeInput => ({
  matters: [], approvals: [], agents: { running: 0, waiting: 0, tasks: [] }, terminal: [], known: true, now: NOW, lang: 'zh-Hans', ...over,
})
const ids = (v: ReturnType<typeof homeView>, key: string) => v.groups.find(g => g.key === key)?.rows.map(r => r.id) ?? []

describe('homeView(此刻与一起做合成的一份看法)', () => {
  it('分组顺序固定 等你 → 在做 → 带回来的,空组不出', () => {
    const v = homeView(input({ matters: [m('w', NOW), m('r', NOW, 'open'), m('d', NOW - H, 'done')], approvals: [{ taskId: 'w', kind: 'permission', id: 'p1', summary: 'Bash: ls' }] as any }))
    expect(v.groups.map(g => g.key)).toEqual(['waiting', 'working', 'back'])
    expect(homeView(input({ matters: [m('r', NOW)] })).groups.map(g => g.key)).toEqual(['working'])
  })
  it('够不着电脑 ⇒ 不出等你组、说暂时不知道,其余组照常', () => {
    const v = homeView(input({ known: false, matters: [m('w', NOW), m('r', NOW)], approvals: [{ taskId: 'w', kind: 'permission', id: 'p1', summary: 's' }] as any }))
    expect(v.waitingUnknown).toBe(true)
    expect(v.groups.map(g => g.key)).not.toContain('waiting')
    expect(v.waitingCount).toBe(0)
  })
  it('同一件事两条批准 ⇒ 等你组一行,带第一条请求;去处带 ?request=', () => {
    const v = homeView(input({ matters: [m('w', NOW)], approvals: [{ taskId: 'w', kind: 'question', id: 'q1', summary: 'a' }, { taskId: 'w', kind: 'permission', id: 'p2', summary: 'b' }] as any }))
    const rows = v.groups[0]!.rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'w', status: 'waiting', pendingRequestId: 'q1', title: 'a', href: '/matter/w?request=q1', caption: 'tw' })
    expect(v.waitingCount).toBe(1)
  })
  it('主人对话、访客对话、归档的不进列表', () => {
    const v = homeView(input({ matters: [m('a', NOW), m('c', NOW, 'open', { kind: 'chat' }), m('x', NOW, 'archived')] }))
    expect(v.groups.flatMap(g => g.rows.map(r => r.id))).toEqual(['a'])
  })
  it('终端会话:状态并进同一套词;终端自己在问 ⇒ 等你组里说「回电脑上答」但不计数', () => {
    expect([terminalStatusKey('waiting'), terminalStatusKey('running'), terminalStatusKey('idle'), terminalStatusKey('ended')]).toEqual(['waiting', 'working', 'replied', 'done'])
    const local = term({ session_id: 'L', status: 'waiting', pending: { tool: 'Bash', summary: 'rm', since: NOW, hash: null, actionable: false } })
    const phone = term({ session_id: 'P', status: 'waiting', pending: { tool: 'Bash', summary: 'deploy', since: NOW, hash: 'ab', actionable: true } })
    const v = homeView(input({ terminal: [local, phone, term({ session_id: 'E', status: 'ended' })] }))
    const w = v.groups.find(g => g.key === 'waiting')!.rows
    expect(w.map(r => r.id).sort()).toEqual(['L', 'P'])
    expect(w.find(r => r.id === 'L')).toMatchObject({ source: 'terminal', note: t('zh-Hans', 'terminal.askedLocally'), href: '/terminal/L', title: 'Bash: rm' })
    expect(w.find(r => r.id === 'P')!.note).toBeNull()
    expect(v.waitingCount).toBe(1)
    expect(v.groups.flatMap(g => g.rows.map(r => r.id))).not.toContain('E')
  })
  it('终端在跑 ⇒ 在做组;歇着 ⇒ 带回来的(这一轮做完了)', () => {
    const v = homeView(input({ terminal: [term({ session_id: 'R', status: 'running' }), term({ session_id: 'I', status: 'idle' })] }))
    expect(ids(v, 'working')).toEqual(['R'])
    expect(v.groups.find(g => g.key === 'back')!.rows[0]).toMatchObject({ id: 'I', status: 'replied' })
  })
  it('带回来的只收 24 小时内的;更早的算进「全部」的数', () => {
    const v = homeView(input({ matters: [m('new', NOW - 2 * H, 'done'), m('old', NOW - 30 * H, 'done')] }))
    expect(ids(v, 'back')).toEqual(['new'])
    expect(v.moreCount).toBe(1)
  })
  it('离开一小时以上、这期间有带回来的 ⇒ 组名换成「你不在的这 N 小时」', () => {
    const v = homeView(input({ matters: [m('a', NOW - H, 'done')], away: NOW - 3 * H }))
    expect(v.groups.find(g => g.key === 'back')!.title).toBe(t('zh-Hans', 'today.whileAway', { n: 3 }))
    const plain = homeView(input({ matters: [m('a', NOW - H, 'done')] }))
    expect(plain.groups.find(g => g.key === 'back')!.title).toBe(t('zh-Hans', 'home.group.back'))
  })
  it('组内按最近动静倒序;等你组里一件事在前、终端在后', () => {
    const phone = term({ session_id: 'P', status: 'waiting', last_event_at: NOW, pending: { tool: 'Bash', summary: 'x', since: NOW, hash: 'h', actionable: true } })
    const v = homeView(input({ matters: [m('a', NOW - 3 * H), m('b', NOW - H), m('w', NOW - 5 * H)], approvals: [{ taskId: 'w', kind: 'permission', id: 'p', summary: 's' }] as any, terminal: [phone] }))
    expect(ids(v, 'waiting')).toEqual(['w', 'P'])
    expect(ids(v, 'working')).toEqual(['b', 'a'])
  })
  it('做完类的状态词进 caption;在做的没有 caption', () => {
    const v = homeView(input({ matters: [m('f', NOW, 'open'), m('r', NOW)], agents: { running: 1, waiting: 0, tasks: [{ id: 'f', status: 'running', phase: 'failed' }] } as any }))
    expect(v.groups.find(g => g.key === 'back')!.rows[0]).toMatchObject({ id: 'f', status: 'failed', caption: t('zh-Hans', 'status.failed') })
    expect(v.groups.find(g => g.key === 'working')!.rows[0]!.caption).toBeNull()
  })
})
