import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { RosterResponseT } from '@wechat-cc/protocol'
import { buildRoster, ROSTER_BACK_WINDOW_MS, type RosterPending } from '../../domain/roster'
import { phoneMayOpenMatter } from '../../domain/matters/phone-scope'
import type { MatterStore } from '../../ports/matters'
import type { CliSessionView } from '../../ports/cli-session'
import type { MatterSeen } from '../../adapters/store/matter-seen'

export interface RosterReaderDeps {
  matters: Pick<MatterStore, 'list'> & Partial<Pick<MatterStore, 'get'>>
  workbench?: {
    list(query: {archived:'exclude';limit:number}): {tasks:Array<{id:string;status:string;phase?:string}>}
    attention(): {tasks:Array<{id:string}>}
    detail(id:string): {
      permissions:Array<{id:string;tool:string;description:string;createdAt:number}>
      questions:Array<{id:string;questions:Array<{question:string}>;createdAt:number}>
    }
  }
  terminals: () => CliSessionView[]
  seen: MatterSeen
  relay?: (matterId: string) => { index: number; total: number; currentAgent: string } | null
  executorName?: (id: string) => string
  now?: () => number
}
export function makeRosterReader(deps: RosterReaderDeps) {
  return { read(scope: 'operator' | 'device'): RosterResponseT {
    const now = deps.now?.() ?? Date.now()
    const wb = deps.workbench
    const attention = wb ? wb.attention().tasks.map(t => t.id) : []
    const sessions = deps.terminals()
    // 只读可能进名单的那几份,不翻全部历史(桌面每 3 秒拉一次):没完的(open / working / waiting,不论多旧)+ 24 小时内动过的;
    // 等你的任务和挂着活会话的终端事不论多旧也要在,按 id 补。
    const byId = new Map<string, ReturnType<MatterStore['list']>[number]>()
    const add = (ms: ReturnType<MatterStore['list']>) => { for (const m of ms) byId.set(m.id, m) }
    for (const kind of ['task', 'terminal'] as const) {
      for (const state of ['open', 'working', 'waiting'] as const) add(deps.matters.list({kind,state,limit:500}))
      add(deps.matters.list({kind,since:now - ROSTER_BACK_WINDOW_MS,limit:500}))
    }
    for (const id of [...attention, ...sessions.flatMap(t => t.matter_id ? [t.matter_id] : [])]) {
      if (byId.has(id)) continue
      const m = deps.matters.get?.(id)
      if (m) add([m])
    }
    const all = [...byId.values()]
    const visible = all.filter(m => scope !== 'device' || phoneMayOpenMatter(m, null))
    const matters = visible.filter(m => (m.kind === 'task' || m.kind === 'terminal') && m.archivedAt == null)
      .map(m => ({...m,project:m.projectPath ? basename(m.projectPath) : undefined,
        agentNames: Object.fromEntries((m.agents ?? []).map(id => [id,deps.executorName?.(id) ?? m.agentNames?.[id] ?? id]))}))
    const shown = new Set(matters.map(m => m.id))
    const tasks = new Map<string, {status:string;phase?:string}>()
    const pending = new Map<string,RosterPending[]>()
    if (wb) {
      for (const t of wb.list({archived:'exclude',limit:500}).tasks) tasks.set(t.id,{status:t.status,phase:t.phase})
      for (const id of attention) {
        try {
          const d = wb.detail(id)
          pending.set(id,[
            ...d.permissions.map(p => ({kind:'permission' as const,id:p.id,summary:`${p.tool}: ${p.description}`,since:p.createdAt})),
            ...d.questions.map(q => ({kind:'question' as const,id:q.id,summary:q.questions[0]?.question ?? '',since:q.createdAt})),
          ])
        } catch { tasks.delete(id) } // 刚被清掉:这件事按 matter 自己判,其余照常。
      }
    }
    const relays = new Map<string,NonNullable<ReturnType<NonNullable<RosterReaderDeps['relay']>>>>()
    for (const m of matters) { const relay = deps.relay?.(m.id); if (relay) relays.set(m.id,relay) }
    // 挂在被筛掉 / 归档的事下的会话也不单列;那件事查不到(被删了)⇒ 当没挂的会话列。
    const terminals = sessions.filter(t => !t.matter_id || shown.has(t.matter_id) || !byId.has(t.matter_id))
      .map(t => ({session_id:t.session_id,code:t.code,source:t.source,status:t.status,
        project:basename(t.project),last_summary:t.last_summary,last_event_at:t.last_event_at,
        ...(t.matter_id?{matter_id:t.matter_id}:{}),pending:t.pending?{since:t.pending.since}:null,
        ...(deps.executorName ? {displayName:deps.executorName(t.source)} : {})}))
    const items = buildRoster({matters,tasks,pending,relays,terminals,seen:deps.seen,now})
    const version = createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0,16)
    return {items,version}
  } }
}
