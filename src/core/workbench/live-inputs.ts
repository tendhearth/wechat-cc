import type {Db} from '../../lib/db'
import type {Attachment} from './attachments'

export function normalizeInputRequestId(value:unknown):string{
  if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))throw Error('invalid_request')
  return value.toLowerCase()
}

export type LiveInputStatus='pending'|'sending'|'delivered'|'held'|'withdrawn'
export interface LiveInput {id:string;taskId:string;runId:string;text:string;status:LiveInputStatus;createdAt:number;error:string|null;attachments?:Attachment[]}
type InputRow=Omit<LiveInput,'attachments'>&{attachmentsJson:string}
const SELECT='SELECT id,task_id AS taskId,run_id AS runId,text,status,created_at AS createdAt,error,attachments_json AS attachmentsJson FROM workbench_live_inputs'
const publicInput=(row:InputRow|null):LiveInput|null=>{if(!row)return null;const {attachmentsJson,...input}=row;const attachments=JSON.parse(attachmentsJson) as Attachment[];return {...input,...(attachments.length?{attachments}:{})}}
export const sameAttachments=(a:readonly Attachment[]|undefined,b:readonly Attachment[]|undefined)=>JSON.stringify(a??[])===JSON.stringify(b??[])
export function makeLiveInputStore(db:Db){
  const get=(id:string)=>publicInput(db.query<InputRow,[string]>(SELECT+' WHERE id=?').get(id))
  return{
    get,
    add(input:Pick<LiveInput,'id'|'taskId'|'runId'|'text'|'attachments'>):LiveInput{
      const prior=get(input.id)
      if(prior){if(prior.taskId!==input.taskId||prior.runId!==input.runId||prior.text!==input.text||!sameAttachments(prior.attachments,input.attachments))throw Error('input_conflict');return prior}
      db.query('INSERT INTO workbench_live_inputs(id,task_id,run_id,text,status,created_at,attachments_json) VALUES(?,?,?,?,?,?,?)').run(input.id,input.taskId,input.runId,input.text,'pending',Date.now(),JSON.stringify(input.attachments??[]))
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
