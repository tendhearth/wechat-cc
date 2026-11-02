import type { AgentActivity } from '../../ports/agent-provider'
import type { TurnUsage } from '../../domain/turn-usage'
import type { ChatTurnHandle, ChatTurnLog } from '../../ports/chat-turns'
import type { MatterItemStatus, MatterLog, MatterStore } from '../../ports/matters'
import type { Db } from '../../lib/db'

/**
 * chat-turns.ts —— 对话的一轮 → 这件对话的 matter_turns / matter_items(M3a)。只经 MatterLog 写。
 * 一轮:executor = provider,policy 记 alias(开的时候)和 mode(收的时候);结局 completed → completed,其余(超时 / 认证 / 出错)→ failed。
 * 步:每个工具调用一步(同一个 activity id 的 started → completed 合成一行;没有 activity 的只记名字);送达一步;出错一步。
 * 主人那句、CC 的回复这两步要引 messages 的 id,id 还没传到协调器,M3b 补。
 */
const LABEL_MAX = 200, DETAIL_MAX = 2000, ERROR_MAX = 2000
const statusOf = (a: AgentActivity): MatterItemStatus => a.status === 'running' ? 'started' : a.status === 'completed' ? 'completed' : 'failed'
const activityPayload = (a: AgentActivity) => ({
  id: a.id, type: a.type, status: a.status, label: a.label.slice(0, LABEL_MAX),
  ...(a.detail ? { detail: a.detail.slice(0, DETAIL_MAX) } : {}), ...(a.parentId ? { parentId: a.parentId } : {}),
})

export function makeChatTurnLog(deps: { db: Db; log: MatterLog; matters: Pick<MatterStore, 'findChat'> }): ChatTurnLog {
  const { db, log, matters } = deps
  return {
    begin({ chatId, provider, alias }) {
      const matter = matters.findChat(chatId)
      if (!matter) return null
      const turn = log.startTurn({ matterId: matter.id, executor: provider, policy: { alias } })
      let usage: TurnUsage | null = null, sessionId: string | null = null, ended = false, plain = 0
      const handle: ChatTurnHandle = {
        event(ev) {
          if (ended) return
          if (ev.kind === 'tool_call') {
            const tool = ev.server ? `${ev.server}/${ev.tool}` : ev.tool
            if (ev.activity) log.writeItem({ matterId: matter.id, turnId: turn.id, kind: 'tool_call', status: statusOf(ev.activity), key: `${turn.id}:${ev.activity.id}`, payload: { tool, activity: activityPayload(ev.activity) } })
            else log.writeItem({ matterId: matter.id, turnId: turn.id, kind: 'tool_call', status: 'completed', key: `${turn.id}:plain:${++plain}`, payload: { tool } })
          } else if (ev.kind === 'result') {
            if (ev.usage) usage = ev.usage
            if (ev.sessionId) sessionId = ev.sessionId
          } else if (ev.kind === 'init' && ev.sessionId) sessionId = ev.sessionId
        },
        end(r) {
          if (ended) return
          ended = true
          log.updateTurn(turn.id, { policy: { alias, mode: r.mode } })
          if (r.report) log.writeItem({ matterId: matter.id, turnId: turn.id, kind: 'delivery', status: 'completed', payload: { delivery: r.report.delivery, bubbles: r.report.bubbles, attachments: r.report.attachmentsSent } })
          if (r.outcome !== 'completed' && (r.error || r.errorCode)) log.writeItem({ matterId: matter.id, turnId: turn.id, kind: 'error', status: 'completed', payload: { text: (r.error ?? '').slice(0, ERROR_MAX), ...(r.errorCode ? { code: r.errorCode } : {}), outcome: r.outcome } })
          log.finishTurn(turn.id, { status: r.outcome === 'completed' ? 'completed' : 'failed', errorCode: r.outcome === 'completed' ? null : (r.errorCode ?? r.outcome), usage, nativeSessionId: sessionId })
        },
      }
      return handle
    },
    interruptAll() {
      for (const t of db.query<{ id: string }, []>("SELECT t.id FROM matter_turns t JOIN matters m ON m.id=t.matter_id WHERE m.kind='chat' AND t.status='running' ORDER BY t.cursor").all())
        log.finishTurn(t.id, { status: 'interrupted', errorCode: 'daemon_restarted' })
    },
  }
}
