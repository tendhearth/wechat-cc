import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { RosterResponseT } from '@wechat-cc/protocol'
import { buildRoster, ROSTER_BACK_WINDOW_MS, type RosterInput, type RosterPending } from '../../domain/roster'
import { phoneMayOpenMatter } from '../../domain/matters/phone-scope'
import type { MatterStore } from '../../ports/matters'
import type { CliSessionView } from '../../ports/cli-session'
import type { MatterSeen } from '../../adapters/store/matter-seen'

export interface RosterReaderDeps {
  matters: Pick<MatterStore, 'list'> & Partial<Pick<MatterStore, 'get'>>
  workbench?: {
    list(query: {archived:'exclude';limit:number;cursor?:string}): {tasks:Array<{id:string;status:string;phase?:string}>;page?:{nextCursor:string|null}}
    attention(): {tasks:Array<{id:string}>}
    detail(id:string): {
      permissions:Array<{id:string;tool:string;description:string;createdAt:number}>
      questions:Array<{id:string;questions:Array<{question:string}>;createdAt:number}>
    }
  }
  terminals: (options?: { includeEnded?: boolean }) => CliSessionView[]
  seen: MatterSeen
  relay?: (matterId: string) => { index: number; total: number; currentAgent: string } | null
  executorName?: (id: string) => string
  now?: () => number
}
type MatterRow = ReturnType<MatterStore['list']>[number]

export interface RosterGathered {
  input: Omit<RosterInput, 'seen' | 'now' | 'backWindowMs'>
  /** 进了名单的事,原样(带完整 projectPath / originMessageId)。 */
  matters: Map<string, MatterRow>
  /** 终端会话,原样(project 是完整 cwd)。 */
  sessions: Map<string, CliSessionView>
}

/** 工作台列表接口的页上限(`listFilters` 里那条 `limit>100`);没归档的任务最多翻这么多页。 */
const TASK_PAGE = 100, TASK_PAGES_MAX = 20

/** 名单要的那几份数据;`windowMs` 管「带回来的」往回看多远(名单 24 小时,地方更长)。 */
export function gatherRoster(deps: RosterReaderDeps, scope: 'operator' | 'device', now: number, windowMs: number, includeEnded = false): RosterGathered {
  const wb = deps.workbench
  const attention = wb ? wb.attention().tasks.map(t => t.id) : []
  const sessions = includeEnded ? deps.terminals({ includeEnded }) : deps.terminals()
  // 只读可能进名单的那几份,不翻全部历史(桌面每 3 秒拉一次):没完的(open / working / waiting,不论多旧)+ 窗口内动过的;
  // 等你的任务和挂着活会话的终端事不论多旧也要在,按 id 补。
  const byId = new Map<string, MatterRow>()
  const add = (ms: MatterRow[]) => { for (const m of ms) byId.set(m.id, m) }
  for (const kind of ['task', 'terminal'] as const) {
    for (const state of ['open', 'working', 'waiting'] as const) add(deps.matters.list({kind,state,limit:500}))
    add(deps.matters.list({kind,since:now - windowMs,limit:500}))
  }
  for (const id of [...attention, ...sessions.flatMap(t => t.matter_id ? [t.matter_id] : [])]) {
    if (byId.has(id)) continue
    const m = deps.matters.get?.(id)
    if (m) add([m])
  }
  const all = [...byId.values()]
  const visible = all.filter(m => scope !== 'device' || phoneMayOpenMatter(m, null))
  const kept = visible.filter(m => (m.kind === 'task' || m.kind === 'terminal') && m.archivedAt == null)
  const matters = kept.map(m => ({...m,project:m.projectPath ? basename(m.projectPath) : undefined,
      agentNames: Object.fromEntries((m.agents ?? []).map(id => [id,deps.executorName?.(id) ?? m.agentNames?.[id] ?? id]))}))
  const shown = new Set(matters.map(m => m.id))
  const tasks = new Map<string, {status:string;phase?:string}>()
  const pending = new Map<string,RosterPending[]>()
  if (wb) {
    // 工作台的列表一页最多 TASK_PAGE 件,多要会直接抛错(真机上名单因此整个读不出来过);按页翻。
    let cursor: string | undefined
    for (let n = 0; n < TASK_PAGES_MAX; n++) {
      const page = wb.list({archived:'exclude',limit:TASK_PAGE,...(cursor ? {cursor} : {})})
      for (const t of page.tasks) tasks.set(t.id,{status:t.status,phase:t.phase})
      cursor = page.page?.nextCursor ?? undefined
      if (!cursor) break
    }
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
  const liveSessions = sessions.filter(t => !t.matter_id || shown.has(t.matter_id) || !byId.has(t.matter_id))
  const terminals = liveSessions.map(t => ({session_id:t.session_id,code:t.code,source:t.source,status:t.status,
      project:basename(t.project),last_summary:t.last_summary,last_event_at:t.last_event_at,
      ...(t.matter_id?{matter_id:t.matter_id}:{}),pending:t.pending?{since:t.pending.since}:null,
      ...(deps.executorName ? {displayName:deps.executorName(t.source)} : {})}))
  return {
    input: {matters,tasks,pending,relays,terminals},
    matters: new Map(kept.map(m => [m.id, m])),
    sessions: new Map(liveSessions.map(t => [t.session_id, t])),
  }
}

export function makeRosterReader(deps: RosterReaderDeps) {
  return { read(scope: 'operator' | 'device'): RosterResponseT {
    const now = deps.now?.() ?? Date.now()
    const {input} = gatherRoster(deps, scope, now, ROSTER_BACK_WINDOW_MS)
    const items = buildRoster({...input,seen:deps.seen,now})
    const version = createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0,16)
    return {items,version}
  } }
}
