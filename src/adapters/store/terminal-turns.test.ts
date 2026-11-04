import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../../lib/db'
import { makeMatterStore } from './matters-store'
import { makeMatterLog } from './matter-log'
import { makeTerminalTurnLog, TERMINAL_QUIET_MS } from './terminal-turns'
import type { MatterLog, MatterStore } from '../../ports/matters'
import type { TerminalTurnLog } from '../../ports/terminal-turns'
import { makeCliSessionStore } from './cli-session-store'

/** 终端会话 → 一件 kind='terminal' 的事(M4a)。 */
let db: Db, matters: MatterStore, log: MatterLog, turns: TerminalTurnLog
beforeEach(() => {
  db = openDb({ path: ':memory:' })
  matters = makeMatterStore(db); log = makeMatterLog(db)
  turns = makeTerminalTurnLog({ db, log, matters })
})
afterEach(() => db.close())
const ev = (kind: 'stop' | 'prompt' | 'permission' | 'session_end', over: Record<string, unknown> = {}) =>
  ({ source: 'claude', kind, session_id: 'sess-1', cwd: '/Users/me/blog', ...over })
const matterId = () => matters.findBySurface('cli', 'sess-1')!.id
const items = () => log.items(matterId()).map(i => [i.kind, i.status, i.payload])

