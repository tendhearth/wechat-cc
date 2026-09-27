import type {ListMatters,Matter,MatterBinding,MatterSession,MatterStore} from './store'
import {randomUUID} from 'node:crypto'
import type {PendingWorkbenchPermission,PermissionDecision} from '../workbench/permissions'
import type {PendingUserInput} from '../workbench/user-input'
import type {Artifact} from '../workbench/store'
import type {LiveInput} from '../workbench/live-inputs'

/**
 * matters/service.ts — 各表面共用的"一件事"读写面:列表、详情、往一件事说话。
 *
 * 这是统一入口的实体:手机端、桌面、微信管家最终都只调这三个。事件仍从各自的表拼
 * (工作台任务从 workbench 详情取),这里不复制数据。`say` 按 kind 路由:
 * task → 工作台续接;chat → 现有的 app 对话通道(只对主人的 chat)。
 */
export interface MatterTaskView {id:string;title:string;status:string;phase?:string;providerId:string;path:string;error:string|null;updatedAt:number;archivedAt?:number|null}
export interface MatterEvent {kind:string;text:string;createdAt:number;source?:string}
export type MatterInput=Pick<LiveInput,'id'|'taskId'|'runId'|'text'|'status'>
const publicInput=({id,taskId,runId,text,status}:MatterInput):MatterInput=>({id,taskId,runId,text,status})
export interface MatterTaskControls {
  runId?:string;inputMode?:'steer'|'send'|'queue'
  permissions:PendingWorkbenchPermission[];questions:PendingUserInput[];artifacts:Artifact[];inputs:MatterInput[]
}
export interface MatterDetail extends MatterTaskControls {matter:Matter;bindings:MatterBinding[];sessions:MatterSession[];task:MatterTaskView|null;events:MatterEvent[]}
export interface MatterSayInput {requestId:string;runId?:string}
export interface MatterArtifactInput {artifactId:string;sha256:string;offset:number;length?:number}
export const MATTER_ARTIFACT_CHUNK_BYTES=128*1024
export interface MatterArtifactChunk {taskId:string;artifactId:string;name:string;mime:string;size:number;sha256:string;offset:number;nextOffset:number;contentBase64:string}
export interface MattersServiceDeps {
  store:MatterStore
  workbench?:{
    detail(id:string):{task:MatterTaskView;events:Array<{kind:string;text:string;createdAt:number}>}&Partial<MatterTaskControls>
    continueTask(id:string,text:string,options?:{inputRequestId?:string}):MatterTaskView
    submitInput?(id:string,input:{runId:string;requestId:string;text:string}):Promise<LiveInput>
    resolvePermission?(id:string,requestId:string,decision:PermissionDecision):void
    resolveAnswer?(id:string,requestId:string,answers:unknown):void
    artifact?(id:string,artifactId:string):{name:string;mime:string;size:number;sha256:string;contentBase64:string}
  }
  /** 对主人的 chat 说话(app 对话通道),surface 记这句是从哪个表面来的;recent 读该 chat 的消息流(微信 / 桌面 / 手机三处进同一条)。 */
  chat?:{ownerChatId():string|null;say(text:string,surface?:'desktop'|'phone'):Promise<{reply:string}>;recent?(chatId:string,limit:number):Promise<MatterEvent[]>}
  now?:()=>number
}
export interface MattersService {
  list(filter?:ListMatters):Matter[]
  detail(id:string):Promise<MatterDetail>
  /** 主人那条对话(没有就建),并记下是从哪个表面看的;没配主人 → null。 */
  ownerChat(surface:'desktop'|'phone'):Promise<MatterDetail|null>
  say(id:string,text:string,surface?:'desktop'|'phone',input?:MatterSayInput):Promise<{kind:'task';task:MatterTaskView;input?:MatterInput}|{kind:'chat';reply:string}>
  permission(id:string,runId:string,requestId:string,decision:PermissionDecision):void
  answer(id:string,runId:string,requestId:string,answers:unknown):void
  artifactChunk(id:string,input:MatterArtifactInput):MatterArtifactChunk
}
const ID=/^[a-f0-9]{8}$/

