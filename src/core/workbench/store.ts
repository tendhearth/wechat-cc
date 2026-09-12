import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Db } from '../../lib/db'

export type TaskStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface Task {
  id: string; title: string; path: string; providerId: string; status: TaskStatus
  createdAt: number; updatedAt: number; error: string | null
}
export interface StoredTask extends Task { ownerChatId: string | null; sessionId: string | null }
export interface TaskEvent { id: number; taskId: string; kind: 'user' | 'text' | 'tool_call' | 'system' | 'error'; text: string; createdAt: number }
export interface Artifact { id: string; taskId: string; name: string; mime: string; size: number; sha256: string; createdAt: number; approvedAt: number | null }
export interface StoredArtifact extends Artifact { storagePath: string }
const TASK_SELECT = 'SELECT id,title,path,provider_id AS providerId,owner_chat_id AS ownerChatId,session_id AS sessionId,status,error,created_at AS createdAt,updated_at AS updatedAt FROM workbench_tasks'
const ART_SELECT = 'SELECT id,task_id AS taskId,name,mime,size,sha256,storage_path AS storagePath,created_at AS createdAt,approved_at AS approvedAt FROM workbench_artifacts'
export function publicTask({ ownerChatId: _owner, sessionId: _session, ...task }: StoredTask): Task { return task }
export function publicArtifact({ storagePath: _path, ...artifact }: StoredArtifact): Artifact { return artifact }

export function makeWorkbenchStore(db: Db) {
  const get = (id: string): StoredTask => {
    const task = db.query<StoredTask, [string]>(`${TASK_SELECT} WHERE id=?`).get(id)
    if (!task) throw new Error('not_found')
    return task
  }
  const artifacts = (id: string) => db.query<StoredArtifact, [string]>(`${ART_SELECT} WHERE task_id=? ORDER BY created_at DESC,rowid DESC`).all(id)
  const events = (id: string) => db.query<TaskEvent, [string]>('SELECT id,task_id AS taskId,kind,text,created_at AS createdAt FROM workbench_events WHERE task_id=? ORDER BY id').all(id)
  const addEvent = (id: string, kind: TaskEvent['kind'], text: string) => {
    db.query('INSERT INTO workbench_events(task_id,kind,text,created_at) VALUES(?,?,?,?)').run(id, kind, text.slice(0, 40_000), Date.now())
  }
  return {
    get, artifacts, events, addEvent,
    list: () => db.query<StoredTask, []>(`${TASK_SELECT} ORDER BY updated_at DESC,rowid DESC LIMIT 200`).all().map(publicTask),
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
    detail(id: string) { return { task: publicTask(get(id)), events: events(id), artifacts: artifacts(id).map(publicArtifact) } },
  }
}
export type WorkbenchStore = ReturnType<typeof makeWorkbenchStore>
