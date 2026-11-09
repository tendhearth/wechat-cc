/** Owner-scoped project activity. No transcript/body reads, writes, CLI store pruning or model calls. */
import { redactIdentifiers } from '../../lib/redact-identifiers'
import { hostname } from 'node:os'
import type { Db } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeMatterSeen, type MatterSeen } from '../../adapters/store/matter-seen'
import { makeProjectTopicResolver, projectIdentity } from '../terminal'
import { temporary } from '../../lib/topic-bubbles'
import { effectiveStatus } from '../../domain/cli-session-view'
import type { MatchTopic } from '../../domain/topic-match'
import type { TopicSessionT } from '../../../packages/protocol/src/topic-bubbles'
import type { ProjectActivity, ProjectTaskActivitySource } from '../../ports/topic-activity'
export type { ProjectActivity } from '../../ports/topic-activity'

export async function projectActivities(db: Db, owner: string, seen: MatterSeen = makeMatterSeen(db), identify = projectIdentity, taskActivity?: ProjectTaskActivitySource): Promise<Map<string, ProjectActivity>> {
  const topics: MatchTopic[] = (await makeThreadsStore(db).list(owner)).filter(t => !t.private && t.status !== 'done')
    .map(t => ({ id: t.id, title: t.title, aliases: t.aliases, tags: [], summary: '', lastActive:t.lastActive, entries: [] }))
  const resolve = makeProjectTopicResolver(db, owner, topics, identify)
  const paths = new Map<string, ReturnType<typeof resolve>>()
  const mapped = (path: string) => {
    if (!paths.has(path)) paths.set(path, resolve(path))
    return paths.get(path)!
  }
  type Row = { id: string; kind: 'task'|'terminal'; title: string; state: string; updated_at: number; project_path: string|null; session_id: string|null; cwd: string|null; last_event_at:number|null; executor: string|null; project: string|null; repo: string|null; root: string|null; turn_status: string|null; ended_at: number|null; policy_cwd: string|null }
  const query = db.query<Row, [string,string,string]>(`SELECT m.id,m.kind,m.title,m.state,m.updated_at,m.project_path,
    c.session_id,c.cwd,c.last_event_at,COALESCE(t.executor,c.source,w.provider_id) AS executor,t.status AS turn_status,t.ended_at,
    json_extract(t.policy_json,'$.cwd') AS policy_cwd,wt.project_path AS project,wt.repo_root AS repo,wt.root
    FROM matters m
    LEFT JOIN matter_bindings b ON b.matter_id=m.id AND b.surface='cli'
    LEFT JOIN cli_sessions c ON c.session_id=b.surface_key
    LEFT JOIN workbench_tasks w ON w.id=m.id
    LEFT JOIN workbench_worktrees wt ON wt.task_id=w.id
    LEFT JOIN matter_turns t ON t.id=(SELECT id FROM matter_turns WHERE matter_id=m.id ORDER BY seq DESC LIMIT 1)
    WHERE m.kind IN ('task','terminal') AND m.archived_at IS NULL
      AND (m.owner_chat_id=?1 OR (m.kind='terminal' AND m.owner_chat_id IS NULL))
      AND (m.kind!='terminal' OR (
        (c.origin_agent IS NULL OR c.origin_agent='') AND (c.machine IS NULL OR c.machine='' OR c.machine=?2)
        AND NOT EXISTS(SELECT 1 FROM matter_turns mt WHERE mt.matter_id=m.id AND (
          COALESCE(json_extract(mt.policy_json,'$.originAgent'),'')!='' OR COALESCE(json_extract(mt.policy_json,'$.machine'),'') NOT IN ('',?3)))
        AND (c.session_id IS NOT NULL OR json_type(t.policy_json,'$.cwd')='text')))
    ORDER BY m.updated_at DESC,m.id`)
  const rows = () => query.all(owner,hostname(),hostname())
  const pathsOf = (m:Row) => [...new Set([m.project_path,m.cwd,m.policy_cwd,m.project,m.repo,m.root].filter((p): p is string => !!p))]
  const mappings = new Map<string,{topicId:string;paths:string}>()
  await Promise.all(rows().map(async m => {
    const candidates=pathsOf(m)
    if(!candidates.length||candidates.some(temporary))return
    const resolved=await Promise.all(candidates.map(mapped))
    if(resolved.some(r=>r.reason==='ambiguous'))return
    const ids=new Set(resolved.map(r=>r.topicId).filter((id):id is string=>!!id))
    if(ids.size===1)mappings.set(m.id,{topicId:[...ids][0]!,paths:JSON.stringify(candidates)})
  }))
  const out = new Map<string, ProjectActivity>()
  // Re-read live facts after filesystem work, then project synchronously. A changed
  // project path must be resolved by the next change signal rather than guessed.
  for (const m of rows()) {
    const mapping=mappings.get(m.id)
    if(!mapping||mapping.paths!==JSON.stringify(pathsOf(m)))continue
    const id = mapping.topicId
    const entry = out.get(id) ?? { activity: { running: 0, waiting: 0, unread: 0, lastActiveAt: null }, sessions: [] }
    if (entry.sessions.some(s => s.id === m.id)) continue
    const pending = db.query<{ kind: string; item_key: string|null; at: number; label: string|null },[string]>(`SELECT kind,item_key,updated_at AS at,
      substr(COALESCE(json_extract(payload_json,'$.summary'),json_extract(payload_json,'$.description'),json_extract(payload_json,'$.questions[0].question'),json_extract(payload_json,'$.tool'),json_extract(payload_json,'$.toolName'),json_extract(payload_json,'$.title'),json_extract(payload_json,'$.label')),1,100) AS label
      FROM matter_items WHERE matter_id=? AND kind IN ('permission','question') AND status='started' ORDER BY seq DESC LIMIT 1`).get(m.id)
    const last = db.query<{ label: string|null; at: number },[string]>(`SELECT substr(COALESCE(CASE WHEN kind='tool_call' AND json_extract(payload_json,'$.kind')='step' THEN json_extract(payload_json,'$.text') END,json_extract(payload_json,'$.activity.label'),json_extract(payload_json,'$.summary'),json_extract(payload_json,'$.label'),json_extract(payload_json,'$.title'),json_extract(payload_json,'$.toolName'),json_extract(payload_json,'$.tool')),1,140) AS label,updated_at AS at
      FROM matter_items WHERE matter_id=? AND kind IN ('tool_call','system','error') AND COALESCE(item_key,'') NOT LIKE 'ready:%' ORDER BY seq DESC LIMIT 1`).get(m.id)
    const runtime=m.kind==='task'?taskActivity?.(m.id):null
    // Compare seen to the response/turn boundary, never a later heartbeat or a detail read.
    const response = db.query<{ at: number },[string]>("SELECT updated_at AS at FROM matter_items WHERE matter_id=? AND kind='agent_message' AND status='completed' ORDER BY seq DESC LIMIT 1").get(m.id)
    const terminal = ['done','failed','cancelled'].includes(m.state)
    const answeredAt = Math.max(m.ended_at ?? 0,response?.at ?? 0)
    const unseen = !seen(m.id, terminal ? Math.max(answeredAt,m.updated_at) : answeredAt)
    const stale=m.kind==='terminal'&&effectiveStatus({status:pending||m.state==='waiting'?'waiting':m.state==='working'?'running':'idle',last_event_at:m.last_event_at??m.updated_at},Date.now()).stale
    const status: TopicSessionT['activity'] = stale ? 'idle' : runtime?.requestId || pending || m.state === 'waiting' ? 'waiting'
      : terminal && unseen ? 'unread'
      : runtime?.phase==='replied' ? (unseen?'waiting':'idle')
      : m.state === 'working' || runtime?.phase==='working' ? 'running'
      : answeredAt > 0 && unseen ? 'waiting' : 'idle'
    const updatedAt = Math.max(m.updated_at,pending?.at ?? 0,last?.at ?? 0)
    const tool = pending && db.query<{tool:string|null},[string]>("SELECT json_extract(payload_json,'$.tool') AS tool FROM matter_items WHERE matter_id=? AND kind='permission' AND status='started' ORDER BY seq DESC LIMIT 1").get(m.id)?.tool
    const latestStep = stale ? '会话久未更新' : runtime?.requestId ? runtime.waitingFor||'等你回应'
      : pending ? `${pending.kind === 'permission' ? '等你批准' : '等你回答'}${tool ? ` · ${tool}` : ''}${pending.label && pending.label!==tool ? ` · ${pending.label}` : ''}`
      : status === 'waiting' ? '已答复，等你看' : status === 'unread' ? '做完未看' : last?.label || (status === 'running' ? '正在执行' : '已看过')
    entry.sessions.push({ id:m.id, kind:m.kind, title:m.title.slice(0,160), executor:m.executor ?? '', activity:status, latestStep:redactIdentifiers(latestStep), updatedAt,
      requestId: m.kind === 'task' ? runtime?.requestId ?? pending?.item_key ?? null : null })
    if (status !== 'idle') entry.activity[status]++
    entry.activity.lastActiveAt = Math.max(entry.activity.lastActiveAt ?? 0,updatedAt)
    out.set(id,entry)
  }
  const rank = (s: TopicSessionT) => s.activity === 'waiting' ? 0 : s.activity === 'running' ? 1 : s.activity === 'unread' ? 2 : 3
  for (const value of out.values()) value.sessions.sort((a,b) => rank(a)-rank(b) || b.updatedAt-a.updatedAt || a.id.localeCompare(b.id))
  return out
}
