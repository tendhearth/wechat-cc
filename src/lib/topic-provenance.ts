/** Read-only, fail-closed provenance shared by extraction and topic readers. */
import { hostname, tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Db } from './db'
export interface TopicSourceContext { owner: string; machine: string }
export const localTopicContext = (owner: string): TopicSourceContext => ({ owner, machine: hostname() })

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
 const permitted=db.query<{id:string;title:string;archived_at:number|null;path:string|null;turnPaths:string;workPaths:string|null;currentCwd:string|null},[string,string,string]>(`SELECT m.id,m.title,m.archived_at,m.project_path AS path,
   (SELECT json_group_array(json_extract(mt.policy_json,'$.cwd')) FROM matter_turns mt WHERE mt.matter_id=m.id) AS turnPaths,
   (SELECT json_array(w.project_path,w.repo_root,w.root) FROM workbench_worktrees w WHERE w.task_id=m.id) AS workPaths,
   (SELECT c.cwd FROM matter_bindings b JOIN cli_sessions c ON c.session_id=b.surface_key WHERE b.matter_id=m.id AND b.surface='cli') AS currentCwd
   FROM matters m
  WHERE m.id IN (SELECT value FROM json_each(?1)) AND m.kind IN ('task','terminal','act')
   AND (m.owner_chat_id=?2 OR (m.kind='terminal' AND m.owner_chat_id IS NULL))
   AND (
    NOT EXISTS(SELECT 1 FROM matter_bindings b JOIN cli_sessions c ON c.session_id=b.surface_key WHERE b.matter_id=m.id AND b.surface='cli'
     AND (COALESCE(c.origin_agent,'')!='' OR COALESCE(c.machine,'') NOT IN ('',?3)))
    AND NOT EXISTS(SELECT 1 FROM matter_turns mt WHERE mt.matter_id=m.id AND (
     COALESCE(json_extract(mt.policy_json,'$.originAgent'),'')!='' OR COALESCE(json_extract(mt.policy_json,'$.machine'),'') NOT IN ('',?3))))`).all(JSON.stringify(referenced),context.owner,context.machine)
 const allowed=new Set(permitted.map(m=>m.id)),active=new Set(permitted.filter(m=>m.archived_at===null).map(m=>m.id))
 // Work summaries inherit their linked matter's privacy/provenance boundary too.
 const entryAllowed=new Set(permitted.filter(m=>{
  const paths=[m.path,m.currentCwd,...JSON.parse(m.turnPaths),...JSON.parse(m.workPaths??'[]')].filter((p):p is string=>typeof p==='string'&&!!p)
  return paths.length>0&&!paths.some(temporary)&&!isScratchMatter(m.title,null)
 }).map(m=>m.id))
 return { allowed, active, entryAllowed }
}

