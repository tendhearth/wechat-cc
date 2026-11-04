import { basename } from 'node:path'
import type { Db } from '../../lib/db'
import type { MatterLog, MatterStore } from '../../ports/matters'
import type { TerminalEventIn, TerminalTurnLog } from '../../ports/terminal-turns'

/**
 * terminal-turns.ts —— 终端会话 → 一件 kind='terminal' 的事(M4a)。只经 MatterLog 写。
 * - 第一次看到一个 session_id ⇒ 建这件事(标题 = 项目名,出生地 cli)并绑 surface='cli'。
 * - prompt(主人敲的)⇒ 有轮在跑就记进那一轮,没有就开一轮(executor = source);写一步 user_message(原文 M4b 从 transcript 补)。
 * - stop ⇒ 一步 agent_message(最后一句)+ 收这一轮;permission ⇒ 一步 permission(started ⇒ 等你);session_end ⇒ 收尾、这件事 done。
 * 「在跑的那一轮」从库里查(不在内存记):重启后照样接得上。
 */
const TEXT_MAX = 2000, SUMMARY_MAX = 300
export function makeTerminalTurnLog(deps: { db: Db; log: MatterLog; matters: Pick<MatterStore, 'create' | 'bind' | 'findBySurface'> }): TerminalTurnLog {
  const { db, log, matters } = deps
  const matterOf = (ev: { session_id: string; cwd: string; source: string; origin_agent?: string; machine?: string }) => {
    const found = matters.findBySurface('cli', ev.session_id)
    if (found) return found.id
    const title = (ev.cwd && basename(ev.cwd)) || ev.source
    const m = matters.create({ kind: 'terminal', title, projectPath: ev.cwd || null, origin: 'cli' })
    matters.bind(m.id, 'cli', ev.session_id)
    return m.id
  }
  const runningTurn = (matterId: string) => db.query<{ id: string }, [string]>("SELECT id FROM matter_turns WHERE matter_id=? AND status='running' ORDER BY seq DESC LIMIT 1").get(matterId)?.id ?? null
  const openCard = (matterId: string) => db.query<{ item_key: string }, [string]>("SELECT item_key FROM matter_items WHERE matter_id=? AND kind='permission' AND status='started' AND item_key IS NOT NULL ORDER BY seq DESC LIMIT 1").get(matterId)?.item_key ?? null
  const ask = (matterId: string, tool: string, summary: string | null | undefined, at: number) => {
    if (openCard(matterId)) return
    const turnId = runningTurn(matterId)
    log.writeItem({ matterId, ...(turnId ? { turnId } : {}), kind: 'permission', status: 'started', key: `perm:${at}`, payload: { tool, ...(summary ? { summary: summary.slice(0, SUMMARY_MAX) } : {}) } })
  }
  return {
    event(ev, at) {
      const matterId = matterOf(ev)
      const turnId = runningTurn(matterId)
      switch (ev.kind) {
        case 'prompt': {
          if (ev.automated) return
          const id = turnId ?? log.startTurn({ matterId, executor: ev.source, startedAt: at, policy: { cwd: ev.cwd, ...(ev.machine ? { machine: ev.machine } : {}), ...(ev.origin_agent ? { originAgent: ev.origin_agent } : {}) } }).id
          log.writeItem({ matterId, turnId: id, kind: 'user_message', status: 'completed', payload: {} })
          return
        }
        case 'stop':
          if (ev.text) log.writeItem({ matterId, ...(turnId ? { turnId } : {}), kind: 'agent_message', status: 'completed', payload: { text: ev.text.slice(0, TEXT_MAX) } })
          if (turnId) log.finishTurn(turnId, { status: 'completed', endedAt: at })
          return
        case 'permission':
          ask(matterId, 'permission', ev.text, at)
          return
        case 'session_end':
          if (turnId) log.finishTurn(turnId, { status: 'interrupted', errorCode: 'session_end', endedAt: at, matterState: 'done' })
          else log.setState(matterId, 'done')
          return
      }
    },
    permissionAsked(req, at) {
      ask(matterOf(req), req.tool_name, req.summary, at)
    },
    permissionSettled(sessionId, status) {
      const m = matters.findBySurface('cli', sessionId)
      if (!m) return
      const key = openCard(m.id)
      if (!key) return
      log.writeItem({ matterId: m.id, kind: 'permission', status: status === 'allow' ? 'completed' : 'failed', key, payload: { ...(log.item(m.id, key)?.payload ?? {}), outcome: status } })
    },
    interruptAll() {
      for (const t of db.query<{ id: string }, []>("SELECT t.id FROM matter_turns t JOIN matters m ON m.id=t.matter_id WHERE m.kind='terminal' AND t.status='running' ORDER BY t.cursor").all())
        log.finishTurn(t.id, { status: 'interrupted', errorCode: 'daemon_restarted' })
    },
  }
}
