import {createOpenAICompatible} from '@ai-sdk/openai-compatible'
import {jsonSchema,streamText,tool,type LanguageModel,type ModelMessage} from 'ai'

export type ChatMessage=ModelMessage
export interface ToolSpec{name:string;description:string;parameters:Record<string,unknown>}
export type TurnDelta={kind:'text';text:string}|{kind:'tool_call';id:string;name:string;input:unknown}
export interface APIModel{
  stream(messages:ChatMessage[],tools:ToolSpec[],signal:AbortSignal):{
    deltas:AsyncIterable<TurnDelta>
    finished:Promise<{messages:ChatMessage[];toolCalls:{id:string;name:string;input:unknown}[];finishReason:string;model:string|null}>
  }
}

export interface APIModelOptions{baseURL:string;apiKey:string;model:string;maxOutputTokens?:number}
export type LanguageModelFactory=(options:Readonly<APIModelOptions>)=>LanguageModel
const DEFAULT_MAX_OUTPUT_TOKENS=4096

function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no})
  return{promise,resolve,reject}
}

export function createApiModel(options:APIModelOptions,languageModelFactory?:LanguageModelFactory):APIModel{
  const baseURL=options.baseURL.trim(),apiKey=options.apiKey,modelId=options.model.trim()
  const maxOutputTokens=options.maxOutputTokens??DEFAULT_MAX_OUTPUT_TOKENS
  if(!baseURL||!apiKey||!modelId||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>16_384)throw Error('invalid_api_model')
  const frozen=Object.freeze({...options,baseURL,model:modelId,maxOutputTokens})
  const model=languageModelFactory?.(frozen)??createOpenAICompatible({name:'workbench-api',baseURL,apiKey}).chatModel(modelId)
  return{
    stream(messages,toolSpecs,signal){
      const first=messages[0]
      const system=first?.role==='system'?first.content:undefined
      const input=system===undefined?messages:messages.slice(1)
      if(input.some(message=>message.role==='system'))throw Error('invalid_api_messages')
      const tools=Object.fromEntries(toolSpecs.map(spec=>[spec.name,tool({description:spec.description,inputSchema:jsonSchema(spec.parameters)})]))
      const result=streamText({model,system,messages:input,tools,maxOutputTokens,maxRetries:0,abortSignal:signal})
      const responsePromise=result.response
      void responsePromise.catch(()=>undefined)
      const completion=deferred<{messages:ChatMessage[];toolCalls:{id:string;name:string;input:unknown}[];finishReason:string;model:string|null}>()
      // A stream can fail before its owner reaches `finished`; attach a handler
      // immediately while preserving the original rejecting promise for callers.
      void completion.promise.catch(()=>undefined)
      let consumed=false
      async function* deltas():AsyncIterable<TurnDelta>{
        if(consumed)throw Error('api_model_stream_already_consumed')
        consumed=true
        const toolCalls:{id:string;name:string;input:unknown}[]=[]
        let finishReason:string|undefined,responseModel:string|null=null,complete=false
        try{
          for await(const part of result.fullStream){
            if(part.type==='text-delta'){
              yield{kind:'text',text:part.text}
            }else if(part.type==='tool-call'){
              const call={id:part.toolCallId,name:part.toolName,input:part.input}
              toolCalls.push(call)
              yield{kind:'tool_call',...call}
            }else if(part.type==='finish-step'){
              finishReason=part.finishReason
              responseModel=part.response.modelId||null
            }else if(part.type==='finish'){
              finishReason=part.finishReason
            }else if(part.type==='error'){
              throw part.error
            }else if(part.type==='abort'){
              throw Error('api_model_aborted')
            }
            // Reasoning and provider-only stream parts are intentionally private.
          }
          if(!finishReason)throw Error('missing_finish_reason')
          const response=await responsePromise
          complete=true
          // SDK optional fields such as providerExecuted/providerOptions can be
          // explicitly undefined. Normalize to their JSON wire representation;
          // retain actual reasoning/signature values for private continuation.
          const messages=JSON.parse(JSON.stringify(response.messages)) as ChatMessage[]
          completion.resolve({messages,toolCalls,finishReason,model:finishReason==='unknown'?null:responseModel})
        }catch(error){complete=true;completion.reject(error);throw error}
        finally{if(!complete)completion.reject(Error('api_model_stream_incomplete'))}
      }
      return{deltas:deltas(),finished:completion.promise}
    },
  }
}
