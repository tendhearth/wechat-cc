import { topicMatterAccess, localTopicContext } from '../../lib/topic-provenance'
/** Owner-scoped metadata only. Never select permission bodies, commands, diffs or output. */
import { executorNames } from '../../domain/provider-display-names'
import type { Db } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeMatterSeen, type MatterSeen } from '../../adapters/store/matter-seen'
import { matterFeed } from '../../adapters/store/matter-feed'
import { onWriteHint } from '../../lib/write-hints'
import { makeProjectTopicResolver, projectIdentity, boundedProjectIdentity } from '../terminal'
import { temporary, topicRevision } from '../../lib/topic-bubbles'
import { CLI_SESSION_STALE_MS } from '../../domain/cli-session-view'
import type { MatchTopic } from '../../domain/topic-match'
import type { TopicSessionT } from '../../../packages/protocol/src/topic-bubbles'
import type { ProjectActivity, ProjectTaskActivitySource } from '../../ports/topic-activity'
export type { ProjectActivity } from '../../ports/topic-activity'

const defaultName = (id:string) => executorNames(id).name
const defaultSeen = new WeakMap<Db,MatterSeen>()
export function projectSeen(db:Db):MatterSeen {
  let seen=defaultSeen.get(db)
  if(!seen){seen=makeMatterSeen(db);defaultSeen.set(db,seen)}
  return seen
}
// Only schema fields enter the SQL projection. In particular activity.label and
// terminal text/target for commands/searches are not safe cross-project metadata.
const META = `json_object('kind',kind,'tool',COALESCE(json_extract(payload_json,'$.tool'),json_extract(payload_json,'$.toolName')),
  'verb',json_extract(payload_json,'$.verb'),'type',json_extract(payload_json,'$.activity.type'),'status',status,
  'file',CASE WHEN json_extract(payload_json,'$.verb') IN ('read','edit','write','delete') THEN json_extract(payload_json,'$.target') END,
  'key',item_key,'at',updated_at)`
