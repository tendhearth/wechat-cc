import type {Db} from '../../../lib/db'
import type {AgentActivity,AgentEvent} from '../../../ports/agent-provider'
import type { Attachment } from '../../../ports/workbench'
import type {MatterItem,MatterItemKind,MatterItemStatus,MatterLog} from '../../../ports/matters'
import {makeMatterLog} from '../matter-log'
import {isReadyStep} from '../../../domain/matters/ready-step'
import type {WorkbenchTaskEventT} from '@wechat-cc/protocol/desktop-api'

/**
 * 任务的时间线 = 这件事的步(M2,设计稿 2026-10-31 §3.1):一步是 matter_items 里的一行,只经 MatterLog 写。
 * 任务与这件事同 id。payload 里存时间线自己的字段:text、v(写这一步时任务的版本号,`?since=` 用)、sourceId、runId、
 * activity、attachments —— 没有的就不存。
 * 这个文件只剩两件事(M6c):写口,和「步 → WorkbenchTaskEvent」这一个线上投影(桌面 `/v1/workbench/task`;
 * 形状、字段顺序与搬家前的 workbench_events 一字不差,M0 金样钉着)。src 里读时间线一律读步(`timelineSteps` + `stepPayload`)。
 */
/** 写口的种类 = 线上投影的 kind。 */
export type TimelineKind=WorkbenchTaskEventT['kind']
/** 时间线那一步的 payload。 */
export type TimelinePayload={text:string;v:number;sourceId?:string;runId?:string;activity?:AgentActivity;attachments?:Attachment[]}
type EventKind=TimelineKind
type Payload=TimelinePayload
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

/** 这一步是不是时间线上的(你说的 / 执行者说的 / 工具调用 / 系统 / 错误);是 ⇒ 投影里它的 kind。「答完了、闲着」那一步(M6e)是内部事实,不在时间线上。 */
export const timelineKind=(item:MatterItem):TimelineKind|null=>isReadyStep(item)?null:EVENT_KIND[item.kind]??null
export const stepPayload=(item:MatterItem):TimelinePayload=>item.payload as TimelinePayload
/** 只留时间线上的步(权限卡、提问、成果、送达那几种不在这条时间线里)。 */
export const timelineSteps=(items:readonly MatterItem[]):MatterItem[]=>items.filter(item=>timelineKind(item)!==null)

/** 步 → 线上旧形状(WorkbenchTaskEvent)。只在出口用。 */
export function workbenchTaskEvent(item:MatterItem):WorkbenchTaskEventT|null {
  const kind=timelineKind(item);if(!kind)return null
  const p=stepPayload(item)
  return {id:item.id,taskId:item.matterId,kind,text:p.text,createdAt:item.createdAt,sourceId:p.sourceId??null,
    ...(p.runId?{runId:p.runId}:{}),...(item.turnId?{turnId:item.turnId}:{}),...(p.activity?{activity:p.activity}:{}),...(p.attachments?.length?{attachments:p.attachments}:{})}
}

export function makeTimelineEvents(db:Db,log:MatterLog=makeMatterLog(db)) {
  const activeTurn=(matterId:string,runId:string|null)=>runId?db.query<{id:string},[string,string]>("SELECT id FROM matter_turns WHERE matter_id=? AND run_id=? AND status='running' ORDER BY seq DESC LIMIT 1").get(matterId,runId)?.id:null
  /** 这件事时间线上的步,按 seq。 */
  const steps=(id:string)=>timelineSteps(log.items(id))
  /** 线上投影。since:按版本号(事件的 v)筛;sinceCursor(P1b):按这一步最后一次写的全库游标筛 —— 改过的步(工具调用做完)也会再来一次。 */
  const events=(id:string,since?:number,sinceCursor?:number)=>(sinceCursor===undefined?log.items(id):log.items(id,{afterCursor:sinceCursor}))
    .filter(item=>since===undefined||(item.payload as Payload).v>since)
    .map(workbenchTaskEvent).filter((e):e is WorkbenchTaskEventT=>e!==null)
  const addEvent=(id:string,kind:EventKind,text:string,sourceId:string|null=null,runId:string|null=null,attachments:readonly Attachment[]=[],seq:number,turnId?:string|null)=>
    log.writeItem({matterId:id,turnId:turnId===undefined?activeTurn(id,runId):turnId,kind:ITEM_KIND[kind],status:'completed',payload:payloadOf({text:text.slice(0,TEXT_MAX),v:seq,sourceId,runId,attachments})}).id
  const recordAgentEvent=(taskId:string,runId:string,event:VisibleEvent,seq:number)=>{
    const activity=event.kind==='tool_call'&&event.activity?publicActivity(event.activity):undefined
    const nativeId=event.kind==='text'?event.itemId:activity?.id
    const key=nativeId?timelineKey(runId,event.kind,nativeId):null
    const previous=key?log.item(taskId,key):null
    const content=event.kind==='text'?event.text:event.kind==='error'?event.message:activity?.label??(event.server?`${event.server}/${event.tool}`:event.tool)
    const text=(event.kind==='text'&&event.textMode==='append'?((previous?.payload as Payload|undefined)?.text??'')+content:content).slice(0,TEXT_MAX)
    // Duplicate starts may arrive after completion; never turn a finished call back into a spinner(MatterLog 也守着这一条)。
    if(previous&&activity?.status==='running'&&previous.status!=='started')return previous.id
    return log.writeItem({matterId:taskId,turnId:previous?.turnId??activeTurn(taskId,runId),kind:ITEM_KIND[event.kind],status:statusOf(activity),key,payload:payloadOf({text,v:seq,runId,activity})}).id
  }
  const finishRunActivities=(taskId:string,runId:string|null,status:'cancelled'|'interrupted',seq:number)=>{
    for(const item of log.items(taskId)) {
      const p=item.payload as Payload
      if(item.kind!=='tool_call'||!p.activity||p.activity.status!=='running'||!item.key||(runId!==null&&p.runId!==runId))continue
      log.writeItem({matterId:taskId,kind:'tool_call',status:'failed',key:item.key,payload:{...p,v:seq,activity:{...p.activity,status}}})
    }
  }
  return {steps,events,addEvent,recordAgentEvent,finishRunActivities}
}
