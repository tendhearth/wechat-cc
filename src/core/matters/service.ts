import type {ListMatters,Matter,MatterBinding,MatterSession,MatterStore} from './store'
import {randomUUID} from 'node:crypto'
import type {PendingWorkbenchPermission,PermissionDecision} from '../workbench/permissions'
import type {PendingUserInput} from '../workbench/user-input'
import type {Artifact} from '../workbench/store'
import {normalizeInputRequestId,type LiveInput} from '../workbench/live-inputs'
import type {Attachment} from '../workbench/attachments'
import {sayTextHash,type SayReceipts} from './say-receipts'

/**
 * matters/service.ts — 各表面共用的"一件事"读写面:列表、详情、往一件事说话。
 *
 * 这是统一入口的实体:手机端、桌面、微信管家最终都只调这三个。事件仍从各自的表拼
 * (工作台任务从 workbench 详情取),这里不复制数据。`say` 按 kind 路由:
 * task → 工作台续接;chat → 现有的 app 对话通道(只对主人的 chat)。
 */
export interface MatterTaskView {id:string;title:string;status:string;phase?:string;providerId:string;path:string;error:string|null;updatedAt:number;archivedAt?:number|null;worktree?:{branch:string;removed:boolean;merged?:boolean;projectId?:string}}
export interface MatterEvent {kind:string;text:string;createdAt:number;source?:string;attachments?:Attachment[];errorCode?:'execution_model_unsupported';diagnostic?:string}
export type MatterInput=Pick<LiveInput,'id'|'taskId'|'runId'|'text'|'status'|'attachments'>&Partial<Pick<LiveInput,'error'>>
// 只投影显示材料所需的五个字段；不能把内部存储路径、owner 或草稿身份带到手机。
const publicMaterials=(attachments?:readonly Attachment[])=>attachments?.length?{attachments:attachments.map(({id,name,mime,size,sha256})=>({id,name,mime,size,sha256}))}:{}
const publicInput=({id,taskId,runId,text,status,attachments}:MatterInput):MatterInput=>({id,taskId,runId,text,status,...publicMaterials(attachments)})
const publicEvent=({kind,text,createdAt,source,attachments,errorCode,diagnostic}:MatterEvent):MatterEvent=>({kind,text,createdAt,...(source!==undefined?{source}:{}),...publicMaterials(attachments),...(kind==='error'&&errorCode==='execution_model_unsupported'?{errorCode,...(typeof diagnostic==='string'?{diagnostic}:{} )}:{})})
export interface MatterTaskControls {
  runId?:string;inputMode?:'steer'|'send'|'queue'
  permissions:PendingWorkbenchPermission[];questions:PendingUserInput[];artifacts:Artifact[];inputs:MatterInput[]
}
/** 接过来、还没发第一句的电脑会话:第一句会怎样(spec 2026-10-01-tendhearth-continue-sessions D12)。 */
export interface MatterNativeStart {mode:'native_resume'|'fresh_context';providerId:string}
/** 执行者额度用完:能交给谁 / 没人能接 / 已经交出去了(spec 2026-10-01-tendhearth-continue-sessions §7-3;工作台 service/quota-handoff.ts 算)。 */
export type MatterQuotaHandoff =
  | {state:'offer';from:string;to:string;kind:'quota'|'rate_limit';resetAt:number}
  | {state:'none';from:string;kind:'quota'|'rate_limit';resetAt:number}
  | {state:'handed';from:string;to:string;matterId:string}
