import type {Db} from '../../lib/db'
import type {RelayLeg,RelayStop} from '../../domain/relay-decision'

export interface PlanLeg extends RelayLeg {executor:string;brief:string;runId:string|null;stopReason:RelayStop|null}
export interface MatterPlan {matterId:string;state:'approved'|'cancelled'|'done';approvedAt:number;createdAt:number;legs:PlanLeg[]}
export type PlanBrief=Pick<PlanLeg,'executor'|'brief'>
export const isRelayContinue=(text:string)=>/^继续(?:\s|[，,。.!！]|$)/.test(text.trim())

export function makeMatterPlans(db:Db,now=()=>Date.now()){
  function get(id:string):MatterPlan|null{
    const plan=db.query<Omit<MatterPlan,'legs'>,[string]>('SELECT matter_id AS matterId,state,approved_at AS approvedAt,created_at AS createdAt FROM matter_plans WHERE matter_id=?').get(id)
    return plan?{...plan,legs:db.query<PlanLeg,[string]>('SELECT position,executor,brief,state,run_id AS runId,auto_dispatches AS autoDispatches,stop_reason AS stopReason FROM matter_plan_legs WHERE matter_id=? ORDER BY position').all(id)}:null
  }
  function cancel(id:string):boolean{return db.query("UPDATE matter_plans SET state='cancelled' WHERE matter_id=? AND state='approved'").run(id).changes>0}
  return {
    get,cancel,
    approve(id:string,legs:readonly PlanBrief[],firstRun:string){
      if(legs.length<2||legs.length>6)throw Error('invalid_matter_plan')
      db.transaction(()=>{
        const at=now();db.query("INSERT INTO matter_plans VALUES(?,'approved',?,?)").run(id,at,at)
        for(const [index,leg]of legs.entries())db.query('INSERT INTO matter_plan_legs VALUES(?,?,?,?,?,?,0,NULL)').run(id,index+1,leg.executor,leg.brief,index===0?'running':'pending',index===0?firstRun:null)
      })()
    },
    stop(id:string,position:number,reason:RelayStop){db.query("UPDATE matter_plan_legs SET state='stopped',stop_reason=? WHERE matter_id=? AND position=? AND state='running' AND EXISTS(SELECT 1 FROM matter_plans WHERE matter_id=? AND state='approved')").run(reason,id,position,id)},
    advance(id:string,from:number,to:number,runId:string){
      db.transaction(()=>{
        const plan=get(id)
        if(plan?.state!=='approved'||plan.legs.find(l=>l.position===from)?.state!=='running')throw Error('matter_plan_stale')
        const changed=db.query("UPDATE matter_plan_legs SET state='running',run_id=?,auto_dispatches=auto_dispatches+1,stop_reason=NULL WHERE matter_id=? AND position=? AND state='pending' AND auto_dispatches=0").run(runId,id,to)
        if(changed.changes!==1)throw Error('matter_plan_stale')
        db.query("UPDATE matter_plan_legs SET state='completed',stop_reason=NULL WHERE matter_id=? AND position=?").run(id,from)
      })()
    },
    resume(id:string,runId:string){db.query("UPDATE matter_plan_legs SET state='running',stop_reason=NULL WHERE matter_id=? AND run_id=? AND state='stopped' AND EXISTS(SELECT 1 FROM matter_plans WHERE matter_id=? AND state='approved')").run(id,runId,id)},
    done(id:string,position:number){db.transaction(()=>{
      if(get(id)?.state!=='approved')throw Error('matter_plan_stale')
      const result=db.query("UPDATE matter_plan_legs SET state='completed',stop_reason=NULL WHERE matter_id=? AND position=? AND state='running'").run(id,position)
      if(result.changes!==1)throw Error('matter_plan_stale')
      db.query("UPDATE matter_plans SET state='done' WHERE matter_id=?").run(id)
    })()},
    recover(){return db.query("UPDATE matter_plan_legs SET state='stopped',stop_reason='leg_interrupted' WHERE state='running' AND matter_id IN (SELECT matter_id FROM matter_plans WHERE state='approved')").run()},
  }
}
