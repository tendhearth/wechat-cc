import type { ListMatters, Matter, MatterActStep, MatterActTurn, MatterBinding, MatterLog, MatterOrigin, MatterSession, MatterStore, MatterTurn, SayReceipts } from '../../ports/matters'
import {randomUUID} from '../../lib/random'
import type { PendingWorkbenchPermission, PermissionDecision, PendingUserInput, Artifact, LiveInput, Attachment } from '../../ports/workbench'
import { normalizeInputRequestId } from '../../domain/workbench/input-request-id'
import { sayTextHash } from '../../lib/content-hash'
import {phoneScripts,type PhoneScripts} from '../../domain/matters/phone-scripts'
import {lifecycleOfTaskView,wireMatter,type WireMatter} from '../../domain/matters/legacy-status'
import {phoneMayOpenMatter} from '../../domain/matters/phone-scope'
import {isReadyStep} from '../../domain/matters/ready-step'
import {latestChanges,type ReviewTurnLike} from '../../domain/matters/phone-changes'
import type {ChatAttachmentT,MatterEventT} from '@wechat-cc/protocol'

/**
 * matters/service.ts — 各表面共用的"一件事"读写面:列表、详情、往一件事说话。
 *
 * 这是统一入口的实体:手机端、桌面、微信管家最终都只调这三个。事件仍从各自的表拼
 * (工作台任务从 workbench 详情取),这里不复制数据。`say` 按 kind 路由:
 * task → 工作台续接;chat → 现有的 app 对话通道(只对主人的 chat)。
 */
export interface MatterTaskView {id:string;title:string;status:string;phase?:string;providerId:string;path:string;error:string|null;updatedAt:number;archivedAt?:number|null;worktree?:{branch:string;removed:boolean;merged?:boolean;projectId?:string}&PhoneScripts;until?:{command:string;maxRounds:number;rounds:number;status:'active'|'passed'|'exhausted'|'stopped';lastExit:number|null;stopReason:string|null};rewind?:{blocked:boolean}}
// activity(2026-10-17):工具那一步在跑还是做完了 —— 手机看着它跑要知道「正在」哪一步。只给 type/status/label,不给命令输出。
/**
 * 详情 events 的一条(线上旧形状,M6c 起 src 不再手写):任务 = 时间线的步投影成 WorkbenchTaskEvent 再收窄到这里;
 * 对话 = messages 表(正文唯一来源,§8.4,daemon/wiring/owner-chat-reading.ts);终端 / act 是空的。
 * 形状是协议包的 MatterEventT;对话那几条还多带 messageId / replyExtras(桌面 converse.js 读,App 的 zod 丢掉不认)。
 */
