import type {Db} from '../../lib/db'
import type {AgentExecutionChoice} from '../agent-provider'
import type {Attachment} from './attachments'
import type {EntryTarget} from './task-entry'

/** Internal, validated choices; HTTP bodies cannot supply these values. */
export interface EntryReservation {
  ownerKey:string;requestId:string;canonicalRequestHash:string
  target:EntryTarget;workspaceId:string|null;resolvedPath:string|null;directoryIdentity:string|null
  providerId:string;execution:AgentExecutionChoice;materialSnapshot:Attachment[]
}
export interface EntryAccepted {
  taskId:string;matterId:string;runId:string;acceptedAt:number;resolvedPath:string;directoryIdentity:string
}
export type EntryRecord=EntryReservation&{createdAt:number}&(
  | {phase:'reserved';taskId:null;matterId:null;runId:null;acceptedAt:null}
  | ({phase:'accepted'}&EntryAccepted)
)
interface Row {
  ownerKey:string;requestId:string;canonicalRequestHash:string;frozenJson:string;phase:'reserved'|'accepted'
  workspaceId:string|null;resolvedPath:string|null;directoryIdentity:string|null;createdAt:number
  taskId:string|null;matterId:string|null;runId:string|null;acceptedAt:number|null
}
const SELECT=`SELECT owner_key AS ownerKey,request_id AS requestId,canonical_request_hash AS canonicalRequestHash,
  frozen_json AS frozenJson,phase,workspace_id AS workspaceId,resolved_path AS resolvedPath,
  directory_identity AS directoryIdentity,task_id AS taskId,matter_id AS matterId,run_id AS runId,
  accepted_at AS acceptedAt,created_at AS createdAt FROM workbench_entry_requests`
const nonempty=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0
const decode=(row:Row|null):EntryRecord|null=>{
  if(!row)return null
  const {frozenJson,...rest}=row
  return {...JSON.parse(frozenJson),...rest} as EntryRecord
}

export function createEntryStore(db:Db) {
  const get=(ownerKey:string,requestId:string)=>decode(db.query<Row,[string,string]>(SELECT+' WHERE owner_key=? AND request_id=?').get(ownerKey,requestId))
  const requireEntry=(ownerKey:string,requestId:string)=>{const row=get(ownerKey,requestId);if(!row)throw Error('not_found');return row}
  const requireAllocation=(prior:EntryRecord,path:string,identity:string)=>{
    if(!nonempty(path)||!nonempty(identity))throw Error('invalid_entry_allocation')
    if((prior.resolvedPath!==null&&prior.resolvedPath!==path)||(prior.directoryIdentity!==null&&prior.directoryIdentity!==identity))throw Error('creation_conflict')
  }
  return {
    get,
    reserve(input:EntryReservation):EntryRecord {
      return db.transaction(()=>{
        const prior=get(input.ownerKey,input.requestId)
        if(prior){
          if(prior.canonicalRequestHash!==input.canonicalRequestHash)throw Error('creation_conflict')
          // A new default must never replace the first caller's frozen choice.
          return prior
        }
        if(!nonempty(input.ownerKey)||!nonempty(input.requestId)||!/^[a-f0-9]{64}$/.test(input.canonicalRequestHash)||!nonempty(input.providerId))throw Error('invalid_entry_reservation')
        const frozen=JSON.stringify({target:input.target,providerId:input.providerId,execution:input.execution,materialSnapshot:input.materialSnapshot})
        db.query(`INSERT INTO workbench_entry_requests
          (owner_key,request_id,canonical_request_hash,frozen_json,phase,workspace_id,resolved_path,directory_identity,created_at)
          VALUES(?,?,?,?,'reserved',?,?,?,?)`).run(input.ownerKey,input.requestId,input.canonicalRequestHash,frozen,input.workspaceId,input.resolvedPath,input.directoryIdentity,Date.now())
        return requireEntry(input.ownerKey,input.requestId)
      }).immediate()
    },
    allocate(ownerKey:string,requestId:string,path:string,identity:string):EntryRecord {
      return db.transaction(()=>{
        const prior=requireEntry(ownerKey,requestId);requireAllocation(prior,path,identity)
        db.query("UPDATE workbench_entry_requests SET resolved_path=?,directory_identity=? WHERE owner_key=? AND request_id=? AND phase='reserved'").run(path,identity,ownerKey,requestId)
        return requireEntry(ownerKey,requestId)
      })()
    },
    accept(ownerKey:string,requestId:string,accepted:EntryAccepted):EntryRecord {
      return db.transaction(()=>{
        const prior=requireEntry(ownerKey,requestId)
        if(typeof accepted.taskId!=='string'||!/^[a-f0-9]{8}$/.test(accepted.taskId)||accepted.matterId!==accepted.taskId||!nonempty(accepted.runId)||!Number.isSafeInteger(accepted.acceptedAt)||accepted.acceptedAt<=0)throw Error('invalid_entry_receipt')
        requireAllocation(prior,accepted.resolvedPath,accepted.directoryIdentity)
        if(prior.phase==='accepted') {
          if((Object.keys(accepted) as Array<keyof EntryAccepted>).some(key=>prior[key]!==accepted[key]))throw Error('creation_conflict')
          return prior
        }
        db.query(`UPDATE workbench_entry_requests SET phase='accepted',task_id=?,matter_id=?,run_id=?,accepted_at=?,resolved_path=?,directory_identity=?
          WHERE owner_key=? AND request_id=? AND phase='reserved'`).run(accepted.taskId,accepted.matterId,accepted.runId,accepted.acceptedAt,accepted.resolvedPath,accepted.directoryIdentity,ownerKey,requestId)
        return requireEntry(ownerKey,requestId)
      })()
    },
  }
}
export type EntryStore=ReturnType<typeof createEntryStore>