export function makeMattersService(deps:MattersServiceDeps):MattersService {
  const require=(id:string):Matter=>{if(!ID.test(id))throw new Error('invalid_matter_id');const m=deps.store.get(id);if(!m)throw new Error('matter_not_found');return m}
  const taskDetail=(id:string)=>{
    if(require(id).kind!=='task')throw Error('matter_task_required')
    if(!deps.workbench)throw Error('workbench_not_wired')
    const detail=deps.workbench.detail(id)
    if(detail.task.id!==id)throw Error('matter_not_found')
    return detail
  }
  const current=(id:string,runId:string,requestId:string,kind:'permissions'|'questions')=>{
    const detail=taskDetail(id),stale=kind==='permissions'?'permission_stale':'question_stale'
    if(!runId||detail.runId!==runId||!detail[kind]?.some(r=>r.taskId===id&&r.id===requestId))throw Error(stale)
    return detail
  }
  const syncTask=(id:string)=>{
    const task=taskDetail(id).task
    // Receipt replay can refer to a finished or archived task. Derive its
    // actual current state, including a newly queued continuation, rather than
    // interpreting every successful request as a new running turn.
    deps.store.setStatus(id,task.archivedAt!=null?'archived':task.status==='interrupted'?'open':['completed','failed','cancelled'].includes(task.status)?'done':task.phase==='replied'?'replied':'open')
    return task
  }
  return {
    list:filter=>deps.store.list(filter),
    async detail(id){
      const matter=require(id)
      let task:MatterTaskView|null=null,events:MatterEvent[]=[]
      let controls:MatterTaskControls={permissions:[],questions:[],artifacts:[],inputs:[]}
      if(matter.kind==='chat'&&deps.chat?.recent){
        const chatId=deps.store.bindings(id).find(b=>b.surface==='wechat')?.surfaceKey
        if(chatId){try{events=(await deps.chat.recent(chatId,50)).sort((a,b)=>a.createdAt-b.createdAt)}catch{/* 读不到消息流,详情本身还在 */}}
      }
      if(matter.kind==='task'&&deps.workbench){
        try{
          const d=taskDetail(matter.id);task=d.task;events=d.events.slice(-50).map(e=>({kind:e.kind,text:e.text,createdAt:e.createdAt}))
          controls={...(d.runId?{runId:d.runId}:{}),...(d.inputMode?{inputMode:d.inputMode}:{}),
            permissions:(d.permissions??[]).filter(p=>p.taskId===id).map(({id,taskId,tool,description,createdAt})=>({id,taskId,tool,description,createdAt})),
            questions:(d.questions??[]).filter(q=>q.taskId===id).map(({id,taskId,createdAt,questions})=>({id,taskId,createdAt,questions:questions.map(({id,header,question,options,multiSelect,allowOther})=>({id,header,question,options:options.map(({label,description})=>({label,description})),multiSelect,allowOther}))})),
            artifacts:(d.artifacts??[]).filter(a=>a.taskId===id).map(({id,taskId,name,mime,size,sha256,createdAt,approvedAt})=>({id,taskId,name,mime,size,sha256,createdAt,approvedAt})),
            inputs:(d.inputs??[]).filter(input=>input.taskId===id).map(publicInput),
          }
        }
        catch{/* 任务记录不在了也不让详情整个失败:matter 本身还在 */}
      }
      return {matter,bindings:deps.store.bindings(id),sessions:deps.store.sessions(id),task,events,...controls}
    },
    async ownerChat(surface){
      const owner=deps.chat?.ownerChatId();if(!owner)return null
      const m=deps.store.ensureChat(owner);deps.store.bind(m.id,surface,surface==='desktop'?'app':'pwa')
      return this.detail(m.id)
    },
    async say(id,text,surface,input){
      const matter=require(id)
      if(typeof text!=='string'||!text.trim())throw new Error('invalid_text')
      if(matter.kind==='task'){
        if(!deps.workbench)throw new Error('workbench_not_wired')
        const d=taskDetail(id)
        // A retry of a terminal continuation must keep using continueTask's durable
        // input receipt, even when that accepted continuation is now a live run.
        if(input?.runId){
          if(!deps.workbench.submitInput)throw Error('workbench_not_wired')
          const receipt=await deps.workbench.submitInput(id,{...input,runId:input.runId,text})
          return {kind:'task',task:syncTask(id),input:publicInput(receipt)}
        }
        if(!input&&d.runId&&deps.workbench.submitInput){
          const receipt=await deps.workbench.submitInput(id,{runId:d.runId,requestId:randomUUID(),text})
          return {kind:'task',task:syncTask(id),input:publicInput(receipt)}
        }
        if(input)deps.workbench.continueTask(matter.id,text,{inputRequestId:input.requestId});else deps.workbench.continueTask(matter.id,text)
        const task=syncTask(id),receipt=input?taskDetail(id).inputs?.find(r=>r.taskId===id&&r.id===input.requestId):undefined
        return {kind:'task',task,...(receipt?{input:publicInput(receipt)}:{})}
      }
      if(matter.kind==='chat'){
        if(!deps.chat)throw new Error('chat_not_wired')
        const owner=deps.chat.ownerChatId()
        const boundToOwner=!!owner&&deps.store.bindings(id).some(b=>b.surface==='wechat'&&b.surfaceKey===owner)
        if(!boundToOwner)throw new Error('matter_say_unsupported')
        const {reply}=await deps.chat.say(text,surface)
        deps.store.touch(id)
        return {kind:'chat',reply}
      }
      throw new Error('matter_say_unsupported')
    },
    permission(id,runId,requestId,decision){
      if(decision!=='allow'&&decision!=='deny')throw Error('invalid_decision')
      current(id,runId,requestId,'permissions')
      if(!deps.workbench?.resolvePermission)throw Error('workbench_not_wired')
      deps.workbench.resolvePermission(id,requestId,decision)
    },
    answer(id,runId,requestId,answers){
      current(id,runId,requestId,'questions')
      if(!deps.workbench?.resolveAnswer)throw Error('workbench_not_wired')
      deps.workbench.resolveAnswer(id,requestId,answers)
    },
    artifactChunk(id,input){
      const d=taskDetail(id),artifact=d.artifacts?.find(a=>a.taskId===id&&a.id===input.artifactId)
      if(!artifact)throw Error('not_found')
      if(artifact.sha256!==input.sha256)throw Error('artifact_changed')
      const length=input.length??MATTER_ARTIFACT_CHUNK_BYTES
      if(!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>artifact.size||!Number.isSafeInteger(length)||length<1||length>MATTER_ARTIFACT_CHUNK_BYTES)throw Error('invalid_request')
      if(!deps.workbench?.artifact)throw Error('workbench_not_wired')
      const snapshot=deps.workbench.artifact(id,input.artifactId)
      if(snapshot.sha256!==input.sha256||snapshot.size!==artifact.size)throw Error('artifact_changed')
      const bytes=Buffer.from(snapshot.contentBase64,'base64'),chunk=bytes.subarray(input.offset,input.offset+length)
      if(bytes.length!==artifact.size)throw Error('artifact_changed')
      return {taskId:id,artifactId:artifact.id,name:artifact.name,mime:artifact.mime,size:artifact.size,sha256:artifact.sha256,offset:input.offset,nextOffset:input.offset+chunk.length,contentBase64:chunk.toString('base64')}
    },
  }
}
