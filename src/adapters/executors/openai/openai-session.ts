/**
 * OpenAI 兼容执行者的会话 —— 只有这一种(架构终态 B2,2026-10-25)。
 *
 * 以前两份:对话是 openai-agent-provider 自己的循环 + MCP 桥(内存里的历史、/stop 只在步与步之间生效);工作台是
 * api-task-provider 的文件工具 + 持久会话(请求真能掐断、逐字流、用量、严格核对响应)。现在循环只在这里,底下是同一个
 * `APIModel`(api-model.ts),历史都经 `SessionHistory` 存进 api-sessions;两边不同的只有「用途」(`OpenAiPurpose`):
 * 工具面、怎么放行、事件怎么报、失败怎么说。用途在 openai-agent-provider.ts(对话)和 openai-workbench-provider.ts
 * (工作台)里各一份。
 *
 * 一轮(dispatch)是一个立即开跑的任务,事件进队列 —— 不靠消费方拉着走,所以 cancel / close 能等它真停下。
 */
import type {AgentAttachment,AgentEvent,AgentSession} from '../../../ports/agent-provider'
import {AsyncQueue} from '../../../lib/async-queue'
import {sumTurnUsage,type TurnUsage} from '../../../domain/turn-usage'
import {userMessage,type APIModel,type ChatMessage,type ToolSpec} from './api-model'
import type {ApiSessionState} from './api-sessions'

export interface ToolCall{id:string;name:string;input:unknown}
export interface ImagePart{data:Uint8Array|string;mediaType:string}
/** 一次调用的结果:文字回给模型;`images` 在这一批之后另起一条用户消息(Chat Completions 的 tool 消息装不下图)。 */
export interface ToolOutcome{output:string;images?:ImagePart[];/** 结果存进历史之后再报的事件(工作台:这次调用做完 / 失败)。 */after?:AgentEvent}

/** 会话历史 + 它的存法(对话 / 工作台各有一份实现,都落在 api-sessions)。 */
export interface SessionHistory{
  readonly id:string
  /** 存了几次(只增):续接的会话也不会和上一次撞上逐字流的 itemId。 */
  revision():number
  messages():ChatMessage[]
  state():ApiSessionState
  /** 一轮开始:ready ⇒ active(续接来的会话、上一轮做完的对话)。 */
  begin():void
  save(messages:ChatMessage[],state?:ApiSessionState):void
}

export interface StepInfo{steps:number;usage?:TurnUsage}
/** 一轮失败时交出去的东西:事件、历史停在什么状态、要不要补一个 result(对话的 /stop、步数用完是「这一轮结束了」)。 */
export interface FailureReport{events:AgentEvent[];state:ApiSessionState;finish:boolean}

export interface OpenAiPurpose{
  readonly maxSteps:number
  /** 工作台:finishReason 必须是 stop / tool-calls、最后一步要有字、响应形状逐项核,否则不算完成。对话:照收(半截也是回复)。 */
  readonly strict:boolean
  /** 对话:一步的文字攒成一条 text 事件(AgentEvent 的契约:一条完整消息,消费方按条拼);工作台:逐字 append(带 itemId)。 */
  readonly textEvents:'per-step'|'streamed'
  /** 一轮最多吐多少字(端点不认输出上限时兜底)。 */
  readonly outputLimitBytes?:number
  /** 工作台:一个会话只派一轮(又派 ⇒ api_task_busy)。 */
  readonly singleDispatch:boolean
  /** 关闭时等这一轮停下最多多久;等不到:工作台 close 报 api_task_close_unconfirmed(任务不放手),对话照关。 */
  readonly closeTimeoutMs:number
  readonly closeMustConfirm:boolean
  /** cancel() 要不要等这一轮停下(工作台要;对话照旧只掐,不等)。 */
  readonly cancelWaits:boolean
  tools():ToolSpec[]
  /** 模型一发起调用就报(对话:带真正所属的 MCP server)。不给 ⇒ 由 runTool 自己报(工作台的 activity)。 */
  toolCallEvent?(call:ToolCall):AgentEvent
  /** 用户这一轮的消息(对话:挖 [image:路径] 成图块;工作台:核过的附件)。 */
  request(text:string,attachments:readonly AgentAttachment[]):ChatMessage|Promise<ChatMessage>
  /** 每一步 / 每次调用前的核对(工作台:文件夹没换)。抛 ⇒ 这一轮失败。 */
  check?():void
  /** 放行 + 执行一次调用。工作台在 /stop 后直接抛(这一轮作废);对话给每个 call id 回一条结果(历史得是好的,下一轮还要用)。 */
  runTool(call:ToolCall,signal:AbortSignal,emit:(event:AgentEvent)=>void):Promise<ToolOutcome>
  /** 这一步模型报了用的是哪个模型(工作台记进执行信息)。 */
  observedModel?(model:string,sessionId:string):void
  failure(error:unknown,aborted:boolean,info:StepInfo,sessionId:string):FailureReport
  close?():Promise<void>
}

