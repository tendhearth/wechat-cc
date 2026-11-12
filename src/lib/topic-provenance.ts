/** Read-only, fail-closed provenance shared by extraction and topic readers. */
import { hostname, tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Db } from './db'
export interface TopicSourceContext { owner: string; machine: string; allowWork?: boolean; allowDelegate?: boolean }
/** macOS may append .local / collision numbers without changing the computer. */
export const normalizeTopicMachine = (machine: string): string => machine.trim().toLowerCase().replace(/\.local$/, '').replace(/-\d+$/, '')
export const sameTopicMachine = (machine: string | null | undefined, local: string): boolean => !machine || normalizeTopicMachine(machine) === normalizeTopicMachine(local)
export const localTopicContext = (owner: string): TopicSourceContext => ({ owner, machine: hostname() })
/** Identity comes from the authenticated caller, never the requested chat id. */
export function ownerTopicCaller(owner: string | null, caller?: { tier: string; origin: string; chatId?: string }): boolean {
  return !!owner && caller?.tier === 'admin' && (caller.origin === 'operator' || (caller.origin === 'session' && caller.chatId === owner))
}

/** System scratch paths never authorize project work. */
export function temporary(path: string | null): boolean {
  if (!path) return false
  const p = path.replace(/\\/g, '/')
  if (/^\/(private\/)?var\/folders(?:\/|$)/.test(p) || /\/AppData\/Local\/Temp(?:\/|$)/i.test(p) || /\/wechat-cc-(?:selftest|eval)(?:\/|$)/.test(p)) return true
  return [tmpdir(), '/tmp', '/private/tmp', '/var/tmp'].some(root => {
    const canonical = (s: string) => resolve(s).replace(/^\/private\/(tmp|var)(?=\/|$)/, '/$1')
    const rel = relative(canonical(root), canonical(p))
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  })
}

export function isScratchMatter(title: string, projectPath: string | null): boolean {
  return /^selftest(?:[- :：]*(?:phone|chat|workbench))?$/i.test(title.trim()) || temporary(projectPath)
}

function uncachedTopicMatterAccess(db: Db, context: TopicSourceContext, referenced: readonly string[]) {
  const rows = db.query<{
    id: string; kind: string; title: string; archived_at: number | null; path: string | null
    turnFacts: string; workPaths: string | null; cliFacts: string
  }, [string, string]>(`SELECT m.id,m.kind,m.title,m.archived_at,m.project_path AS path,
    (SELECT json_group_array(json_object('cwd',json_extract(mt.policy_json,'$.cwd'),
      'machine',json_extract(mt.policy_json,'$.machine'),'agent',json_extract(mt.policy_json,'$.originAgent')))
      FROM matter_turns mt WHERE mt.matter_id=m.id) AS turnFacts,
    (SELECT json_array(w.project_path,w.repo_root,w.root) FROM workbench_worktrees w WHERE w.task_id=m.id) AS workPaths,
    (SELECT json_group_array(json_object('cwd',c.cwd,'machine',c.machine,'agent',c.origin_agent))
      FROM matter_bindings b JOIN cli_sessions c ON c.session_id=b.surface_key
      WHERE b.matter_id=m.id AND b.surface='cli') AS cliFacts
    FROM matters m WHERE m.id IN (SELECT value FROM json_each(?1)) AND m.kind IN ('task','terminal','act')
    AND (m.owner_chat_id=?2 OR (m.kind='terminal' AND m.owner_chat_id IS NULL))`).all(JSON.stringify(referenced), context.owner)
  const permitted = rows.filter(m => {
    const facts: {machine?: string; agent?: string}[] = [...JSON.parse(m.turnFacts), ...JSON.parse(m.cliFacts)]
    return facts.every(f => !f.agent && sameTopicMachine(f.machine, context.machine))
  })
  const allowed = new Set(permitted.map(m => m.id))
  const active = new Set(permitted.filter(m => m.archived_at === null).map(m => m.id))
  const entryAllowed = new Set(permitted.filter(m => {
    const facts: {cwd?: string}[] = [...JSON.parse(m.turnFacts), ...JSON.parse(m.cliFacts)]
    const paths = [m.path, ...facts.map(f => f.cwd), ...JSON.parse(m.workPaths ?? '[]')]
      .filter((p): p is string => typeof p === 'string' && !!p)
    // Owner-created task/act may use a scratch workspace with no project path.
    // A terminal with no path still has no project identity; temporary/selftest paths stay excluded.
    return (paths.length > 0 || m.kind === 'act' || m.kind === 'task') && !paths.some(temporary) && !isScratchMatter(m.title, null)
  }).map(m => m.id))
  return { allowed, active, entryAllowed }
}

