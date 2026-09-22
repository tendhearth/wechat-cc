import {createHash,randomUUID} from 'node:crypto'
import type {WorkbenchStore,Task} from './store'
import type {LiveInput} from './live-inputs'
import type {PendingWorkbenchPermission,PermissionDecision} from './permissions'
import type {AgentRuntimeSnapshot} from '../agent-provider'
import type {CreateWechatTask,SendWechatArtifact,TaskWaitingFor} from './service'
import type {ArtifactDeliveryReceipt} from './artifact-deliveries'
import type {CreationReceipt} from './creation-receipts'
import type {ProjectCatalogEntry} from './project-catalog'
import {validateUserInputAnswers,type PendingUserInput} from './user-input'
import {resultCommandHelp,resultToken,wechatResultPage} from './wechat-results'
import {isWorkbenchProviderId} from './executor-capabilities'

export interface WechatMessageIdentity {accountId:string;userId:string;msgId?:string;createTimeMs:number}
export type WechatWorkbenchReply=string|{kind:'artifact_delivered';receiptId:string}
type Detail=ReturnType<WorkbenchStore['detail']>&{runId?:string;runtime?:AgentRuntimeSnapshot;inputMode?:'steer'|'send'|'queue';inputs:LiveInput[];permissions:PendingWorkbenchPermission[];questions:PendingUserInput[];wechatNotifications?:{enabled:boolean;notices:Array<{status:string}>};task:Task&{waitingFor?:TaskWaitingFor|null}}
interface Actions {
  projects():ProjectCatalogEntry[]
  createWechat(input:CreateWechatTask):CreationReceipt
  setWechatWatch(id:string,accountId:string,enabled:boolean):unknown
  deliverWechatArtifact?(input:SendWechatArtifact):Promise<ArtifactDeliveryReceipt>
  detail(id:string):Detail
  continueTask(id:string,text:string,options?:{inputRequestId?:string}):Task
  cancel(id:string,expectedRunId?:string):Promise<Task>
  submitInput(id:string,input:{runId:string;requestId:string;text:string}):Promise<LiveInput>
  resolvePermission(id:string,requestId:string,decision:PermissionDecision):void
  resolveAnswer(id:string,requestId:string,answers:unknown):void
}
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
const requestCommand=new RegExp(`^(权限|问题|允许|拒绝|回答)\\s+(${UUID})(?:\\s+([\\s\\S]+))?$`,'i')
const STATUS:Record<string,string>={queued:'准备开始',running:'正在处理',cancelling:'正在停止',completed:'这一轮已完成',failed:'需要处理',cancelled:'已停止',interrupted:'已中断'}
function runtimeStatus(status:string,runtime?:AgentRuntimeSnapshot){
  if(status==='running'&&runtime?.retained){
    if(runtime.backgroundCount>0)return `后台执行中 · ${runtime.backgroundCount}`
    if(runtime.foreground==='idle')return '会话保留中'
  }
  return STATUS[status]??status
}
const REQUEST_MAX=6000
const unavailable='没有找到这个任务，请在桌面工作台核对编号。'
const stale='这条请求已失效或不属于这个任务。请重新查询任务，使用当前请求编号。'
const stopUnconfirmed='这条停止请求已记录，但尚未确认执行结果。请查询任务状态；如需停止当前轮次，请发送一条新的停止消息。'
const usage=(id='<任务编号>')=>`用法：\n项目：任务 项目\n新建：任务 新建 <项目编号> <要求>\n查看：任务 ${id}\n补充：任务 ${id} 补充 <要求>\n停止：任务 ${id} 停止\n处理待办时，请复制任务消息中的完整请求编号。`
const clip=(value:string,max:number)=>value.length>max?value.slice(0,max)+'…':value
const singleLine=(value:string,max=100)=>clip(value.replace(/[\r\n]+/g,' '),max)
export const isWechatTaskCommand=(text:string)=>/^(?:任务|\/task)(?:\s|$)/i.test(text.trim())

