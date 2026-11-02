import type {Db} from '../../../lib/db'
import type {AgentActivity,AgentEvent} from '../../../ports/agent-provider'
import type { Attachment } from '../../../ports/workbench'
import type {MatterItem,MatterItemKind,MatterItemStatus,MatterLog} from '../../../ports/matters'
import {makeMatterLog} from '../matter-log'

export interface TaskEvent { id: number; taskId: string; kind: 'user' | 'text' | 'tool_call' | 'system' | 'error'; text: string; createdAt: number; sourceId?:string|null; runId?:string; activity?:AgentActivity; attachments?:Attachment[]; errorCode?:'execution_model_unsupported'; diagnostic?:string }

/**
 * 任务的时间线 = 这件事的步(M2,设计稿 2026-10-31 §3.1):一条 TaskEvent 是 matter_items 里的一步,只经 MatterLog 写。
 * 任务与这件事同 id。payload 里存时间线自己的字段:text、v(写这一步时任务的版本号,`?since=` 用)、sourceId、runId、
 * activity、attachments —— 没有的就不存。读出来的形状、字段顺序与搬家前(workbench_events)一字不差(M0 金样钉着)。
 */
type EventKind=TaskEvent['kind']
type Payload={text:string;v:number;sourceId?:string;runId?:string;activity?:AgentActivity;attachments?:Attachment[]}
type VisibleEvent=Extract<AgentEvent,{kind:'text'|'tool_call'|'error'}>
const ITEM_KIND:Record<EventKind,MatterItemKind>={user:'user_message',text:'agent_message',tool_call:'tool_call',system:'system',error:'error'}
const EVENT_KIND:Partial<Record<MatterItemKind,EventKind>>={user_message:'user',agent_message:'text',tool_call:'tool_call',system:'system',error:'error'}
const TEXT_MAX=40_000

/** Explicit fields keep future SDK inputs/outputs from silently entering history. */
function publicActivity(a:AgentActivity):AgentActivity {
  return {id:a.id,type:a.type,status:a.status,label:a.label.slice(0,200),
    ...(a.detail?{detail:a.detail.slice(0,2000)}:{}),
    ...(a.output?{output:a.output.slice(0,40_000)}:{}),
    ...(a.parentId?{parentId:a.parentId.slice(0,500)}:{}),
    ...(a.agentIds?{agentIds:a.agentIds.slice(0,20).map(id=>id.slice(0,500))}:{}),
  }
}
/** 步的状态跟着工具调用自己的状态走:还在跑 ⇒ started;做完 ⇒ completed;失败 / 取消 / 中断 ⇒ failed。其余步一写就是 completed。 */
const statusOf=(activity?:AgentActivity):MatterItemStatus=>!activity||activity.status==='completed'?'completed':activity.status==='running'?'started':'failed'
/** 同一个执行者 item 在一次 run 里只一行(搬家前是 (task_id, run_id, event_key) 唯一);matter 里 key 要带上 run。 */
export const timelineKey=(runId:string,kind:EventKind,nativeId:string)=>JSON.stringify([runId,JSON.stringify([kind,nativeId])])
const payloadOf=(p:{text:string;v:number;sourceId?:string|null;runId?:string|null;activity?:AgentActivity;attachments?:readonly Attachment[]}):Payload=>({text:p.text,v:p.v,
  ...(p.sourceId?{sourceId:p.sourceId}:{}),...(p.runId?{runId:p.runId}:{}),...(p.activity?{activity:p.activity}:{}),...(p.attachments?.length?{attachments:[...p.attachments]}:{})})

function publicEvent(item:MatterItem):TaskEvent|null {
  const kind=EVENT_KIND[item.kind];if(!kind)return null
  const p=item.payload as Payload
  return {id:item.id,taskId:item.matterId,kind,text:p.text,createdAt:item.createdAt,sourceId:p.sourceId??null,
    ...(p.runId?{runId:p.runId}:{}),...(p.activity?{activity:p.activity}:{}),...(p.attachments?.length?{attachments:p.attachments}:{})}
}

export function makeTimelineEvents(db:Db,log:MatterLog=makeMatterLog(db)) {
  /** since:按版本号(事件的 v)筛;sinceCursor(P1b):按这一步最后一次写的全库游标筛 —— 改过的步(工具调用做完)也会再来一次。 */
  const events=(id:string,since?:number,sinceCursor?:number)=>(sinceCursor===undefined?log.items(id):log.items(id,{afterCursor:sinceCursor}))
    .filter(item=>since===undefined||(item.payload as Payload).v>since)
    .map(publicEvent).filter((e):e is TaskEvent=>e!==null)
  const addEvent=(id:string,kind:EventKind,text:string,sourceId:string|null=null,runId:string|null=null,attachments:readonly Attachment[]=[],seq:number)=>
    log.writeItem({matterId:id,kind:ITEM_KIND[kind],status:'completed',payload:payloadOf({text:text.slice(0,TEXT_MAX),v:seq,sourceId,runId,attachments})}).id
  const recordAgentEvent=(taskId:string,runId:string,event:VisibleEvent,seq:number)=>{
    const activity=event.kind==='tool_call'&&event.activity?publicActivity(event.activity):undefined
    const nativeId=event.kind==='text'?event.itemId:activity?.id
    const key=nativeId?timelineKey(runId,event.kind,nativeId):null
    const previous=key?log.item(taskId,key):null
    const content=event.kind==='text'?event.text:event.kind==='error'?event.message:activity?.label??(event.server?`${event.server}/${event.tool}`:event.tool)
    const text=(event.kind==='text'&&event.textMode==='append'?((previous?.payload as Payload|undefined)?.text??'')+content:content).slice(0,TEXT_MAX)
    // Duplicate starts may arrive after completion; never turn a finished call back into a spinner(MatterLog 也守着这一条)。
    if(previous&&activity?.status==='running'&&previous.status!=='started')return previous.id
    return log.writeItem({matterId:taskId,kind:ITEM_KIND[event.kind],status:statusOf(activity),key,payload:payloadOf({text,v:seq,runId,activity})}).id
  }
  const finishRunActivities=(taskId:string,runId:string|null,status:'cancelled'|'interrupted',seq:number)=>{
    for(const item of log.items(taskId)) {
      const p=item.payload as Payload
      if(item.kind!=='tool_call'||!p.activity||p.activity.status!=='running'||!item.key||(runId!==null&&p.runId!==runId))continue
      log.writeItem({matterId:taskId,kind:'tool_call',status:'failed',key:item.key,payload:{...p,v:seq,activity:{...p.activity,status}}})
    }
  }
  return {events,addEvent,recordAgentEvent,finishRunActivities}
}