type EntryOrigin={entryId:string;id:string;topicId:string;source:string;matterId:string|null;status:string;supersededBy:string|null;derived:number;owner:string|null}
function uncachedAllowedTopicEntryIds(db: Db, context: TopicSourceContext, entryIds: readonly string[], includeSuperseded = false): Set<string> {
 const origins=db.query<EntryOrigin,[string]>(`WITH RECURSIVE provenance(entryId,id,derived) AS (
   SELECT value,value,0 FROM json_each(?1)
   UNION
   SELECT p.entryId,e.id,p.derived FROM provenance p JOIN topic_entries e ON e.superseded_by=p.id
   UNION
   SELECT p.entryId,s.source_id,1 FROM provenance p JOIN topic_entry_sources s ON s.entry_id=p.id
  ) SELECT p.entryId,p.id,e.thread_id AS topicId,e.source,e.matter_id AS matterId,e.status,e.superseded_by AS supersededBy,p.derived,t.chat_id AS owner
   FROM provenance p LEFT JOIN topic_entries e ON e.id=p.id LEFT JOIN threads t ON t.id=e.thread_id`).all(JSON.stringify(entryIds))
 const byEntry=new Map<string,EntryOrigin[]>()
 for(const o of origins){const group=byEntry.get(o.entryId)??[];group.push(o);byEntry.set(o.entryId,group)}
 const referenced=[...new Set(origins.flatMap(e=>e.matterId?[e.matterId]:[]))]
 const { entryAllowed } = topicMatterAccess(db, context, referenced)
 return new Set(origins.filter(e => e.entryId === e.id).filter(root => {
  const lineage = byEntry.get(root.id) ?? []
  const merged = new Set(lineage.flatMap(o => o.supersededBy ? [o.supersededBy] : []))
  // A cycle without an original cannot prove any lineage.
  if (!lineage.some(o => !merged.has(o.id))) return false
  return lineage.every(origin => {
   // Only owner-derived memories can survive an explicitly deleted source entry.
   // Missing matter records are different: the original entry itself stays hidden.
   const ownerTombstone = context.allowWork !== false && origin.derived && origin.topicId === null
   if (ownerTombstone) return true
   const sameOwner = origin.owner === context.owner // No cross-owner evidence.
   const sameTopic = !!origin.derived || origin.topicId === root.topicId // Only explicit derivation crosses topics.
   const readerAllowsWork = context.allowWork !== false || (origin.source === 'chat' && !origin.matterId) // Restricted readers get pure chat only.
   const lifecycleAllowed = origin.id === root.id
    ? includeSuperseded || origin.supersededBy === null
    : !!origin.derived || origin.status === 'superseded' // Implicit ancestors must really be merged history.
   const knownSource = ['chat', 'work', 'delegate'].includes(origin.source) // Unknown origins fail closed.
   const delegateAllowed = context.allowDelegate !== false || origin.source !== 'delegate' // Project readers exclude consultations.
   const matterAllowed = origin.matterId
    ? entryAllowed.has(origin.matterId)
    : origin.source !== 'work' || merged.has(origin.id) // Synthetic merged work is supported by its originals.
   return sameOwner && sameTopic && readerAllowsWork && lifecycleAllowed && knownSource && delegateAllowed && matterAllowed
  })
 }).map(e => e.id))
}

/** Invalidated by local writes and commits from other SQLite connections. */
type ProvenanceCache = { token: string; matters: Map<string, {allowed:boolean;active:boolean;entry:boolean}>; entries: Map<string,boolean>; restricted: Map<string,boolean>; live: Map<string,string[]> }
const caches = new WeakMap<Db,ProvenanceCache>()
function provenanceCache(db:Db):ProvenanceCache {
 const row=db.query<{n:number;v:number},[]>('SELECT total_changes() AS n,(SELECT data_version FROM pragma_data_version) AS v').get()!
 const token=`${row.n}:${row.v}`
 let cache=caches.get(db)
 if(db.inTransaction){caches.delete(db);return {token,matters:new Map(),entries:new Map(),restricted:new Map(),live:new Map()}}
 if(!cache||cache.token!==token){cache={token,matters:new Map(),entries:new Map(),restricted:new Map(),live:new Map()};caches.set(db,cache)}
 return cache
}
/** Never retain transaction grants across rollback/savepoint boundaries. Nested,
 * synchronous reads share one cache; no write or await occurs inside this scope.
 * Persistent caches remain conservatively invalidated by any database write.
 * Cold reads must therefore stay batched rather than rely on cache hit rates. */
const reading = new WeakMap<Db, ProvenanceCache>()
function provenanceRead<T>(db: Db, read: (cache: ProvenanceCache) => T): T {
 const current = reading.get(db)
 if (current) return read(current)
 const cache = provenanceCache(db)
 reading.set(db, cache)
 try { return read(cache) } finally { reading.delete(db) }
}
const scopeKey=(context:TopicSourceContext,id:string)=>JSON.stringify([context.owner,context.machine,context.allowWork!==false,context.allowDelegate!==false,id])

