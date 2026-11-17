import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { RosterResponseT } from '@wechat-cc/protocol'
import { buildRoster, type RosterPending } from '../../domain/roster'
import { phoneMayOpenMatter } from '../../domain/matters/phone-scope'
import type { MatterStore } from '../../ports/matters'
import type { CliSessionView } from '../../ports/cli-session'
import type { MatterSeen } from '../../adapters/store/matter-seen'

export interface RosterReaderDeps {
  matters: Pick<MatterStore, 'list'>
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
    // 翻页读完整名单;store 每页最多 500,不能让长期积累的历史挤掉活着的事。
    const all: ReturnType<MatterStore['list']> = []
    let before: {at:number;id:string} | undefined
    for (;;) {
      const page = deps.matters.list({limit:500,...(before ? {before} : {})})
      all.push(...page)
      if (page.length < 500) break
      const last = page.at(-1)!
      before = {at:last.updatedAt,id:last.id}
    }
    const visible = all.filter(m => scope !== 'device' || phoneMayOpenMatter(m, null))
    const excluded = new Set(all.filter(m => !visible.includes(m)).map(m => m.id))
    const matters = visible.filter(m => (m.kind === 'task' || m.kind === 'terminal') && m.archivedAt == null)
      .map(m => ({...m,project:m.projectPath ? basename(m.projectPath) : undefined,
        agentNames: Object.fromEntries((m.agents ?? []).map(id => [id,deps.executorName?.(id) ?? m.agentNames?.[id] ?? id]))}))
    const tasks = new Map<string, {status:string;phase?:string}>()
    const pending = new Map<string,RosterPending[]>()
    const wb = deps.workbench
    if (wb) {
      for (const t of wb.list({archived:'exclude',limit:500}).tasks) tasks.set(t.id,{status:t.status,phase:t.phase})
      for (const t of wb.attention().tasks) {
        try {
          const d = wb.detail(t.id)
          pending.set(t.id,[
            ...d.permissions.map(p => ({kind:'permission' as const,id:p.id,summary:`${p.tool}: ${p.description}`,since:p.createdAt})),
            ...d.questions.map(q => ({kind:'question' as const,id:q.id,summary:q.questions[0]?.question ?? '',since:q.createdAt})),
          ])
        } catch { tasks.delete(t.id) } // 刚被清掉:这件事按 matter 自己判,其余照常。
      }
    }
    const relays = new Map<string,NonNullable<ReturnType<NonNullable<RosterReaderDeps['relay']>>>>()
    for (const m of matters) { const relay = deps.relay?.(m.id); if (relay) relays.set(m.id,relay) }
    // 挂在被筛掉 / 归档的事下的会话也不单列。
    const hidden = new Set(all.filter(m => !matters.some(v => v.id === m.id)).map(m => m.id))
    const terminals = deps.terminals().filter(t => !t.matter_id || (!excluded.has(t.matter_id) && !hidden.has(t.matter_id)))
      .map(t => ({session_id:t.session_id,code:t.code,source:t.source,status:t.status,
        project:basename(t.project),last_summary:t.last_summary,last_event_at:t.last_event_at,
        ...(t.matter_id?{matter_id:t.matter_id}:{}),pending:t.pending?{since:t.pending.since}:null,
        ...(deps.executorName ? {displayName:deps.executorName(t.source)} : {})}))
    const items = buildRoster({matters,tasks,pending,relays,terminals,seen:deps.seen,now:deps.now?.() ?? Date.now()})
    const version = createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0,16)
    return {items,version}
  } }
}
