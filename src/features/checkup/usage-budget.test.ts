import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {MockLanguageModelV2} from 'ai/test'
import {simulateReadableStream} from 'ai'
import {makeCheckupBudget,checkupLimits} from '../../domain/checkup-budget'
import {buildInterviewPlan,scoreInterview} from '../../domain/checkup-interview'
import {interviewAnswer} from '../../test-support/checkup-model'
import {makeCheckupTurn} from './runner'
import {createApiModel,userMessage} from '../../adapters/executors/openai/api-model'
import {createOpenAiAgentProvider} from '../../adapters/executors/openai/openai-agent-provider'
import {createGeminiAgentProvider} from '../../adapters/executors/gemini/gemini-agent-provider'
import {createClaudeAgentProvider} from '../../adapters/executors/claude/claude-agent-provider'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {AgentProvider} from '../../ports/agent-provider'
const target={provider:'fake',address:'default',model:'invented',windowTokens:8192,windowKnown:false}
const sample=buildInterviewPlan({windowTokens:8192,full:false}).samples[0]!
const answer=interviewAnswer(sample).toolCalls[0]!
const nativeSettings=<T extends object>(q:T)=>Object.assign(q,{getSettings:async()=>({effective:{},sources:[]})})
beforeEach(()=>{
  for(const key of ['ANTHROPIC_BASE_URL','ANTHROPIC_UNIX_SOCKET','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_USE_ANTHROPIC_AWS','CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD','CLAUDE_CODE_USE_MANTLE'])vi.stubEnv(key,undefined)
})
afterEach(()=>vi.unstubAllEnvs())
const gateway=()=>{vi.stubEnv('ANTHROPIC_BASE_URL','https://fictional.invalid');vi.stubEnv('ANTHROPIC_API_KEY','fictional')}

it('defaults to short/full hard limits and never refunds unknown usage from a byte guess',()=>{
  expect(checkupLimits(false)).toEqual({maxOutputTokens:300000,maxRequests:120})
  expect(checkupLimits(true)).toEqual({maxOutputTokens:1000000,maxRequests:400})
  const budget=makeCheckupBudget({maxOutputTokens:5000,maxRequests:3})
  const first=budget.reserve(4096);first.settle({outputBytes:300})
  expect(budget.usage).toEqual({requests:1,outputTokens:100})
  const last=budget.reserve(4096);expect(last.maxOutputTokens).toBe(904)
  last.settle({outputTokens:904});last.settle({outputTokens:0})
  expect(budget.exhausted).toBe(true)
  expect(()=>budget.reserve(1)).toThrow('checkup_usage_limit')
})

for(const backend of ['openai','gemini','claude'] as const) it(`${backend}: every request fills its output cap; the final capped answer is kept`,async()=>{
  const caps:number[]=[],budget=makeCheckupBudget({maxOutputTokens:5000,maxRequests:5})
  let provider:AgentProvider
  if(backend==='openai')provider=createOpenAiAgentProvider({makeMcpBridge:async()=>{throw Error('production')},makeChatModel:(_model,limits)=>createApiModel({baseURL:'http://unused.invalid',apiKey:'fictional',model:'invented',...limits},()=>new MockLanguageModelV2({doStream:async o=>{
    const cap=o.maxOutputTokens!;caps.push(cap)
    return{stream:simulateReadableStream({chunks:[{type:'tool-call',toolCallId:`call-${caps.length}`,toolName:answer.name,input:JSON.stringify(answer.input)},{type:'finish',finishReason:'tool-calls',usage:{inputTokens:1,outputTokens:cap,totalTokens:cap+1}}]})}
  }}))})
  else if(backend==='gemini')provider=createGeminiAgentProvider({model:'invented',systemInstruction:'unused',mcpConnect:async()=>{throw Error('production')},buildGate:()=>{throw Error('production')},genai:{models:{generateContent:async o=>{
    const cap=o.config!.maxOutputTokens!;caps.push(cap)
    return{functionCalls:[{name:answer.name,args:answer.input as Record<string,unknown>}],usageMetadata:{candidatesTokenCount:100,thoughtsTokenCount:cap-100}}
  }}}})
  else {gateway();provider=createClaudeAgentProvider({sdkOptionsForProject:()=>{throw Error('production')},checkupFetch:(async(_url:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init!.body));caps.push(body.max_tokens)
    return Response.json({usage:{output_tokens:body.max_tokens}})
  }) as unknown as typeof fetch,queryImpl:((args:any)=>nativeSettings((async function*(){
    for await(const _ of args.prompt){
      expect(args.options.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST==='1').toBe(true)
      expect(args.options.env.DISABLE_COMPACT==='1').toBe(true)
      expect(args.options.env.DISABLE_AUTO_COMPACT==='1').toBe(true)
      const response=await fetch(args.options.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',body:JSON.stringify({max_tokens:4096})})
      await response.text();if(!response.ok)return
      const client=new Client({name:'offline',version:'1'})
      try{
        await client.connect(new StreamableHTTPClientTransport(new URL(args.options.mcpServers.wechat.url)))
        await client.callTool({name:answer.name,arguments:answer.input as Record<string,unknown>})
        yield{type:'result',subtype:'success',session_id:'fake',num_turns:1,result:''}
      }finally{await client.close()}
      return
    }
  })())) as any})}
  const turn=makeCheckupTurn(()=>provider)
  const results=[]
  const pinnedTarget=backend==='claude'?{...target,address:'https://fictional.invalid'}:target
  while(!budget.exhausted)results.push(await turn(sample,pinnedTarget,new AbortController().signal,budget))
  expect(caps.reduce((sum,n)=>sum+n,0)).toBe(5000)
  expect(budget.usage).toEqual({requests:caps.length,outputTokens:5000})
  expect(results.every(r=>scoreInterview(sample,r).qualities.memory===true)).toBe(true)
  expect(results.at(-1)?.toolCalls.length).toBeGreaterThan(0)
  const before=caps.length
  await expect(turn(sample,pinnedTarget,new AbortController().signal,budget)).rejects.toMatchObject({code:'checkup_usage_limit'})
  expect(caps).toHaveLength(before)
})

