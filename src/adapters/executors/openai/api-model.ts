/**
 * OpenAI 兼容执行者和 AI SDK 之间的唯一一层(B2,2026-10-25:对话、工作台、一次性评估都走它)。
 * 别的文件不 import `ai` / `@ai-sdk/*`。
 */
import {createOpenAICompatible} from '@ai-sdk/openai-compatible'
import {aiSdkUsage,type TurnUsage} from '../../../domain/turn-usage'
import {makeThinkFilter} from '../../../domain/think-tags'
import {makeTimeoutFetch,openaiFetchTimeoutsFromEnv,type FetchLike,type FetchTimeouts} from '../../../lib/timeout-fetch'
import {jsonSchema,streamText,tool,type LanguageModel,type ModelMessage,type TextStreamPart,type ToolSet} from 'ai'
import {makeOpenaiRetry,type OpenaiRetryOptions} from './openai-retry'
import {usageFetch} from './usage-fetch'
import type {CheckupBudget} from '../../../domain/checkup-budget'

export type ChatMessage=ModelMessage
export interface ToolSpec{name:string;description:string;parameters:Record<string,unknown>}
export type TurnDelta={kind:'text';text:string}|{kind:'tool_call';id:string;name:string;input:unknown}
export interface StepResult{messages:ChatMessage[];toolCalls:{id:string;name:string;input:unknown}[];finishReason:string;model:string|null;usage?:TurnUsage}
export interface APIModel{
  /** 一步:先把 `deltas` 读完,再等 `finished`(反过来会和 AI SDK 的 tee 互相等)。`signal` 真的掐掉请求。 */
  stream(messages:ChatMessage[],tools:ToolSpec[],signal:AbortSignal,retryAllowed?:boolean):{deltas:AsyncIterable<TurnDelta>;finished:Promise<StepResult>;readonly requestBytes?:number}
  /** 一次性评估(cheapEval / strongEval):整段文字,开头的 <think> 已剥。 */
  generate(messages:ChatMessage[],signal?:AbortSignal):Promise<string>
}

export interface APIModelOptions extends OpenaiRetryOptions{
  baseURL:string;apiKey:string;model:string
  /** 每一步的输出上限。缺省 4096(工作台);`null` ⇒ 不设,交给上游默认(对话一直是这样,长回复不被截)。 */
  maxOutputTokens?:number|null
  /** 请求内的重试上限(最多 2)。流式缺省 0(工作台);对话给 2;generate 缺省 2。SDK 自己的重试一律关掉。 */
  maxRetries?:number
  budget?:CheckupBudget
  /** generate() 的输出上限(思考型模型把思维链也算 completion token,缺省 4000)。 */
  evalMaxOutputTokens?:number
  timeouts?:FetchTimeouts
  /** 测试接缝:换掉 fetch(超时那层照样套在外面)。 */
  fetch?:FetchLike
  /** AI SDK 的 provider 名(只进日志 / providerOptions 的键)。 */
  providerName?:string
}
export type LanguageModelFactory=(options:Readonly<APIModelOptions>)=>LanguageModel
const DEFAULT_MAX_OUTPUT_TOKENS=4096
/** generate()(后台一次性评估)的输出上限;聊天回合不设(交给上游默认)。 */
export const DEFAULT_EVAL_MAX_OUTPUT_TOKENS=4000

/**
 * 一次性评估的输出预算被思考吃光、一个字答案都没有(finish_reason=length + 正文空 / 只有没闭合的 <think>)。
 * 2026-10-30 起真机:网关上的 DeepSeek 把 4000 token 全花在 reasoning_content 上,generate() 回 '' ——
 * 调用方只看得到「不是 JSON」(记忆整理连败五晚,日志写 bad_json)。现在抛这个,原因写清楚,provider 可以换模型再试。
 */
export class EvalOutputExhaustedError extends Error{
  constructor(readonly model:string,readonly budget:number){
    super(`eval_output_exhausted: ${model} spent the whole ${budget}-token output budget thinking and returned no answer`)
    this.name='EvalOutputExhaustedError'
  }
}

function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no})
  return{promise,resolve,reject}
}

/** 原始输出也算开始:思维链或尚未拼完的工具参数不能因为没有可见文字就被重发。 */
function outputPart(part:TextStreamPart<ToolSet>):boolean{
  return(part.type==='text-delta'||part.type==='reasoning-delta')?!!part.text
    :['tool-input-start','tool-input-delta','tool-call','tool-result','tool-error','file'].includes(part.type)
}