export function topicMatterAccess(db:Db,context:TopicSourceContext,ids:readonly string[]) {
 return provenanceRead(db, cache => {
 const missing=[...new Set(ids)].filter(id=>!cache.matters.has(scopeKey(context,id)))
 if(missing.length){
  const result=uncachedTopicMatterAccess(db,context,missing)
  for(const id of missing)cache.matters.set(scopeKey(context,id),{allowed:result.allowed.has(id),active:result.active.has(id),entry:result.entryAllowed.has(id)})
 }
 return {allowed:new Set(ids.filter(id=>cache.matters.get(scopeKey(context,id))?.allowed)),active:new Set(ids.filter(id=>cache.matters.get(scopeKey(context,id))?.active)),entryAllowed:new Set(ids.filter(id=>cache.matters.get(scopeKey(context,id))?.entry))}
 })
}
export function allowedTopicEntryIds(db:Db,context:TopicSourceContext,ids:readonly string[],includeSuperseded=false):Set<string> {
 return provenanceRead(db, cache => {
 const key=(id:string)=>JSON.stringify([context.owner,context.machine,context.allowWork!==false,context.allowDelegate!==false,id,includeSuperseded]),missing=[...new Set(ids)].filter(id=>!cache.entries.has(key(id)))
 if(missing.length){
  const allowed=uncachedAllowedTopicEntryIds(db,context,missing,includeSuperseded)
  for(const id of missing)cache.entries.set(key(id),allowed.has(id))
 }
 return new Set(ids.filter(id=>cache.entries.get(key(id))))
 })
}
/** Current roots inherit their full lineage; superseded history is not a separate root. */
export function restrictedTopicIds(db:Db,context:TopicSourceContext,ids:readonly string[]):Set<string> {
 return provenanceRead(db, cache => {
 const missing=[...new Set(ids)].filter(id=>!cache.restricted.has(scopeKey(context,id)))
 if(missing.length){
  const rows=db.query<{id:string;topicId:string;status:string},[string,string]>(`SELECT e.id,e.thread_id AS topicId,e.status FROM topic_entries e JOIN threads t ON t.id=e.thread_id WHERE t.chat_id=? AND t.id IN (SELECT value FROM json_each(?)) AND e.status!='superseded'`).all(context.owner,JSON.stringify(missing))
  const allowed=allowedTopicEntryIds(db,context,rows.map(e=>e.id),true)
  const byTopic=new Map<string,typeof rows>()
  for(const row of rows){const entries=byTopic.get(row.topicId)??[];entries.push(row);byTopic.set(row.topicId,entries)}
  for(const id of missing){
   const entries=byTopic.get(id)??[]
   cache.restricted.set(scopeKey(context,id),entries.some(e=>!allowed.has(e.id)))
   cache.live.set(scopeKey(context,id),entries.filter(e=>e.status==='live').map(e=>e.id))
  }
 }
 return new Set(ids.filter(id=>cache.restricted.get(scopeKey(context,id))))
 })
}
export function visibleTopicEntryIds(db:Db,context:TopicSourceContext,topic:string):Set<string> {
 return provenanceRead(db, cache => {
 const key=scopeKey(context,topic)
 if(!cache.live.has(key))cache.live.set(key,db.query<{id:string},[string]>("SELECT id FROM topic_entries WHERE thread_id=? AND status='live'").all(topic).map(e=>e.id))
 return allowedTopicEntryIds(db,context,cache.live.get(key)!)
 })
}

/** Restricted readers inherit current entries for cached metadata/existence.
 * Owner metadata stays available; entry authorization still applies separately.
 * Raw records are never changed by this filtered view. */
export function readableTopicMetadata<T extends {id:string;title:string;summary:string;description?:string}>(db:Db,context:TopicSourceContext,rows:T[]):T[] {
 // Owner names and aliases remain usable even when one work entry cannot be proven.
 if (context.allowWork !== false) return rows
 const restricted=restrictedTopicIds(db,context,rows.map(t=>t.id))
 if(!restricted.size)return rows
 const originals=db.query<{id:string;topicId:string},[string]>(`SELECT id,thread_id AS topicId FROM topic_entries WHERE thread_id IN (SELECT value FROM json_each(?)) AND status!='superseded'`).all(JSON.stringify([...restricted]))
 const allowed=allowedTopicEntryIds(db,context,originals.map(e=>e.id),true)
 const visible=new Set(originals.filter(e=>allowed.has(e.id)).map(e=>e.topicId))
 return rows.filter(t=>!restricted.has(t.id)||visible.has(t.id)).map(t=>restricted.has(t.id)?{...t,title:'',summary:'',description:'',aliases:[],tags:[],facets:[],episodes:[]}:t)
}
