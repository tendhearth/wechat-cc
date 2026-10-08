import type {SqlDatabase} from '../../lib/runtime/sqlite'
export interface GitWorkspacePrepareInput {workspaceId:string;ownerKey:string;requestId:string;canonicalRequestHash:string;sourcePath:string;providerId:string}
export interface GitWorkspaceRecord extends GitWorkspacePrepareInput {id:string;sourceIdentity:string;gitRoot:string;gitRootIdentity:string;gitDir:string;gitDirIdentity:string;commonDir:string;commonDirIdentity:string;projectSubpath:string;baseCommit:string;sourceBranch:string|null;branch:string;worktreeRoot:string;executionPath:string;directoryIdentity:string|null;executionIdentity:string|null;worktreeGitDir:string|null;worktreeGitDirIdentity:string|null;rootIdentity:string|null;sourceGitState:GitState;sourceStatus:string;configurationFingerprint:string|null;status:'reserved'|'provisioning'|'ready'|'failed'|'needs_recovery';failureReason:string|null;createdAt:number;updatedAt:number}
export interface GitState {head:string;index:Record<string,string>}

/** Task database migration copies this DDL; core never runs main-library migrations. */
export const GIT_WORKSPACE_SCHEMA_SQL=`CREATE TABLE workbench_git_workspaces (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  canonical_request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','provisioning','ready','failed','needs_recovery')),
  record_json TEXT NOT NULL,
  UNIQUE(owner_key,request_id)
);`
interface Row {record_json:string}
const frozenKeys=['id','workspaceId','ownerKey','requestId','canonicalRequestHash','providerId','sourcePath','sourceIdentity','gitRoot','gitRootIdentity','gitDir','gitDirIdentity','commonDir','commonDirIdentity','projectSubpath','baseCommit','sourceBranch','branch','worktreeRoot','executionPath','sourceGitState','sourceStatus','createdAt'] as const
export function createGitWorkspaceStore(db:SqlDatabase) {
  const get=(id:string):GitWorkspaceRecord|null=>{const row=db.query<Row,[string]>('SELECT record_json FROM workbench_git_workspaces WHERE id=?').get(id);return row?JSON.parse(row.record_json) as GitWorkspaceRecord:null}
  return {
    get,
    reserve(record:GitWorkspaceRecord):GitWorkspaceRecord {
      return db.transaction(()=>{
        const prior=get(record.id)
        if(prior){
          // Concurrent admission generates another timestamp for the same
          // reservation. Adopt the first receipt; semantic identities still match.
          for(const key of frozenKeys)if(key!=='createdAt'&&JSON.stringify(prior[key])!==JSON.stringify(record[key]))throw Error('git_workspace_conflict')
          return prior
        }
        const conflict=db.query<Row,[string,string]>('SELECT record_json FROM workbench_git_workspaces WHERE owner_key=? AND request_id=?').get(record.ownerKey,record.requestId)
        if(conflict)throw Error('git_workspace_conflict')
        db.query('INSERT INTO workbench_git_workspaces(id,owner_key,request_id,canonical_request_hash,status,record_json) VALUES(?,?,?,?,?,?)').run(record.id,record.ownerKey,record.requestId,record.canonicalRequestHash,record.status,JSON.stringify(record))
        return record
      }).immediate()
    },
    update(record:GitWorkspaceRecord):GitWorkspaceRecord {
      return db.transaction(()=>{
        const prior=get(record.id);if(!prior)throw Error('git_workspace_not_found')
        for(const key of frozenKeys)if(JSON.stringify(prior[key])!==JSON.stringify(record[key]))throw Error('git_workspace_conflict')
        for(const key of ['directoryIdentity','executionIdentity','worktreeGitDir','worktreeGitDirIdentity','rootIdentity','configurationFingerprint'] as const)if(prior[key]!==null&&prior[key]!==record[key])throw Error('git_workspace_conflict')
        const next={...record,updatedAt:Date.now()}
        db.query('UPDATE workbench_git_workspaces SET status=?,record_json=? WHERE id=?').run(next.status,JSON.stringify(next),next.id)
        return next
      }).immediate()
    },
  }
}
export type GitWorkspaceStore=ReturnType<typeof createGitWorkspaceStore>