/** 一条用户消息;带图就是 text + image 分块,图一律是 data URL 字符串(存进 SQLite 的 JSON 也原样回来)。 */
export function userMessage(text:string,images:readonly {data:Uint8Array|string;mediaType:string}[]=[]):ChatMessage{
  if(images.length===0)return{role:'user',content:text}
  return{role:'user',content:[{type:'text',text},...images.map(i=>({type:'image' as const,image:typeof i.data==='string'?i.data:`data:${i.mediaType};base64,${Buffer.from(i.data).toString('base64')}`,mediaType:i.mediaType}))]}
}
export function systemMessage(text:string):ChatMessage{return{role:'system',content:text}}
export function toolResultMessage(toolCallId:string,toolName:string,output:string):ChatMessage{
  return{role:'tool',content:[{type:'tool-result',toolCallId,toolName,output:{type:'text',value:output}}]}
}

export function createApiModel(options:APIModelOptions,languageModelFactory?:LanguageModelFactory):APIModel{
  const baseURL=options.baseURL.trim(),apiKey=options.apiKey,modelId=options.model.trim()
  const maxOutputTokens=options.maxOutputTokens===null?undefined:options.maxOutputTokens??DEFAULT_MAX_OUTPUT_TOKENS
  const maxRetries=options.maxRetries??0
  if(!baseURL||!apiKey||!modelId||(maxOutputTokens!==undefined&&(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>16_384))||!Number.isSafeInteger(maxRetries)||maxRetries<0||maxRetries>2)throw Error('invalid_api_model')
  const frozen=Object.freeze({...options,baseURL,model:modelId,maxOutputTokens})
  const injectedModel=languageModelFactory?.(frozen)
  const modelFor=(observe:(bytes:number)=>void=()=>{})=>injectedModel??createOpenAICompatible({name:options.providerName??'workbench-api',baseURL,apiKey,includeUsage:true,
    // 边界超时(arch backlog #4 第 2 步,§4.4):AI SDK 自己没有请求超时 —— 黑洞地址会一直挂到回合看门狗。
    // 连不上 / 流停住 ⇒ 带 network 码的错误。
    fetch:usageFetch(makeTimeoutFetch(options.timeouts??openaiFetchTimeoutsFromEnv(),options.fetch),observe,options.beforeRetry) as typeof fetch}).chatModel(modelId)
  const retry=makeOpenaiRetry(modelId,options)
  return{
    stream(messages,toolSpecs,signal,retryAllowed=true){
      let requestBytes:number|undefined
      const model=modelFor(bytes=>{requestBytes=bytes})
      const first=messages[0]
      const system=first?.role==='system'?first.content:undefined
      const input=system===undefined?messages:messages.slice(1)
      if(input.some(message=>message.role==='system'))throw Error('invalid_api_messages')
      // Schema-only tools (no `execute`): AI SDK surfaces the calls and stops after one step — the session owns the loop.
      const tools=Object.fromEntries(toolSpecs.map(spec=>[spec.name,tool({description:spec.description,inputSchema:jsonSchema(spec.parameters)})]))
      const completion=deferred<StepResult>()
      // A stream can fail before its owner reaches `finished`; attach a handler
      // immediately while preserving the original rejecting promise for callers.
      void completion.promise.catch(()=>undefined)
      let consumed=false
      async function* deltas():AsyncIterable<TurnDelta>{
        if(consumed)throw Error('api_model_stream_already_consumed')
        consumed=true
        let complete=false,outputStarted=false
        try{
          for(let retries=0;;retries++){
            const toolCalls:{id:string;name:string;input:unknown}[]=[]
            let finishReason:string|undefined,responseModel:string|null=null,usage:TurnUsage|undefined
            // 内联在 content 里的思维链不给主人看 —— 见 think-tags.ts(只剥开头那一段)。
            const think=makeThinkFilter()
            const attempt=new AbortController()
            let lease:ReturnType<CheckupBudget['reserve']>|undefined,outputBytes=0
            try{
              signal.throwIfAborted()
              lease=options.budget?.reserve(maxOutputTokens??DEFAULT_MAX_OUTPUT_TOKENS)
              // 错误只交给下面的结构化通道;SDK 缺省 onError 会把请求/响应正文打到 console。
              const abortSignal=maxRetries?AbortSignal.any([signal,attempt.signal]):signal
              const result=streamText({model,system,messages:input,tools,...(maxOutputTokens!==undefined?{maxOutputTokens:lease?.maxOutputTokens??maxOutputTokens}:{}),maxRetries:0,abortSignal,onError:()=>{}})
              const responsePromise=result.response
              void responsePromise.catch(()=>undefined)
              for await(const part of result.fullStream){
                if(part.type==='text-delta'||part.type==='reasoning-delta')outputBytes+=new TextEncoder().encode(part.text).length
                else if(part.type==='tool-call')outputBytes+=new TextEncoder().encode(JSON.stringify({name:part.toolName,input:part.input})).length
                if(outputPart(part))outputStarted=true
                if(part.type==='text-delta'){
                  const text=think.push(part.text)
                  if(text)yield{kind:'text',text}
                }else if(part.type==='tool-call'){
                  const call={id:part.toolCallId,name:part.toolName,input:part.input}
                  toolCalls.push(call)
                  yield{kind:'tool_call',...call}
                }else if(part.type==='finish-step'){
                  finishReason=part.finishReason
                  responseModel=part.response.modelId||null
                  // 端点报的这一步用量(v82 逐回合用量);不报 ⇒ 不写
                  usage=aiSdkUsage(part.usage)
                }else if(part.type==='finish'){
                  finishReason=part.finishReason
                }else if(part.type==='error'){
                  // AI SDK v5 把传输层失败(网关 401 …)作为 error 分块送进 fullStream,`response` 随后只剩一个丢了原因的
                  // NoOutputGeneratedError —— 抛这里拿到的真错误(status / message 都在)。
                  attempt.abort(part.error)
                  throw part.error
                }else if(part.type==='abort'){
                  throw Error('api_model_aborted')
                }
                // Reasoning and provider-only stream parts are intentionally private.
              }
              const tail=think.end()
              if(tail)yield{kind:'text',text:tail}
              if(!finishReason)throw Error('missing_finish_reason')
              const response=await responsePromise
              complete=true
              // SDK optional fields such as providerExecuted/providerOptions can be
              // explicitly undefined. Normalize to their JSON wire representation;
              // retain actual reasoning/signature values for private continuation.
              const messages=JSON.parse(JSON.stringify(response.messages)) as ChatMessage[]
              completion.resolve({messages,toolCalls,finishReason,model:finishReason==='unknown'?null:responseModel,...(usage?{usage}:{})})
              return
            }catch(error){attempt.abort(error);if(!await retry(error,retries,outputStarted,signal,retryAllowed?maxRetries:0))throw error}
            finally{lease?.settle({outputTokens:usage?.output,outputBytes,exhausted:finishReason==='length'});attempt.abort()}
          }
        }catch(error){complete=true;completion.reject(error);throw error}
        finally{if(!complete)completion.reject(Error('api_model_stream_incomplete'))}
      }
      return{deltas:deltas(),finished:completion.promise,get requestBytes(){return requestBytes}}
    },
    async generate(messages,signal=new AbortController().signal){
      const model=modelFor()
      // streamText 而不是 generateText:只实现了流式的端点 / 测试替身也能用,一条路。
      // 显式给 max_tokens:思考型模型(Kimi / GLM 带思考)把思维链也算 completion token,上游默认预算被思考吃光就回
      // content="" + finish_reason=length —— 看起来像模型不回话。
      const first=messages[0]
      const system=first?.role==='system'?first.content:undefined
      const budget=options.evalMaxOutputTokens??DEFAULT_EVAL_MAX_OUTPUT_TOKENS
      let outputStarted=false
      for(let retries=0;;retries++){
        const attempt=new AbortController()
        try{
          signal.throwIfAborted()
          const result=streamText({model,system,messages:system===undefined?messages:messages.slice(1),maxOutputTokens:budget,maxRetries:0,abortSignal:AbortSignal.any([signal,attempt.signal]),onError:()=>{}})
          // 先启动另一条 tee 的消费,观察早到的拒绝;error 分块后对端可能还不肯断流。
          const textPromise=result.text
          void textPromise.catch(()=>undefined)
          // 同上:传输层失败是 fullStream 里的 error 分块,`result.text` 之后只剩通用的 NoOutputGeneratedError。
          let finishReason:string|undefined
          for await(const part of result.fullStream){
            if(outputPart(part))outputStarted=true
            if(part.type==='error'){attempt.abort(part.error);throw part.error}
            else if(part.type==='abort')throw Error('api_model_aborted')
            else if(part.type==='finish')finishReason=part.finishReason
          }
          const raw=await textPromise
          // 一次性调用也要剥 —— cheapEval / 判断题直接拿这个字符串比对。
          const think=makeThinkFilter()
          const visible=think.push(raw)+think.end()
          // 预算用完还一个字没答(思考在 reasoning_content 里,或内联 <think> 没闭合)⇒ 不是答案,别当答案交出去。
          // 截了一半的正文照旧返回 —— 那是调用方自己判的事。
          const lead=raw.trimStart()
          if(finishReason==='length'&&(!visible.trim()||(lead.startsWith('<think>')&&!lead.includes('</think>'))))throw new EvalOutputExhaustedError(modelId,budget)
          return visible
        }catch(error){attempt.abort(error);if(!await retry(error,retries,outputStarted,signal,options.maxRetries??2))throw error}
        finally{attempt.abort()}
      }
    },
  }
}