function fail(code:string):never{throw Error(code)}
function check(signal:AbortSignal){if(signal.aborted)fail('api_task_cancelled')}
const hasText=(m:ChatMessage)=>m.role==='assistant'&&(typeof m.content==='string'?!!m.content.trim():m.content.some(p=>p.type==='text'&&p.text.trim()))

/** 工作台的响应核对(原 api-task-provider 一字不差):模型说完了没有、协议消息和工具调用对不对得上。 */
function strictCheck(result:Awaited<ReturnType<APIModel['stream']>['finished']>,ids:Set<string>):void{
  if(!['stop','tool-calls'].includes(result.finishReason))fail('api_task_incomplete')
  if(!result.messages.length)fail('api_task_response_invalid')
  // AI SDK may append its own error result for an unknown tool.
  // Retain the actual assistant call, then record our bounded tool
  // policy result once; never accept a purported executed result.
  for(const message of result.messages){
    if(message.role==='assistant')continue
    if(message.role!=='tool'||!Array.isArray(message.content)||!message.content.length||message.content.some(part=>part.type!=='tool-result'||part.output.type!=='error-text'||!result.toolCalls.some(call=>call.id===part.toolCallId&&call.name===part.toolName)))fail('api_task_response_invalid')
  }
  if(!result.messages.some(m=>m.role==='assistant'))fail('api_task_response_invalid')
  if(result.toolCalls.length>16||(!result.toolCalls.length&&result.finishReason!=='stop'))fail('api_task_response_invalid')
  if(result.toolCalls.length&&result.finishReason!=='tool-calls')fail('api_task_incomplete')
  if(!result.toolCalls.length&&!result.messages.some(hasText))fail('api_task_incomplete')
  const messageCalls=result.messages.flatMap(m=>m.role==='assistant'&&Array.isArray(m.content)?m.content.filter(p=>p.type==='tool-call').map(p=>({id:p.toolCallId,name:p.toolName,input:p.input})):[])
  if(JSON.stringify(messageCalls)!==JSON.stringify(result.toolCalls))fail('api_task_response_invalid')
  for(const call of result.toolCalls){
    if(!call.id||call.id.length>256||ids.has(call.id))fail('api_task_response_invalid')
    ids.add(call.id)
  }
}

/**
 * 历史停在一步当中(助理发了工具调用、结果没回齐)时退回这一步之前 —— 不然下一轮请求在 API 那边是坏的。
 * 只有对话会接着用失败过的历史(工作台失败就记 interrupted,不续接)。
 */
export function trimDanglingToolCalls(messages:ChatMessage[]):ChatMessage[]{
  for(let i=messages.length-1;i>=0;i--){
    const m=messages[i]!
    if(m.role!=='assistant'||!Array.isArray(m.content))continue
    const calls=m.content.filter(p=>p.type==='tool-call').map(p=>p.toolCallId)
    if(!calls.length)return messages
    const answered=new Set(messages.slice(i+1).flatMap(t=>t.role==='tool'&&Array.isArray(t.content)?t.content.map(p=>p.type==='tool-result'?p.toolCallId:''):[]))
    return calls.every(id=>answered.has(id))?messages:messages.slice(0,i)
  }
  return messages
}

