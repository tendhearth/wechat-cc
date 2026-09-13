import type {Db} from '../../lib/db'

export interface ControlReceipt {
  id:string;taskId:string;runId:string|null;action:'stop';textHash:string;result:string|null;createdAt:number
}
const SELECT='SELECT id,task_id AS taskId,run_id AS runId,action,text_hash AS textHash,result,created_at AS createdAt FROM workbench_control_receipts'

/** Durable at-most-once control actions. An unfinished receipt is never re-executed. */
export function makeControlReceiptStore(db:Db){
  const get=(id:string)=>db.query<ControlReceipt,[string]>(SELECT+' WHERE id=?').get(id)
  return{
    get,
    reserve(input:Omit<ControlReceipt,'result'|'createdAt'>){
      return db.transaction(()=>{
        const prior=get(input.id)
        if(prior){
          if(prior.taskId!==input.taskId||prior.action!==input.action||prior.textHash!==input.textHash)throw Error('control_conflict')
          return{receipt:prior,created:false}
        }
        db.query('INSERT INTO workbench_control_receipts(id,task_id,run_id,action,text_hash,created_at) VALUES(?,?,?,?,?,?)').run(input.id,input.taskId,input.runId,input.action,input.textHash,Date.now())
        return{receipt:get(input.id)!,created:true}
      })()
    },
    complete:(id:string,result:string)=>db.query('UPDATE workbench_control_receipts SET result=? WHERE id=? AND result IS NULL').run(result,id),
  }
}