describe('terminal-turns', () => {
  it('看的那条路首见(adopt,M6d):建这件事并按登记处那一行对齐 —— 登记处列表里的状态 / 等你那一项一字不变;已经有了 ⇒ 不动', () => {
    const now = 10_000_000
    const store = makeCliSessionStore(db, () => now)
    const at = now - 60_000
    for (const id of ['E', 'R', 'W', 'I']) store.touch({ session_id: id, source: 'claude', cwd: '/w/blog', machine: 'mac' }, at)
    store.setStatus('E', 'ended', at)
    store.setStatus('R', 'running', at, { promptAt: at })
    store.setStatus('W', 'waiting', at, { pending: { tool: 'Bash', summary: 'rm -rf ./tmp' } })
    store.setStatus('I', 'idle', at, { summary: '好了' })
    const view = () => store.list({ includeEnded: true }).map(r => ({ id: r.session_id, status: r.status, tool: r.pending_tool, summary: r.pending_summary, said: r.last_summary }))
    // 等你那一项的时间(pending_at)从卡推 = 卡写进去的那一刻,不是列里的时间(钩子那条路 permissionAsked 也一样);这里不比
    const before = view()
    for (const id of ['E', 'R', 'W', 'I']) turns.adopt({ source: 'claude', session_id: id, cwd: '/w/blog', machine: 'mac' })
    expect(['E', 'R', 'W', 'I'].every(id => matters.findBySurface('cli', id))).toBe(true)
    expect(view()).toEqual(before)
    const r = matters.findBySurface('cli', 'R')!.id
    expect(turns.adopt({ source: 'claude', session_id: 'R', cwd: '/w/blog' })).toBe(r)
    expect(log.turns(r)).toHaveLength(1)
    // 登记处没有这一行(只知道 id 和记录)⇒ 只建,不开轮
    turns.adopt({ source: 'claude', session_id: 'NEW', cwd: '/w/blog' })
    expect(log.turns(matters.findBySurface('cli', 'NEW')!.id)).toEqual([])
  })
  it('第一次看到一个会话 ⇒ 建一件 terminal 的事(标题 = 项目名、出生地 cli),绑 surface=cli;之后同一件', () => {
    turns.event(ev('prompt'), 1_000)
    turns.event(ev('prompt'), 2_000)
    const m = matters.get(matterId())!
    expect(m).toMatchObject({ kind: 'terminal', title: 'blog', projectPath: '/Users/me/blog', origin: 'cli' })
    expect(matters.list({ kind: 'terminal' })).toHaveLength(1)
  })
  it('主人发问开一轮(在做);答完写最后一句、收这一轮(回到 open);还在跑时再发问记进同一轮', () => {
    turns.event(ev('prompt'), 1_000)
    expect(log.state(matterId())?.state).toBe('working')
    turns.event(ev('prompt'), 1_500)
    turns.event(ev('stop', { text: '改好了,测试也过了' }), 3_000)
    expect(log.turns(matterId())).toMatchObject([{ executor: 'claude', status: 'completed', startedAt: 1_000, endedAt: 3_000, policy: { cwd: '/Users/me/blog' } }])
    expect(items()).toEqual([['user_message', 'completed', {}], ['user_message', 'completed', {}], ['agent_message', 'completed', { text: '改好了,测试也过了' }]])
    expect(log.state(matterId())?.state).toBe('open')
  })
  it('记录会读进步的会话(transcribed,M4b):发问 / 最后一句不在钩子这边写(从记录来,免得两份);轮照样开、照样收', () => {
    turns.event(ev('prompt', { transcribed: true }), 1_000)
    turns.event(ev('stop', { text: '改好了', transcribed: true }), 2_000)
    expect(log.turns(matterId())).toMatchObject([{ status: 'completed', startedAt: 1_000, endedAt: 2_000 }])
    expect(items()).toEqual([])
  })
  it('harness 自己塞的 prompt:也开一轮(policy.automated,在做),但不写「主人说了一句」、不替主人收卡;在跑时再塞记进同一轮(M4d)', () => {
    turns.permissionAsked({ source: 'claude', session_id: 'sess-1', cwd: '/w', tool_name: 'Bash', summary: 'ls' }, 500)
    turns.event(ev('prompt', { automated: true }), 1_000)
    expect(log.turns(matterId())).toMatchObject([{ status: 'running', policy: { automated: true } }])
    expect(items()).toEqual([['permission', 'started', { tool: 'Bash', summary: 'ls' }]])
    turns.event(ev('prompt', { automated: true }), 1_500)
    expect(log.turns(matterId())).toHaveLength(1)
    turns.event(ev('stop', { text: '好了' }), 2_000)
    expect(log.turns(matterId())).toMatchObject([{ status: 'completed' }])
  })
  it('要权限 ⇒ 一张卡(等你);同一件事已经有开着的卡不再加;放行 ⇒ 做完、回到在做;拒绝 ⇒ failed', () => {
    turns.event(ev('prompt'), 1_000)
    turns.permissionAsked({ source: 'claude', session_id: 'sess-1', cwd: '/Users/me/blog', tool_name: 'Bash', summary: 'rm -rf dist' }, 2_000)
    turns.event(ev('permission', { text: 'Bash: rm -rf dist' }), 2_001)
    expect(log.state(matterId())?.state).toBe('waiting')
    expect(items().filter(i => i[0] === 'permission')).toEqual([['permission', 'started', { tool: 'Bash', summary: 'rm -rf dist' }]])
    turns.permissionSettled('sess-1', 'allow')
    expect(log.state(matterId())?.state).toBe('working')
    turns.permissionAsked({ source: 'claude', session_id: 'sess-1', cwd: '/Users/me/blog', tool_name: 'Write', summary: null }, 3_000)
    turns.permissionSettled('sess-1', 'timeout')
    expect(items().filter(i => i[0] === 'permission')).toEqual([
      ['permission', 'completed', { tool: 'Bash', summary: 'rm -rf dist', outcome: 'allow' }],
      ['permission', 'failed', { tool: 'Write', outcome: 'timeout' }],
    ])
    turns.permissionSettled('sess-unknown', 'allow')
  })
  it('没挂在轮上的卡(重启后先来的权限请求)在终端里答了:之后发问 / 答完 / 结束 / 开机都把它收掉,不一直挂「等你」(Codex 评审 P2)', () => {
    const open = () => log.items(matterId()).filter(i => i.kind === 'permission' && i.status === 'started').length
    turns.permissionAsked({ source: 'claude', session_id: 'sess-1', cwd: '/w', tool_name: 'Bash', summary: 'ls' }, 1_000)
    expect(log.state(matterId())?.state).toBe('waiting')
    turns.event(ev('stop', { text: '好了' }), 2_000)
    expect(open()).toBe(0); expect(log.state(matterId())?.state).toBe('open')
    turns.permissionAsked({ source: 'claude', session_id: 'sess-1', cwd: '/w', tool_name: 'Bash', summary: 'ls' }, 3_000)
    turns.event(ev('prompt'), 4_000)
    expect(open()).toBe(0); expect(log.state(matterId())?.state).toBe('working')
    turns.event(ev('stop'), 4_500)
    turns.permissionAsked({ source: 'claude', session_id: 'sess-1', cwd: '/w', tool_name: 'Bash', summary: 'ls' }, 5_000)
    turns.event(ev('session_end'), 6_000)
    expect(open()).toBe(0); expect(log.state(matterId())?.state).toBe('done')
    turns.permissionAsked({ source: 'claude', session_id: 'sess-9', cwd: '/w', tool_name: 'Bash', summary: 'ls' }, 7_000)
    turns.interruptAll()
    const nine = matters.findBySurface('cli', 'sess-9')!.id
    expect(log.items(nine).map(i => [i.status, i.payload.outcome])).toEqual([['failed', 'daemon_restarted']])
    expect(log.state(nine)?.state).not.toBe('waiting')
  })
  it('没挂在轮上的卡落定以后停在「在做」,又重启 ⇒ 开机把没有在跑的轮的「在做 / 等你」落回 open(Codex 评审第二轮)', () => {
    turns.permissionAsked({ source: 'claude', session_id: 'sess-1', cwd: '/w', tool_name: 'Bash', summary: 'ls' }, 1_000)
    turns.permissionSettled('sess-1', 'allow')
    expect(log.state(matterId())?.state).toBe('working')
    turns.interruptAll()
    expect(log.state(matterId())?.state).toBe('open')
  })
  it('会话结束 ⇒ 还开着的轮记中断、这件事 done;没轮也 done', () => {
    turns.event(ev('prompt'), 1_000)
    turns.event(ev('session_end'), 2_000)
    expect(log.turns(matterId())).toMatchObject([{ status: 'interrupted', errorCode: 'session_end', endedAt: 2_000 }])
    expect(log.state(matterId())?.state).toBe('done')
    turns.event(ev('stop', { session_id: 'sess-2' }), 3_000)
    turns.event(ev('session_end', { session_id: 'sess-2' }), 4_000)
    expect(log.state(matters.findBySurface('cli', 'sess-2')!.id)?.state).toBe('done')
  })
  it('开机 interruptAll:久没动静的终端轮记中断;别的种类不碰', () => {
    turns.event(ev('prompt'), 1_000)
    const task = matters.create({ kind: 'task', title: 't' })
    log.startTurn({ matterId: task.id, executor: 'codex' })
    turns.interruptAll(Date.now() + TERMINAL_QUIET_MS + 60_000)
    expect(log.turns(matterId())).toMatchObject([{ status: 'interrupted', errorCode: 'daemon_restarted' }])
    expect(log.turns(task.id)).toMatchObject([{ status: 'running' }])
  })
  it('开机 interruptAll:最近还有动静的终端轮不收(终端在 daemon 外面跑,重启它照样在做),等它自己的 stop;开着的卡照样收(M4d)', () => {
    turns.event(ev('prompt'), 1_000)
    turns.permissionAsked({ source: 'claude', session_id: 'sess-1', cwd: '/w', tool_name: 'Bash', summary: 'ls' }, 1_500)
    turns.interruptAll(Date.now())
    expect(log.turns(matterId())).toMatchObject([{ status: 'running' }])
    expect(log.items(matterId()).find(i => i.kind === 'permission')).toMatchObject({ status: 'failed', payload: { outcome: 'daemon_restarted' } })
    expect(log.state(matterId())?.state).toBe('working')
    turns.event(ev('stop', { text: '好了' }), 2_000)
    expect(log.turns(matterId())).toMatchObject([{ status: 'completed' }])
  })
})
