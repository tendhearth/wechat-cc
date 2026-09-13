import type {Db} from '../../lib/db'
import type {AgentActivity,AgentEvent} from '../agent-provider'
import type {TaskEvent} from './store'
import type {Attachment} from './attachments'

type EventRow=Omit<TaskEvent,'runId'|'activity'|'attachments'> & {runId:string|null;activityJson:string|null;attachmentsJson:string}
type VisibleEvent=Extract<AgentEvent,{kind:'text'|'tool_call'|'error'}>
const SELECT='SELECT id,task_id AS taskId,kind,text,created_at AS createdAt,source_id AS sourceId,run_id AS runId,activity_json AS activityJson,attachments_json AS attachmentsJson FROM workbench_events'

/** Explicit fields keep future SDK inputs/outputs from silently entering history. */
function publicActivity(a:AgentActivity):AgentActivity {
  return {id:a.id,type:a.type,status:a.status,label:a.label.slice(0,200),
    ...(a.detail?{detail:a.detail.slice(0,2000)}:{}),
    ...(a.parentId?{parentId:a.parentId.slice(0,500)}:{}),
    ...(a.agentIds?{agentIds:a.agentIds.slice(0,20).map(id=>id.slice(0,500))}:{}),
  }
}
function publicEvent({runId,activityJson,attachmentsJson,...row}:EventRow):TaskEvent {
  const attachments=JSON.parse(attachmentsJson) as Attachment[]
  return {...row,...(runId?{runId}:{}),...(activityJson?{activity:JSON.parse(activityJson) as AgentActivity}:{}),...(attachments.length?{attachments}:{})}
}

export function makeTimelineEvents(db:Db) {
  const events=(id:string)=>db.query<EventRow,[string]>(SELECT+' WHERE task_id=? ORDER BY id').all(id).map(publicEvent)
  const addEvent=(id:string,kind:TaskEvent['kind'],text:string,sourceId:string|null=null,runId:string|null=null,attachments:readonly Attachment[]=[])=>Number(
    db.query('INSERT INTO workbench_events(task_id,kind,text,created_at,source_id,run_id,attachments_json) VALUES(?,?,?,?,?,?,?)')
      .run(id,kind,text.slice(0,40_000),Date.now(),sourceId,runId,JSON.stringify(attachments)).lastInsertRowid)
  const recordAgentEvent=(taskId:string,runId:string,event:VisibleEvent)=>db.transaction(()=>{
    const activity=event.kind==='tool_call'&&event.activity?publicActivity(event.activity):undefined
    const nativeId=event.kind==='text'?event.itemId:activity?.id
    const key=nativeId?JSON.stringify([event.kind,nativeId]):null
    const previous=key?db.query<EventRow,[string,string,string]>(SELECT+' WHERE task_id=? AND run_id=? AND event_key=?').get(taskId,runId,key):null
    const content=event.kind==='text'?event.text:event.kind==='error'?event.message:activity?.label??(event.server?`${event.server}/${event.tool}`:event.tool)
    const text=(event.kind==='text'&&event.textMode==='append'?(previous?.text??'')+content:content).slice(0,40_000)
    if(previous) {
      // Duplicate starts may arrive after completion; never turn a finished call back into a spinner.
      if(activity?.status==='running'&&previous.activityJson&&JSON.parse(previous.activityJson).status!=='running')return previous.id
      db.query('UPDATE workbench_events SET text=?,activity_json=? WHERE id=?').run(text,activity?JSON.stringify(activity):null,previous.id)
      return previous.id
    }
    return Number(db.query('INSERT INTO workbench_events(task_id,kind,text,created_at,run_id,event_key,activity_json) VALUES(?,?,?,?,?,?,?)')
      .run(taskId,event.kind,text,Date.now(),runId,key,activity?JSON.stringify(activity):null).lastInsertRowid)
  })()
  const finishRunActivities=(taskId:string,runId:string|null,status:'cancelled'|'interrupted')=>db.transaction(()=>{
    const rows=runId===null
      ?db.query<EventRow,[string]>(SELECT+' WHERE task_id=? AND activity_json IS NOT NULL').all(taskId)
      :db.query<EventRow,[string,string]>(SELECT+' WHERE task_id=? AND run_id=? AND activity_json IS NOT NULL').all(taskId,runId)
    for(const row of rows) {
      const activity=JSON.parse(row.activityJson!) as AgentActivity
      if(activity.status==='running')db.query('UPDATE workbench_events SET activity_json=? WHERE id=?').run(JSON.stringify({...activity,status}),row.id)
    }
  })()
  return {events,addEvent,recordAgentEvent,finishRunActivities}
}
