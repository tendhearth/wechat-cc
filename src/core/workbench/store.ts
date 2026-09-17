import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {StoredHandoff,HandoffView} from './handoff-record'
import {publicSource,type StoredNativeSource} from './native-adoption'
import type {NativeHistoryMessage} from './native-history'
import type { Db } from '../../lib/db'
import {makeLiveInputStore} from './live-inputs'
import {makeTaskAttachmentStore} from './attachments'
import {makeExecutionSettingsStore,NATIVE_EXECUTION_CHOICE} from './execution-settings'
import {makeControlReceiptStore} from './control-receipts'
import {makeCreationReceiptStore} from './creation-receipts'
import {makeWechatNotificationStore} from './wechat-notifications'
import {makeArtifactDeliveryStore} from './artifact-deliveries'
import {makeTimelineEvents} from './timeline-events'
import type {AgentActivity} from '../agent-provider'

export type TaskStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface Task {
  id: string; title: string; path: string; providerId: string; status: TaskStatus
  createdAt: number; updatedAt: number; error: string | null; archivedAt: number | null
}
export interface StoredTask extends Task { ownerChatId: string | null; sessionId: string | null }
export interface TaskEvent { id: number; taskId: string; kind: 'user' | 'text' | 'tool_call' | 'system' | 'error'; text: string; createdAt: number; sourceId?:string|null; runId?:string; activity?:AgentActivity; attachments?:import('./attachments').Attachment[] }
export interface Artifact { id: string; taskId: string; name: string; mime: string; size: number; sha256: string; createdAt: number; approvedAt: number | null }
export interface StoredArtifact extends Artifact { storagePath: string }
const TASK_SELECT = 'SELECT id,title,path,provider_id AS providerId,owner_chat_id AS ownerChatId,session_id AS sessionId,status,error,created_at AS createdAt,updated_at AS updatedAt,archived_at AS archivedAt FROM workbench_tasks'
const HANDOFF_SELECT='SELECT id,source_task_id AS sourceTaskId,target_task_id AS targetTaskId,purpose,request,packet_sha256 AS packetSha256,artifact_refs_json AS artifactRefsJson,quote_json AS quoteJson,created_at AS createdAt,request_event_id AS requestEventId,source_native_id AS sourceNativeId,target_native_id AS targetNativeId,packet_json AS packetJson,token_hash AS tokenHash FROM workbench_handoffs'
const SOURCE_SELECT='SELECT id,task_id AS taskId,provider_id AS providerId,native_id AS nativeId,cwd,imported_at AS importedAt,first_dispatched_at AS firstDispatchedAt,snapshot_sha256 AS snapshotSha256,observed_fingerprint AS observedFingerprint,selected_message_count AS selectedMessageCount,truncated,snapshot_json AS snapshotJson,pages_json AS pagesJson FROM workbench_sources'
const ART_SELECT = 'SELECT id,task_id AS taskId,name,mime,size,sha256,storage_path AS storagePath,created_at AS createdAt,approved_at AS approvedAt FROM workbench_artifacts'
export function publicTask({ ownerChatId: _owner, sessionId: _session, ...task }: StoredTask): Task { return task }
export function publicArtifact({ storagePath: _path, ...artifact }: StoredArtifact): Artifact { return artifact }

export interface WorkbenchListQuery {
  q?: string
  archived?: 'exclude' | 'only' | 'all'
  limit?: number
  cursor?: string
}
export interface TaskPage {
  tasks: Task[]
  page: {limit: number; total: number; hasMore: boolean; nextCursor: string | null}
}
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[]=['completed','failed','cancelled','interrupted']