export type MatterDetailEvent=MatterEventT&{messageId?:string;replyExtras?:{attachments?:ChatAttachmentT[];narration?:string[]}}
export type MatterInput=Pick<LiveInput,'id'|'taskId'|'runId'|'text'|'status'|'attachments'>&Partial<Pick<LiveInput,'error'>>
// 只投影显示材料所需的五个字段；不能把内部存储路径、owner 或草稿身份带到手机。
const publicMaterials=(attachments?:readonly Attachment[])=>attachments?.length?{attachments:attachments.map(({id,name,mime,size,sha256})=>({id,name,mime,size,sha256}))}:{}
const publicInput=({id,taskId,runId,text,status,attachments}:MatterInput):MatterInput=>({id,taskId,runId,text,status,...publicMaterials(attachments)})
const publicEvent=({kind,text,createdAt,source,attachments,errorCode,diagnostic,activity,messageId,replyExtras}:MatterDetailEvent):MatterDetailEvent=>({kind,text,createdAt,...(messageId?{messageId}:{}),...(replyExtras?{replyExtras}:{}),...(source!==undefined?{source}:{}),...(kind==='tool_call'&&activity&&typeof activity.status==='string'?{activity:{type:String(activity.type),status:activity.status,label:String(activity.label??'').slice(0,200)}}:{}),...publicMaterials(attachments),...(kind==='error'&&errorCode==='execution_model_unsupported'?{errorCode,...(typeof diagnostic==='string'?{diagnostic}:{} )}:{})})
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
export interface MatterDetail extends MatterTaskControls {/** 线上形状:带旧 status(wire-compat.ts 第一行)。 */matter:WireMatter;bindings:MatterBinding[];sessions:MatterSession[];task:MatterTaskView|null;events:MatterDetailEvent[];nativeStart?:MatterNativeStart;quotaHandoff?:MatterQuotaHandoff;/** CC 自己做的事(M5c):最近的轮,新的在前,每轮带自己的步。只有 act 带;读不到就不带。 */actTurns?:MatterActTurn[]}
export interface MatterSayInput {requestId:string;runId?:string;draftId?:string;attachmentIds?:string[]}
type MatterMaterials=Pick<MatterSayInput,'draftId'|'attachmentIds'>
export interface MatterArtifactInput {artifactId:string;sha256:string;offset:number;length?:number}
export const MATTER_ARTIFACT_CHUNK_BYTES=128*1024
export interface MatterArtifactChunk {taskId:string;artifactId:string;name:string;mime:string;size:number;sha256:string;offset:number;nextOffset:number;contentBase64:string}
export interface MattersServiceDeps {
  store:MatterStore
  /** Trusted owner resolver for narrow phone receipt reads; no identity comes from the request. */
  ownerChatId?:()=>string|null
  /** 执行者 id → 正式名字(收敛清单 ⑥,接 registry.namesOf(id).name)。没接 ⇒ 不带 agentNames,界面退回 id。 */
  executorName?:(id:string)=>string
  workbench?:{
    detail(id:string):{task:MatterTaskView;events:MatterDetailEvent[]}&Partial<MatterTaskControls>&{requiresExternalClose?:boolean;continuation?:{mode:string};rewind?:{blocked:unknown}|null}
    /** 手机说第一句给「导入了、还没发过第一句」的任务(spec D5);没接 ⇒ 手机也走 continueTask(409)。 */
    continueImported?(id:string,text:string,options:{inputRequestId?:string}&MatterMaterials,attachmentPolicy?:'owner'):Promise<MatterTaskView>
    continueTask(id:string,text:string,options?:{inputRequestId?:string}&MatterMaterials,attachmentPolicy?:'owner'):MatterTaskView
    submitInput?(id:string,input:{runId:string;requestId:string;text:string}&MatterMaterials,attachmentPolicy?:'owner'):Promise<LiveInput>
    inputReceipt?(id:string,requestId:string):LiveInput|null
    resolvePermission?(id:string,requestId:string,decision:PermissionDecision):void|Promise<void>
    /** 停下这一轮(与桌面「停止」同一个 cancel;expectedRunId 不对 ⇒ 不停,免得停掉后来的那一轮)。 */
    cancel?(id:string,expectedRunId?:string):Promise<unknown>
    /** 独立工作区:提交到分支 / 删除工作区(2026-10-07,手机也能做)。没接 ⇒ 手机没有这两个按钮。 */
    /** 手机「另做一份」要源项目编号(只给编号,不给路径);没接 ⇒ 手机没有这个按钮。 */
    projects?():ReadonlyArray<{id:string;path:string}>
    worktreeAction?(id:string,action:'commit'|'remove'|'merge'|'reopen'):{branch:string;committed?:boolean;removed?:boolean;removing?:boolean;merged?:boolean;into?:string;reopened?:boolean}
    /** 工作区脚本(2026-10-20):运行 / 停下。批准只在电脑上(没批 ⇒ script_approval_required)。没接 ⇒ 手机没有这个按钮。 */
    scriptAction?(id:string,action:'run'|'stop'):Promise<{branch:string;scripts:unknown;port:number|null}>
    resolveAnswer?(id:string,requestId:string,answers:unknown):void
    artifact?(id:string,artifactId:string):{name:string;mime:string;size:number;sha256:string;contentBase64:string}
    /** 额度用完时这件事能不能交给另一位;null = 不用打扰。没接 ⇒ 详情里没有这一块。 */
    quotaHandoff?(id:string):MatterQuotaHandoff|null
    /** 交出去(按 requestId 幂等、一件事只交一次);回新那件的任务 id。 */
    handOff?(id:string,input:{requestId:string;providerId:string}):{taskId:string;created:boolean}
    /** 回到某一轮(切片 4,手机只用 to:'start' 撤掉最新那一轮):各轮(找最新没撤的)、预览、带 token 执行。没接 ⇒ 手机没有这个按钮。 */
    reviewList?(id:string):ReadonlyArray<{artifactId:string;createdAt:number;discarded?:boolean}>
    rewindPreview?(id:string,input:{artifactId:string;to:'start'|'end'}):Promise<WorkbenchRewindPreview>
    rewind?(id:string,input:{artifactId:string;to:'start'|'end';token:string}):Promise<{discarded:string[]}>
    /** 交办(P3e 起手机与桌面经 /v1/matter/create、create-receipt 同一个处理器;上下文由调用方给:谁的、哪个表面、出生地)。 */
    createEntry?(input:never,context:MatterEntryContext):unknown
    entryReceipt?(requestId:string,context:MatterEntryContext):unknown
    /** 逐文件审阅与行评论(P3e 起手机与桌面经 /v1/matter/review-* 同一个处理器);撤销一次回退(桌面)。 */
    markReviewFile?(id:string,input:never):unknown
    returnReviewFiles?(id:string,input:never):Promise<unknown>|unknown
    reviewComment?(id:string,input:never):unknown
    sendReviewComments?(id:string,input:never):Promise<unknown>|unknown
    undoRewind?(id:string,undo:string):Promise<unknown>
  }
  /** 对主人的 chat 说话(app 对话通道),surface 记这句是从哪个表面来的;recent 读该 chat 的消息流(微信 / 桌面 / 手机三处进同一条)。 */
  chat?:{file?(input:{id:string;i:number;offset:number;sha256?:string;size?:number}):Promise<{status:number;body:Record<string,unknown>}>;ownerChatId():string|null;say(text:string,surface?:'desktop'|'phone'):Promise<{reply:string}>;recent?(chatId:string,limit:number):Promise<MatterDetailEvent[]>;search?(chatId:string,query:string,limit:number):Promise<(MatterDetailEvent&{id:string})[]>}
  /** 聊天那件事「说一句」的 requestId 回执(v70);没接 ⇒ 不去重(老行为)。 */
  sayReceipts?:SayReceipts
  /** 主人对话要是在这里首建,出生地记成什么(daemon 按鉴权来源算:桌面 = desktop,手机 = App / 浏览器)。没接 ⇒ 桌面记 desktop,手机不知道就不写。 */
  originOf?:(surface:'desktop'|'phone')=>MatterOrigin|null
  /** 轮与步(只读;M5c 给 act 的列表行与详情用)。没接 ⇒ act 行不带 act、详情不带 actTurns。 */
  log?:Pick<MatterLog,'turns'|'items'>
  /** act 详情至多带几轮(默认 20)。 */
  actTurnLimit?:number
  now?:()=>number
}
export interface MattersService {
  /** 线上形状:每行带旧 status(wire-compat.ts 第一行,store.legacyStatuses 现算)。 */
  list(filter?:ListMatters):WireMatter[]
  /** act 行带上发起方与最近那一轮(M5c,「CC 最近在忙」);别的行原样。没接 log / 读不到 ⇒ 原样。 */
  withActs<M extends Matter>(matters:M[]):M[]
  /** 手机令牌(设备 / 链接)能不能看这件:别人的聊天不给(domain/matters/phone-scope.ts;主人取 ownerChatId)。 */
  phoneMayOpen(matter:unknown):boolean
  /** 这件在手机上露过面(绑定 phone / pwa;手机令牌读列表、详情时记)。 */
  seenOnPhone(id:string):void
  detail(id:string):Promise<MatterDetail>
  /** One durable workbench input, including its delivery reason; never loads or mutates the detail. */
  inputReceipt(id:string,requestId:string):MatterInput|null
  /** 主人那条对话(没有就建),并记下是从哪个表面看的;没配主人 → null。 */
  ownerChat(surface:'desktop'|'phone'):Promise<MatterDetail|null>
  ownerChatFile(input:{id:string;i:number;offset:number;sha256?:string;size?:number}):Promise<{status:number;body:Record<string,unknown>}>
  say(id:string,text:string,surface?:'desktop'|'phone',input?:MatterSayInput):Promise<{kind:'task';task:MatterTaskView;input?:MatterInput}|{kind:'chat';reply:string}>
  permission(id:string,runId:string,requestId:string,decision:PermissionDecision):void
  answer(id:string,runId:string,requestId:string,answers:unknown):void
  /** 手机上停下正在跑的这一轮(2026-10-06)。runId 必须是手机看到的那一轮;已经换了一轮 / 没在跑 ⇒ input_stale。 */
  stop(id:string,runId:string):Promise<void>
  /** 独立工作区的提交 / 删除(2026-10-07):手机看不到合并命令(在电脑上合并),只回分支和结果。 */
  worktree(id:string,action:'commit'|'remove'|'merge'|'reopen'):{branch:string;committed?:boolean;removed?:boolean;removing?:boolean;merged?:boolean;reopened?:boolean}
  /** 工作区脚本的运行 / 停下(2026-10-20):回分支 + 状态 + 端口,不带脚本原文、不带路径。 */
  worktreeScript(id:string,action:'run'|'stop'):Promise<{branch:string}&Omit<PhoneScripts,'lastLines'>>
  artifactChunk(id:string,input:MatterArtifactInput):MatterArtifactChunk
  /** 在主人那条对话里搜(2026-10-06,对标 Orca 会话历史搜索):新的在前;没配主人 ⇒ null。 */
  searchOwnerChat(query:string,limit?:number):Promise<{hits:(MatterDetailEvent&{id:string})[]}|null>
  /** 额度用完 ⇒ 交给确认卡上那位继续(同一文件夹新开一件);从手机来的,新那件记手机露面。 */
  handoff(id:string,input:{requestId:string;providerId:string},surface?:'desktop'|'phone'):Promise<{matterId:string;created:boolean}>
  /** 手机「撤掉这一轮」的预览(切片 4):只认最新那一轮没撤的、只回到它开始之前;不是最新那轮 ⇒ rewind_not_latest。 */
  rewindPreview(id:string,artifactId:string):Promise<PhoneRewindPreview>
  /** 带预览给的 token 撤掉(同一轮);回撤掉了哪几轮(制品 id)。 */
  rewind(id:string,artifactId:string,token:string):Promise<{discarded:string[]}>
  /**
   * 交办一件新事(P3e,`POST /v1/matter/create`):手机与桌面同一个调用,差别只在上下文 —— 表面、出生地,桌面的主人由调用方给
   * (`ownerKey`,内部 API 的 resolveAdminChatId),手机缺省取这里的主人。`input` 是 parseEntryInput 验过的(在 daemon 那一层)。
   */
  createEntry(input:unknown,context:{surface:'desktop'|'phone';ownerKey?:string;origin?:MatterEntryContext['origin']}):unknown
  /** 交办的回执(按 requestId);没有 ⇒ null。上下文同 createEntry(不带出生地)。 */
  entryReceipt(requestId:string,context:{surface:'desktop'|'phone';ownerKey?:string}):unknown
  /**
   * 手机看改动(P3e,`GET /v1/matter/changes` 手机那一份):最近一轮的改动快照,裁到能放进中继一帧(domain/matters/phone-changes.ts)。
   * 没撤掉的轮一个都没有 ⇒ null;未知任务 ⇒ 工作台抛 not_found。桌面那一份(各轮原样)是 desktop.reviews。
   */
  changes(id:string):unknown
  /**
   * 逐文件审阅 / 打回 / 行评论 / 发出评论(P3e,`/v1/matter/review-*`):手机与桌面同一个调用,差别只在调用方给的参数
   * (手机不带 comment / restartToken / asLesson / 行号,发出评论的回执与任务视图不给手机 —— 这些在处理器里收)。
   */
  markReviewFile(id:string,input:{artifactId:string;path:string;mark:'accepted'|'returned';comment?:string}):unknown
  returnReviewFiles(id:string,input:{artifactId:string;paths:string[];comment:string;inputRequestId?:string;restartToken?:string;asLesson?:true}):Promise<Record<string,unknown>>
  reviewComment(id:string,input:Record<string,unknown>):unknown
  sendReviewComments(id:string,input:{summary?:string;inputRequestId?:string;restartToken?:string}):Promise<unknown>
  /**
   * 一件事上的动作,桌面那一份(P3e,`/v1/matter/*` 在 operator 范围下):参数、回包、错误码同搬来之前的 `/v1/workbench/*`
   * —— 工作台原样,不经上面手机那几样的 matter 层判断(runId 过期、只撤最新一轮 …),桌面本来就没有。没接工作台 ⇒ workbench_not_wired。
   */
  desktop:MatterDesktopActions
}
/** 交办的上下文(工作台 task-entry 的 EntryContext 那几样;matters 不依赖工作台)。 */
export interface MatterEntryContext {ownerKey:string;surface:'desktop'|'phone';origin?:'desktop'|'app'|'web'|null}
/** 桌面那一份动作(见 MattersService.desktop)。回包是工作台原样,这里不收窄。 */
export interface MatterDesktopActions {
  /** 停下(桌面「停止」):expectedRunId 不对 ⇒ 不停,免得停掉后来的那一轮;回任务视图。 */
  cancel(id:string,expectedRunId?:string):Promise<unknown>
  resolvePermission(id:string,requestId:string,decision:PermissionDecision):Promise<void>
  resolveAnswer(id:string,requestId:string,answers:unknown):void
  /** 成果整份(桌面一次读完;手机按块读的是 artifactChunk)。 */
  artifact(id:string,artifactId:string):Promise<unknown>
  /** 额度用完 ⇒ 交给另一位(桌面 202 回工作台原样)。 */
  quotaHandoff(id:string,input:{requestId:string;providerId:string}):unknown
  /** 独立工作区:commit / remove / merge / reopen 同步,run / stop 是工作区脚本。回工作台原样(含合并命令)。 */
  worktree(id:string,action:'commit'|'remove'|'merge'|'reopen'|'run'|'stop'):Promise<unknown>
  /** 这件事各轮的改动(桌面「改动」面板,原样;手机那一份是 changes)。 */
  reviews(id:string):Promise<unknown>
  /** 回到某一轮:预览(任意一轮、开始前 / 结束后)、带 token 执行、撤销最近一次回退(手机只撤最新那一轮,是上面的 rewindPreview / rewind)。 */
  rewindPreview(id:string,input:{artifactId:string;to:'start'|'end'}):Promise<unknown>
  rewind(id:string,input:{artifactId:string;to:'start'|'end';token:string}):Promise<unknown>
  undoRewind(id:string,undo:string):Promise<unknown>
}
/** 工作台预览里手机用得到的那几样(service/rewind.ts 的 RewindPreview;不依赖它,免得 matters 反向依赖工作台域)。 */
export interface WorkbenchRewindPreview {
  token:string;target:{round:number};discarded:Array<{round:number}>
  files:{count:number;paths:Array<{status:string;path:string}>};extraChanges:{count:number;paths:Array<{status:string;path:string}>}|null
  droppedCommits:{count:number;elsewhere:boolean};rebuildHint:string;session:string;devServer:boolean;goal:{status:string;willStop:boolean}|null
}
/** 手机确认页的预览:撤掉第几轮、多少文件(至多 50 个路径)、之后的额外改动、丢掉的提交、先重新构建、会话 / 开发服务 / goal 怎么样。 */
export interface PhoneRewindPreview {
  token:string;round:number;rounds:number[]
  files:{count:number;paths:Array<{status:string;path:string}>};extraChanges:{count:number;paths:Array<{status:string;path:string}>}|null
  droppedCommits:{count:number;elsewhere:boolean};rebuildHint:string;session:string;devServer:boolean;goalWillStop:boolean
}
const PHONE_REWIND_PATHS=50
const phonePaths=(l:{count:number;paths:Array<{status:string;path:string}>})=>({count:l.count,paths:l.paths.slice(0,PHONE_REWIND_PATHS).map(({status,path})=>({status,path}))})
const ID=/^[a-f0-9]{8}$/
/**
 * act 步的 payload 到手机只留数字、真假、短字符串(≤120 字),外加一层全是数字的表(记忆整理改了几条);别的(数组、深一层的对象)不给。
 * 各发起方写的本来就只是摘要(设计稿 M5:正文不进库),这里再收一道,免得以后哪个发起方顺手塞了大东西一路送到手机。
 */