export interface MatterDetail extends MatterTaskControls {matter:Matter;bindings:MatterBinding[];sessions:MatterSession[];task:MatterTaskView|null;events:MatterEvent[];nativeStart?:MatterNativeStart;quotaHandoff?:MatterQuotaHandoff}
export interface MatterSayInput {requestId:string;runId?:string;draftId?:string;attachmentIds?:string[]}
type MatterMaterials=Pick<MatterSayInput,'draftId'|'attachmentIds'>
export interface MatterArtifactInput {artifactId:string;sha256:string;offset:number;length?:number}
export const MATTER_ARTIFACT_CHUNK_BYTES=128*1024
export interface MatterArtifactChunk {taskId:string;artifactId:string;name:string;mime:string;size:number;sha256:string;offset:number;nextOffset:number;contentBase64:string}
export interface MattersServiceDeps {
  store:MatterStore
  /** Trusted owner resolver for narrow phone receipt reads; no identity comes from the request. */
  ownerChatId?:()=>string|null
  workbench?:{
    detail(id:string):{task:MatterTaskView;events:MatterEvent[]}&Partial<MatterTaskControls>&{requiresExternalClose?:boolean;continuation?:{mode:string}}
    /** 手机说第一句给「导入了、还没发过第一句」的任务(spec D5);没接 ⇒ 手机也走 continueTask(409)。 */
    continueImported?(id:string,text:string,options:{inputRequestId?:string}&MatterMaterials,attachmentPolicy?:'owner'):Promise<MatterTaskView>
    continueTask(id:string,text:string,options?:{inputRequestId?:string}&MatterMaterials,attachmentPolicy?:'owner'):MatterTaskView
    submitInput?(id:string,input:{runId:string;requestId:string;text:string}&MatterMaterials,attachmentPolicy?:'owner'):Promise<LiveInput>
    inputReceipt?(id:string,requestId:string):LiveInput|null
    resolvePermission?(id:string,requestId:string,decision:PermissionDecision):void
    /** 停下这一轮(与桌面「停止」同一个 cancel;expectedRunId 不对 ⇒ 不停,免得停掉后来的那一轮)。 */
    cancel?(id:string,expectedRunId?:string):Promise<unknown>
    /** 独立工作区:提交到分支 / 删除工作区(2026-10-07,手机也能做)。没接 ⇒ 手机没有这两个按钮。 */
    /** 手机「另做一份」要源项目编号(只给编号,不给路径);没接 ⇒ 手机没有这个按钮。 */
    projects?():ReadonlyArray<{id:string;path:string}>
    worktreeAction?(id:string,action:'commit'|'remove'|'merge'):{branch:string;committed?:boolean;removed?:boolean;merged?:boolean;into?:string}
    resolveAnswer?(id:string,requestId:string,answers:unknown):void
    artifact?(id:string,artifactId:string):{name:string;mime:string;size:number;sha256:string;contentBase64:string}
    /** 额度用完时这件事能不能交给另一位;null = 不用打扰。没接 ⇒ 详情里没有这一块。 */
    quotaHandoff?(id:string):MatterQuotaHandoff|null
    /** 交出去(按 requestId 幂等、一件事只交一次);回新那件的任务 id。 */
    handOff?(id:string,input:{requestId:string;providerId:string}):{taskId:string;created:boolean}
  }
  /** 对主人的 chat 说话(app 对话通道),surface 记这句是从哪个表面来的;recent 读该 chat 的消息流(微信 / 桌面 / 手机三处进同一条)。 */
  chat?:{ownerChatId():string|null;say(text:string,surface?:'desktop'|'phone'):Promise<{reply:string}>;recent?(chatId:string,limit:number):Promise<MatterEvent[]>;search?(chatId:string,query:string,limit:number):Promise<(MatterEvent&{id:string})[]>}
  /** 聊天那件事「说一句」的 requestId 回执(v70);没接 ⇒ 不去重(老行为)。 */
  sayReceipts?:SayReceipts
  now?:()=>number
}
export interface MattersService {
  list(filter?:ListMatters):Matter[]
  detail(id:string):Promise<MatterDetail>
  /** One durable workbench input, including its delivery reason; never loads or mutates the detail. */
  inputReceipt(id:string,requestId:string):MatterInput|null
  /** 主人那条对话(没有就建),并记下是从哪个表面看的;没配主人 → null。 */
  ownerChat(surface:'desktop'|'phone'):Promise<MatterDetail|null>
  say(id:string,text:string,surface?:'desktop'|'phone',input?:MatterSayInput):Promise<{kind:'task';task:MatterTaskView;input?:MatterInput}|{kind:'chat';reply:string}>
  permission(id:string,runId:string,requestId:string,decision:PermissionDecision):void
  answer(id:string,runId:string,requestId:string,answers:unknown):void
  /** 手机上停下正在跑的这一轮(2026-10-06)。runId 必须是手机看到的那一轮;已经换了一轮 / 没在跑 ⇒ input_stale。 */
  stop(id:string,runId:string):Promise<void>
  /** 独立工作区的提交 / 删除(2026-10-07):手机看不到合并命令(在电脑上合并),只回分支和结果。 */
  worktree(id:string,action:'commit'|'remove'|'merge'):{branch:string;committed?:boolean;removed?:boolean;merged?:boolean}
  artifactChunk(id:string,input:MatterArtifactInput):MatterArtifactChunk
  /** 在主人那条对话里搜(2026-10-06,对标 Orca 会话历史搜索):新的在前;没配主人 ⇒ null。 */
  searchOwnerChat(query:string,limit?:number):Promise<{hits:(MatterEvent&{id:string})[]}|null>
  /** 额度用完 ⇒ 交给确认卡上那位继续(同一文件夹新开一件);从手机来的,新那件记手机露面。 */
  handoff(id:string,input:{requestId:string;providerId:string},surface?:'desktop'|'phone'):Promise<{matterId:string;created:boolean}>
}
const ID=/^[a-f0-9]{8}$/

