import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {publicSource,type StoredNativeSource} from './native-adoption'
import type {NativeHistoryMessage} from './native-history'
import type { Db } from '../../lib/db'

export type TaskStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface Task {
  id: string; title: string; path: string; providerId: string; status: TaskStatus
  createdAt: number; updatedAt: number; error: string | null; archivedAt: number | null
}
export interface StoredTask extends Task { ownerChatId: string | null; sessionId: string | null }
export interface TaskEvent { id: number; taskId: string; kind: 'user' | 'text' | 'tool_call' | 'system' | 'error'; text: string; createdAt: number; sourceId?:string|null }
export interface Artifact { id: string; taskId: string; name: string; mime: string; size: number; sha256: string; createdAt: number; approvedAt: number | null }
export interface StoredArtifact extends Artifact { storagePath: string }
const TASK_SELECT = 'SELECT id,title,path,provider_id AS providerId,owner_chat_id AS ownerChatId,session_id AS sessionId,status,error,created_at AS createdAt,updated_at AS updatedAt,archived_at AS archivedAt FROM workbench_tasks'
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
  const events = (id: string) => db.query<TaskEvent, [string]>('SELECT id,task_id AS taskId,kind,text,created_at AS createdAt,source_id AS sourceId FROM workbench_events WHERE task_id=? ORDER BY id').all(id)
  const addEvent = (id: string, kind: TaskEvent['kind'], text: string,sourceId:string|null=null) => {
    db.query('INSERT INTO workbench_events(task_id,kind,text,created_at,source_id) VALUES(?,?,?,?,?)').run(id, kind, text.slice(0, 40_000), Date.now(),sourceId)
  }
  const sourceRow=(row:StoredNativeSource|null)=>row?{...row,truncated:!!row.truncated}:null
  const source=(id:string)=>sourceRow(db.query<StoredNativeSource,[string]>(SOURCE_SELECT+' WHERE task_id=?').get(id))
  const sourceByIdentity=(providerId:string,nativeId:string)=>sourceRow(db.query<StoredNativeSource,[string,string]>(SOURCE_SELECT+' WHERE provider_id=? AND native_id=?').get(providerId,nativeId))
  return {
    get, artifacts, events, addEvent,source,sourceByIdentity,
    taskByNativeIdentity:(providerId:string,nativeId:string)=>db.query<StoredTask,[string,string]>(TASK_SELECT+' WHERE provider_id=? AND session_id=? LIMIT 1').get(providerId,nativeId),
    markSourceDispatched(id:string){db.query('UPDATE workbench_sources SET first_dispatched_at=COALESCE(first_dispatched_at,?) WHERE task_id=?').run(Date.now(),id)},
    importSource(input:Omit<StoredNativeSource,'id'|'taskId'|'importedAt'|'firstDispatchedAt'|'selectedMessageCount'> & {title:string;ownerChatId:string|null;messages:NativeHistoryMessage[]}) {
      return db.transaction(()=>{
        const existing=sourceByIdentity(input.providerId,input.nativeId)
        if(existing)return{task:get(existing.taskId),source:publicSource(existing),created:false}
        const task=this.create({title:input.title,path:input.cwd,providerId:input.providerId,ownerChatId:input.ownerChatId}),id=randomUUID(),now=Date.now()
        db.query('INSERT INTO workbench_sources(id,task_id,provider_id,native_id,cwd,imported_at,snapshot_sha256,observed_fingerprint,selected_message_count,truncated,snapshot_json,pages_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,task.id,input.providerId,input.nativeId,input.cwd,now,input.snapshotSha256,input.observedFingerprint,input.messages.length,input.truncated?1:0,input.snapshotJson,input.pagesJson)
        for(const message of input.messages)addEvent(task.id,message.role==='user'?'user':'text',message.text,id)
        this.session(task.id,input.nativeId);this.update(task.id,'interrupted')
        return{task:get(task.id),source:publicSource(source(task.id)!),created:true}
      })()
    },
    projectProvider: (path:string) => db.query<{providerId:string},[string]>('SELECT provider_id AS providerId FROM workbench_tasks WHERE path=? ORDER BY updated_at DESC,id DESC LIMIT 1').get(path)?.providerId ?? null,
    list: () => db.query<StoredTask, []>(`${TASK_SELECT} ORDER BY updated_at DESC,rowid DESC LIMIT 200`).all().map(publicTask),
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
      db.query('UPDATE workbench_tasks SET status=?,error=?,updated_at=? WHERE id=?').run(status,error,Date.now(),id)
    },
    session(id: string, sessionId: string | null) { db.query('UPDATE workbench_tasks SET session_id=? WHERE id=?').run(sessionId,id) },
    recover() {
      const rows = db.query<{ id: string; path: string; status: TaskStatus }, []>("SELECT id,path,status FROM workbench_tasks WHERE status IN ('queued','running','cancelling')").all()
      db.transaction(() => {
        for (const { id,path,status } of rows) {
          db.query("UPDATE workbench_tasks SET status='interrupted',error='daemon_restarted',updated_at=? WHERE id=?").run(Date.now(),id)
          addEvent(id, 'system', status === 'queued'
            ? '服务重启时任务仍在等待，未自动派发。原请求已保留，请补充要求后手动继续。'
            : `服务重启，任务已中断，未自动重跑。已保存的成果版本仍可查看；中断前尚未收集的文件保留在 ${join(path,'.cc-workbench',id)}。请先确认原执行程序已退出并检查该文件夹，再补充要求继续。`)
        }
      })()
    },
    addArtifact(input: Omit<StoredArtifact, 'id' | 'createdAt' | 'approvedAt'>) {
      db.query('INSERT OR IGNORE INTO workbench_artifacts(id,task_id,name,mime,size,sha256,storage_path,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),input.taskId,input.name,input.mime,input.size,input.sha256,input.storagePath,Date.now())
    },
    artifact(taskId: string, id: string): StoredArtifact {
      const artifact = db.query<StoredArtifact, [string,string]>(`${ART_SELECT} WHERE task_id=? AND id=?`).get(taskId,id)
      if (!artifact) throw new Error('not_found')
      return artifact
    },
    approve(taskId: string, id: string, sha256: string) {
      const a = this.artifact(taskId,id)
      if (a.sha256 !== sha256) throw new Error('artifact_changed')
      db.query('UPDATE workbench_artifacts SET approved_at=? WHERE task_id=? AND id=? AND sha256=?').run(Date.now(),taskId,id,sha256)
    },
    detail(id: string) { const origin=source(id);return {...(origin?{source:publicSource(origin)}:{}), task: publicTask(get(id)), events: events(id), artifacts: artifacts(id).map(publicArtifact) } },
  }
}
export type WorkbenchStore = ReturnType<typeof makeWorkbenchStore>