const ACT_STR_MAX=120,ACT_KEYS_MAX=12
function phoneActPayload(p:Record<string,unknown>):Record<string,unknown>|undefined{
  const out:Record<string,unknown>={}
  for(const [k,v] of Object.entries(p)){
    if(Object.keys(out).length>=ACT_KEYS_MAX)break
    if(typeof v==='number'&&Number.isFinite(v)||typeof v==='boolean')out[k]=v
    else if(typeof v==='string')out[k]=v.slice(0,ACT_STR_MAX)
    else if(v&&typeof v==='object'&&!Array.isArray(v)){const e=Object.entries(v as Record<string,unknown>);if(e.length<=ACT_KEYS_MAX&&e.every(([,n])=>typeof n==='number'&&Number.isFinite(n)))out[k]={...(v as Record<string,number>)}}
  }
  return Object.keys(out).length?out:undefined
}
function actTurnView(t:MatterTurn,steps:MatterActStep[]):MatterActTurn{
  const trigger=t.policy?.trigger
  return {id:t.id,status:t.status,errorCode:t.errorCode,...(typeof trigger==='string'?{trigger}:{}),startedAt:t.startedAt,endedAt:t.endedAt,steps}
}

export function makeMattersService(deps:MattersServiceDeps):MattersService {
  /** 同一 requestId 还在说的那一轮:重发直接跟上它,不起第二轮(回执表只管跨重启与已说完的)。 */
  const chatInFlight=new Map<string,Promise<{kind:'chat';reply:string}>>()
  const require=(id:string):Matter=>{if(!ID.test(id))throw new Error('invalid_matter_id');const m=deps.store.get(id);if(!m)throw new Error('matter_not_found');return m}
  /** act 那件事最近的 n 轮(新的在前)+ 发起方(取自轮的 policy.who)。没接 log ⇒ null;读失败往外抛(调用方吞)。 */
  const actTurns=(id:string,n:number):{who?:string;turns:MatterActTurn[]}|null=>{
    if(!deps.log)return null
    const all=deps.log.turns(id)
    const who=all.map(t=>t.policy?.who).find((w):w is string=>typeof w==='string')
    const picked=all.slice(-n).reverse()
    if(!picked.length)return {...(who?{who}:{}),turns:[]}
    const want=new Set(picked.map(t=>t.id)),steps=new Map<string,MatterActStep[]>()
    for(const i of deps.log.items(id)){
      // 「答完了、闲着」那一步(M6e)是内部事实,不进给人看的轮视图
      if(!i.turnId||!want.has(i.turnId)||isReadyStep(i))continue
      const payload=phoneActPayload(i.payload)
      let l=steps.get(i.turnId);if(!l)steps.set(i.turnId,l=[])
      l.push({kind:i.kind,status:i.status,at:i.updatedAt,...(payload?{payload}:{})})
    }
    return {...(who?{who}:{}),turns:picked.map(t=>actTurnView(t,steps.get(t.id)??[]))}
  }
  const actOf=<M extends Matter>(m:M,n=1):{matter:M;turns:MatterActTurn[]}|null=>{
    if(m.kind!=='act')return null
    try{const r=actTurns(m.id,n);if(!r)return null;const latest=r.turns[0];return {matter:{...m,act:{...(r.who?{who:r.who}:{}),...(latest?{latest}:{})}},turns:r.turns}}
    catch{return null/* 读不到轮:这一行照旧,只是不带 act */}
  }
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
    deps.store.setLifecycle(id,lifecycleOfTaskView(task))
    return task
  }
  /** 手机只撤最新那一轮(没撤掉的里最新的);换了一轮 / 已撤掉 ⇒ rewind_not_latest(页面重拉再看一眼)。 */
  const latestRound=(id:string,artifactId:string)=>{
    if(require(id).kind!=='task')throw Error('matter_task_required')
    if(!deps.workbench?.reviewList||!deps.workbench.rewindPreview||!deps.workbench.rewind)throw Error('workbench_not_wired')
    const live=deps.workbench.reviewList(id).filter(r=>!r.discarded)
    const latest=live.reduce<(typeof live)[number]|null>((a,b)=>!a||b.createdAt>a.createdAt?b:a,null)
    if(!latest||latest.artifactId!==artifactId)throw Error('rewind_not_latest')
  }
  /** 这些执行者叫什么(收敛清单 ⑥):只由 deps.executorName 定;没接 / 一个都没有 ⇒ 不带这个字段。 */
  const namesFor=(ids:ReadonlyArray<string|null|undefined>):{agentNames?:Record<string,string>}=>{
    if(!deps.executorName)return {}
    const out:Record<string,string>={}
    for(const id of ids)if(id&&!(id in out))out[id]=deps.executorName(id)
    return Object.keys(out).length?{agentNames:out}:{}
  }
  return {
    list(filter){
      // 列表每行行尾画参与过的执行者(一次查完整页)
      const matters=deps.store.list(filter),ids=matters.map(m=>m.id),agents=deps.store.agents(ids),legacy=deps.store.legacyStatuses(ids)
      return matters.map(m=>{const w=wireMatter(m,legacy.get(m.id)??'open'),a=agents.get(m.id);return a?.length?{...w,agents:a,...namesFor(a)}:w})
    },
    withActs(matters){return matters.map(m=>actOf(m)?.matter??m)},
    phoneMayOpen(matter){return phoneMayOpenMatter(matter,(deps.ownerChatId??deps.chat?.ownerChatId)?.()??null)},
    seenOnPhone(id){deps.store.bind(id,'phone','pwa')},
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
      let task:MatterTaskView|null=null,events:MatterDetailEvent[]=[]
      let controls:MatterTaskControls={permissions:[],questions:[],artifacts:[],inputs:[]}
      let nativeStart:MatterNativeStart|undefined
      let quotaHandoff:MatterQuotaHandoff|undefined
      if(matter.kind==='chat'&&deps.chat?.recent){
        const chatId=deps.store.bindings(id).find(b=>b.surface==='wechat')?.surfaceKey
        if(chatId){try{events=(await deps.chat.recent(chatId,50)).sort((a,b)=>a.createdAt-b.createdAt).map(publicEvent)}catch{/* 读不到消息流,详情本身还在 */}}
      }
      if(matter.kind==='task'&&deps.workbench){
        try{
          const d=taskDetail(matter.id);const wt=(d.task as {worktree?:{branch:string;projectPath?:string;removed:boolean;merged?:boolean;port?:number;scripts?:unknown}}).worktree;const projectId=wt?.projectPath?deps.workbench.projects?.().find(p=>p.path===wt.projectPath)?.id:undefined;task={...d.task,...(wt?{worktree:{branch:wt.branch,removed:wt.removed,...(wt.merged?{merged:true}:{}),...(projectId?{projectId}:{}),...(wt.removed?{}:phoneScripts(wt.scripts as never,wt.port,d.events as never,[d.task.path,wt.projectPath??'']))}}:{}),...(d.rewind?.blocked?{rewind:{blocked:true}}:{})};events=d.events.slice(-50).map(publicEvent)
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
      // 详情页标题下那组头像:跟列表同一个出处
      const agents=deps.store.agents([matter.id]).get(matter.id)
      const named=namesFor([...(agents??[]),task?.providerId,nativeStart?.providerId,quotaHandoff?.from,quotaHandoff&&'to' in quotaHandoff?quotaHandoff.to:undefined])
      const act=actOf(matter,deps.actTurnLimit??20)
      const status=deps.store.legacyStatuses([matter.id]).get(matter.id)??'open'
      return {matter:wireMatter({...(act?.matter??matter),...(agents?.length?{agents}:{}),...named},status),...(act?{actTurns:act.turns}:{}),bindings:deps.store.bindings(id),sessions:deps.store.sessions(id),task,events,...controls,...(nativeStart?{nativeStart}:{}),...(quotaHandoff?{quotaHandoff}:{})}
    },
    async ownerChatFile(input){return deps.chat?.file ? deps.chat.file(input) : {status:503,body:{error:'chat_not_wired'}}},
    async ownerChat(surface){
      const owner=deps.chat?.ownerChatId();if(!owner)return null
      const origin=deps.originOf?deps.originOf(surface):surface==='desktop'?'desktop':null
      const m=deps.store.ensureChat(owner,undefined,origin);deps.store.bind(m.id,surface,surface==='desktop'?'app':'pwa')
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
      return {branch:r.branch,...(r.committed!==undefined?{committed:r.committed}:{}),...(r.removed?{removed:true}:{}),...(r.removing?{removing:true}:{}),...(r.merged!==undefined?{merged:r.merged}:{}),...(r.reopened?{reopened:true}:{})}
    },
    async worktreeScript(id,action){
      require(id)
      if(!deps.workbench?.scriptAction)throw Error('workbench_not_wired')
      const r=await deps.workbench.scriptAction(id,action)
      const {lastLines:_,...state}=phoneScripts(r.scripts as never,r.port,[],[])
      return {branch:r.branch,...state}
    },
    async rewindPreview(id,artifactId){
      latestRound(id,artifactId)
      const p=await deps.workbench!.rewindPreview!(id,{artifactId,to:'start'})
      return {token:p.token,round:p.target.round,rounds:p.discarded.map(r=>r.round),files:phonePaths(p.files),extraChanges:p.extraChanges?phonePaths(p.extraChanges):null,
        droppedCommits:{count:p.droppedCommits.count,elsewhere:p.droppedCommits.elsewhere},rebuildHint:p.rebuildHint,session:p.session,devServer:p.devServer,goalWillStop:!!p.goal?.willStop}
    },
    async rewind(id,artifactId,token){
      latestRound(id,artifactId)
      const r=await deps.workbench!.rewind!(id,{artifactId,to:'start',token})
      return {discarded:[...r.discarded]}
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
    createEntry(input,context){
      if(!deps.workbench?.createEntry)throw Error('workbench_not_wired')
      const ownerKey=context.ownerKey??(deps.ownerChatId??deps.chat?.ownerChatId)?.()??''
      return deps.workbench.createEntry(input as never,{ownerKey,surface:context.surface,...(context.origin!==undefined?{origin:context.origin}:{})})
    },
    entryReceipt(requestId,context){
      if(!deps.workbench?.entryReceipt)throw Error('workbench_not_wired')
      const ownerKey=context.ownerKey??(deps.ownerChatId??deps.chat?.ownerChatId)?.()??''
      return deps.workbench.entryReceipt(requestId,{ownerKey,surface:context.surface})
    },
    changes(id){
      if(!deps.workbench?.reviewList)throw Error('workbench_not_wired')
      return latestChanges(deps.workbench.reviewList(id) as unknown as ReviewTurnLike[])
    },
    markReviewFile(id,input){if(!deps.workbench?.markReviewFile)throw Error('workbench_not_wired');return deps.workbench.markReviewFile(id,input as never)},
    async returnReviewFiles(id,input){if(!deps.workbench?.returnReviewFiles)throw Error('workbench_not_wired');return await deps.workbench.returnReviewFiles(id,input as never) as Record<string,unknown>},
    reviewComment(id,input){if(!deps.workbench?.reviewComment)throw Error('workbench_not_wired');return deps.workbench.reviewComment(id,input as never)},
    async sendReviewComments(id,input){if(!deps.workbench?.sendReviewComments)throw Error('workbench_not_wired');return await deps.workbench.sendReviewComments(id,input as never)},
    desktop:desktopActions(deps.workbench),
  }
}

/** 桌面那一份(MattersService.desktop):工作台原样;缺哪样 ⇒ workbench_not_wired(同搬来之前没挂上时的码)。 */
function desktopActions(w:MattersServiceDeps['workbench']):MatterDesktopActions{
  const need=<T>(fn:T|undefined):T=>{if(!fn)throw Error('workbench_not_wired');return fn}
  return {
    cancel:(id,expectedRunId)=>need(w?.cancel).call(w,id,expectedRunId),
    resolvePermission:async(id,requestId,decision)=>{await need(w?.resolvePermission).call(w,id,requestId,decision)},
    resolveAnswer:(id,requestId,answers)=>{need(w?.resolveAnswer).call(w,id,requestId,answers)},
    artifact:async(id,artifactId)=>need(w?.artifact).call(w,id,artifactId),
    quotaHandoff:(id,input)=>need(w?.handOff).call(w,id,input),
    worktree:async(id,action)=>action==='run'||action==='stop'?await need(w?.scriptAction).call(w,id,action):need(w?.worktreeAction).call(w,id,action),
    reviews:async id=>need(w?.reviewList).call(w,id),
    rewindPreview:(id,input)=>need(w?.rewindPreview).call(w,id,input),
    rewind:(id,input)=>need(w?.rewind).call(w,id,input),
    undoRewind:(id,undo)=>need(w?.undoRewind).call(w,id,undo),
  }
}