// Internal receipt identity only; neither the hash nor message metadata is shown in replies.
function inputId(chatId:string,taskId:string,text:string,identity?:WechatMessageIdentity){
  if(!identity)return randomUUID()
  const delivery=identity.msgId?['id',identity.msgId]:['fallback',identity.createTimeMs||0,text]
  const hash=createHash('sha256').update(JSON.stringify(['workbench-wechat-input',identity.accountId,chatId,identity.userId,taskId,delivery])).digest('hex')
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
}
/** The early dedup and message audit must use the same identity as the task receipt. */
export function wechatTaskMessageKey(msg:WechatMessageIdentity&{chatId:string;text:string}):string|null{
  if(!isWechatTaskCommand(msg.text))return null
  if(/^(?:任务|\/task)\s+[a-f0-9]{8}\s+文件(?:\s|$)/i.test(msg.text.trim()))return 'workbench:'+inputId(msg.chatId,'',msg.text,msg)
  const taskId=/^(?:任务|\/task)\s+([a-f0-9]{8})(?:\s|$)/i.exec(msg.text.trim())?.[1]?.toLowerCase()??''
  return 'workbench:'+inputId(msg.chatId,taskId,msg.text,msg)
}
function inputReply(input:LiveInput,retained=false){
  const prefix=`任务 ${input.taskId}：`
  if(input.status==='delivered')return prefix+'补充已传达给执行者。'
  if(input.status==='pending')return prefix+(retained?'补充已保存在 CC，当前执行者暂不接收；不会自动发送。':'补充已保存，将在当前轮次完成后进入同一任务的下一轮。')
  if(input.status==='sending')return prefix+'补充正在发送，尚未确认收到。请稍后查询任务。'
  if(input.status==='withdrawn')return prefix+'这条补充已撤回。'
  return prefix+'未确认执行者收到这条补充，内容已保留。请在桌面工作台检查后决定是否重发。'
}
function questionBody(request:PendingUserInput){
  return request.questions.map((q,i)=>[
    `${i+1}. ${q.header}：${q.question}`,
    ...q.options.map((o,j)=>`  ${j+1}) ${o.label}${o.description?' — '+o.description:''}`),
    q.multiSelect?'可多选，用逗号分隔选项编号。':'请选择一个选项编号。',
    q.allowOther?'也可写「其他 <你的答案>」。':'',
  ].filter(Boolean).join('\n')).join('\n\n')
}
function questionReply(id:string,request:PendingUserInput){
  const body=questionBody(request)
  if(body.length>REQUEST_MAX)return `任务 ${id} 的问题内容较长，请在桌面工作台完整查看并回答。\n请求：${request.id}`
  const sample=request.questions.map((q,i)=>`${request.questions.length>1?(i+1)+'=':''}${q.options.length?'1':'其他 <你的答案>'}`).join('\n')
  return `任务 ${id} · 等待回答\n${body}\n\n回答：任务 ${id} 回答 ${request.id} ${sample}`
}
function phoneAnswers(request:PendingUserInput,text:string):unknown {
  if(text.trim().startsWith('{'))return validateUserInputAnswers(request,JSON.parse(text))
  const values=new Map<number,string>()
  if(request.questions.length===1)values.set(1,text.trim())
  else for(const line of text.trim().split(/\r?\n/)){
    const match=/^([1-4])\s*=\s*(.+)$/.exec(line.trim())
    if(!match||values.has(Number(match[1])))throw Error('invalid_answer')
    values.set(Number(match[1]),match[2]!)
  }
  if(values.size!==request.questions.length)throw Error('invalid_answer')
  const answers=Object.fromEntries(request.questions.map((q,i)=>{
    const raw=values.get(i+1);if(!raw)throw Error('invalid_answer')
    const other=/^其他\s+([\s\S]+)$/.exec(raw)
    if(other){if(!q.allowOther)throw Error('invalid_answer');return[q.id,[other[1]!.trim()]]}
    if(!/^[1-8](?:\s*[,，]\s*[1-8])*$/.test(raw))throw Error('invalid_answer')
    return[q.id,raw.split(/[,，]/).map(n=>{const option=q.options[Number(n.trim())-1];if(!option)throw Error('invalid_answer');return option.label})]
  }))
  return validateUserInputAnswers(request,answers)
}
function statusReply(detail:Detail){
  const {task,events,artifacts,permissions,questions,inputs}=detail,id=task.id
  const latest=events.filter(e=>e.kind==='text').at(-1)
  const error=events.filter(e=>e.kind==='error').at(-1)?.text
  const lines=[`${singleLine(task.title,120)} · ${id}`,`${task.providerId} · ${runtimeStatus(task.status,detail.runtime)}`]
  if(detail.wechatNotifications){
    const unknown=detail.wechatNotifications.notices.filter(n=>n.status==='unknown'||n.status==='sending').length
    const waiting=detail.wechatNotifications.notices.filter(n=>n.status==='pending').length
    lines.push(`微信提醒：${detail.wechatNotifications.enabled?'已开启':'已关闭'}${unknown?` · ${unknown} 条尚未确认送达，不会自动重发`:''}${waiting?` · ${waiting} 条等待发送`:''}`)
  }
  if(task.status==='running'&&detail.runtime?.retained)lines.push(`后续回复仍会留在这个任务里。结束会停止尚未结束的后台工作并保存当前成果。\n结束：任务 ${id} 停止`)
  // 等待行说人话:挡路的那位已经答复、正数着秒自己让开时，说清不用干等——不必等桌面才知道。
  // `writer_not_closed` 那种挡路方永远不安静（`holderWriting` 恒为 true），今天这个依赖成立
  // （`findPathBlocker` 只在 `state==='uncertain'` 时给 `writer_not_closed`，而 `isReplied` 在
  // `uncertain` 时必为 false），走不到这句。但这条约束只管着今天一处判据不变，不管着这句话
  // 本身——桌面那处为「`writer_not_closed` 文案不许被覆盖」的教训另外选了双保险
  // （`reason!=='writer_not_closed'`），这里补上同一道，呈现给主人的那句话不该只在一半的面上成立。
  if(task.waitingFor?.holderWriting===false&&task.waitingFor.closeInMs!=null&&task.waitingFor.reason!=='writer_not_closed'){
    // 向下取:宁可显示得比实际剩的更少,不能说得比实际剩的更多(同桌面那处,评审修复轮 2 #3)。
    const seconds=Math.max(0,Math.floor(task.waitingFor.closeInMs/1000)),blockerId=task.waitingFor.taskId
    lines.push(`「${singleLine(task.waitingFor.title,80)}」已答复，会话还开着；等 ${seconds} 秒它会自己让开，或者说『任务 ${blockerId} 停止』。`)
  }
  if(latest){
    lines.push('最近回复：\n'+clip(latest.text,1500))
    if(latest.text.length>1500)lines.push(`完整正文（第 1 页）：任务 ${id} 正文 ${resultToken(latest)} 1`)
  }
  if(error&&['failed','interrupted'].includes(task.status))lines.push('需要处理：'+clip(error,500))
  else if(task.error)lines.push('需要处理：'+clip(task.error,500))
  if(artifacts.length)lines.push(`已保存 ${artifacts.length} 份成果版本：\n`+artifacts.slice(0,8).map(a=>`• ${singleLine(a.name)} (${a.size} 字节)\n获取：任务 ${id} 文件 ${a.id}`).join('\n'))
  const held=inputs.filter(input=>input.status==='held').slice(0,3)
  if(held.length)lines.push('尚未交付的补充（已保留）：\n'+held.map(input=>'• '+clip(input.text,200)).join('\n'))
  const queued=inputs.filter(input=>input.status==='pending'||input.status==='sending').length
  if(queued)lines.push(`还有 ${queued} 条补充等待交付。`)
  if(permissions.length)lines.push(`等待权限处理：${permissions.length} 项\n`+permissions.slice(0,4).map(p=>`${singleLine(p.tool,80)} · ${singleLine(p.description,150)}\n查看：任务 ${id} 权限 ${p.id}`).join('\n'))
  if(questions.length)lines.push(`等待回答：${questions.length} 项\n`+questions.slice(0,4).map(q=>`${singleLine(q.questions.map(item=>item.header).join('、'),80)}\n查看：任务 ${id} 问题 ${q.id}`).join('\n'))
  lines.push(`补充：任务 ${id} 补充 <要求>`,`查看结果：任务 ${id} 结果`)
  return lines.join('\n\n')
}
function failure(error:unknown,id:string){
  const code=error instanceof Error?error.message:''
  if(code==='artifact_delivery_conflict')return '这条文件请求与已记录的内容不一致，没有再次发送。请重新查看任务成果。'
  if(code==='artifact_transport_unavailable')return '文件发送暂不可用，已保存的成果仍可在桌面工作台查看。'
  if(code==='artifact_changed'||code.startsWith('invalid_artifact'))return '成果文件已变化或未通过校验，没有发送。请在桌面查看保存的版本。'
  if(code==='subscription_conflict')return '提醒绑定的账号已变化，没有把旧提醒转发到新账号。请在原聊天关闭提醒后重新设置。'
  if(code==='permission_stale'||code==='question_stale')return stale
  if(code==='invalid_answer'||error instanceof SyntaxError)return '答案格式或选项不正确，尚未提交。请按问题中的示例回答。'
  if(code==='workbench_archived')return '这项任务已归档。请在桌面工作台恢复任务后再继续。'
  if(code==='restart_confirmation_required'||code==='restart_confirmation_stale')return '原执行会话暂时无法恢复。请打开桌面工作台，查看恢复选项并确认是否带此前记录重新开始。'
  if(code==='external_close_confirmation_required')return '请先在桌面工作台确认原执行程序已关闭，再继续这项任务。'
  if(code==='input_stale'||code==='workbench_busy')return '任务轮次已变化或正在停止，这条补充没有发送。请重新查询任务后再提交。'
  if(code==='input_conflict')return '这条消息的内容与已记录的补充不一致，未再次发送。请重新查询任务。'
  if(code==='control_conflict')return '这条消息的内容与已记录的操作不一致，未再次执行。请重新查询任务。'
  if(code==='creation_conflict')return '这条消息的内容与已记录的新建要求不一致，未再次创建。请发送一条新消息。'
  if(code==='project_stale')return '这个项目编号已失效或目录已变化，没有开始工作。请发送「任务 项目」重新选择。'
  if(code==='workbench_attachments_unsupported')return '这个执行者暂不支持工作任务附件，没有开始工作。请移除附件，或改用支持附件的执行者。'
  if(code==='workbench_execution_unsupported')return '这个执行者暂不支持所选执行设置，没有开始工作。请改为自动设置，或选择其他执行者。'
  if(code==='workbench_resume_unsupported')return '这个执行者无法安全恢复原会话，没有继续工作。请在桌面查看恢复说明，并决定是否带记录重新开始。'
  if(code==='unattended_ack_required')return 'agy 是免审执行者：跑任务时看不到、拦不下单步操作，没有权限卡和提问，只能停止；它用的工具凭据不是按任务隔离的；时间线只有文字；不能带附件、不能选模型。请先在桌面工作台确认一次，之后微信也能直接用。没有开始工作。'
  if(code==='unavailable_provider')return '暂时没有可用的工作执行者，没有开始工作。请在桌面连接或管理一个支持工作任务的执行者。'
  if(code==='invalid_wechat_identity')return '无法确认这条微信消息的账号和发送者，没有创建任务。请在原聊天重新发送。'
  if(code==='control_stale')return '原请求对应的轮次已结束，未停止当前轮次。请重新查询任务。'
  if(code==='input_limit'||code==='input_delivery_busy')return '仍有补充等待交付，请稍后再试。'
  if(code.startsWith('invalid_'))return usage(id)
  return '暂时无法处理，请在桌面工作台查看任务状态。'
}

