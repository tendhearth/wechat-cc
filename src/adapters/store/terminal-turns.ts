import { basename } from 'node:path'
import type { Db } from '../../lib/db'
import type { MatterLog, MatterStore } from '../../ports/matters'
import type { TerminalEventIn, TerminalTurnLog } from '../../ports/terminal-turns'

/**
 * terminal-turns.ts —— 终端会话 → 一件 kind='terminal' 的事(M4a)。只经 MatterLog 写。
 * - 第一次看到一个 session_id ⇒ 建这件事(标题 = 项目名,出生地 cli)并绑 surface='cli'。
 * - prompt(主人敲的)⇒ 有轮在跑就记进那一轮,没有就开一轮(executor = source);写一步 user_message(原文 M4b 从 transcript 补)。
 * - stop ⇒ 一步 agent_message(最后一句)+ 收这一轮;permission ⇒ 一步 permission(started ⇒ 等你);session_end ⇒ 收尾、这件事 done。
 * 记录会读进步的会话(ev.transcribed,M4b):发问 / 最后一句不在这里写,从记录来(features/terminal/terminal-steps.ts)。
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
  /**
   * 收掉这件事里所有还开着的卡(不论挂没挂在轮上)。没挂在轮上的那种(重启后先来的权限请求)在终端里答了就没有
   * 落定回调,不收就一直挂「等你」(Codex 评审)。发问 / 答完 ⇒ 已经答过了(completed,结果不知道);结束 / 开机 ⇒ failed。
   */
  const closeCards = (matterId: string, status: 'completed' | 'failed', outcome: string) => {
    for (const r of db.query<{ item_key: string }, [string]>("SELECT item_key FROM matter_items WHERE matter_id=? AND kind='permission' AND status='started' AND item_key IS NOT NULL ORDER BY seq").all(matterId))
      log.writeItem({ matterId, kind: 'permission', status, key: r.item_key, payload: { ...(log.item(matterId, r.item_key)?.payload ?? {}), outcome } })
  }
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
          closeCards(matterId, 'completed', 'answered_in_terminal')
          const id = turnId ?? log.startTurn({ matterId, executor: ev.source, startedAt: at, policy: { cwd: ev.cwd, ...(ev.machine ? { machine: ev.machine } : {}), ...(ev.origin_agent ? { originAgent: ev.origin_agent } : {}) } }).id
          if (!ev.transcribed) log.writeItem({ matterId, turnId: id, kind: 'user_message', status: 'completed', payload: {} })
          return
        }
        case 'stop':
          closeCards(matterId, 'completed', 'answered_in_terminal')
          if (ev.text && !ev.transcribed) log.writeItem({ matterId, ...(turnId ? { turnId } : {}), kind: 'agent_message', status: 'completed', payload: { text: ev.text.slice(0, TEXT_MAX) } })
          if (turnId) log.finishTurn(turnId, { status: 'completed', endedAt: at })
          else log.setState(matterId, 'open')
          return
        case 'permission':
          ask(matterId, 'permission', ev.text, at)
          return
        case 'session_end':
          closeCards(matterId, 'failed', 'session_end')
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
      // 开着的卡:权限码只在内存里,重启就作废了 ⇒ 一律收掉;这件事回到 open(上面已经没有在跑的轮)
      for (const m of db.query<{ id: string }, []>("SELECT DISTINCT i.matter_id AS id FROM matter_items i JOIN matters m ON m.id=i.matter_id WHERE m.kind='terminal' AND i.kind='permission' AND i.status='started'").all()) {
        closeCards(m.id, 'failed', 'daemon_restarted')
        log.setState(m.id, 'open')
      }
      // 没有在跑的轮却还显示「在做 / 等你」的(没挂在轮上的卡落定后停在在做,又重启了):落回 open(Codex 评审第二轮)。
      // 上一次进程里在做的事,这一次谁也不知道它还在不在做 —— 下一个钩子事件会把它推回该在的地方。
      for (const m of db.query<{ id: string }, []>("SELECT m.id FROM matters m WHERE m.kind='terminal' AND m.state IN ('working','waiting') AND NOT EXISTS (SELECT 1 FROM matter_turns t WHERE t.matter_id=m.id AND t.status='running')").all())
        log.setState(m.id, 'open')
    },
  }
}
