/** Read only. SQL selects metadata and existing topic index lines, never message/permission bodies. */
import { hostname } from 'node:os'
import type { Db } from '../../lib/db'
import { makeThreadsStore } from '../../lib/threads-store'
import { temporary, topicMatterAccess, allowedTopicEntryIds, localTopicContext } from '../../lib/topic-provenance'
import { makeProjectTopicResolver, projectIdentity } from '../terminal'
import { projectActivities, stepLabel } from './project-activity'
import type { MatterSeen } from '../../adapters/store/matter-seen'
import type { ProjectTaskActivitySource } from '../../ports/topic-activity'
import { activityWindow, summarizeProjectsActivity, type ProjectsActivityQueryT, type ProjectActivityEvidenceT } from '../../domain/projects-activity'

type Deps={db:Db;owner:string;now?:()=>number;identify?:typeof projectIdentity;seen?:MatterSeen;taskActivity?:ProjectTaskActivitySource;executorName?:(id:string)=>string}
type Turn={id:string;matterId:string;kind:'task'|'terminal';cwd:string|null;executor:string;status:string;started:number;ended:number|null;code:string|null;eventAt:number|null;last:string|null;project:string|null;repo:string|null;root:string|null}
export async function readProjectsActivity(d:Deps,query:ProjectsActivityQueryT){
 const {db,owner}=d,now=d.now?.()??Date.now(),window=activityWindow(query,now),start=Number.isFinite(window.start)?window.start:0
 const topics=await makeThreadsStore(db, { filterSources: true }).list(owner)
 const evidence=new Map<string,ProjectActivityEvidenceT>(topics.filter(t=>!t.private).map(t=>[t.id,{id:t.id,title:t.title,aliases:t.aliases,private:false,entries:[],history:[],current:[]}]))
 const current=await projectActivities(db,owner,d.seen,d.identify,d.taskActivity,d.executorName)
 const codes=new Map(db.query<{id:string;code:string},[]>("SELECT matter_id AS id,substr(surface_key,1,6) AS code FROM matter_bindings WHERE surface='cli'").all().map(r=>[r.id,r.code]))
 for(const [id,value]of current){const p=evidence.get(id);if(p)p.current=value.sessions.map(s=>({id:s.id,kind:s.kind,executor:s.executor,activity:s.activity,latestStep:s.latestStep,updatedAt:s.updatedAt,...(s.kind==='terminal'&&codes.has(s.id)?{code:codes.get(s.id)!}:{})}))}
 const rows=db.query<Turn,[string,string,number,number]>(`SELECT t.id,t.matter_id AS matterId,m.kind,t.executor,t.status,t.started_at AS started,t.ended_at AS ended,
   CASE WHEN m.kind='terminal' THEN json_extract(t.policy_json,'$.cwd') ELSE COALESCE(json_extract(t.policy_json,'$.cwd'),m.project_path) END AS cwd,
   wt.project_path AS project,wt.repo_root AS repo,wt.root,substr(b.surface_key,1,6) AS code,
   (SELECT MAX(i.updated_at) FROM matter_items i WHERE i.turn_id=t.id AND i.updated_at>=?3 AND i.updated_at<?4) AS eventAt,
   (SELECT json_object('kind',i.kind,'tool',COALESCE(json_extract(i.payload_json,'$.tool'),json_extract(i.payload_json,'$.toolName')),
    'verb',json_extract(i.payload_json,'$.verb'),'type',json_extract(i.payload_json,'$.activity.type'),'status',i.status,
    'file',CASE WHEN json_extract(i.payload_json,'$.verb') IN ('read','edit','write','delete') THEN json_extract(i.payload_json,'$.target') END,
    'at',i.updated_at) FROM matter_items i WHERE i.turn_id=t.id AND i.kind IN ('tool_call','system','error')
      AND i.updated_at>=?3 AND i.updated_at<?4 ORDER BY i.updated_at DESC,i.seq DESC LIMIT 1) AS last
  FROM matter_turns t JOIN matters m ON m.id=t.matter_id
  LEFT JOIN matter_bindings b ON b.matter_id=m.id AND b.surface='cli'
  LEFT JOIN cli_sessions c ON c.session_id=b.surface_key
  LEFT JOIN workbench_worktrees wt ON wt.task_id=m.id
  WHERE m.kind IN ('task','terminal') AND (m.owner_chat_id=?1 OR (m.kind='terminal' AND m.owner_chat_id IS NULL))
   AND (m.kind!='terminal' OR (COALESCE(c.origin_agent,'')='' AND COALESCE(c.machine,'') IN ('',?2)
    AND NOT EXISTS(SELECT 1 FROM matter_turns mt WHERE mt.matter_id=m.id AND (
     COALESCE(json_extract(mt.policy_json,'$.originAgent'),'')!='' OR COALESCE(json_extract(mt.policy_json,'$.machine'),'') NOT IN ('',?2)))))
   AND ((t.started_at>=?3 AND t.started_at<?4) OR (t.ended_at>=?3 AND t.ended_at<?4)
    OR EXISTS(SELECT 1 FROM matter_items i WHERE i.turn_id=t.id AND i.updated_at>=?3 AND i.updated_at<?4))
  ORDER BY MAX(t.started_at,COALESCE(t.ended_at,0)) DESC,t.id`).all(owner,hostname(),start,window.end)
 const resolve=makeProjectTopicResolver(db,owner,topics.map(t=>({id:t.id,title:t.title,aliases:t.aliases,tags:[],summary:'',lastActive:t.lastActive,entries:[]})),d.identify,rows.map(r=>r.cwd).filter((p):p is string=>!!p),{includeDoneHistory:true})
 const historicalMatters=new Map<string,string>()
 for(const r of rows){
  if(!r.cwd||temporary(r.cwd))continue
  // Task worktree facts may confirm a root, but conflicting roots never merge.
  const paths=r.kind==='task'?[...new Set([r.cwd,r.project,r.repo,r.root].filter((p):p is string=>!!p))]:[r.cwd]
  if(paths.some(temporary))continue
  const mapped=await Promise.all(paths.map(resolve)),ids=new Set(mapped.map(m=>m.topicId).filter(Boolean))
  if(mapped.some(m=>m.reason==='ambiguous')||ids.size!==1||!mapped[0]?.topicId)continue
  const p=evidence.get(mapped[0].topicId)
  if(!p)continue
  const last=r.last?JSON.parse(r.last):null
  const ended=r.ended!==null&&r.ended>=start&&r.ended<window.end
  const at=Math.max(r.started>=start&&r.started<window.end?r.started:0,ended?r.ended!:0,last?.at??0,r.eventAt??0)
  const step=ended?(r.status==='completed'?'答完了':r.status==='failed'?'执行失败':r.status==='cancelled'?'已取消':'执行中断'):stepLabel(last)||(r.started>=start?'开始执行':'有执行记录')
  historicalMatters.set(r.id,r.matterId)
  p.history!.push({id:r.id,kind:r.kind,executor:r.executor??'',...(r.code?{code:r.code}:{}),at,step})
 }
 const entries=db.query<{id:string;topicId:string;kind:'decision'|'progress'|'conclusion';line:string;status:'live'|'done';at:number;source:string;matterId:string|null},[string,number,number]>(`SELECT e.id,e.thread_id AS topicId,e.kind,e.line,e.status,e.source,e.matter_id AS matterId,CAST((julianday(e.updated_ts)-2440587.5)*86400000+0.5 AS INTEGER) AS at
  FROM topic_entries e JOIN threads t ON t.id=e.thread_id WHERE t.chat_id=?1 AND t.private=0
   AND e.kind IN ('decision','progress','conclusion') AND e.status IN ('live','done')
   AND julianday(e.updated_ts)>=julianday(?2/1000.0,'unixepoch') AND julianday(e.updated_ts)<julianday(?3/1000.0,'unixepoch')
  ORDER BY julianday(e.updated_ts) DESC,e.id`).all(owner,start,window.end)
 // No await between this authorization snapshot and rendering: privacy/owner changes
 // during filesystem identity reads must not publish the earlier topic snapshot.
 const visible=new Set(db.query<{id:string},[string]>('SELECT id FROM threads WHERE chat_id=? AND private=0').all(owner).map(t=>t.id))
 // Consolidation drops matter_id and mixed groups become chat. Walk every original,
 // including superseded rows outside the requested window, in this same final snapshot.
 const referenced=[...new Set([...entries.flatMap(e=>e.matterId?[e.matterId]:[]),...historicalMatters.values(),...[...evidence.values()].flatMap(p=>p.current?.map(s=>s.id)??[])])]
 const {allowed,active}=topicMatterAccess(db,localTopicContext(owner),referenced)
 const entryIds=allowedTopicEntryIds(db,localTopicContext(owner),entries.map(e=>e.id))
 for(const e of entries){
  if(!entryIds.has(e.id))continue
  evidence.get(e.topicId)?.entries!.push({id:e.id,kind:e.kind,line:e.line,status:e.status,updatedAt:e.at})
 }
 const safe=[...evidence.values()].filter(p=>visible.has(p.id)).map(p=>({...p,
  current:p.current?.filter(s=>active.has(s.id)),history:p.history?.filter(h=>allowed.has(historicalMatters.get(h.id)??''))}))
 const result=summarizeProjectsActivity(query,safe,now)
 return result
}
