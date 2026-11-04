import { describe, expect, it } from 'vitest'
import { openTestDb } from '../lib/db'
import { makeCliEventHub } from './cli-events'
import { makeCliSessionStore } from '../adapters/store/cli-session-store'
import { makeMatterStore } from '../adapters/store/matters-store'
import { makeMatterLog } from '../adapters/store/matter-log'
import { makeTerminalTurnLog } from '../adapters/store/terminal-turns'
import type { TerminalTurnLog } from '../ports/terminal-turns'

/** 终端会话的钩子事件经登记处同时写进这件事(M4a):并行写,登记处照旧;写轮出错不影响登记处与推送。 */
function rig(turnsOverride?: TerminalTurnLog) {
  const db = openTestDb(), logs: string[] = []
  const matters = makeMatterStore(db), log = makeMatterLog(db)
  const turns = turnsOverride ?? makeTerminalTurnLog({ db, log, matters })
  const store = makeCliSessionStore(db)
  const hub = makeCliEventHub({ send: async () => 'sent', projectName: c => c.split('/').pop() ?? c, log: (t, l) => logs.push(`${t} ${l}`), store, turns, now: () => 1_000 })
  return { db, hub, store, matters, log, logs }
}
const base = { source: 'claude' as const, session_id: 'sess-1', cwd: '/w/blog' }

describe('cli-events × 终端的轮与步(M4a)', () => {
  it('发问 → 要权限 → 放行 → 答完:登记处与这件事的轮 / 步一路对得上', () => {
    const r = rig()
    r.hub.observe({ ...base, kind: 'prompt' })
    r.hub.permissionAsked({ ...base, tool_name: 'Bash', summary: 'npm test' })
    const id = r.matters.findBySurface('cli', 'sess-1')!.id
    expect(r.store.get('sess-1')?.status).toBe('waiting')
    expect(r.log.state(id)?.state).toBe('waiting')
    r.hub.permissionSettled('sess-1', 'allow')
    expect(r.store.get('sess-1')?.status).toBe('running')
    expect(r.log.state(id)?.state).toBe('working')
    r.hub.observe({ ...base, kind: 'stop', text: '测试全过' })
    expect(r.store.get('sess-1')?.status).toBe('idle')
    expect(r.log.turns(id)).toMatchObject([{ status: 'completed' }])
    expect(r.log.items(id).map(i => [i.kind, i.status])).toEqual([['user_message', 'completed'], ['permission', 'completed'], ['agent_message', 'completed']])
  })
  it('写轮抛错:登记处照写(指针与最近一次发问),只记一行日志;没建上那件事 ⇒ 读时当歇着(M4d 第 2 步,登记处没有状态列)', () => {
    const boom = () => { throw new Error('disk full') }
    const r = rig({ event: boom, permissionAsked: boom, permissionSettled: boom, ensure: boom, interruptAll: () => {} })
    r.hub.observe({ ...base, kind: 'prompt' })
    expect(r.store.get('sess-1')).toMatchObject({ cwd: '/w/blog', last_event_at: 1_000, last_prompt_at: 1_000, status: 'idle', last_summary: null, pending_tool: null })
    expect(r.logs.some(l => l.startsWith('CLI_TURNS turn prompt'))).toBe(true)
  })
})
