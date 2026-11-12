import {describe,expect,it,vi} from 'vitest'
import {MockLanguageModelV2} from 'ai/test'
import {simulateReadableStream} from 'ai'
import {createApiModel,userMessage,type APIModelOptions} from './api-model'
import {createOpenAiAgentProvider} from './openai-agent-provider'
import {collectTurn,type AgentMcpTools} from '../../../ports/agent-provider'
import {TIER_PROFILES} from '../../../domain/user-tier'
import {assertCallAllowed,NetworkUnprotectedError} from '../../../lib/network-gate'
import {providerErrorCodeOf} from '../../../lib/provider-error-code'
import {retrySleep} from './openai-retry'

const sse=(delta:Record<string,unknown>={content:'ok'},finish='stop')=>new Response([
  {choices:[{index:0,delta,finish_reason:null}]},
  {choices:[{index:0,delta:{},finish_reason:finish}]},
].map(chunk=>'data: '+JSON.stringify({id:'r',object:'chat.completion.chunk',created:1,model:'DeepSeek',...chunk})+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
const failed=(status:number)=>new Response(JSON.stringify({error:{message:'litellm.AuthenticationError Received Model Group=DeepSeek private body'}}),{status,headers:{'content-type':'application/json'}})
function fixture(fetch:APIModelOptions['fetch'],extra:Partial<APIModelOptions>={}){
  const sleep=vi.fn(async(_ms:number,_signal:AbortSignal)=>{}),log=vi.fn((_tag:string,_line:string)=>{})
  const api=createApiModel({baseURL:'http://gateway.test/v1',apiKey:'secret-key',model:'DeepSeek',maxRetries:2,fetch,retrySleep:sleep,retryRandom:()=>0,log,...extra})
  const bridge:AgentMcpTools={tools:[],serverOf:()=>undefined,call:async()=>'',close:async()=>{}}
  const provider=createOpenAiAgentProvider({makeChatModel:()=>api,makeMcpBridge:async()=>bridge,makeBuiltins:()=>[],log})
  return{api,provider,sleep,log}
}
async function turn(provider:ReturnType<typeof createOpenAiAgentProvider>){
  const session=await provider.spawn({alias:'sandbox',path:process.cwd()},{tierProfile:TIER_PROFILES.trusted,permissionMode:'strict',chatId:'sandbox'})
  try{return await collectTurn(session.dispatch('private prompt'))}finally{await session.close()}
}

describe('OpenAI gateway bounded transient retries (injected fetch, no ports)',()=>{
  it.each([401,404,408,409,410,429,500,502,503,524,599])('%i then 200 completes a conversation without AUTH_FAILED',async status=>{
    const fetch=vi.fn().mockImplementationOnce(async()=>failed(status)).mockImplementation(async()=>sse())
    const f=fixture(fetch),summary=await turn(f.provider)
    expect(summary.result).toBeDefined()
    expect(summary.error).toBeUndefined()
    expect(summary.assistantText).toEqual(['ok'])
    expect(summary.errorCode).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(f.sleep.mock.calls.map(c=>c[0])).toEqual([2000])
    expect(f.log.mock.calls.filter(c=>c[0]!=='SESSION_SPAWN')).toEqual([['OPENAI_RETRY',`attempt=2 status=${status} model=DeepSeek`]])
  })

  it.each(['cheapEval','strongEval'] as const)('%s retries a single 401 without marking credentials invalid',async kind=>{
    const fetch=vi.fn().mockImplementationOnce(async()=>failed(401)).mockImplementation(async()=>sse())
    const f=fixture(fetch)
    expect(await f.provider[kind]!('private prompt')).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(f.log.mock.calls.map(c=>c[0])).toEqual(['OPENAI_RETRY'])
  })

  it('three 401s exhaust exactly three attempts, then retain conversation and cheapEval auth classification',async()=>{
    const fetch=vi.fn(async()=>failed(401)),f=fixture(fetch)
    const summary=await turn(f.provider)
    expect(summary.result).toBeUndefined()
    expect(summary.errorCode).toBe('auth_rejected')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(f.sleep.mock.calls.map(c=>c[0])).toEqual([2000,4000])
    expect(providerErrorCodeOf(await f.provider.cheapEval!('private prompt').catch(e=>e))).toBe('auth_rejected')
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(f.log.mock.calls.filter(c=>c[0]==='AUTH_FAILED')).toHaveLength(1)
    expect(f.log.mock.calls.filter(c=>c[0]==='OPENAI_RETRY').map(c=>c[1])).toEqual([
      'attempt=2 status=401 model=DeepSeek','attempt=3 status=401 model=DeepSeek',
      'attempt=2 status=401 model=DeepSeek','attempt=3 status=401 model=DeepSeek',
    ])
    expect(JSON.stringify(f.log.mock.calls.filter(c=>c[0]==='OPENAI_RETRY'))).not.toMatch(/secret-key|private/)
  })

  it.each([400,403,422])('%i is terminal (403 still has the existing auth verdict)',async status=>{
    const fetch=vi.fn(async()=>failed(status)),f=fixture(fetch)
    const summary=await turn(f.provider)
    expect(summary.error).toBeTruthy()
    expect(summary.errorCode).toBe(status===403?'auth_rejected':'invalid_request')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(f.sleep).not.toHaveBeenCalled()
  })

  it('transient socket failure before output retries; explicit offline and guard failures do not',async()=>{
    const fetch=vi.fn().mockRejectedValueOnce(Object.assign(Error('socket hang up'),{code:'ECONNRESET'})).mockImplementation(async()=>sse())
    const f=fixture(fetch)
    expect((await turn(f.provider)).error).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(f.log).toHaveBeenCalledWith('OPENAI_RETRY','attempt=2 status=network model=DeepSeek')
    for(const error of [
      Object.assign(Error('fetch failed'),{cause:{code:'ENETDOWN'}}),
      Object.assign(Error('network unreachable'),{code:'ENETUNREACH'}),
      new NetworkUnprotectedError({safe:false,source:'bx',detail:'offline'}),
    ]){
      const offline=vi.fn().mockRejectedValue(error),g=fixture(offline)
      await expect(g.api.generate([userMessage('x')])).rejects.toThrow()
      expect(offline).toHaveBeenCalledTimes(1)
      expect(g.sleep).not.toHaveBeenCalled()
    }
  })

  it('rechecks the real network gate after the delay; a new refusal stops without another fetch',async()=>{
    const fetch=vi.fn(async()=>failed(410)),gate={check:vi.fn(async()=>({safe:false,source:'bx' as const,detail:'offline'}))}
    const f=fixture(fetch,{beforeRetry:()=>assertCallAllowed(gate,{provider:'openai',baseUrl:'https://api.openai.com/v1',model:'m',exact:true})})
    await expect(f.api.generate([userMessage('x')])).rejects.toBeInstanceOf(NetworkUnprotectedError)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(gate.check).toHaveBeenCalledTimes(1)
    expect(f.sleep).toHaveBeenCalledTimes(1)
    expect(f.log).not.toHaveBeenCalled()
  })

  it('conversation dispatch preserves network_unprotected when the guard closes during backoff',async()=>{
    const refusal=new NetworkUnprotectedError({safe:false,source:'bx',detail:'offline'}),fetch=vi.fn(async()=>failed(410))
    const f=fixture(fetch,{beforeRetry:async()=>{throw refusal}})
    const summary=await turn(f.provider)
    expect(summary.errorCode).toBe('network_unprotected')
    expect(summary.result).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(f.log.mock.calls.filter(c=>c[0]==='OPENAI_RETRY'||c[0]==='AUTH_FAILED')).toEqual([])
  })

  it('backoff has a small bounded jitter and never stacks SDK retries on top',async()=>{
    const fetch=vi.fn(async()=>failed(502)),f=fixture(fetch,{retryRandom:()=>0.5})
    await expect(f.api.generate([userMessage('x')])).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(f.sleep.mock.calls.map(c=>c[0])).toEqual([2100,4100])
  })

  it('a transport error inside the stream before output can retry',async()=>{
    const cause=Object.assign(Error('socket hang up'),{code:'ECONNRESET'}),sleep=vi.fn(async()=>{})
    const doStream=vi.fn().mockImplementationOnce(async()=>({stream:simulateReadableStream({chunks:[{type:'error',error:cause}]})}))
      .mockImplementation(async()=>({stream:simulateReadableStream({chunks:[{type:'text-start',id:'t'},{type:'text-delta',id:'t',delta:'ok'},{type:'text-end',id:'t'},{type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}}]})}))
    const api=createApiModel({baseURL:'http://unused.test',apiKey:'k',model:'m',maxRetries:2,retrySleep:sleep},()=>new MockLanguageModelV2({doStream}))
    expect(await api.generate([userMessage('x')])).toBe('ok')
    expect(doStream).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it.each(['stream','generate'] as const)('%s aborts an error stream that stays open before retrying',async kind=>{
    const cause=Object.assign(Error('socket hang up'),{code:'ECONNRESET'}),cancelled=vi.fn()
    let attempts=0
    const model=new MockLanguageModelV2({doStream:async options=>{
      attempts++
      if(attempts===1)return{stream:new ReadableStream({start(c){
        c.enqueue({type:'error',error:cause})
        options.abortSignal?.addEventListener('abort',()=>{cancelled();c.error(options.abortSignal?.reason)},{once:true})
      }})}
      expect(cancelled).toHaveBeenCalledTimes(1)
      return{stream:simulateReadableStream({chunks:[{type:'text-start',id:'t'},{type:'text-delta',id:'t',delta:'ok'},{type:'text-end',id:'t'},{type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}}]})}
    }})
    const api=createApiModel({baseURL:'http://unused.test',apiKey:'k',model:'m',maxRetries:2,retrySleep:async()=>{}},()=>model)
    if(kind==='generate')expect(await api.generate([userMessage('x')])).toBe('ok')
    else{
      const r=api.stream([userMessage('x')],[],new AbortController().signal),seen=[]
      for await(const d of r.deltas)seen.push(d)
      expect(seen).toEqual([{kind:'text',text:'ok'}])
      expect((await r.finished).finishReason).toBe('stop')
    }
    expect(attempts).toBe(2)
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('a later step still closes its failed stream when retry is forbidden',async()=>{
    const cause=Object.assign(Error('socket hang up'),{code:'ECONNRESET'}),cancelled=vi.fn(),sleep=vi.fn(async()=>{})
    const model=new MockLanguageModelV2({doStream:async options=>({stream:new ReadableStream({start(c){
      c.enqueue({type:'error',error:cause})
      options.abortSignal?.addEventListener('abort',()=>{cancelled();c.error(options.abortSignal?.reason)},{once:true})
    }})})})
    const api=createApiModel({baseURL:'http://unused.test',apiKey:'k',model:'m',maxRetries:2,retrySleep:sleep},()=>model)
    const r=api.stream([userMessage('x')],[],new AbortController().signal,false)
    await expect(async()=>{for await(const _ of r.deltas){}}).rejects.toBe(cause)
    await expect(r.finished).rejects.toBe(cause)
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('generate propagates an error after partial text instead of retrying or returning a partial answer',async()=>{
    const cause=Object.assign(Error('socket hang up'),{code:'ECONNRESET'}),sleep=vi.fn(async()=>{})
    const doStream=vi.fn(async()=>({stream:simulateReadableStream({chunks:[{type:'text-start',id:'t'},{type:'text-delta',id:'t',delta:'partial'},{type:'error',error:cause}] as never[]})}))
    const api=createApiModel({baseURL:'http://unused.test',apiKey:'k',model:'m',maxRetries:2,retrySleep:sleep},()=>new MockLanguageModelV2({doStream}))
    await expect(api.generate([userMessage('x')])).rejects.toBe(cause)
    expect(doStream).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('production sleep clears its timer when aborted, including an already cancelled request',async()=>{
    vi.useFakeTimers()
    try{
      const controller=new AbortController(),waiting=retrySleep(2000,controller.signal)
      const rejected=expect(waiting).rejects.toThrow('cancelled')
      expect(vi.getTimerCount()).toBe(1)
      controller.abort(Error('cancelled'))
      await rejected
      expect(vi.getTimerCount()).toBe(0)
      expect(()=>retrySleep(4000,controller.signal)).toThrow('cancelled')
      expect(vi.getTimerCount()).toBe(0)
    }finally{vi.useRealTimers()}
  })

  it.each(['text','think','reasoning','tool-input','tool-call'] as const)('after %s output, a stream error never retries',async kind=>{
    const cause=Object.assign(Error('socket hang up'),{code:'ECONNRESET'})
    const chunks:unknown[]=kind==='reasoning'?[{type:'reasoning-start',id:'r'},{type:'reasoning-delta',id:'r',delta:'hidden'}]
      :kind==='tool-input'?[{type:'tool-input-start',id:'c',toolName:'save'},{type:'tool-input-delta',id:'c',delta:'{'}]
      :kind==='tool-call'?[{type:'tool-call',toolCallId:'c',toolName:'save',input:'{}'}]
      :[{type:'text-start',id:'t'},{type:'text-delta',id:'t',delta:kind==='think'?'<think>hidden':'partial'}]
    const doStream=vi.fn(async()=>({stream:simulateReadableStream({chunks:[...chunks,{type:'error',error:cause}] as never[]})}))
    const api=createApiModel({baseURL:'http://unused.test',apiKey:'k',model:'m',maxRetries:2,retrySleep:vi.fn(async()=>{})},()=>new MockLanguageModelV2({doStream}))
    const request=api.stream([userMessage('x')],[{name:'save',description:'save',parameters:{type:'object'}}],new AbortController().signal)
    await expect(async()=>{for await(const _ of request.deltas){}}).rejects.toBe(cause)
    await expect(request.finished).rejects.toBe(cause)
    expect(doStream).toHaveBeenCalledTimes(1)
  })

  it('a later request in a turn that already ran a tool does not retry',async()=>{
    const fetch=vi.fn().mockImplementationOnce(async()=>sse({tool_calls:[{index:0,id:'c',type:'function',function:{name:'save',arguments:'{}'}}]},'tool_calls')).mockImplementation(async()=>failed(410))
    const f=fixture(fetch),execute=vi.fn(async()=>'saved')
    const provider=createOpenAiAgentProvider({makeChatModel:()=>f.api,makeMcpBridge:async()=>({tools:[],serverOf:()=>undefined,call:async()=>'',close:async()=>{}}),makeBuiltins:()=>[{spec:{name:'save',description:'save',parameters:{type:'object'}},execute,risk:'caution'}]})
    expect((await turn(provider)).error).toBeTruthy()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(f.sleep).not.toHaveBeenCalled()
  })

  it.each(['stream','generate'] as const)('abort cancels %s while retry sleep is pending',async kind=>{
    const controller=new AbortController(),entered=Promise.withResolvers<void>(),fetch=vi.fn(async()=>failed(410))
    const sleep=vi.fn(async(_ms:number,signal:AbortSignal)=>{entered.resolve();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})
    const f=fixture(fetch,{retrySleep:sleep})
    const result=kind==='generate'?f.api.generate([userMessage('x')],controller.signal):(async()=>{const r=f.api.stream([userMessage('x')],[],controller.signal);for await(const _ of r.deltas){};return r.finished})()
    const rejected=expect(result).rejects.toThrow('cancelled')
    await entered.promise
    controller.abort(Error('cancelled'))
    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })
})
