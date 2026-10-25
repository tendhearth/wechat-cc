import {describe,expect,it,vi} from 'vitest'
import {MockLanguageModelV2} from 'ai/test'
import {simulateReadableStream,type LanguageModel} from 'ai'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {createApiModel,userMessage,toolResultMessage,DEFAULT_EVAL_MAX_OUTPUT_TOKENS,type ChatMessage,type ToolSpec} from './api-model'

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
    expect(finished.usage).toEqual({input:1,output:2})   // 端点报的用量(10-20)
    expect(JSON.stringify(finished.messages)).toContain('hidden chain')
    expect(JSON.stringify(finished.messages)).toContain('Visible')
    expect(capture.maxOutputTokens).toBe(321)
    expect(factory).toHaveBeenCalledOnce()
  })

  it('hides an inline think block that the endpoint streams inside content',async()=>{
    // 2026-09-14 真机:某网关的 DeepSeek 不走 reasoning_content,把思维链内联进
    // content,标签还被切在 chunk 边界上 —— 主人看到的回复曾经就是 `<think>`。
    const model=streamModel([
      {type:'text-start',id:'t1'},
      {type:'text-delta',id:'t1',delta:'<th'},
      {type:'text-delta',id:'t1',delta:'ink>\nWe need answer only "ready".\n</thi'},
      {type:'text-delta',id:'t1',delta:'nk>\nrea'},
      {type:'text-delta',id:'t1',delta:'dy'},
      {type:'text-end',id:'t1'},
      {type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:2,totalTokens:3}},
    ])
    const api=createApiModel({baseURL:'http://unused.test/v1',apiKey:'secret',model:'fixture'},vi.fn(()=>model as LanguageModel))
    const turn=api.stream([user('say ready')],[],new AbortController().signal)
    const seen=[];for await(const delta of turn.deltas)seen.push(delta)
    expect(seen.map(d=>d.kind==='text'?d.text:'').join('')).toBe('ready')
    expect(JSON.stringify(seen)).not.toContain('think')
    // 协议历史照原样保留 —— 这次修的是主人看见什么,不是回送给模型什么。
    expect(JSON.stringify((await turn.finished).messages)).toContain('</think>')
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

// B2(2026-10-25):对话、工作台、一次性评估都走这一层(原 openai-chat-model.ts 的 ChatModelClient 并进来了)。
const textModel=(chunks:string[],capture?:Record<string,unknown>)=>streamModel([
  {type:'text-start',id:'1'},...chunks.map(delta=>({type:'text-delta',id:'1',delta})),{type:'text-end',id:'1'},
  {type:'finish',finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}},
],capture)
const api=(model:unknown,extra:Record<string,unknown>={})=>createApiModel({baseURL:'http://unused.test/v1',apiKey:'k',model:'m',...extra},()=>model as LanguageModel)

describe('APIModel —— 对话用的选项与一次性评估',()=>{
  it('maxOutputTokens:null ⇒ 不设上限(对话:交给上游默认);maxRetries 照传',async()=>{
    const capture:Record<string,unknown>={}
    const turn=api(textModel(['hi'],capture),{maxOutputTokens:null,maxRetries:2}).stream([user('x')],[],new AbortController().signal)
    for await(const _ of turn.deltas){}
    expect(capture.maxOutputTokens).toBeUndefined()
    expect(()=>api(textModel([]),{maxRetries:9})).toThrow('invalid_api_model')
    expect(()=>api(textModel([]),{maxOutputTokens:0})).toThrow('invalid_api_model')
  })

  it('a 401 the SDK reports as a fullStream error part surfaces with its real cause (not NoOutputGeneratedError)',async()=>{
    const cause=Object.assign(new Error('Authentication Error, Invalid proxy server token passed'),{statusCode:401})
    const turn=api(new MockLanguageModelV2({doStream:async()=>{throw cause}}),{maxRetries:2}).stream([user('hi')],[],new AbortController().signal)
    await expect(async()=>{for await(const _ of turn.deltas){}}).rejects.toBe(cause)
    await expect(turn.finished).rejects.toBe(cause)
  })

  it('generate() returns the concatenated text and hides an inline think block (cheapEval compares this string directly)',async()=>{
    expect(await api(textModel(['4','2'])).generate([user('answer?')])).toBe('42')
    expect(await api(textModel(['<think>\nthe answer is yes\n</think>\n\nyes'])).generate([user('yes or no?')])).toBe('yes')
  })

  it('generate() rejects with the original cause when doStream() rejects',async()=>{
    const cause=Object.assign(new Error('Authentication Error'),{statusCode:401})
    await expect(api(new MockLanguageModelV2({doStream:async()=>{throw cause}})).generate([user('hi')])).rejects.toBe(cause)
  })

  it('generate() passes an explicit eval output budget (thinking models burn the default budget and return empty content)',async()=>{
    const capture:Record<string,unknown>={}
    await api(textModel(['ok'],capture)).generate([user('hi')])
    expect(capture.maxOutputTokens).toBe(DEFAULT_EVAL_MAX_OUTPUT_TOKENS)
    await api(textModel(['ok'],capture),{evalMaxOutputTokens:123}).generate([user('hi')])
    expect(capture.maxOutputTokens).toBe(123)
  })
})

describe('message helpers',()=>{
  it('userMessage: 没图是纯字符串;有图是 text + image 分块,图一律是 data URL(存进 SQLite 的 JSON 原样回来)',()=>{
    expect(userMessage('hi')).toEqual({role:'user',content:'hi'})
    expect(userMessage('看图',[{data:new Uint8Array([1,2]),mediaType:'image/png'}])).toEqual({role:'user',content:[{type:'text',text:'看图'},{type:'image',image:'data:image/png;base64,AQI=',mediaType:'image/png'}]})
    expect(userMessage('看图',[{data:'data:image/png;base64,AQI=',mediaType:'image/png'}])).toEqual(userMessage('看图',[{data:new Uint8Array([1,2]),mediaType:'image/png'}]))
  })
  it('toolResultMessage: 一条 text 结果',()=>{
    expect(toolResultMessage('c1','reply','ok')).toEqual({role:'tool',content:[{type:'tool-result',toolCallId:'c1',toolName:'reply',output:{type:'text',value:'ok'}}]})
  })
})
