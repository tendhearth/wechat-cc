import type {CandidateResult,CandidateStatus} from '../../domain/matter-parallel'
import type {Db} from '../../lib/db'
import type {RelayLeg,RelayStop} from '../../domain/relay-decision'

export interface PlanLeg extends RelayLeg {executor:string;brief:string;runId:string|null;stopReason:RelayStop|null}
export interface MatterPlan {matterId:string;state:'approved'|'cancelled'|'done';approvedAt:number;createdAt:number;legs:PlanLeg[]}
export type PlanBrief=Pick<PlanLeg,'executor'|'brief'>&{parallel?:readonly string[]}
export interface PlanCandidate {
  matterId:string;position:number;ordinal:number;executor:string;taskId:string|null;runId:string|null
  status:CandidateStatus;result:CandidateResult|null;chosen:boolean
}
type CandidateRow=Omit<PlanCandidate,'result'|'chosen'>&{result:string|null;chosen:number}
const CANDIDATE_COLUMNS='matter_id AS matterId,position,ordinal,executor,task_id AS taskId,run_id AS runId,status,result,chosen'
const candidate=(row:CandidateRow):PlanCandidate=>({...row,result:row.result?JSON.parse(row.result):null,chosen:row.chosen===1})
export const isRelayContinue=(text:string)=>/^继续(?:\s|[，,。.!！]|$)/.test(text.trim())