type EntryOrigin={entryId:string;id:string;topicId:string;source:string;matterId:string|null;status:string;supersededBy:string|null}
function uncachedAllowedTopicEntryIds(db: Db, context: TopicSourceContext, entryIds: readonly string[], includeSuperseded = false): Set<string> {
 const origins=db.query<EntryOrigin,[string]>(`WITH RECURSIVE provenance(entryId,id) AS (
   SELECT value,value FROM json_each(?1)
   UNION
   SELECT p.entryId,e.id FROM provenance p JOIN topic_entries e ON e.superseded_by=p.id
  ) SELECT p.entryId,e.id,e.thread_id AS topicId,e.source,e.matter_id AS matterId,e.status,e.superseded_by AS supersededBy
   FROM provenance p JOIN topic_entries e ON e.id=p.id`).all(JSON.stringify(entryIds))
 const byEntry=new Map<string,EntryOrigin[]>()
 for(const o of origins){const group=byEntry.get(o.entryId)??[];group.push(o);byEntry.set(o.entryId,group)}
 const referenced=[...new Set(origins.flatMap(e=>e.matterId?[e.matterId]:[]))]
 const { entryAllowed } = topicMatterAccess(db, context, referenced)
 return new Set(origins.filter(e=>e.entryId===e.id).filter(e=>{
  const lineage=byEntry.get(e.id)??[],merged=new Set(lineage.flatMap(o=>o.supersededBy?[o.supersededBy]:[]))
  // Only synthetic nodes may lack a work matter. Any unprovable original hides
  // the whole group; chat/work mixtures inherit the same intersection of access.
  if(!lineage.some(o=>!merged.has(o.id))||lineage.some(o=>
   o.topicId!==e.topicId||(o.id===e.id?!includeSuperseded&&o.supersededBy!==null:o.status!=='superseded')||
   (o.source!=='chat'&&o.source!=='work')||
   (o.matterId?!entryAllowed.has(o.matterId):o.source==='work'&&!merged.has(o.id))))return false
  return true
 }).map(e=>e.id))
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
const scopeKey=(context:TopicSourceContext,id:string)=>JSON.stringify([context.owner,context.machine,id])

export function topicMatterAccess(db:Db,context:TopicSourceContext,ids:readonly string[]) {
 const cache=provenanceCache(db),missing=[...new Set(ids)].filter(id=>!cache.matters.has(scopeKey(context,id)))
 if(missing.length){
  const result=uncachedTopicMatterAccess(db,context,missing)
  for(const id of missing)cache.matters.set(scopeKey(context,id),{allowed:result.allowed.has(id),active:result.active.has(id),entry:result.entryAllowed.has(id)})
 }
 return {allowed:new Set(ids.filter(id=>cache.matters.get(scopeKey(context,id))?.allowed)),active:new Set(ids.filter(id=>cache.matters.get(scopeKey(context,id))?.active)),entryAllowed:new Set(ids.filter(id=>cache.matters.get(scopeKey(context,id))?.entry))}
}
export function allowedTopicEntryIds(db:Db,context:TopicSourceContext,ids:readonly string[],includeSuperseded=false):Set<string> {
 const cache=provenanceCache(db),key=(id:string)=>JSON.stringify([context.owner,context.machine,id,includeSuperseded]),missing=[...new Set(ids)].filter(id=>!cache.entries.has(key(id)))
 if(missing.length){
  const allowed=uncachedAllowedTopicEntryIds(db,context,missing,includeSuperseded)
  for(const id of missing)cache.entries.set(key(id),allowed.has(id))
 }
 return new Set(ids.filter(id=>cache.entries.get(key(id))))
}
/** Cached text inherits all originals, including superseded rows without successors. */
export function restrictedTopicIds(db:Db,context:TopicSourceContext,ids:readonly string[]):Set<string> {
 const cache=provenanceCache(db),missing=[...new Set(ids)].filter(id=>!cache.restricted.has(scopeKey(context,id)))
 if(missing.length){
  const rows=db.query<{id:string;topicId:string;status:string},[string,string]>(`SELECT e.id,e.thread_id AS topicId,e.status FROM topic_entries e JOIN threads t ON t.id=e.thread_id WHERE t.chat_id=? AND t.id IN (SELECT value FROM json_each(?))`).all(context.owner,JSON.stringify(missing))
  const allowed=allowedTopicEntryIds(db,context,rows.map(e=>e.id),true)
  for(const id of missing){
   const entries=rows.filter(e=>e.topicId===id)
   cache.restricted.set(scopeKey(context,id),entries.some(e=>!allowed.has(e.id)))
   cache.live.set(scopeKey(context,id),entries.filter(e=>e.status==='live').map(e=>e.id))
  }
 }
 return new Set(ids.filter(id=>cache.restricted.get(scopeKey(context,id))))
}
export function visibleTopicEntryIds(db:Db,context:TopicSourceContext,topic:string):Set<string> {
 const cache=provenanceCache(db),key=scopeKey(context,topic)
 if(!cache.live.has(key))cache.live.set(key,db.query<{id:string},[string]>("SELECT id FROM topic_entries WHERE thread_id=? AND status='live'").all(topic).map(e=>e.id))
 return allowedTopicEntryIds(db,context,cache.live.get(key)!)
}