it('counts OpenAI transport retries against the request gate before sending another request',async()=>{
  let calls=0
  const budget=makeCheckupBudget({maxOutputTokens:50000,maxRequests:2})
  const api=createApiModel({baseURL:'http://unused.invalid',apiKey:'fictional',model:'invented',budget,maxRetries:2,retrySleep:async()=>{}},()=>new MockLanguageModelV2({doStream:async()=>{calls++;throw Object.assign(Error('offline 503'),{statusCode:503})}}))
  const pending=api.stream([userMessage('fictional')],[],new AbortController().signal)
  await expect(async()=>{for await(const _ of pending.deltas){}}).rejects.toMatchObject({code:'checkup_usage_limit'})
  expect(calls).toBe(2);expect(budget.usage.requests).toBe(2)
})

it('counts reasoning-only whole-question retries in the same output allowance',async()=>{
  const caps:number[]=[],budget=makeCheckupBudget({maxOutputTokens:9000,maxRequests:10})
  const provider=createGeminiAgentProvider({model:'invented',systemInstruction:'unused',mcpConnect:async()=>{throw Error('production')},buildGate:()=>{throw Error('production')},genai:{models:{generateContent:async o=>{
    const cap=o.config!.maxOutputTokens!;caps.push(cap)
    return{candidates:[{finishReason:'MAX_TOKENS'}],usageMetadata:{thoughtsTokenCount:cap}}
  }}}})
  await expect(makeCheckupTurn(()=>provider)(sample,target,new AbortController().signal,budget)).rejects.toMatchObject({code:'checkup_output_exhausted'})
  expect(caps).toEqual([4096,4904]);expect(budget.usage.outputTokens).toBe(9000)
})

it('Claude native recovery requests cannot bypass the request gate, and a prior action survives',async()=>{
  gateway()
  const budget=makeCheckupBudget({maxOutputTokens:50000,maxRequests:2})
  let sent=0
  const provider=createClaudeAgentProvider({sdkOptionsForProject:()=>{throw Error('production')},checkupFetch:(async()=>{sent++;return Response.json({usage:{output_tokens:200}})}) as unknown as typeof fetch,queryImpl:((args:any)=>nativeSettings((async function*(){
    for await(const _ of args.prompt){
      const client=new Client({name:'offline',version:'1'})
      const request=async()=>{const response=await fetch(args.options.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',body:JSON.stringify({max_tokens:4096})});await response.text()}
      try{
        // SDK-shaped retries keep num_turns fixed; only the HTTP boundary can
        // count them. The third request must never reach the upstream.
        await request();await client.connect(new StreamableHTTPClientTransport(new URL(args.options.mcpServers.wechat.url)))
        await client.callTool({name:answer.name,arguments:answer.input as Record<string,unknown>})
        await request();await request()
        yield{type:'result',subtype:'success',session_id:'fake',num_turns:1,result:''}
      }finally{await client.close()}
      return
    }
  })())) as any})
  const result=await makeCheckupTurn(()=>provider)(sample,{...target,address:'https://fictional.invalid'},new AbortController().signal,budget)
  expect(sent).toBe(2)
  expect(budget.usage).toEqual({requests:2,outputTokens:400})
  expect(result.usageLimited).toBe(true)
  expect(scoreInterview(sample,result)).toMatchObject({observed:true,business:true})
})

it('refuses an unverified native transport before sending any model request',async()=>{
  gateway()
  let requested=false
  const provider=createClaudeAgentProvider({sdkOptionsForProject:()=>{throw Error('production')},checkupFetch:(async()=>{requested=true;return Response.json({})}) as unknown as typeof fetch,queryImpl:(()=>Object.assign((async function*(){})(),{getSettings:async()=>({effective:{env:{ANTHROPIC_UNIX_SOCKET:'/fictional/socket'}},sources:[]})})) as any})
  const budget=makeCheckupBudget({maxOutputTokens:5000,maxRequests:2})
  await expect(makeCheckupTurn(()=>provider)(sample,target,new AbortController().signal,budget)).rejects.toMatchObject({code:'isolated_evaluation_unavailable'})
  expect(requested).toBe(false)
  expect(budget.usage).toEqual({requests:0,outputTokens:0})
})