export function openOpenAiSession(args:{model:APIModel;history:SessionHistory;purpose:OpenAiPurpose}):AgentSession{
  const {model,history,purpose}=args
  let closed=false,active:Promise<void>|null=null,controller:AbortController|null=null,dispatched=false,first=true,toolsClosed=false
  const closeTools=async()=>{if(toolsClosed)return;toolsClosed=true;await purpose.close?.().catch(()=>{})}

  async function run(text:string,attachments:readonly AgentAttachment[],queue:AsyncQueue<AgentEvent>,signal:AbortSignal){
    const started=Date.now()
    if(first){first=false;queue.push({kind:'init',sessionId:history.id})}
    let outputBytes=0,usage:TurnUsage|undefined,steps=0
    const push=(event:AgentEvent)=>{queue.push(event)}
    try{
      check(signal);purpose.check?.()
      history.begin()
      // 同步给得出来就同步(工作台):这一轮一路同步走到第一个请求,和统一之前的时序一样。
      const pending=purpose.request(text,attachments)
      const request=pending instanceof Promise?await pending:pending
      history.save([...history.messages(),request])
      const ids=new Set<string>()
      for(const message of history.messages())if(message.role==='assistant'&&Array.isArray(message.content))for(const part of message.content)if(part.type==='tool-call')ids.add(part.toolCallId)
      for(let step=0;step<purpose.maxSteps;step++){
        check(signal);purpose.check?.()
        const itemId=`${history.id}:${history.revision()}:${step}`
        steps++
        const turn=model.stream(structuredClone(history.messages()),purpose.tools(),signal)
        void turn.finished.catch(()=>undefined)
        let buffered=''
        const flush=()=>{if(buffered){push({kind:'text',text:buffered});buffered=''}}
        for await(const delta of turn.deltas){
          check(signal)
          if(delta.kind==='text'){
            outputBytes+=Buffer.byteLength(delta.text)
            if(purpose.outputLimitBytes!==undefined&&outputBytes>purpose.outputLimitBytes)fail('api_task_output_limit')
            if(purpose.textEvents==='streamed')push({kind:'text',text:delta.text,itemId,textMode:'append'})
            else buffered+=delta.text
          }else if(purpose.toolCallEvent){
            // 工具调用之前先把已攒的文字吐出来,保持「先说后做」的事件顺序。
            flush();push(purpose.toolCallEvent(delta))
          }
        }
        flush()
        const result=await turn.finished;check(signal);purpose.check?.()
        if(result.usage)usage=sumTurnUsage(usage,result.usage)
        if(purpose.strict)strictCheck(result,ids)
        const assistantMessages=result.messages.filter(m=>m.role==='assistant')
        history.save([...history.messages(),...assistantMessages])
        if(result.model)purpose.observedModel?.(result.model,history.id)
        if(!result.toolCalls.length){
          history.save(history.messages(),'ready')
          push({kind:'result',sessionId:history.id,numTurns:steps,durationMs:Date.now()-started,...(usage?{usage}:{})});return
        }
        const followUps:ChatMessage[]=[]
        for(const call of result.toolCalls){
          const outcome=await purpose.runTool(call,signal,push)
          history.save([...history.messages(),{role:'tool',content:[{type:'tool-result',toolCallId:call.id,toolName:call.name,output:{type:'text',value:outcome.output}}]}])
          if(outcome.after)push(outcome.after)
          if(outcome.images?.length)followUps.push(userMessage(`[${call.name} 的结果]`,outcome.images))
        }
        check(signal)
        if(followUps.length)history.save([...history.messages(),...followUps])
      }
      fail('api_task_step_limit')
    }catch(error){
      const report=purpose.failure(error,signal.aborted,{steps,...(usage?{usage}:{})},history.id)
      // 存不下(工作台)⇒ 这一轮的 promise 失败、close 跟着失败,任务不放手(和改之前一样)。
      if(history.state()==='active')history.save(report.state==='interrupted'?history.messages():trimDanglingToolCalls(history.messages()),report.state)
      for(const event of report.events)push(event)
      if(report.finish)push({kind:'result',sessionId:history.id,numTurns:steps,durationMs:Date.now()-started,...(usage?{usage}:{})})
    }finally{queue.end()}
  }

  return{
    dispatch(text,attachments=[]){
      if(closed)fail('api_task_closed')
      if(purpose.singleDispatch&&(active||dispatched))fail('api_task_busy')
      dispatched=true
      // 在 dispatch() 的同步体里建好:dispatch 返回之后、第一次 next() 之前的 cancel() 也够得着这一轮。
      const ctl=new AbortController();controller=ctl
      const queue=new AsyncQueue<AgentEvent>()
      const work=run(text,attachments,queue,ctl.signal)
      active=work
      // Persistence errors must make close reject so task ownership remains held.
      void work.catch(()=>undefined).finally(()=>{ctl.abort();if(active===work)active=null;if(controller===ctl)controller=null})
      return queue.iterable()
    },
    async cancel(){
      controller?.abort()
      if(purpose.cancelWaits&&active)await drained(active,purpose.closeTimeoutMs)
    },
    async close(){
      closed=true;controller?.abort()
      const work=active
      try{
        if(work)await drained(work,purpose.closeTimeoutMs)
        else if(history.state()==='active')history.save(history.messages(),'ready')
      }catch(error){
        // 这一轮还没停下:工具等它停了再关;工作台照实报「没确认关掉」(任务不放手),对话照关。
        if(work)void work.catch(()=>undefined).finally(closeTools)
        if(!work||purpose.closeMustConfirm)throw error
        return
      }
      await closeTools()
    },
  }
}

async function drained(work:Promise<void>,timeoutMs:number){
  let timer:ReturnType<typeof setTimeout>|undefined
  try{await Promise.race([work,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(Error('api_task_close_unconfirmed')),timeoutMs)})])}
  finally{if(timer)clearTimeout(timer)}
}
