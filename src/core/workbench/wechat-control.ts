import {createHash,randomUUID} from 'node:crypto'
import type {WorkbenchStore,Task} from './store'
import type {LiveInput} from './live-inputs'
import type {PendingWorkbenchPermission,PermissionDecision} from './permissions'
import type {AgentRuntimeSnapshot} from '../agent-provider'
import {validateUserInputAnswers,type PendingUserInput} from './user-input'

export interface WechatMessageIdentity {accountId:string;userId:string;msgId?:string;createTimeMs:number}
type Detail=ReturnType<WorkbenchStore['detail']>&{runId?:string;runtime?:AgentRuntimeSnapshot;inputMode?:'steer'|'send'|'queue';inputs:LiveInput[];permissions:PendingWorkbenchPermission[];questions:PendingUserInput[]}
interface Actions {
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
const usage=(id='<任务编号>')=>`用法：任务 ${id}\n补充：任务 ${id} 补充 <要求>\n停止：任务 ${id} 停止\n处理待办时，请复制任务消息中的完整请求编号。`
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
  const latest=events.filter(e=>e.kind==='text').at(-1)?.text
  const error=events.filter(e=>e.kind==='error').at(-1)?.text
  const lines=[`${singleLine(task.title,120)} · ${id}`,`${task.providerId} · ${runtimeStatus(task.status,detail.runtime)}`]
  if(task.status==='running'&&detail.runtime?.retained)lines.push(`后续回复仍会留在这个任务里。结束会停止尚未结束的后台工作并保存当前成果。\n结束：任务 ${id} 停止`)
  if(latest)lines.push('最近回复：\n'+clip(latest,1500))
  if(error&&['failed','interrupted'].includes(task.status))lines.push('需要处理：'+clip(error,500))
  else if(task.error)lines.push('需要处理：'+clip(task.error,500))
  if(artifacts.length)lines.push(`已保存 ${artifacts.length} 份成果版本：\n`+artifacts.slice(0,8).map(a=>`• ${singleLine(a.name)} (${a.size} 字节)`).join('\n'))
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
  if(code==='permission_stale'||code==='question_stale')return stale
  if(code==='invalid_answer'||error instanceof SyntaxError)return '答案格式或选项不正确，尚未提交。请按问题中的示例回答。'
  if(code==='workbench_archived')return '这项任务已归档。请在桌面工作台恢复任务后再继续。'
  if(code==='restart_confirmation_required'||code==='restart_confirmation_stale')return '原执行会话暂时无法恢复。请打开桌面工作台，查看恢复选项并确认是否带此前记录重新开始。'
  if(code==='external_close_confirmation_required')return '请先在桌面工作台确认原执行程序已关闭，再继续这项任务。'
  if(code==='input_stale'||code==='workbench_busy')return '任务轮次已变化或正在停止，这条补充没有发送。请重新查询任务后再提交。'
  if(code==='input_conflict')return '这条消息的内容与已记录的补充不一致，未再次发送。请重新查询任务。'
  if(code==='control_conflict')return '这条消息的内容与已记录的操作不一致，未再次执行。请重新查询任务。'
  if(code==='control_stale')return '原请求对应的轮次已结束，未停止当前轮次。请重新查询任务。'
  if(code==='input_limit'||code==='input_delivery_busy')return '仍有补充等待交付，请稍后再试。'
  if(code.startsWith('invalid_'))return usage(id)
  return '暂时无法处理，请在桌面工作台查看任务状态。'
}

export function makeWechatWorkbenchControl(opts:{store:WorkbenchStore;ownerChatId:()=>string|null;actions:Actions}){
  return async(chatId:string,text:string,identity?:WechatMessageIdentity):Promise<string|null>=>{
    if(!isWechatTaskCommand(text))return null
    if(!opts.ownerChatId()||chatId!==opts.ownerChatId()||(identity&&identity.userId!==chatId))return null
    const command=text.trim().replace(/^(?:任务|\/task)\s*/i,'')
    if(!command||command==='列表'){
      const tasks=opts.store.listOwned(chatId,8)
      return tasks.length?'最近的任务：\n'+tasks.map(t=>`${t.id} · ${singleLine(t.title)} · ${runtimeStatus(t.status,opts.actions.detail(t.id).runtime)}`).join('\n')+'\n\n查看或选择：任务 <任务编号>':'还没有属于你的工作任务。请先在桌面工作台创建。'
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
        return receipt.result??stopUnconfirmed
      }
      if(!suffix||['结果','状态','待办'].includes(suffix))return statusReply(opts.actions.detail(id))
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
      if(/^(权限|问题|允许|拒绝|回答|停止|结果|状态|待办)(?:\s|$)/.test(suffix))return usage(id)
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
