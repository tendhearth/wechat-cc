import type {Db} from '../../lib/db'
import type {Attachment} from './attachments'
import type {AgentExecutionChoice} from '../agent-provider'
import {normalizeExecutionChoice,PROVIDER_EXECUTION_CHOICE,sameExecutionChoice} from './execution-settings'

export function normalizeInputRequestId(value:unknown):string{
  if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))throw Error('invalid_request')
  return value.toLowerCase()
}

export type LiveInputStatus='pending'|'sending'|'delivered'|'held'|'withdrawn'
export interface LiveInput {id:string;taskId:string;runId:string;text:string;status:LiveInputStatus;createdAt:number;error:string|null;attachments?:Attachment[];execution?:AgentExecutionChoice}
type InputRow=Omit<LiveInput,'attachments'|'execution'>&{attachmentsJson:string;executionJson:string|null}
const SELECT='SELECT id,task_id AS taskId,run_id AS runId,text,status,created_at AS createdAt,error,attachments_json AS attachmentsJson,execution_json AS executionJson FROM workbench_live_inputs'
const publicInput=(row:InputRow|null):LiveInput|null=>{if(!row)return null;const {attachmentsJson,executionJson,...input}=row;const attachments=JSON.parse(attachmentsJson) as Attachment[];return {...input,...(attachments.length?{attachments}:{}),...(executionJson?{execution:normalizeExecutionChoice(JSON.parse(executionJson),PROVIDER_EXECUTION_CHOICE)}:{})}}
export const sameAttachments=(a:readonly Attachment[]|undefined,b:readonly Attachment[]|undefined)=>JSON.stringify(a??[])===JSON.stringify(b??[])
export function makeLiveInputStore(db:Db){
  const get=(id:string)=>publicInput(db.query<InputRow,[string]>(SELECT+' WHERE id=?').get(id))
  return{
    get,
    add(input:Pick<LiveInput,'id'|'taskId'|'runId'|'text'|'attachments'|'execution'>):LiveInput{
      const execution=input.execution===undefined?undefined:normalizeExecutionChoice(input.execution,PROVIDER_EXECUTION_CHOICE)
      const prior=get(input.id)
      if(prior){if(prior.taskId!==input.taskId||prior.runId!==input.runId||prior.text!==input.text||!sameAttachments(prior.attachments,input.attachments)||(prior.execution&&execution?!sameExecutionChoice(prior.execution,execution):prior.execution!==execution))throw Error('input_conflict');return prior}
      db.query('INSERT INTO workbench_live_inputs(id,task_id,run_id,text,status,created_at,attachments_json,execution_json) VALUES(?,?,?,?,?,?,?,?)').run(input.id,input.taskId,input.runId,input.text,'pending',Date.now(),JSON.stringify(input.attachments??[]),execution?JSON.stringify(execution):null)
      return get(input.id)!
    },
    list:(id:string)=>db.query<InputRow,[string]>(SELECT+' WHERE task_id=? ORDER BY rowid DESC LIMIT 50').all(id).map(row=>publicInput(row)!),
    next:(id:string)=>publicInput(db.query<InputRow,[string]>(SELECT+" WHERE task_id=? AND status='pending' ORDER BY rowid LIMIT 1").get(id)),
    count:(id:string)=>db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM workbench_live_inputs WHERE task_id=? AND status IN ('pending','sending')").get(id)!.n,
    set:(id:string,status:LiveInputStatus,error:string|null=null)=>db.query('UPDATE workbench_live_inputs SET status=?,error=? WHERE id=?').run(status,error,id),
    hold:(taskId:string,error:string)=>db.query("UPDATE workbench_live_inputs SET status='held',error=? WHERE task_id=? AND status IN ('pending','sending')").run(error,taskId),
    recover:()=>db.query("UPDATE workbench_live_inputs SET status='held',error='daemon_restarted' WHERE status IN ('pending','sending')").run(),
  }
}
