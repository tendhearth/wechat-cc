import type {Db} from '../../lib/db'
import type {FileVersion,Identity,Snapshot} from './restore-snapshots'

export const RESTORE_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS workbench_restore_workspaces (
 workspace_id TEXT PRIMARY KEY, path TEXT NOT NULL, directory_identity TEXT NOT NULL,
 generation INTEGER NOT NULL, invalid INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workbench_restore_runs (
 restore_run_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL,
 generation INTEGER NOT NULL, status TEXT NOT NULL, artifact_id TEXT UNIQUE, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workbench_restore_runs_workspace ON workbench_restore_runs(workspace_id);
CREATE TABLE IF NOT EXISTS workbench_restore_paths (
 workspace_id TEXT NOT NULL, path TEXT NOT NULL, change_id TEXT NOT NULL,
 PRIMARY KEY(workspace_id,path)
);
CREATE TABLE IF NOT EXISTS workbench_restore_operations (
 operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL,
 state TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(workspace_id,request_id)
);
CREATE INDEX IF NOT EXISTS workbench_restore_operations_workspace ON workbench_restore_operations(workspace_id,state);
`
export type RestoreState='active'|'closing'|'closed'|'uncertain'
export type RestoreOperationState='prepared'|'applying'|'reverted'|'conflict'|'needs_recovery'|'resolved_keep_current'
export interface RestoreRun {restoreRunId:string;workspaceId:string;taskId:string;runId:string;generation:number;startedAt:number;finishedAt:number|null;status:RestoreState}
export interface RestoreOperation {operationId:string;workspaceId:string;taskId:string;artifactId:string;path:string;changeId:string;requestId:string;state:RestoreOperationState;reason?:string;observedFingerprint?:string}
export interface StoredChange {path:string;changeId:string;before:FileVersion;after:FileVersion;reason?:string}
export interface StoredRun extends RestoreRun {path:string;directoryIdentity:string;blobRootIdentity:string;before?:Snapshot;after?:Snapshot;artifactId:string|null;artifactSha256:string|null;changes:StoredChange[];error?:string;writerGroups?:number[];closeProof?:{kind:'session_close'|'spawn_rejected'|'groups_gone'|'administrator';at:number;groups:number[]}}
export interface StoredOperation {receipt:RestoreOperation;inputHash:string;restoreRunId:string;generation:number;chain:Identity[];temporaryPath?:string;temporaryIdentity?:string;effectReady?:boolean}
export interface Workspace {workspaceId:string;path:string;directoryIdentity:string;generation:number;invalid:number}
const pending="('prepared','applying','needs_recovery')"
export function createRestoreStore(db:Db){
  const parse=<T>(row:{data:string}|null)=>row?JSON.parse(row.data) as T:null
  const workspace=(id:string)=>db.query<Workspace,[string]>('SELECT workspace_id AS workspaceId,path,directory_identity AS directoryIdentity,generation,invalid FROM workbench_restore_workspaces WHERE workspace_id=?').get(id)
  const runs=(id:string)=>db.query<{data:string},[string]>('SELECT data FROM workbench_restore_runs WHERE workspace_id=? ORDER BY generation DESC').all(id).map(r=>JSON.parse(r.data) as StoredRun)
  const run=(id:string)=>parse<StoredRun>(db.query<{data:string},[string]>('SELECT data FROM workbench_restore_runs WHERE restore_run_id=?').get(id))
  const operation=(id:string)=>parse<StoredOperation>(db.query<{data:string},[string]>('SELECT data FROM workbench_restore_operations WHERE operation_id=?').get(id))
  const operations=(id:string)=>db.query<{data:string},[string]>('SELECT data FROM workbench_restore_operations WHERE workspace_id=?').all(id).map(r=>JSON.parse(r.data) as StoredOperation)
  return {workspace,runs,run,operation,operations,
    allRuns:()=>db.query<{data:string},[]>('SELECT data FROM workbench_restore_runs').all().map(r=>JSON.parse(r.data) as StoredRun),
    atomic:<T>(fn:()=>T)=>db.transaction(fn).immediate(),
    pending:(id:string)=>!!db.query(`SELECT 1 FROM workbench_restore_operations WHERE workspace_id=? AND state IN ${pending} LIMIT 1`).get(id),
    findRequest:(id:string,requestId:string)=>parse<StoredOperation>(db.query<{data:string},[string,string]>('SELECT data FROM workbench_restore_operations WHERE workspace_id=? AND request_id=?').get(id,requestId)),
    putWorkspace:(w:Workspace)=>db.query('INSERT INTO workbench_restore_workspaces(workspace_id,path,directory_identity,generation,invalid) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET generation=excluded.generation,invalid=excluded.invalid').run(w.workspaceId,w.path,w.directoryIdentity,w.generation,w.invalid),
    insertRun:(r:StoredRun)=>db.query('INSERT INTO workbench_restore_runs(restore_run_id,workspace_id,task_id,generation,status,artifact_id,data) VALUES(?,?,?,?,?,?,?)').run(r.restoreRunId,r.workspaceId,r.taskId,r.generation,r.status,r.artifactId,JSON.stringify(r)),
    putRun:(r:StoredRun)=>db.query('UPDATE workbench_restore_runs SET status=?,artifact_id=?,data=? WHERE restore_run_id=?').run(r.status,r.artifactId,JSON.stringify(r),r.restoreRunId),
    pathVersion:(id:string,path:string)=>db.query<{changeId:string},[string,string]>('SELECT change_id AS changeId FROM workbench_restore_paths WHERE workspace_id=? AND path=?').get(id,path)?.changeId,
    setPathVersion:(id:string,path:string,changeId:string)=>db.query('INSERT INTO workbench_restore_paths(workspace_id,path,change_id) VALUES(?,?,?) ON CONFLICT(workspace_id,path) DO UPDATE SET change_id=excluded.change_id').run(id,path,changeId),
    insertOperation:(o:StoredOperation)=>db.query('INSERT INTO workbench_restore_operations(operation_id,workspace_id,request_id,state,data) VALUES(?,?,?,?,?)').run(o.receipt.operationId,o.receipt.workspaceId,o.receipt.requestId,o.receipt.state,JSON.stringify(o)),
    putOperation:(o:StoredOperation)=>db.query('UPDATE workbench_restore_operations SET state=?,data=? WHERE operation_id=?').run(o.receipt.state,JSON.stringify(o),o.receipt.operationId),
  }
}