export function makeMatterPlans(db:Db,now=()=>Date.now()){
  function get(id:string):MatterPlan|null{
    const plan=db.query<Omit<MatterPlan,'legs'>,[string]>('SELECT matter_id AS matterId,state,approved_at AS approvedAt,created_at AS createdAt FROM matter_plans WHERE matter_id=?').get(id)
    return plan?{...plan,legs:db.query<PlanLeg,[string]>('SELECT position,executor,brief,state,run_id AS runId,auto_dispatches AS autoDispatches,stop_reason AS stopReason FROM matter_plan_legs WHERE matter_id=? ORDER BY position').all(id)}:null
  }
  const candidates=(id:string,position?:number)=>db.query<CandidateRow,[string,number|null,number|null]>(
    `SELECT ${CANDIDATE_COLUMNS} FROM matter_plan_candidates WHERE matter_id=? AND (? IS NULL OR position=?) ORDER BY position,ordinal`,
  ).all(id,position??null,position??null).map(candidate)
  function candidateForTask(id:string):PlanCandidate|null{
    const row=db.query<CandidateRow,[string]>(`SELECT ${CANDIDATE_COLUMNS} FROM matter_plan_candidates WHERE task_id=?`).get(id)
    return row?candidate(row):null
  }
  const root=(id:string)=>candidateForTask(id)?.matterId??id
  const activeTask=(id:string,before=Infinity)=>candidates(id).filter(c=>c.position<before&&c.chosen).at(-1)?.taskId??id
  function cancel(id:string):boolean{return db.query("UPDATE matter_plans SET state='cancelled' WHERE matter_id=? AND state='approved'").run(id).changes>0}
  const consumeDispatch=(id:string,from:number|null)=>{
    db.query('UPDATE matter_plan_comparisons SET dispatch_pending=0 WHERE matter_id=? AND position=?').run(id,from)
  }
  return {
    comparison:(id:string,position:number)=>db.query<{revision:number;text:string|null},[string,number]>(
      'SELECT revision,text FROM matter_plan_comparisons WHERE matter_id=? AND position=?').get(id,position),
    saveComparison(id:string,position:number,text:string){
      return db.query<{revision:number},[string,number,string]>(`INSERT INTO matter_plan_comparisons(matter_id,position,text) VALUES(?,?,?)
        ON CONFLICT(matter_id,position) DO UPDATE SET text=excluded.text,enqueued=0 WHERE text IS NULL RETURNING revision`).get(id,position,text)
    },
    comparisonIntents(owner:string){
      return db.query<{matterId:string;position:number;revision:number;text:string},[string]>(`SELECT c.matter_id AS matterId,c.position,c.revision,c.text FROM matter_plan_comparisons c
        JOIN workbench_tasks t ON t.id=c.matter_id WHERE t.owner_chat_id=? AND t.archived_at IS NULL AND c.text IS NOT NULL AND c.enqueued=0`).all(owner)
    },
    comparisonEnqueued(id:string,position:number,revision:number){
      db.query('UPDATE matter_plan_comparisons SET enqueued=1 WHERE matter_id=? AND position=? AND revision=?').run(id,position,revision)
    },
    dispatchIntents(owner:string){
      return db.query<{matterId:string},[string]>(`SELECT c.matter_id AS matterId FROM matter_plan_comparisons c
        JOIN matter_plans p ON p.matter_id=c.matter_id JOIN workbench_tasks t ON t.id=c.matter_id
        WHERE p.state='approved' AND c.dispatch_pending=1 AND t.owner_chat_id=? AND t.archived_at IS NULL`).all(owner)
    },
    choiceReceipt(id:string,hash:string){
      const row=db.query<{commandHash:string;reply:string},[string]>('SELECT command_hash AS commandHash,reply FROM matter_plan_choice_receipts WHERE request_id=?').get(id)
      if(row&&row.commandHash!==hash)throw Error('control_conflict')
      return row?.reply
    },
    saveChoiceReceipt(id:string,hash:string,taskId:string|null,reply:string){
      db.query('INSERT INTO matter_plan_choice_receipts VALUES(?,?,?,?)').run(id,hash,taskId,reply)
    },
    reopenCandidate(taskId:string,runId:string|undefined){
      const member=candidateForTask(taskId)
      if(!member||member.chosen||member.runId!==runId)return null
      const plan=get(member.matterId)
      if(plan?.state!=='approved'||plan.legs.find(l=>l.position===member.position)?.state!=='running')return null
      const {matterId,position,ordinal}=member
      db.query("UPDATE matter_plan_candidates SET status='running',result=NULL WHERE matter_id=? AND position=? AND ordinal=?").run(matterId,position,ordinal)
      db.query('UPDATE matter_plan_comparisons SET text=NULL,revision=revision+1 WHERE matter_id=? AND position=? AND text IS NOT NULL').run(matterId,position)
      return matterId
    },
    refreshCandidate(member:PlanCandidate,result:CandidateResult){
      const {matterId,position,ordinal}=member
      db.query('UPDATE matter_plan_candidates SET result=? WHERE matter_id=? AND position=? AND ordinal=?').run(JSON.stringify(result),matterId,position,ordinal)
      db.query('UPDATE matter_plan_comparisons SET text=NULL,revision=revision+1 WHERE matter_id=? AND position=? AND text IS NOT NULL').run(matterId,position)
    },
    pendingChoices(owner:string){
      return db.query<{matterId:string;position:number},[string]>(`SELECT l.matter_id AS matterId,l.position FROM matter_plan_legs l
        JOIN matter_plans p ON p.matter_id=l.matter_id
        JOIN workbench_tasks t ON t.id=l.matter_id
        WHERE p.state='approved' AND l.state='running' AND t.owner_chat_id=? AND t.archived_at IS NULL
        AND EXISTS(SELECT 1 FROM matter_plan_candidates c WHERE c.matter_id=l.matter_id AND c.position=l.position)`).all(owner)
    },
    get,cancel,candidates,candidateForTask,root,activeTask,
    groups(id:string){
      const all=candidates(root(id))
      return [...new Set(all.map(c=>c.position))].map(position=>({position,
        members:all.filter(c=>c.position===position).map(({executor,taskId,status,chosen})=>({executor,taskId,status,chosen})),
      }))
    },
    bindCandidate(id:string,position:number,ordinal:number,taskId:string,runId:string){
      const changed=db.query("UPDATE matter_plan_candidates SET task_id=?,run_id=? WHERE matter_id=? AND position=? AND ordinal=? AND status='queued' AND task_id IS NULL").run(taskId,runId,id,position,ordinal)
      if(changed.changes!==1)throw Error('matter_plan_stale')
    },
    progressCandidate(runId:string,status:'running'|'waiting'){
      db.query("UPDATE matter_plan_candidates SET status=? WHERE run_id=? AND status IN ('queued','running','waiting')").run(status,runId)
    },
    settleCandidate(id:string,position:number,ordinal:number,status:CandidateStatus,result:CandidateResult|null){
      return db.query("UPDATE matter_plan_candidates SET status=?,result=? WHERE matter_id=? AND position=? AND ordinal=? AND status IN ('queued','running','waiting')").run(status,result?JSON.stringify(result):null,id,position,ordinal).changes===1
    },
    openGroup(id:string,from:number|null,to:number,ownerResume:boolean){
      db.transaction(()=>{
        const plan=get(id),current=plan?.legs.find(l=>l.position===from)
        const allowed=ownerResume?current?.state==='completed':current?.state==='running'
        if(plan?.state!=='approved'||!allowed||plan.legs.find(l=>l.state==='pending')?.position!==to)throw Error('matter_plan_stale')
        db.query("UPDATE matter_plan_legs SET state='completed',stop_reason=NULL WHERE matter_id=? AND position=?").run(id,from)
        db.query("UPDATE matter_plan_legs SET state='running',auto_dispatches=auto_dispatches+?,stop_reason=NULL WHERE matter_id=? AND position=?").run(ownerResume?0:1,id,to)
        consumeDispatch(id,from)
      })()
    },
    choose(id:string,position:number,ordinal:number){
      db.transaction(()=>{
        const plan=get(id)
        if(plan?.state!=='approved'||plan.legs.find(l=>l.position===position)?.state!=='running')throw Error('matter_parallel_not_ready')
        const changed=db.query("UPDATE matter_plan_candidates SET chosen=1 WHERE matter_id=? AND position=? AND ordinal=? AND task_id IS NOT NULL AND status IN ('completed','failed','cancelled','interrupted')").run(id,position,ordinal)
        if(changed.changes!==1)throw Error('matter_parallel_not_ready')
        db.query("UPDATE matter_plan_legs SET state='completed' WHERE matter_id=? AND position=?").run(id,position)
        if(plan.legs.some(l=>l.position>position))db.query('UPDATE matter_plan_comparisons SET dispatch_pending=1 WHERE matter_id=? AND position=?').run(id,position)
        else db.query("UPDATE matter_plans SET state='done' WHERE matter_id=?").run(id)
      })()
    },
    approve(id:string,legs:readonly PlanBrief[],firstRun:string,firstExecutor=legs[0]?.executor){
      if(!legs.length||legs.length>6||legs.length===1&&!legs[0]?.parallel)throw Error('invalid_matter_plan')
      db.transaction(()=>{
        const at=now();db.query("INSERT INTO matter_plans VALUES(?,'approved',?,?)").run(id,at,at)
        for(const [index,leg]of legs.entries()){
          db.query('INSERT INTO matter_plan_legs VALUES(?,?,?,?,?,?,0,NULL)').run(id,index+1,leg.executor,leg.brief,index===0?'running':'pending',index===0&&!leg.parallel?firstRun:null)
          for(const [member,executor]of (leg.parallel??[]).entries()){
            const first=index===0&&executor===firstExecutor
            db.query("INSERT INTO matter_plan_candidates(matter_id,position,ordinal,executor,task_id,run_id,status) VALUES(?,?,?,?,?,?,'queued')").run(id,index+1,member+1,executor,first?id:null,first?firstRun:null)
          }
        }
      })()
    },
    stop(id:string,position:number,reason:RelayStop){db.query("UPDATE matter_plan_legs SET state='stopped',stop_reason=? WHERE matter_id=? AND position=? AND state='running' AND EXISTS(SELECT 1 FROM matter_plans WHERE matter_id=? AND state='approved')").run(reason,id,position,id)},
    hold(id:string,from:number|null,to:number,reason:RelayStop){
      db.transaction(()=>{
        const plan=get(id),current=plan?.legs.find(l=>l.position===from),next=plan?.legs.find(l=>l.position===to)
        if(plan?.state!=='approved'||next?.state!=='pending'||(from!==null&&(!current||!['running','completed'].includes(current.state))))throw Error('matter_plan_stale')
        if(current)db.query("UPDATE matter_plan_legs SET state='completed',stop_reason=NULL WHERE matter_id=? AND position=?").run(id,from)
        db.query("UPDATE matter_plan_legs SET stop_reason=? WHERE matter_id=? AND position=? AND state='pending'").run(reason,id,to)
      })()
    },
    advance(id:string,from:number|null,to:number,runId:string,ownerResume=false){
      db.transaction(()=>{
        const plan=get(id),current=plan?.legs.find(l=>l.position===from)
        if(plan?.state!=='approved')throw Error('matter_plan_stale')
        if(ownerResume){
          if(plan.legs.some(l=>l.state==='running'||l.state==='stopped')||plan.legs.find(l=>l.state==='pending')?.position!==to||plan.legs.some(l=>l.position>to&&l.state!=='pending')||(from!==null&&current?.state!=='completed'))throw Error('matter_plan_stale')
        }else if(current?.state!=='running')throw Error('matter_plan_stale')
        const changed=db.query(`UPDATE matter_plan_legs SET state='running',run_id=?,auto_dispatches=auto_dispatches+?,stop_reason=NULL WHERE matter_id=? AND position=? AND state='pending'${ownerResume?'':' AND auto_dispatches=0'}`).run(runId,ownerResume?0:1,id,to)
        if(changed.changes!==1)throw Error('matter_plan_stale')
        if(current)db.query("UPDATE matter_plan_legs SET state='completed',stop_reason=NULL WHERE matter_id=? AND position=?").run(id,from)
        consumeDispatch(id,from)
      })()
    },
    resume(id:string,runId:string){db.query("UPDATE matter_plan_legs SET state='running',stop_reason=NULL WHERE matter_id=? AND run_id=? AND state='stopped' AND EXISTS(SELECT 1 FROM matter_plans WHERE matter_id=? AND state='approved')").run(id,runId,id)},
    done(id:string,position?:number){db.transaction(()=>{
      const plan=get(id)
      if(plan?.state!=='approved')throw Error('matter_plan_stale')
      if(position!==undefined){
        const result=db.query("UPDATE matter_plan_legs SET state='completed',stop_reason=NULL WHERE matter_id=? AND position=? AND state='running'").run(id,position)
        if(result.changes!==1)throw Error('matter_plan_stale')
      }else if(plan.legs.some(l=>l.state!=='completed'))throw Error('matter_plan_stale')
      db.query("UPDATE matter_plans SET state='done' WHERE matter_id=?").run(id)
    })()},
    recover(){
      db.query("UPDATE matter_plan_candidates AS c SET status='interrupted' WHERE status IN ('queued','running','waiting') AND EXISTS(SELECT 1 FROM matter_plan_legs l WHERE l.matter_id=c.matter_id AND l.position=c.position AND l.state='running')").run()
      return db.query("UPDATE matter_plan_legs AS l SET state='stopped',stop_reason='leg_interrupted' WHERE state='running' AND matter_id IN (SELECT matter_id FROM matter_plans WHERE state='approved') AND NOT EXISTS(SELECT 1 FROM matter_plan_candidates c WHERE c.matter_id=l.matter_id AND c.position=l.position)").run()
    },
  }
}