export function makeMattersService(deps:MattersServiceDeps):MattersService {
  /** 同一 requestId 还在说的那一轮:重发直接跟上它,不起第二轮(回执表只管跨重启与已说完的)。 */
  const chatInFlight=new Map<string,Promise<{kind:'chat';reply:string}>>()
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
    inputReceipt(id,requestId){
      if(!ID.test(id))throw Error('invalid_matter_id')
      const key=normalizeInputRequestId(requestId),matter=deps.store.get(id)
      const owner=(deps.ownerChatId??deps.chat?.ownerChatId)?.()??null
      if(!matter||matter.kind!=='task'||!owner||matter.ownerChatId!==owner)return null
      if(!deps.workbench?.inputReceipt)throw Error('workbench_not_wired')
      const input=deps.workbench.inputReceipt(id,key)
      if(!input||input.id!==key||input.taskId!==id)return null
      return {...publicInput(input),error:input.error}
    },
    async detail(id){
      const matter=require(id)
      let task:MatterTaskView|null=null,events:MatterEvent[]=[]
      let controls:MatterTaskControls={permissions:[],questions:[],artifacts:[],inputs:[]}
      let nativeStart:MatterNativeStart|undefined
      let quotaHandoff:MatterQuotaHandoff|undefined
      if(matter.kind==='chat'&&deps.chat?.recent){
        const chatId=deps.store.bindings(id).find(b=>b.surface==='wechat')?.surfaceKey
        if(chatId){try{events=(await deps.chat.recent(chatId,50)).sort((a,b)=>a.createdAt-b.createdAt).map(publicEvent)}catch{/* 读不到消息流,详情本身还在 */}}
      }
      if(matter.kind==='task'&&deps.workbench){
        try{
          const d=taskDetail(matter.id);const wt=(d.task as {worktree?:{branch:string;projectPath?:string;removed:boolean;merged?:boolean}}).worktree;const projectId=wt?.projectPath?deps.workbench.projects?.().find(p=>p.path===wt.projectPath)?.id:undefined;task={...d.task,...(wt?{worktree:{branch:wt.branch,removed:wt.removed,...(wt.merged?{merged:true}:{}),...(projectId?{projectId}:{})}}:{})};events=d.events.slice(-50).map(publicEvent)
          controls={...(d.runId?{runId:d.runId}:{}),...(d.inputMode?{inputMode:d.inputMode}:{}),
            permissions:(d.permissions??[]).filter(p=>p.taskId===id).map(({id,taskId,tool,description,createdAt})=>({id,taskId,tool,description,createdAt})),
            questions:(d.questions??[]).filter(q=>q.taskId===id).map(({id,taskId,createdAt,questions})=>({id,taskId,createdAt,questions:questions.map(({id,header,question,options,multiSelect,allowOther})=>({id,header,question,options:options.map(({label,description})=>({label,description})),multiSelect,allowOther}))})),
            artifacts:(d.artifacts??[]).filter(a=>a.taskId===id).map(({id,taskId,name,mime,size,sha256,createdAt,approvedAt})=>({id,taskId,name,mime,size,sha256,createdAt,approvedAt})),
            inputs:(d.inputs??[]).filter(input=>input.taskId===id).map(publicInput),
          }
          if(d.requiresExternalClose)nativeStart={mode:d.continuation?.mode==='restart_required'?'fresh_context':'native_resume',providerId:d.task.providerId}
        }
        catch{/* 任务记录不在了也不让详情整个失败:matter 本身还在 */}
        try{quotaHandoff=deps.workbench.quotaHandoff?.(matter.id)??undefined}catch{/* 算不出来就不给这一块,详情照旧 */}
      }
      return {matter,bindings:deps.store.bindings(id),sessions:deps.store.sessions(id),task,events,...controls,...(nativeStart?{nativeStart}:{}),...(quotaHandoff?{quotaHandoff}:{})}
    },
    async ownerChat(surface){
      const owner=deps.chat?.ownerChatId();if(!owner)return null
      const m=deps.store.ensureChat(owner);deps.store.bind(m.id,surface,surface==='desktop'?'app':'pwa')
      return this.detail(m.id)
    },
    async say(id,text,surface,input){
      const matter=require(id)
      if(typeof text!=='string'||(!text.trim()&&!(matter.kind==='task'&&Array.isArray(input?.attachmentIds)&&input.attachmentIds.length)))throw new Error('invalid_text')
      if(matter.kind==='task'){
        if(!deps.workbench)throw new Error('workbench_not_wired')
        const d=taskDetail(id)
        const requestId=input?normalizeInputRequestId(input.requestId):undefined
        const materials:MatterMaterials={...(input?.draftId!==undefined?{draftId:input.draftId}:{}),...(input?.attachmentIds!==undefined?{attachmentIds:input.attachmentIds}:{})}
        // 策略来自可信调用表面，Workbench 再解析当前主人；不从请求体接受 owner 或策略。
        const attachmentPolicy=surface==='phone'?'owner':undefined
        // 手机接过来的电脑会话,第一句(spec D5):确认卡就是「原程序已关闭」的声明,令牌在 daemon 里一闪而过。
        // 只认手机(R8):桌面 / 内部 API 照旧拿 409 external_close_confirmation_required,桌面自己的声明按钮不被绕过。
        if(surface==='phone'&&d.requiresExternalClose&&deps.workbench.continueImported){
          await deps.workbench.continueImported(matter.id,text,{...(requestId!==undefined?{inputRequestId:requestId}:{}),...materials},'owner')
          const task=syncTask(id),receipt=requestId?taskDetail(id).inputs?.find(r=>r.taskId===id&&r.id===requestId):undefined
          return {kind:'task',task,...(receipt?{input:publicInput(receipt)}:{})}
        }
        // A retry of a terminal continuation must keep using continueTask's durable
        // input receipt, even when that accepted continuation is now a live run.
        if(input?.runId){
          if(!deps.workbench.submitInput)throw Error('workbench_not_wired')
          const request={requestId:requestId!,runId:input.runId,text,...materials}
          const receipt=await (attachmentPolicy?deps.workbench.submitInput(id,request,attachmentPolicy):deps.workbench.submitInput(id,request))
          return {kind:'task',task:syncTask(id),input:publicInput(receipt)}
        }
        if(!input&&d.runId&&deps.workbench.submitInput){
          const request={runId:d.runId,requestId:randomUUID(),text}
          const receipt=await (attachmentPolicy?deps.workbench.submitInput(id,request,attachmentPolicy):deps.workbench.submitInput(id,request))
          return {kind:'task',task:syncTask(id),input:publicInput(receipt)}
        }
        const options=input?{inputRequestId:requestId,...materials}:undefined
        if(attachmentPolicy)deps.workbench.continueTask(matter.id,text,options,attachmentPolicy)
        else if(options)deps.workbench.continueTask(matter.id,text,options)
        else deps.workbench.continueTask(matter.id,text)
        const task=syncTask(id),receipt=input?taskDetail(id).inputs?.find(r=>r.taskId===id&&r.id===requestId):undefined
        return {kind:'task',task,...(receipt?{input:publicInput(receipt)}:{})}
      }
      if(matter.kind==='chat'){
        if(input?.draftId!==undefined||input?.attachmentIds?.length)throw new Error('matter_say_unsupported')
        if(!deps.chat)throw new Error('chat_not_wired')
        const owner=deps.chat.ownerChatId()
        const boundToOwner=!!owner&&deps.store.bindings(id).some(b=>b.surface==='wechat'&&b.surfaceKey===owner)
        if(!boundToOwner)throw new Error('matter_say_unsupported')
        const chat=deps.chat
        const speak=async():Promise<{kind:'chat';reply:string}>=>{
          const {reply}=await chat.say(text,surface)
          deps.store.touch(id)
          return {kind:'chat',reply}
        }
        // 与工作台输入回执同一规矩:带 requestId ⇒ 同 id 同文的重发拿原来的结果、不再说;同 id 异文 ⇒ input_conflict。
        const receipts=deps.sayReceipts
        if(!input||!receipts)return speak()
        const requestId=normalizeInputRequestId(input.requestId)
        const {fresh,receipt}=receipts.reserve({requestId,matterId:id,textHash:sayTextHash(text)})
        if(!fresh){
          if(receipt.matterId!==id||receipt.textHash!==sayTextHash(text))throw Error('input_conflict')
          const flight=chatInFlight.get(requestId)
          if(flight)return flight
          // 说完了 ⇒ 原来的回复;还是 pending 却没人在说 ⇒ 那一轮被 daemon 重启打断了:这句已经收下、
          // 可能已经进了 CC 的会话,不能再说一遍(同工作台被重启扣下的输入:回执在,重发不再派发)。
          return {kind:'chat',reply:receipt.status==='replied'?receipt.reply??'':''}
        }
        const flight=speak().then(
          result=>{chatInFlight.delete(requestId);try{receipts.settle(requestId,result.reply)}catch{/* 回执写不进不影响这次结果 */}return result},
          error=>{chatInFlight.delete(requestId);try{receipts.drop(requestId)}catch{/* 同上 */}throw error},
        )
        chatInFlight.set(requestId,flight)
        return flight
      }
      throw new Error('matter_say_unsupported')
    },
    async handoff(id,input,surface){
      if(require(id).kind!=='task')throw Error('matter_task_required')
      const requestId=normalizeInputRequestId(input.requestId)
      if(!deps.workbench?.handOff)throw Error('workbench_not_wired')
      const r=deps.workbench.handOff(id,{requestId,providerId:input.providerId})
      const matterId=deps.store.get(r.taskId)?.id??r.taskId
      if(surface==='phone'){try{deps.store.bind(matterId,'phone','pwa')}catch{/* 只是露面登记 */}}
      return {matterId,created:r.created}
    },
    permission(id,runId,requestId,decision){
      if(decision!=='allow'&&decision!=='deny')throw Error('invalid_decision')
      current(id,runId,requestId,'permissions')
      if(!deps.workbench?.resolvePermission)throw Error('workbench_not_wired')
      deps.workbench.resolvePermission(id,requestId,decision)
    },
    worktree(id,action){
      require(id)
      if(!deps.workbench?.worktreeAction)throw Error('workbench_not_wired')
      const r=deps.workbench.worktreeAction(id,action)
      return {branch:r.branch,...(r.committed!==undefined?{committed:r.committed}:{}),...(r.removed?{removed:true}:{}),...(r.merged!==undefined?{merged:r.merged}:{})}
    },
    async stop(id,runId){
      const detail=taskDetail(id)
      if(!runId||detail.runId!==runId)throw Error('input_stale')
      if(!deps.workbench?.cancel)throw Error('workbench_not_wired')
      await deps.workbench.cancel(id,runId)
    },
    answer(id,runId,requestId,answers){
      current(id,runId,requestId,'questions')
      if(!deps.workbench?.resolveAnswer)throw Error('workbench_not_wired')
      deps.workbench.resolveAnswer(id,requestId,answers)
    },
    async searchOwnerChat(query,limit=30){
      const q=query.trim()
      if(!q||q.length>200)throw Error('invalid_query')
      const chatId=deps.chat?.ownerChatId()
      if(!chatId||!deps.chat?.search)return null
      return {hits:await deps.chat.search(chatId,q,Math.max(1,Math.min(50,Math.trunc(limit))))}
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