function listFilters(query:WorkbenchListQuery) {
  const q=query.q===undefined ? '' : typeof query.q==='string' ? query.q.trim() : null
  const archived=query.archived??'exclude',limit=query.limit??50
  if(q===null || q.length>200 || !['exclude','only','all'].includes(archived) || !Number.isInteger(limit) || limit<1 || limit>100) throw new Error('invalid_request')
  const filterHash=createHash('sha256').update(JSON.stringify({q,archived})).digest('hex')
  let cursor:{v:1;updatedAt:number;id:string;filterHash:string}|undefined
  if(query.cursor!==undefined) {
    try {
      if(typeof query.cursor!=='string' || query.cursor.length>1024 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error()
      const bytes=Buffer.from(query.cursor,'base64url')
      if(bytes.toString('base64url')!==query.cursor) throw new Error()
      const decoded=JSON.parse(bytes.toString('utf8'))
      if(!decoded || decoded.v!==1 || !Number.isSafeInteger(decoded.updatedAt) || decoded.updatedAt<0 || typeof decoded.id!=='string' || !/^[a-f0-9]{8}$/.test(decoded.id) || decoded.filterHash!==filterHash) throw new Error()
      cursor=decoded
    } catch {throw new Error('invalid_cursor')}
  }
  return {q,archived,limit,filterHash,cursor}
}

export function makeWorkbenchStore(db: Db) {
  const get = (id: string): StoredTask => {
    const task = db.query<StoredTask, [string]>(`${TASK_SELECT} WHERE id=?`).get(id)
    if (!task) throw new Error('not_found')
    return task
  }
  const artifacts = (id: string) => db.query<StoredArtifact, [string]>(`${ART_SELECT} WHERE task_id=? ORDER BY created_at DESC,rowid DESC`).all(id)
  const {events,addEvent:insertEvent,recordAgentEvent:upsertAgentEvent,finishRunActivities:finishActivities}=makeTimelineEvents(db)
  const bump=(id:string):number=>{
    const row=db.query<{seq:number},[number,string]>('UPDATE workbench_tasks SET seq=seq+1,updated_at=? WHERE id=? RETURNING seq').get(Date.now(),id)
    if(!row)throw new Error('not_found')
    return row.seq
  }
  const version=(id:string)=>db.query<{seq:number},[string]>('SELECT seq FROM workbench_tasks WHERE id=?').get(id)?.seq??0
  const addEvent=(id:Parameters<typeof insertEvent>[0],kind:Parameters<typeof insertEvent>[1],text:Parameters<typeof insertEvent>[2],sourceId:Parameters<typeof insertEvent>[3]=null,runId:Parameters<typeof insertEvent>[4]=null,attachments:Parameters<typeof insertEvent>[5]=[])=>db.transaction(()=>insertEvent(id,kind,text,sourceId,runId,attachments,bump(id)))()
  const recordAgentEvent=(taskId:Parameters<typeof upsertAgentEvent>[0],runId:Parameters<typeof upsertAgentEvent>[1],event:Parameters<typeof upsertAgentEvent>[2])=>db.transaction(()=>upsertAgentEvent(taskId,runId,event,bump(taskId)))()
  const finishRunActivities=(taskId:Parameters<typeof finishActivities>[0],runId:Parameters<typeof finishActivities>[1],status:Parameters<typeof finishActivities>[2])=>db.transaction(()=>{finishActivities(taskId,runId,status,bump(taskId))})()
  const sourceRow=(row:StoredNativeSource|null)=>row?{...row,truncated:!!row.truncated}:null
  const source=(id:string)=>sourceRow(db.query<StoredNativeSource,[string]>(SOURCE_SELECT+' WHERE task_id=?').get(id))
  const sourceByIdentity=(providerId:string,nativeId:string)=>sourceRow(db.query<StoredNativeSource,[string,string]>(SOURCE_SELECT+' WHERE provider_id=? AND native_id=?').get(providerId,nativeId))
  const handoffs=(id:string):HandoffView[]=>db.query<StoredHandoff,[string,string]>(HANDOFF_SELECT+' WHERE source_task_id=? OR target_task_id=? ORDER BY created_at,rowid').all(id,id).map(({packetJson:_packet,tokenHash:_token,artifactRefsJson,quoteJson,...h})=>{
    const a=get(h.sourceTaskId),b=get(h.targetTaskId)
    return{...h,artifacts:JSON.parse(artifactRefsJson),quote:quoteJson?JSON.parse(quoteJson):null,sourceTitle:a.title,targetTitle:b.title,sourceProviderId:a.providerId,targetProviderId:b.providerId,sourceStatus:a.status,targetStatus:b.status}
  })
  return {
    atomic:<T>(operation:()=>T):T=>db.transaction(operation)(),
    attachments:makeTaskAttachmentStore(db),
    execution:makeExecutionSettingsStore(db),
    liveInputs:makeLiveInputStore(db),
    controlReceipts:makeControlReceiptStore(db),
    creationReceipts:makeCreationReceiptStore(db),
    wechatNotifications:makeWechatNotificationStore(db),
    artifactDeliveries:makeArtifactDeliveryStore(db),
    get, artifacts, events, addEvent,recordAgentEvent,finishRunActivities,source,sourceByIdentity,handoffs,bump,version,
    recordHandoffNative:(id:string,nativeId:string):{sourceTaskId:string;targetTaskId:string}|null=>db.transaction(()=>{
      const row=db.query<{sourceTaskId:string;targetTaskId:string},[string,string]>('UPDATE workbench_handoffs SET target_native_id=? WHERE id=? AND target_native_id IS NULL RETURNING source_task_id AS sourceTaskId,target_task_id AS targetTaskId').get(nativeId,id)
      if(row){bump(row.sourceTaskId);bump(row.targetTaskId)}
      return row??null
    })(),
    recordHandoffEvent:(id:string,eventId:number):{sourceTaskId:string;targetTaskId:string}|null=>db.transaction(()=>{
      const row=db.query<{sourceTaskId:string;targetTaskId:string},[number,string]>('UPDATE workbench_handoffs SET request_event_id=? WHERE id=? RETURNING source_task_id AS sourceTaskId,target_task_id AS targetTaskId').get(eventId,id)
      if(row){bump(row.sourceTaskId);bump(row.targetTaskId)}
      return row??null
    })(),
    handoffByToken:(hash:string)=>db.query<StoredHandoff,[string]>(HANDOFF_SELECT+' WHERE token_hash=?').get(hash),
    handoffRecord(taskId:string,id:string){
      const record=db.query<StoredHandoff,[string,string,string]>(HANDOFF_SELECT+' WHERE id=? AND (source_task_id=? OR target_task_id=?)').get(id,taskId,taskId)
      if(!record)throw new Error('not_found');return record
    },
    createHandoff(input:Omit<StoredHandoff,'targetTaskId'|'createdAt'|'targetNativeId'|'requestEventId'> & {targetTaskId:string|null;targetProviderId:string;path:string;title:string;ownerChatId:string|null}) {
      return db.transaction(()=>{
        const old=this.handoffByToken(input.tokenHash);if(old)return old
        const task=input.targetTaskId?get(input.targetTaskId):this.create({title:input.title,path:input.path,providerId:input.targetProviderId,ownerChatId:input.ownerChatId})
        if(!input.targetTaskId)this.update(task.id,'interrupted')
        db.query('INSERT INTO workbench_handoffs(id,source_task_id,target_task_id,purpose,request,packet_sha256,artifact_refs_json,quote_json,created_at,source_native_id,target_native_id,packet_json,token_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(input.id,input.sourceTaskId,task.id,input.purpose,input.request,input.packetSha256,input.artifactRefsJson,input.quoteJson,Date.now(),input.sourceNativeId,null,input.packetJson,input.tokenHash)
        return this.handoffRecord(task.id,input.id)
      })()
    },
    taskByNativeIdentity:(providerId:string,nativeId:string)=>db.query<StoredTask,[string,string]>(TASK_SELECT+' WHERE provider_id=? AND session_id=? LIMIT 1').get(providerId,nativeId),
    markSourceDispatched(id:string){db.query('UPDATE workbench_sources SET first_dispatched_at=COALESCE(first_dispatched_at,?) WHERE task_id=?').run(Date.now(),id)},
    importSource(input:Omit<StoredNativeSource,'id'|'taskId'|'importedAt'|'firstDispatchedAt'|'selectedMessageCount'> & {title:string;ownerChatId:string|null;messages:NativeHistoryMessage[]}) {
      return db.transaction(()=>{
        const existing=sourceByIdentity(input.providerId,input.nativeId)
        if(existing)return{task:get(existing.taskId),source:publicSource(existing),created:false}
        const task=this.create({title:input.title,path:input.cwd,providerId:input.providerId,ownerChatId:input.ownerChatId}),id=randomUUID(),now=Date.now()
        db.query('UPDATE workbench_tasks SET execution_choice_json=? WHERE id=?').run(JSON.stringify(NATIVE_EXECUTION_CHOICE),task.id)
        db.query('INSERT INTO workbench_sources(id,task_id,provider_id,native_id,cwd,imported_at,snapshot_sha256,observed_fingerprint,selected_message_count,truncated,snapshot_json,pages_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,task.id,input.providerId,input.nativeId,input.cwd,now,input.snapshotSha256,input.observedFingerprint,input.messages.length,input.truncated?1:0,input.snapshotJson,input.pagesJson)
        for(const message of input.messages)addEvent(task.id,message.role==='user'?'user':'text',message.text,id)
        this.session(task.id,input.nativeId);this.update(task.id,'interrupted')
        return{task:get(task.id),source:publicSource(source(task.id)!),created:true}
      })()
    },
    projectProvider: (path:string) => db.query<{providerId:string},[string]>('SELECT provider_id AS providerId FROM workbench_tasks WHERE path=? ORDER BY updated_at DESC,id DESC LIMIT 1').get(path)?.providerId ?? null,
    list: () => db.query<StoredTask, []>(`${TASK_SELECT} ORDER BY updated_at DESC,rowid DESC LIMIT 200`).all().map(publicTask),
    listOwned:(ownerChatId:string,limit=8)=>db.query<StoredTask,[string,number]>(`${TASK_SELECT} WHERE owner_chat_id=? AND archived_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT ?`).all(ownerChatId,Math.max(1,Math.min(20,limit))).map(publicTask),
    ownedProjects(ownerChatId:string,providers?:readonly string[]):Array<{path:string;providerId:string}> {
      const rows=db.query<{path:string;providerId:string},[string]>('SELECT path,provider_id AS providerId FROM workbench_tasks WHERE owner_chat_id=? ORDER BY updated_at DESC,id DESC').all(ownerChatId)
      const accepted=[...new Set(providers??[])]
      const available=accepted.length
        ? db.query<{path:string;providerId:string},string[]>(`SELECT path,provider_id AS providerId FROM workbench_tasks WHERE owner_chat_id=? AND provider_id IN (${accepted.map(()=>'?').join(',')}) ORDER BY updated_at DESC,id DESC`).all(ownerChatId,...accepted)
        : []
      const preferred=new Map<string,string>()
      for(const row of available)if(!preferred.has(row.path))preferred.set(row.path,row.providerId)
      const seen=new Set<string>()
      return rows.filter(row=>seen.has(row.path)?false:(seen.add(row.path),true)).map(row=>({...row,providerId:preferred.get(row.path)??row.providerId}))
    },
    /** Real-time keyset paging, not a snapshot: updated tasks can move before a cursor. */
    listPage(query:WorkbenchListQuery={}):TaskPage {
      const {q,archived,limit,filterHash,cursor}=listFilters(query)
      const where:string[]=[],args:Array<string|number>=[]
      if(archived!=='all')where.push(archived==='only' ? 'archived_at IS NOT NULL' : 'archived_at IS NULL')
      if(q) {
        const pattern='%'+q.replace(/[\\%_]/g,char=>'\\'+char)+'%'
        where.push("(title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')")
        args.push(pattern,pattern,pattern)
      }
      const filter=where.length ? ' WHERE '+where.join(' AND ') : ''
      return db.transaction(()=>{
        const total=db.query<{count:number},Array<string|number>>('SELECT COUNT(*) AS count FROM workbench_tasks'+filter).get(...args)!.count
        const pageWhere=[...where],pageArgs=[...args]
        if(cursor) {
          pageWhere.push('(updated_at < ? OR (updated_at = ? AND id < ?))')
          pageArgs.push(cursor.updatedAt,cursor.updatedAt,cursor.id)
        }
        const rows=db.query<StoredTask,Array<string|number>>(TASK_SELECT+(pageWhere.length ? ' WHERE '+pageWhere.join(' AND ') : '')+' ORDER BY updated_at DESC,id DESC LIMIT ?').all(...pageArgs,limit+1)
        const hasMore=rows.length>limit,tasks=rows.slice(0,limit).map(publicTask),last=tasks.at(-1)
        const nextCursor=hasMore && last ? Buffer.from(JSON.stringify({v:1,updatedAt:last.updatedAt,id:last.id,filterHash})).toString('base64url') : null
        return {tasks,page:{limit,total,hasMore,nextCursor}}
      })()
    },
    setArchived(id:string,archived:boolean):StoredTask {
      if(typeof archived!=='boolean')throw new Error('invalid_request')
      get(id)
      if(archived) {
        const result=db.query("UPDATE workbench_tasks SET archived_at=COALESCE(archived_at,?) WHERE id=? AND status IN ('completed','failed','cancelled','interrupted') AND (error IS NULL OR error!='writer_not_closed')").run(Date.now(),id)
        if(!result.changes)throw new Error('workbench_busy')
      } else db.query('UPDATE workbench_tasks SET archived_at=NULL WHERE id=?').run(id)
      return get(id)
    },
    clearWriterError(id:string) {
      db.query("UPDATE workbench_tasks SET error=NULL WHERE id=? AND error='writer_not_closed'").run(id)
    },
    create(input: { title: string; path: string; providerId: string; ownerChatId: string | null }): StoredTask {
      let id: string
      do { id = randomBytes(4).toString('hex') } while (db.query('SELECT 1 FROM workbench_tasks WHERE id=?').get(id))
      const now = Date.now()
      db.query('INSERT INTO workbench_tasks(id,title,path,provider_id,owner_chat_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,input.title,input.path,input.providerId,input.ownerChatId,'queued',now,now)
      return get(id)
    },
    update(id: string, status: TaskStatus, error: string | null = null) {
      db.transaction(()=>{
        db.query('UPDATE workbench_tasks SET status=?,error=?,updated_at=? WHERE id=?').run(status,error,Date.now(),id)
        bump(id)
      })()
    },
    session(id: string, sessionId: string | null) { db.transaction(()=>{db.query('UPDATE workbench_tasks SET session_id=? WHERE id=?').run(sessionId,id);bump(id)})() },
    recover() {
      const rows = db.query<{ id: string; path: string; status: TaskStatus }, []>("SELECT id,path,status FROM workbench_tasks WHERE status IN ('queued','running','cancelling')").all()
      db.transaction(() => {
        for (const { id,path,status } of rows) {
          finishRunActivities(id,null,'interrupted')
          db.query("UPDATE workbench_tasks SET status='interrupted',error='daemon_restarted',updated_at=? WHERE id=?").run(Date.now(),id)
          addEvent(id, 'system', status === 'queued'
            ? '服务重启时任务仍在等待，未自动派发。原请求已保留，请补充要求后手动继续。'
            : `服务重启，任务已中断，未自动重跑。已保存的成果版本仍可查看；中断前尚未收集的文件保留在 ${join(path,'.cc-workbench',id)}。请先确认原执行程序已退出并检查该文件夹，再补充要求继续。`)
        }
      })()
    },
    addArtifact(input: Omit<StoredArtifact, 'id' | 'createdAt' | 'approvedAt'>) {
      db.transaction(()=>{
        db.query('INSERT OR IGNORE INTO workbench_artifacts(id,task_id,name,mime,size,sha256,storage_path,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),input.taskId,input.name,input.mime,input.size,input.sha256,input.storagePath,Date.now())
        bump(input.taskId)
      })()
    },
    artifact(taskId: string, id: string): StoredArtifact {
      const artifact = db.query<StoredArtifact, [string,string]>(`${ART_SELECT} WHERE task_id=? AND id=?`).get(taskId,id)
      if (!artifact) throw new Error('not_found')
      return artifact
    },
    approve(taskId: string, id: string, sha256: string) {
      const a = this.artifact(taskId,id)
      if (a.sha256 !== sha256) throw new Error('artifact_changed')
      db.transaction(()=>{
        db.query('UPDATE workbench_artifacts SET approved_at=? WHERE task_id=? AND id=? AND sha256=?').run(Date.now(),taskId,id,sha256)
        bump(taskId)
      })()
    },
    detail(id: string, opts: { since?: number } = {}) {
      // version 必须先读、events 后读:并发写夹在两次读之间时,宁可让这次的 version 落后于
      // 已经读到的 events(下一轮轮询用同一个 since 会重复看到那几行,按 id 去重即可),
      // 也不要反过来让 version 抢先报出「已追上」而漏掉刚落库、还没读到的那几行。
      const v=version(id),origin=source(id)
      return {handoffs:handoffs(id),...(origin?{source:publicSource(origin)}:{}), task: publicTask(get(id)), events: events(id,opts.since), artifacts: artifacts(id).map(publicArtifact), version: v }
    },
  }
}
export type WorkbenchStore = ReturnType<typeof makeWorkbenchStore>
