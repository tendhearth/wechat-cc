import type {Db} from '../../lib/db'

export type LiveInputStatus='pending'|'sending'|'delivered'|'held'|'withdrawn'
export interface LiveInput {id:string;taskId:string;runId:string;text:string;status:LiveInputStatus;createdAt:number;error:string|null}
const SELECT='SELECT id,task_id AS taskId,run_id AS runId,text,status,created_at AS createdAt,error FROM workbench_live_inputs'
export function makeLiveInputStore(db:Db){
  const get=(id:string)=>db.query<LiveInput,[string]>(SELECT+' WHERE id=?').get(id)
  return{
    get,
    add(input:Pick<LiveInput,'id'|'taskId'|'runId'|'text'>):LiveInput{
      const prior=get(input.id)
      if(prior){if(prior.taskId!==input.taskId||prior.runId!==input.runId||prior.text!==input.text)throw Error('input_conflict');return prior}
      db.query('INSERT INTO workbench_live_inputs(id,task_id,run_id,text,status,created_at) VALUES(?,?,?,?,?,?)').run(input.id,input.taskId,input.runId,input.text,'pending',Date.now())
      return get(input.id)!
    },
    list:(id:string)=>db.query<LiveInput,[string]>(SELECT+' WHERE task_id=? ORDER BY rowid DESC LIMIT 50').all(id),
    next:(id:string)=>db.query<LiveInput,[string]>(SELECT+" WHERE task_id=? AND status='pending' ORDER BY rowid LIMIT 1").get(id),
    count:(id:string)=>db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM workbench_live_inputs WHERE task_id=? AND status IN ('pending','sending')").get(id)!.n,
    set:(id:string,status:LiveInputStatus,error:string|null=null)=>db.query('UPDATE workbench_live_inputs SET status=?,error=? WHERE id=?').run(status,error,id),
    hold:(taskId:string,error:string)=>db.query("UPDATE workbench_live_inputs SET status='held',error=? WHERE task_id=? AND status IN ('pending','sending')").run(error,taskId),
    recover:()=>db.query("UPDATE workbench_live_inputs SET status='held',error='daemon_restarted' WHERE status IN ('pending','sending')").run(),
  }
}
