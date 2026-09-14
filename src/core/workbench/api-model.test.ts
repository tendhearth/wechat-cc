import {describe,expect,it,vi} from 'vitest'
import {MockLanguageModelV2} from 'ai/test'
import {simulateReadableStream,type LanguageModel} from 'ai'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {createApiModel,type ChatMessage,type ToolSpec} from './api-model'

const user=(text:string):ChatMessage=>({role:'user',content:text})
const streamModel=(chunks:unknown[],capture?:Record<string,unknown>)=>new MockLanguageModelV2({
  doStream:async options=>{
    if(capture)Object.assign(capture,options)
    return{stream:simulateReadableStream({chunks:chunks as never[]})}
  },
})

describe('APIModel transport',()=>{
  it('streams visible text and tool calls once, retaining protocol finish metadata and messages',async()=>{
    const capture:Record<string,unknown>={}
    const model=streamModel([
      {type:'text-start',id:'t1'},
      {type:'reasoning-start',id:'r1'},
      {type:'reasoning-delta',id:'r1',delta:'hidden chain'},
      {type:'reasoning-end',id:'r1'},
      {type:'text-delta',id:'t1',delta:'Visible'},
      {type:'text-end',id:'t1'},
      {type:'tool-call',toolCallId:'call-1',toolName:'save',input:'{"name":"out.md"}'},
      {type:'finish',finishReason:'tool-calls',usage:{inputTokens:1,outputTokens:2,totalTokens:3}},
    ],capture)
    const factory=vi.fn(()=>model as LanguageModel)
    const api=createApiModel({baseURL:'http://unused.test/v1',apiKey:'secret',model:'fixture',maxOutputTokens:321},factory)
    const tools:ToolSpec[]=[{name:'save',description:'save output',parameters:{type:'object'}}]
    const turn=api.stream([user('make it')],tools,new AbortController().signal)
    const seen=[];for await(const delta of turn.deltas)seen.push(delta)
    expect(seen).toEqual([{kind:'text',text:'Visible'},{kind:'tool_call',id:'call-1',name:'save',input:{name:'out.md'}}])
    expect(JSON.stringify(seen)).not.toContain('hidden chain')
    const finished=await turn.finished
    expect(finished).toMatchObject({toolCalls:[{id:'call-1',name:'save',input:{name:'out.md'}}],finishReason:'tool-calls',model:'mock-model-id'})
    expect(JSON.stringify(finished.messages)).toContain('hidden chain')
    expect(JSON.stringify(finished.messages)).toContain('Visible')
    expect(capture.maxOutputTokens).toBe(321)
    expect(factory).toHaveBeenCalledOnce()
  })

  it('propagates the exact abort signal and rejects transport errors through iteration and finished',async()=>{
    const cause=Object.assign(Error('gateway failed'),{statusCode:502}),capture:Record<string,unknown>={};let attempts=0
    const model=new MockLanguageModelV2({doStream:async options=>{attempts++;Object.assign(capture,options);throw cause}})
    const controller=new AbortController(),turn=createApiModel({baseURL:'http://unused.test/v1',apiKey:'x',model:'m'},()=>model).stream([user('x')],[],controller.signal)
    await expect(async()=>{for await(const _ of turn.deltas){}}).rejects.toBe(cause)
    await expect(turn.finished).rejects.toBe(cause)
    expect(capture.abortSignal).toBe(controller.signal)
    expect(attempts).toBe(1)
  })

  it('observes an early finished rejection until its caller subscribes',async()=>{
    const cause=Error('early failure'),model=new MockLanguageModelV2({doStream:async()=>{throw cause}})
    const unhandled:unknown[]=[];const listener=(reason:unknown)=>unhandled.push(reason);process.on('unhandledRejection',listener)
    try{
      const turn=createApiModel({baseURL:'http://unused.test',apiKey:'x',model:'m'},()=>model).stream([user('x')],[],new AbortController().signal)
      await expect(async()=>{for await(const _ of turn.deltas){}}).rejects.toBe(cause)
      await new Promise(resolve=>setImmediate(resolve))
      expect(unhandled).toEqual([])
      await expect(turn.finished).rejects.toBe(cause)
    }finally{process.off('unhandledRejection',listener)}
  })

  it('preserves the SDK unknown finish classification when the provider omits a finish',async()=>{
    const model=streamModel([{type:'text-start',id:'t'},{type:'text-delta',id:'t',delta:'partial'},{type:'text-end',id:'t'}])
    const turn=createApiModel({baseURL:'http://unused.test',apiKey:'x',model:'m'},()=>model).stream([user('x')],[],new AbortController().signal)
    for await(const _ of turn.deltas){}
    expect(await turn.finished).toMatchObject({finishReason:'unknown',model:null})
  })

  it('rejects finished when its only delta consumer returns early',async()=>{
    const model=streamModel([{type:'text-start',id:'t'},{type:'text-delta',id:'t',delta:'one'},{type:'text-delta',id:'t',delta:'two'},{type:'text-end',id:'t'},{type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:2,totalTokens:3}}])
    const turn=createApiModel({baseURL:'http://unused.test',apiKey:'x',model:'m'},()=>model).stream([user('x')],[],new AbortController().signal)
    for await(const _ of turn.deltas)break
    await expect(turn.finished).rejects.toThrow('api_model_stream_incomplete')
  })

  it('treats an explicit aborted stream as failure',async()=>{
    const controller=new AbortController()
    const model={specificationVersion:'v2',provider:'test',modelId:'abort-model',supportedUrls:{},doGenerate:async()=>{throw Error('unused')},doStream:async(options:{abortSignal?:AbortSignal})=>({stream:new ReadableStream({start(stream){stream.enqueue({type:'text-start',id:'t'});stream.enqueue({type:'text-delta',id:'t',delta:'partial'});options.abortSignal?.addEventListener('abort',()=>stream.error(options.abortSignal?.reason),{once:true})}})})} as never
    const turn=createApiModel({baseURL:'http://unused.test',apiKey:'x',model:'m'},()=>model).stream([user('x')],[],controller.signal)
    await expect(async()=>{for await(const _ of turn.deltas)controller.abort(Error('cancelled'))}).rejects.toThrow('cancelled')
    await expect(turn.finished).rejects.toThrow('cancelled')
  })

  it('uses the OpenAI-compatible provider against a loopback SSE endpoint without retrying',async()=>{
    let requests=0,body:unknown
    const server=createServer(async(req,res)=>{
      requests++;body=JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString())
      res.writeHead(200,{'content-type':'text/event-stream'})
      res.end([
        'data: '+JSON.stringify({id:'resp',object:'chat.completion.chunk',created:1,model:'loopback-model',choices:[{index:0,delta:{role:'assistant',content:'hello'},finish_reason:null}]})+'\n\n',
        'data: '+JSON.stringify({id:'resp',object:'chat.completion.chunk',created:1,model:'loopback-model',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n',
        'data: [DONE]\n\n',
      ].join(''))
    })
    server.listen(0,'127.0.0.1');await once(server,'listening')
    try{
      const address=server.address();if(!address||typeof address==='string')throw Error('missing address')
      const turn=createApiModel({baseURL:`http://127.0.0.1:${address.port}/v1`,apiKey:'fixture-key',model:'requested-model',maxOutputTokens:77}).stream([user('hi')],[],new AbortController().signal)
      const text=[];for await(const delta of turn.deltas)if(delta.kind==='text')text.push(delta.text)
      expect(text.join('')).toBe('hello')
      expect(await turn.finished).toMatchObject({finishReason:'stop',model:'loopback-model'})
      expect(requests).toBe(1);expect(body).toMatchObject({model:'requested-model',max_tokens:77,stream:true})
    }finally{server.close();await once(server,'close')}
  })
})