type Meta = {kind:string;tool:string|null;verb:string|null;type:string|null;status:string;file:string|null;key:string|null;at:number}
type Row = {id:string;kind:'task'|'terminal';title:string;state:string;updated_at:number;project_path:string|null;cwd:string|null;last_event_at:number|null;executor:string|null;project:string|null;repo:string|null;root:string|null;turn_status:string|null;ended_at:number|null;policy_cwd:string|null;pending:string|null;last:string|null;response_at:number|null}
function readRows(db:Db,owner:string,ids?:string[]):Row[] {
  const rows=db.query<Row,[string,string]>(`SELECT m.id,m.kind,m.title,m.state,m.updated_at,m.project_path,
    c.cwd,c.last_event_at,COALESCE(t.executor,c.source,w.provider_id) AS executor,t.status AS turn_status,t.ended_at,
    json_extract(t.policy_json,'$.cwd') AS policy_cwd,wt.project_path AS project,wt.repo_root AS repo,wt.root,
    (SELECT ${META} FROM matter_items WHERE matter_id=m.id AND kind IN ('permission','question') AND status='started' ORDER BY seq DESC LIMIT 1) AS pending,
    (SELECT ${META} FROM matter_items WHERE matter_id=m.id AND kind IN ('tool_call','system','error') AND COALESCE(item_key,'') NOT LIKE 'ready:%' ORDER BY seq DESC LIMIT 1) AS last,
    (SELECT updated_at FROM matter_items WHERE matter_id=m.id AND kind='agent_message' AND status='completed' ORDER BY seq DESC LIMIT 1) AS response_at
    FROM matters m
    LEFT JOIN matter_bindings b ON b.matter_id=m.id AND b.surface='cli'
    LEFT JOIN cli_sessions c ON c.session_id=b.surface_key
    LEFT JOIN workbench_tasks w ON w.id=m.id
    LEFT JOIN workbench_worktrees wt ON wt.task_id=w.id
    LEFT JOIN matter_turns t ON t.id=(SELECT id FROM matter_turns WHERE matter_id=m.id ORDER BY seq DESC LIMIT 1)
    WHERE m.kind IN ('task','terminal') AND m.archived_at IS NULL
      AND (m.owner_chat_id=?1 OR (m.kind='terminal' AND m.owner_chat_id IS NULL))
      AND (m.kind!='terminal' OR c.session_id IS NOT NULL OR json_type(t.policy_json,'$.cwd')='text')
      ${ids?'AND m.id IN (SELECT value FROM json_each(?2))':'AND ?2 IS NOT NULL'}
    ORDER BY m.updated_at DESC,m.id`).all(owner,JSON.stringify(ids??[]))
  const allowed=topicMatterAccess(db,localTopicContext(owner),rows.map(m=>m.id)).entryAllowed
  return rows.filter(m=>allowed.has(m.id))
}
// Fixed vocabulary + a validated tool identifier. Free-form descriptions never cross this boundary.
const toolName = (tool:string|null|undefined) => tool && /^[\w.:-]{1,80}$/.test(tool) ? tool : ''
const verbs:Record<string,string>={run:'运行命令',read:'读取文件',edit:'修改文件',write:'写入文件',delete:'删除文件',search:'搜索',find:'查找文件',subtask:'子任务',web:'浏览网页',websearch:'搜索网页',todo:'更新清单',todos:'更新清单',plan:'更新计划',tend:'照看子任务',tool:'使用工具',bgoutput:'读取命令结果',command:'运行命令',file_change:'修改文件',agent:'子任务'}
export function stepLabel(last:Meta|null):string {
  if(!last)return ''
  if(last.kind==='error')return '步骤失败'
  const verb=last.verb??last.type??'',tool=toolName(last.tool)
  const action=verbs[verb]||(tool?`使用工具 · ${tool}`:last.kind==='tool_call'?'工具步骤':'状态更新')
  // target is a filename only for structured file operations; never use a command's target.
  const file=last.file?.replace(/\\/g,'/').split('/').pop()
  return `${action}${file&&/^[\p{L}\p{N}_. -]{1,100}$/u.test(file)?` · ${file}`:''}${last.status==='failed'?' · 失败':''}`
}
const rank=(s:TopicSessionT)=>s.activity==='waiting'?0:s.activity==='running'?1:s.activity==='unread'?2:3
const digests=new WeakMap<ProjectActivity,string>()
export const projectActivityRevision=(a:ProjectActivity)=>digests.get(a)??topicRevision(a)
const token=(db:Db)=>{
  const r=db.query<{n:number;v:number},[]>('SELECT total_changes() AS n,(SELECT data_version FROM pragma_data_version) AS v').get()!
  return `${r.n}:${r.v}`
}
const IDENTITY_TTL=60_000
interface Cache {
  seen:MatterSeen;identify:typeof projectIdentity;source?:ProjectTaskActivitySource;name:(id:string)=>string
  dispose():void
  read():Promise<Map<string,ProjectActivity>>
}
const caches=new WeakMap<Db,Map<string,Cache[]>>()
function createCache(db:Db,owner:string,seen:MatterSeen,identify:typeof projectIdentity,source:ProjectTaskActivitySource|undefined,name:(id:string)=>string):Cache {
  let rows=new Map<string,Row>(),mapped=new Map<string,string>(),groups=new Map<string,Map<string,TopicSessionT>>()
  const membership=new Map<string,string>()
  let seenVersion=seen.version?.(),minExpiry=Infinity
  let result=new Map<string,ProjectActivity>(),resolve:ReturnType<typeof makeProjectTopicResolver>|undefined
  let full=true,mappingDirty=true,signalled=false,stamp='',identityAt=0,busy:Promise<Map<string,ProjectActivity>>|undefined
  const dirty=new Set<string>(),expiry=new Map<string,number>()
  const offFeed=matterFeed(db).onChange(id=>{dirty.add(id);signalled=true})
  const offHints=onWriteHint(db,h=>{
    signalled=true
    if(h.kind==='matter')dirty.add(h.matterId)
    else if(h.kind==='topics'&&h.chatId===owner&&h.mapping!==false)mappingDirty=true
  })
  const pathsOf=(m:Row)=>m.kind==='terminal'?[...new Set([m.cwd||m.policy_cwd||m.project_path,m.policy_cwd].filter((p):p is string=>!!p))]:[...new Set([m.project_path,m.project,m.repo,m.root].filter((p):p is string=>!!p))]
  const signature=(m:Row)=>JSON.stringify(pathsOf(m))
  async function compute():Promise<Map<string,ProjectActivity>> {
    // Feed/hints flush before checking the O(1) SQLite token, including same-stack writes.
    await Promise.resolve()
    const now=Date.now(),current=token(db)
    if(stamp&&(stamp.split(':')[1]!==current.split(':')[1]||(stamp!==current&&!signalled)))full=true // raw/external writers fail closed
    signalled=false
    const nextSeen=seen.version?.()
    if(nextSeen!==seenVersion)for(const id of rows.keys())dirty.add(id)
    seenVersion=nextSeen
    if(now-identityAt>=IDENTITY_TTL){full=true;mappingDirty=true}
    if(now>minExpiry){minExpiry=Infinity;for(const [id,at] of expiry){if(now>at){dirty.add(id);expiry.delete(id)}else minExpiry=Math.min(minExpiry,at)}}
    if(!full&&!mappingDirty&&!dirty.size){stamp=current;return result}
    const ids=full?undefined:[...dirty];dirty.clear()
    const updates=readRows(db,owner,ids),previous=full?rows:new Map((ids??[]).flatMap(id=>rows.has(id)?[[id,rows.get(id)!] as const]:[]))
    rows=full?new Map():rows
    if(ids)for(const id of ids)rows.delete(id)
    for(const m of updates){rows.set(m.id,m);if(!previous.has(m.id)||signature(previous.get(m.id)!)!==signature(m))mappingDirty=true}
    if(ids?.some(id=>previous.has(id)&&!rows.has(id)))mappingDirty=true
    let changed=ids??[...new Set([...previous.keys(),...rows.keys()])]
    if(full||mappingDirty){
      mappingDirty=false
      const topics:MatchTopic[]=(await makeThreadsStore(db, { filterSources: true }).list(owner)).filter(t=>!t.private&&t.status!=='done').map(t=>({id:t.id,title:t.title,aliases:t.aliases,tags:[],summary:'',lastActive:t.lastActive,entries:[]}))
      // Filesystem facts are cached across ordinary pushes/pages. A new cwd or
      // changed provenance re-registers all names before any mapping is accepted.
      const identities=new Map<string,ReturnType<typeof identify>>()
      const identifyOnce=(path:string)=>{
        if(!identities.has(path))identities.set(path,boundedProjectIdentity(identify,path))
        return identities.get(path)!
      }
      resolve=makeProjectTopicResolver(db,owner,topics,identifyOnce,[...rows.values()].flatMap(pathsOf))
      const next=new Map<string,string>()
      await Promise.all([...rows.values()].map(async m=>{
        const paths=pathsOf(m)
        if(!paths.length||paths.some(temporary))return
        const identities=await Promise.all(paths.map(identifyOnce))
        if(new Set(identities.filter(i=>!!i).map(i=>i!.key)).size>1)return
        const values=await Promise.all(paths.map(resolve!))
        // Current terminal cwd must itself resolve, including no_match/private/done.
        if(values.some(v=>v.reason==='ambiguous')||(m.kind==='terminal'&&!values[0]?.topicId))return
        const topics=new Set(values.map(v=>v.topicId).filter((v):v is string=>!!v))
        if(topics.size===1)next.set(m.id,[...topics][0]!)
      }))
      mapped=next;changed=[...new Set([...membership.keys(),...rows.keys()])];identityAt=now
    }
    full=false
    const affected=new Set<string>()
    // Each update removes/replaces one member; only affected project groups sort/hash.
    for(const id of changed){
      const oldTopic=membership.get(id)
      if(oldTopic){groups.get(oldTopic)?.delete(id);affected.add(oldTopic);membership.delete(id)}
      expiry.delete(id)
      const m=rows.get(id),topic=mapped.get(id)
      if(!m||!topic)continue
      const pending:Meta|null=m.pending?JSON.parse(m.pending):null,last:Meta|null=m.last?JSON.parse(m.last):null
      const runtime=m.kind==='task'?source?.(id):null
      const terminal=['done','failed','cancelled'].includes(m.state),answeredAt=Math.max(m.ended_at??0,m.response_at??0)
      const unseen=m.kind==='task'&&!seen(id,terminal?Math.max(answeredAt,m.updated_at):answeredAt)
      // Attention requires an actual unresolved request. A reply in the owner's
      // terminal is already visible there; only CC task results use seen.
      const waiting=!!(runtime?.requestId||pending)
      const stale=m.kind==='terminal'&&m.state==='working'&&!waiting&&now-(m.last_event_at??m.updated_at)>CLI_SESSION_STALE_MS
      const running=runtime?runtime.phase==='working':m.state==='working'&&m.turn_status==='running'
      const activity:TopicSessionT['activity']=waiting?'waiting':stale||runtime?.phase==='queued'?'idle':running?'running'
        :m.kind==='task'&&unseen&&(terminal||runtime?.phase==='replied'||answeredAt>0)?'unread':'idle'
      const requestKind=runtime?.requestKind??pending?.kind,tool=toolName(runtime?.tool??pending?.tool)
      const latestStep=waiting?(requestKind==='permission'?`等你批准${tool?` · ${tool}`:''}`:requestKind==='question'?'等你回答':'等你回应')
        :stale?'会话久未更新':runtime?.phase==='queued'?'排队中':activity==='unread'?'做完未看'
        :m.kind==='terminal'&&activity==='idle'&&(m.turn_status==='completed'||!m.turn_status&&m.response_at)?'答完了':stepLabel(last)||(activity==='running'?'正在执行':'暂无新步骤')
      const session:TopicSessionT={id,kind:m.kind,title:m.title.slice(0,160),executor:m.executor??'',displayName:name(m.executor??''),activity,latestStep,updatedAt:Math.max(m.updated_at,pending?.at??0,last?.at??0),requestId:m.kind==='task'?runtime?.requestId??pending?.key??null:null}
      const members=groups.get(topic)??new Map();members.set(id,session);groups.set(topic,members);membership.set(id,topic);affected.add(topic)
      if(m.kind==='terminal'&&!waiting&&!stale&&m.state==='working'){const at=(m.last_event_at??m.updated_at)+CLI_SESSION_STALE_MS;expiry.set(id,at);minExpiry=Math.min(minExpiry,at)}
    }
    if(affected.size){
      result=new Map(result)
      for(const topic of affected){
        const sessions=[...(groups.get(topic)?.values()??[])].sort((a,b)=>rank(a)-rank(b)||b.updatedAt-a.updatedAt||a.id.localeCompare(b.id))
        if(!sessions.length){groups.delete(topic);result.delete(topic);continue}
        const value:ProjectActivity={activity:{running:0,waiting:0,unread:0,lastActiveAt:null},sessions}
        for(const s of sessions){if(s.activity!=='idle')value.activity[s.activity]++;value.activity.lastActiveAt=Math.max(value.activity.lastActiveAt??0,s.updatedAt)}
        digests.set(value,topicRevision(value));result.set(topic,value)
      }
    }
    stamp=current
    // Writes that landed while identities were resolving are not cached as current.
    if(token(db)!==current||dirty.size||mappingDirty)return compute()
    return result
  }
  return {seen,identify,source,name,dispose(){offFeed();offHints()},read(){return busy??=(compute().finally(()=>{busy=undefined}))}}
}
export async function projectActivities(db:Db,owner:string,seen:MatterSeen=projectSeen(db),identify=projectIdentity,taskActivity?:ProjectTaskActivitySource,executorName=defaultName):Promise<Map<string,ProjectActivity>> {
  let owners=caches.get(db);if(!owners){owners=new Map();caches.set(db,owners)}
  const list=owners.get(owner)??[]
  let cache=list.find(c=>c.seen===seen&&c.identify===identify&&c.source===taskActivity&&c.name===executorName)
  if(!cache){cache=createCache(db,owner,seen,identify,taskActivity,executorName);list.push(cache);if(list.length>8)list.shift()!.dispose();owners.set(owner,list)}
  return cache.read()
}