export function makeWechatWorkbenchControl(opts:{store:WorkbenchStore;ownerChatId:()=>string|null;actions:Actions}){
  return async(chatId:string,text:string,identity?:WechatMessageIdentity):Promise<WechatWorkbenchReply|null>=>{
    if(!isWechatTaskCommand(text))return null
    if(!opts.ownerChatId()||chatId!==opts.ownerChatId()||(identity&&identity.userId!==chatId))return null
    const artifactRequestId=inputId(chatId,'',text,identity),commandHash=createHash('sha256').update(text).digest('hex')
    const originalFile=opts.store.artifactDeliveries.get(artifactRequestId)
    if(originalFile&&(originalFile.commandHash!==commandHash||originalFile.ownerChatId!==chatId||originalFile.accountId!==identity?.accountId))return failure(Error('artifact_delivery_conflict'),originalFile.taskId)
    const command=text.trim().replace(/^(?:任务|\/task)\s*/i,'')
    if(/^项目(?:\s|$)/.test(command)){
      const match=/^项目(?:\s+([1-9]\d{0,3}))?$/.exec(command)
      if(!match)return usage()
      const page=Number(match[1]??1),projects=opts.actions.projects(),slice=projects.slice((page-1)*8,page*8)
      if(!projects.length)return '还没有可用的项目。请先在桌面工作台选择一次文件夹，之后就能在这里交代任务。'
      if(!slice.length)return '没有这一页项目，请发送「任务 项目」查看。'
      const example=slice.find(p=>isWorkbenchProviderId(p.providerId))
      return '选择要工作的项目：\n\n'+slice.map(p=>`${singleLine(p.name)} · ${p.id}\n${singleLine(p.path,240)}\n${p.providerId??'暂无可用执行者'}\n新建：任务 新建 ${p.id} <要求>`).join('\n\n')+(example?`\n\n也可明确指定：任务 新建 ${example.id} 用 @${example.providerId} <要求>`:'')+(projects.length>page*8?`\n下一页：任务 项目 ${page+1}`:'')
    }
    if(/^新建(?:\s|$)/.test(command)){
      if(!identity?.accountId?.trim())return failure(Error('invalid_wechat_identity'),'')
      const match=/^新建\s+(p-[a-f0-9]{20})\s+([\s\S]+)$/i.exec(command)
      if(!match)return usage()
      // @ makes an executor choice unambiguous; "用 Python 处理数据" remains ordinary input.
      const explicit=/^用\s+@(\S+)(?:\s+|$)([\s\S]*)$/i.exec(match[2]!)
      if(/^用\s+@/i.test(match[2]!)&&(!explicit||!isWorkbenchProviderId(explicit[1]!.toLowerCase())))return usage()
      const choice=explicit??/^用\s+(claude|codex)(?:\s+|$)([\s\S]*)$/i.exec(match[2]!)
      try{return opts.actions.createWechat({ownerChatId:chatId,accountId:identity.accountId,requestId:inputId(chatId,'',text,identity),commandHash:createHash('sha256').update(text).digest('hex'),projectId:match[1]!.toLowerCase(),...(choice?{providerId:choice[1]!.toLowerCase()}:{}),text:choice?choice[2]!:match[2]!}).reply}
      catch(error){return failure(error,'')}
    }
    if(!command||command==='列表'){
      const tasks=opts.store.listOwned(chatId,8)
      return tasks.length?'最近的任务：\n'+tasks.map(t=>`${t.id} · ${singleLine(t.title)} · ${runtimeStatus(t.status,opts.actions.detail(t.id).runtime)}`).join('\n')+'\n\n查看或选择：任务 <任务编号>\n新建任务：先发送「任务 项目」':'还没有属于你的工作任务。发送「任务 项目」选择文件夹并交代任务。'
    }
    const match=/^([a-f0-9]{8})(?:\s+([\s\S]+))?$/i.exec(command)
    if(!match)return usage()
    const id=match[1]!.toLowerCase(),suffix=match[2]?.trim()??''
    let task:Task
    try{const stored=opts.store.get(id);if(stored.ownerChatId!==chatId)return unavailable;task=stored}catch{return unavailable}
    try{
      const requestId=inputId(chatId,id,text,identity),textHash=createHash('sha256').update(text).digest('hex')
      const receipt=opts.store.controlReceipts.get(requestId)
      if(receipt){
        if(receipt.taskId!==id||receipt.textHash!==textHash)throw Error('control_conflict')
        return receipt.result??(receipt.action==='stop'?stopUnconfirmed:'这条提醒设置已记录，但尚未确认结果。请查询任务状态。')
      }
      if(suffix==='提醒我'||suffix==='静音'){
        if(!identity?.accountId?.trim())return failure(Error('invalid_wechat_identity'),id)
        if(opts.store.liveInputs.get(requestId))throw Error('control_conflict')
        return opts.store.atomic(()=>{
          opts.store.controlReceipts.reserve({id:requestId,taskId:id,runId:null,action:suffix==='提醒我'?'watch':'mute',textHash})
          opts.actions.setWechatWatch(id,identity.accountId,suffix==='提醒我')
          const reply=`任务 ${id}：${suffix==='提醒我'?'已开启这项任务的完成和待处理提醒。':'已关闭这项任务的微信提醒。'}\n查看：任务 ${id}`
          opts.store.controlReceipts.complete(requestId,reply)
          return reply
        })
      }
      if(!suffix||['结果','状态','待办'].includes(suffix))return statusReply(opts.actions.detail(id))
      if(/^文件(?:\s|$)/.test(suffix)){
        if(opts.store.liveInputs.get(requestId)||opts.store.controlReceipts.get(requestId)||opts.store.creationReceipts.get(artifactRequestId))throw Error('artifact_delivery_conflict')
        const file=new RegExp(`^文件\\s+(${UUID})$`,'i').exec(suffix)
        if(!file)return `文件命令格式不正确。请发送「任务 ${id} 结果」，复制对应成果的完整获取命令。`
        if(!identity?.accountId?.trim())return '无法确认文件应发往哪个微信账号，没有发送。请在原聊天重新索取。'
        if(!opts.actions.deliverWechatArtifact)throw Error('artifact_transport_unavailable')
        let delivery:ArtifactDeliveryReceipt
        try{delivery=await opts.actions.deliverWechatArtifact({ownerChatId:chatId,accountId:identity.accountId,requestId:artifactRequestId,commandHash:textHash,taskId:id,artifactId:file[1]!.toLowerCase()})}
        catch(error){if(error instanceof Error&&error.message==='not_found')return '没有找到属于这项任务的成果文件。请重新查看结果并复制获取命令。';throw error}
        if(delivery.status==='accepted')return{kind:'artifact_delivered',receiptId:delivery.id}
        if(delivery.status==='unknown'||delivery.status==='sending')return '文件是否送达尚未确认，不会自动重发。请先检查微信记录；确认未收到后，可发送一条新的获取命令。'
        if(delivery.status==='blocked')return '文件未发送，账号绑定或成果校验已失效。请在桌面查看这项任务。'
        return '文件暂未发送，保存的成果版本未变。请稍后重新发送获取命令。'
      }
      if(/^正文(?:\s|$)/.test(suffix)){
        const page=/^正文\s+(r[1-9]\d*-[a-f0-9]{12})\s+([1-9]\d*)$/i.exec(suffix)
        if(!page)return resultCommandHelp(id)
        return wechatResultPage({taskId:id,events:opts.actions.detail(id).events,token:page[1]!.toLowerCase(),page:Number(page[2])})
      }
      if(suffix==='停止'){
        if(opts.store.liveInputs.get(requestId))throw Error('control_conflict')
        const runId=opts.actions.detail(id).runId??null
        const reserved=opts.store.controlReceipts.reserve({id:requestId,taskId:id,runId,action:'stop',textHash})
        if(!reserved.created)return reserved.receipt.result??stopUnconfirmed
        let reply=`任务 ${id}：这一轮已经结束，无需停止。`
        if(runId){
          try{await opts.actions.cancel(id,runId);reply=`任务 ${id}：已请求停止。`}
          catch(error){reply=failure(error,id)}
        }
        opts.store.controlReceipts.complete(requestId,reply)
        return reply
      }
      const control=requestCommand.exec(suffix)
      if(control){
        const verb=control[1]!,requestId=control[2]!.toLowerCase(),answer=control[3],detail=opts.actions.detail(id)
        if(verb==='权限'||verb==='允许'||verb==='拒绝'){
          if(answer)return usage(id)
          const request=detail.permissions.find(p=>p.id===requestId)
          if(!detail.runId||!request)return stale
          if(verb==='权限')return request.description.length>REQUEST_MAX?`任务 ${id}：权限内容较长，请在桌面工作台完整查看。\n可拒绝：任务 ${id} 拒绝 ${requestId}`:`任务 ${id} · 等待权限\n${request.tool}\n${request.description}\n\n允许：任务 ${id} 允许 ${requestId}\n拒绝：任务 ${id} 拒绝 ${requestId}`
          if(verb==='允许'&&request.description.length>REQUEST_MAX)return '这项权限内容较长，请在桌面工作台完整查看后处理。微信仍可拒绝。'
          opts.actions.resolvePermission(id,requestId,verb==='允许'?'allow':'deny')
          return `任务 ${id}：已${verb}这项请求。`
        }
        const request=detail.questions.find(q=>q.id===requestId)
        if(!detail.runId||!request)return stale
        if(verb==='问题')return answer?usage(id):questionReply(id,request)
        if(!answer)return usage(id)
        if(questionBody(request).length>REQUEST_MAX)return '这组问题内容较长，请在桌面工作台完整查看并回答。'
        opts.actions.resolveAnswer(id,requestId,phoneAnswers(request,answer))
        return `任务 ${id}：已提交回答。`
      }
      if(/^(权限|问题|允许|拒绝|回答|停止|结果|状态|待办|提醒我|静音|正文|文件)(?:\s|$)/.test(suffix))return usage(id)
      const supplement=suffix.replace(/^(?:补充|继续)(?:\s+|$)/,'').trim()
      if(!supplement)return usage(id)
      const prior=opts.store.liveInputs.get(requestId)
      if(prior)return inputReply(await opts.actions.submitInput(id,{runId:prior.runId,requestId,text:supplement}),!!opts.actions.detail(id).runtime?.retained)
      const detail=opts.actions.detail(id)
      if(detail.runId){
        if(!detail.inputMode)throw Error('input_stale')
        return inputReply(await opts.actions.submitInput(id,{runId:detail.runId,requestId,text:supplement}),!!detail.runtime?.retained)
      }
      opts.actions.continueTask(task.id,supplement,{inputRequestId:requestId})
      return `任务 ${id}：已收到补充要求，继续处理。稍后发送「任务 ${id}」查看进展。`
    }catch(error){return failure(error,id)}
  }
}
