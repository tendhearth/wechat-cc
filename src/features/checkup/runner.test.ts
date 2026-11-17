import { describe, expect, it, vi } from 'vitest'
import { fakeCheckupTools, makeCheckupTurn } from './runner'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildCheckupPlan, scoreTool } from '../../domain/butler-checkup'
import type { AgentProvider } from '../../ports/agent-provider'
import { withNetworkGate } from '../../app/provider-registry'

const target={provider:'fake',address:'default',model:'invented',windowTokens:8192,windowKnown:false}
describe('synthetic checkup provider lifecycle',()=>{
  it('serves real stateless MCP initialization, tool listing and fake argument recording on loopback',async()=>{
    const sample=buildCheckupPlan({windowTokens:8192,full:false}).tools[0]!
    const bridge=await fakeCheckupTools(sample),client=new Client({name:'offline-checkup-client',version:'1'})
    const errors:unknown[]=[];client.onerror=e=>errors.push(e)
    try{
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)))
      expect((await client.listTools()).tools.map(t=>t.name)).toEqual([sample.tool])
      const result=await client.callTool({name:sample.tool,arguments:sample.input})
      expect(result.isError).not.toBe(true)
      expect(bridge.calls).toEqual([{name:sample.tool,input:sample.input}])
      expect(errors).toEqual([])
    }finally{await client.close();await bridge.close()}
  })
  it('scores actual fake tool invocations and records first streamed text',async()=>{
    const close=vi.fn(async()=>{})
    const provider:AgentProvider={supportsIsolatedEvaluation:true,async spawn(project,ctx){
      expect(project.path).toContain('cc-synthetic-checkup-')
      expect(ctx.appendInstructions).not.toContain('PRIVATE_CANARY')
      expect(ctx.mcpEnv).toBeUndefined()
      return {async *dispatch(){await ctx.evaluation!.tools.call('checkup_lookup',{code:'wrong',place:'wrong'});yield {kind:'text',text:'好'};yield {kind:'text',text:'了'};yield {kind:'result',sessionId:'fictional',numTurns:1,durationMs:1}},close}
    }}
    const turn=await makeCheckupTurn(()=>provider)(buildCheckupPlan({windowTokens:8192,full:false}).tools[0]!,target,new AbortController().signal)
    expect(turn.text).toBe('好了');expect(turn.toolCalls).toEqual([{name:'checkup_lookup',input:{code:'wrong',place:'wrong'}}]);expect(turn.firstTextMs).toBeGreaterThanOrEqual(0);expect(close).toHaveBeenCalledOnce()
  })
  it('scores an exhausted fake tool loop as a wrong tool answer, even after one correct call',async()=>{
    const sample=buildCheckupPlan({windowTokens:8192,full:false}).tools[0]!
    const provider:AgentProvider={supportsIsolatedEvaluation:true,async spawn(_project,ctx){return {
      async *dispatch(){await ctx.evaluation!.tools.call(sample.tool,sample.input);yield {kind:'error',message:'bounded model loop',code:'checkup_step_budget'}},
      close:async()=>{},
    }}}
    const turn=await makeCheckupTurn(()=>provider)(sample,target,new AbortController().signal)
    expect(turn.toolCalls).toEqual([{name:sample.tool,input:sample.input}])
    expect(turn.toolError).toBe(true)
    expect(scoreTool(sample,turn)).toBe(0)
  })
  it('never turns a memory request error or tool infrastructure error into a weak score',async()=>{
    const plan=buildCheckupPlan({windowTokens:8192,full:false})
    for(const [sample,code] of [[plan.memory[0]!,'checkup_step_budget'],[plan.tools[0]!,'auth_failed']] as const){
      const provider:AgentProvider={supportsIsolatedEvaluation:true,async spawn(){return {async *dispatch(){yield {kind:'error',message:'offline error fixture',code}},close:async()=>{}}}}
      await expect(makeCheckupTurn(()=>provider)(sample,target,new AbortController().signal)).rejects.toMatchObject({code})
    }
  })
  it('does not invoke providers which have not verified an isolated surface',async()=>{
    const spawn=vi.fn()
    await expect(makeCheckupTurn(()=>({spawn}))(buildCheckupPlan({windowTokens:8192,full:false}).memory[0]!,target,new AbortController().signal)).rejects.toMatchObject({code:'isolated_evaluation_unavailable'})
    expect(spawn).not.toHaveBeenCalled()
  })
  it('continues to honor the registry network guard before spawn',async()=>{
    const spawn=vi.fn(),inner:AgentProvider={supportsIsolatedEvaluation:true,spawn,callTarget:()=>({provider:'openai',baseUrl:'https://api.openai.com',model:'invented'})}
    const gated=withNetworkGate(inner,{check:async()=>({safe:false,source:'probe',detail:'offline fixture'})},'openai')
    await expect(makeCheckupTurn(()=>gated)(buildCheckupPlan({windowTokens:8192,full:false}).memory[0]!,target,new AbortController().signal)).rejects.toMatchObject({code:'network_unprotected'})
    expect(spawn).not.toHaveBeenCalled()
  })
  it('cancels the actual dispatched session and closes all local resources',async()=>{
    const abort=new AbortController(),cancel=vi.fn(async()=>{}),close=vi.fn(async()=>{})
    let started!:()=>void
    const ready=new Promise<void>(r=>started=r)
    const provider:AgentProvider={supportsIsolatedEvaluation:true,async spawn(){return {async *dispatch(){started();await new Promise<void>(resolve=>abort.signal.addEventListener('abort',()=>resolve(),{once:true}));yield {kind:'error',message:'cancelled',code:'cancelled'}},cancel,close}}}
    const result=makeCheckupTurn(()=>provider)(buildCheckupPlan({windowTokens:8192,full:false}).memory[0]!,target,abort.signal)
    await ready;abort.abort()
    await expect(result).rejects.toBeDefined();expect(cancel).toHaveBeenCalled();expect(close).toHaveBeenCalled()
  })
})

it('uses the real CC prompt builder with only projected persona and three fake everyday actions',async()=>{
  const {buildInterviewPlan}=await import('../../domain/checkup-interview')
  const {extractCheckupPersona}=await import('../../domain/checkup-persona')
  const persona=extractCheckupPersona('名字：小禾\n称呼用户：阿青\n自称：小禾\n口头禅：慢慢来\n记忆：PRIVATE_REAL_MEMORY_555')
  const sample=buildInterviewPlan({windowTokens:8192,full:false,persona,executors:['worker']}).samples[0]!
  let sent=''
  const provider:AgentProvider={supportsIsolatedEvaluation:true,async spawn(_project,ctx){
    sent=ctx.appendInstructions!
    expect(ctx.evaluation!.tools.tools.map(t=>t.name)).toEqual(['reply','ask_user','delegate'])
    expect(sent).toContain('小禾');expect(sent).toContain('阿青')
    expect(sent).not.toMatch(/PRIVATE_REAL_MEMORY|练习|考试|体检/)
    return {async *dispatch(prompt){expect(prompt).not.toContain('PRIVATE_REAL_MEMORY');await ctx.evaluation!.tools.call('reply',{text:'阿青，小禾在呢，慢慢来。'});yield {kind:'result',sessionId:'invented',numTurns:1,durationMs:1}},close:async()=>{}}
  }}
  const result=await makeCheckupTurn(()=>provider)(sample,target,new AbortController().signal)
  expect(result.toolCalls).toHaveLength(1)
  expect(sent).toContain('你')
})

it('allows final text and fake conversation actions without unavailable memory tools',async()=>{
  const {interviewInstructions}=await import('./instructions')
  const prompt=interviewInstructions('claude','synthetic')
  expect(prompt).not.toMatch(/memory_read|memory_write|a2a_send|wxvault|Read\/Bash/)
  expect(prompt).toContain('不需要调任何工具来「发送」')
  expect(prompt).toContain('reply')
  expect(prompt).toContain('ask_user')
})

it('measures the first reply action even when the model streams no final text',async()=>{
  const {buildInterviewPlan}=await import('../../domain/checkup-interview')
  const sample=buildInterviewPlan({windowTokens:8192,full:false}).samples[0]!
  const provider:AgentProvider={supportsIsolatedEvaluation:true,async spawn(_project,ctx){return {async *dispatch(){await ctx.evaluation!.tools.call('reply',{text:'我记得。'});yield {kind:'result',sessionId:'invented',numTurns:1,durationMs:1}},close:async()=>{}}}}
  const result=await makeCheckupTurn(()=>provider)(sample,target,new AbortController().signal)
  expect(result.firstTextMs).not.toBeNull()
  expect(result.firstTextMs).toBeGreaterThanOrEqual(0)
})

it('keeps exam labels out of the model-visible MCP server and tool namespace',async()=>{
  const {buildInterviewPlan}=await import('../../domain/checkup-interview')
  const bridge=await fakeCheckupTools(buildInterviewPlan({windowTokens:8192,full:false}).samples[0]!),client=new Client({name:'offline',version:'1'})
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)))
    expect(client.getServerVersion()?.name).toBe('wechat')
    expect(bridge.tools.serverOf('reply')).toBe('wechat')
    expect((await client.listTools()).tools.map(t=>t.name)).toEqual(['reply','ask_user'])
  }finally{await client.close();await bridge.close()}
})

it('allows a delegate then a reply then model completion without exhausting the interview budget',async()=>{
  const {buildInterviewPlan,scoreInterview}=await import('../../domain/checkup-interview')
  const {estimateInterview}=await import('./estimate')
  const {createOpenAiAgentProvider}=await import('../../adapters/executors/openai/openai-agent-provider')
  const {scriptedOpenAiModel}=await import('../../test-support/executors/openai-scripted')
  const sample=buildInterviewPlan({windowTokens:8192,full:false,executors:['private-id']}).samples.find(s=>s.expected.action==='delegate')!
  const model=scriptedOpenAiModel([{calls:[{name:'delegate',input:{executor:sample.expected.executor!,instruction:`整理 ${sample.expected.task}，交付清单。`}}]},{calls:[{name:'reply',input:{text:'交代好了。'}}]},{text:['done']}])
  const provider=createOpenAiAgentProvider({makeChatModel:()=>model.model,makeMcpBridge:async()=>{throw Error('production tools')}})
  const result=await makeCheckupTurn(()=>provider)(sample,target,new AbortController().signal)
  expect(result.toolError).toBeUndefined()
  expect(scoreInterview(sample,result).business).toBe(true)
  const estimate=estimateInterview({windowTokens:8192,full:false,executors:['private-id']})
  expect(estimate.requests).toBe(56)
  expect(estimate.maxRequests).toBe(120)
  expect(estimate.outputTokens).toBe(81200)
})

it('does not bypass the registry network guard when preparing model capacity',async()=>{
  let calls=0
  const provider:AgentProvider={spawn:async()=>{throw Error('no generation')},callTarget:()=>({provider:'gemini',model:'m'}),prepareContextWindow:async()=>{calls++}}
  const gated=withNetworkGate(provider,{check:async()=>({safe:false,source:'probe',detail:'offline'})},'gemini')
  await expect(gated.prepareContextWindow?.('m')).rejects.toMatchObject({code:'network_unprotected'})
  expect(calls).toBe(0)
})

// Acceptance 2026-11-13: HTTP 200, finish_reason=length, reasoning only.
for(const backend of ['openai','openai-inline-think','openai-closed-think','claude','claude-whitespace','claude-warning','claude-result','gemini'] as const) for(const recovery of [true,false]) it(`${backend} reasoning-only exhaustion: larger retry ${recovery?'recovers':'stays unmeasured'}`,async()=>{
  const {buildInterviewPlan}=await import('../../domain/checkup-interview')
  const sample=buildInterviewPlan({windowTokens:8192,full:false}).samples[0]!
  const budgets:number[]=[]
  let provider:AgentProvider
  if(backend.startsWith('openai')){
    const {createApiModel}=await import('../../adapters/executors/openai/api-model')
    const {createOpenAiAgentProvider}=await import('../../adapters/executors/openai/openai-agent-provider')
    let requests=0
    provider=createOpenAiAgentProvider({makeMcpBridge:async()=>{throw Error('production bridge')},makeChatModel:(_model,limits)=>{
      budgets.push(limits!.maxOutputTokens)
      return createApiModel({baseURL:'http://fictional.invalid/v1',apiKey:'fictional',model:'invented',...limits,fetch:async()=>{
        const exhausted=++requests===1||!recovery
        const chunks=[{delta:exhausted?(backend==='openai-inline-think'?{content:'<think>思考中'}:backend==='openai-closed-think'?{content:'<think>思考中</think>'}:{reasoning_content:'思考中'}):{content:'完成'},finish_reason:null},{delta:{},finish_reason:exhausted?'length':'stop'}]
        return new Response(chunks.map(c=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'invented',choices:[{index:0,...c}]})).join('\n\n')+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
      }})
    }})
  }else if(backend.startsWith('claude')){
    const {createClaudeAgentProvider}=await import('../../adapters/executors/claude/claude-agent-provider')
    const {createScriptedClaude}=await import('../../test-support/executors/claude-scripted')
    provider=createClaudeAgentProvider({sdkOptionsForProject:()=>{throw Error('production instructions')},queryImpl:((args:any)=>{
      budgets.push(Number(args.options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS))
      const exhaustedReplay=backend==='claude-result'?[{type:'result',subtype:'success',stop_reason:'max_tokens',session_id:'fictional',result:''}]:backend==='claude-warning'?[{type:'assistant',error:'max_output_tokens',api_error_params:{cut:'output_limit'},message:{model:'<synthetic>',content:[{type:'text',text:'Claude response exceeded the 4096 output token maximum.'}]}},{type:'result',subtype:'success',session_id:'fictional',result:''}]:[
        ...(backend==='claude-whitespace'?[{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'\n'}}}]:[]),
        {type:'assistant',message:{content:[{type:'thinking',thinking:'思考中'}],stop_reason:'max_tokens'}},
        {type:'result',subtype:'success',session_id:'fictional',result:''},
      ]
      const replay=budgets.length===1||!recovery?exhaustedReplay:[{type:'assistant',message:{content:[{type:'text',text:'完成'}]}},{type:'result',subtype:'success',session_id:'fictional',result:'完成'}]
      return createScriptedClaude({turns:[{steps:[],replay}]}).query(args)
    }) as any})
  }else{
    const {createGeminiAgentProvider}=await import('../../adapters/executors/gemini/gemini-agent-provider')
    provider=createGeminiAgentProvider({model:'invented',systemInstruction:'production',mcpConnect:async()=>{throw Error('production bridge')},buildGate:()=>{throw Error('production gate')},genai:{models:{generateContent:async(req:any)=>{
      budgets.push(req.config.maxOutputTokens)
      return budgets.length===1||!recovery?{candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{thought:true,text:'思考中'}]}}]}:{text:'完成'}
    }}}})
  }
  const pending=makeCheckupTurn(()=>provider)(sample,target,new AbortController().signal)
  if(recovery)expect((await pending).text).toBe('完成')
  else await expect(pending).rejects.toMatchObject({code:'checkup_output_exhausted'})
  expect(budgets).toEqual([4096,8192])
})
it('bounds an exhausted question to two isolated attempts and reports it as unmeasured',async()=>{
  const budgets:number[]=[],close=vi.fn(async()=>{})
  const provider:AgentProvider={supportsIsolatedEvaluation:true,async spawn(_project,ctx){budgets.push(ctx.evaluation!.maxOutputTokens);return{async *dispatch(){yield{kind:'error',code:'checkup_output_exhausted',message:'reasoning only'}},close}}}
  const sample=buildCheckupPlan({windowTokens:8192,full:false}).memory[0]!
  await expect(makeCheckupTurn(()=>provider)(sample,target,new AbortController().signal)).rejects.toMatchObject({code:'checkup_output_exhausted'})
  expect(budgets).toEqual([4096,8192]);expect(close).toHaveBeenCalledTimes(2)
})

it('does not retry Claude context-window warnings as output exhaustion',async()=>{
  const {createClaudeAgentProvider}=await import('../../adapters/executors/claude/claude-agent-provider')
  const {createScriptedClaude}=await import('../../test-support/executors/claude-scripted')
  const {buildInterviewPlan}=await import('../../domain/checkup-interview')
  let calls=0
  const provider=createClaudeAgentProvider({sdkOptionsForProject:()=>{throw Error('production')},queryImpl:((args:any)=>{
    calls++
    return createScriptedClaude({turns:[{steps:[],replay:[{type:'assistant',error:'max_output_tokens',api_error_params:{cut:'context_window'},message:{model:'<synthetic>',content:[{type:'text',text:'model_context_window_exceeded'}]}},{type:'result',subtype:'success',is_error:true,session_id:'fictional',result:''}]}]}).query(args)
  }) as any})
  await expect(makeCheckupTurn(()=>provider)(buildInterviewPlan({windowTokens:8192,full:false}).samples[0]!,target,new AbortController().signal)).rejects.toBeDefined()
  expect(calls).toBe(1)
})

for(const backend of ['openai','claude','gemini'] as const) for(const checkpoint of ['recall','honesty']) it(`${backend} retains a scored ${checkpoint} fake reply when only the sign-off exhausts reasoning`,async()=>{
  const {buildInterviewPlan,scoreInterview}=await import('../../domain/checkup-interview')
  const {interviewAnswer}=await import('../../test-support/checkup-model')
  const sample=buildInterviewPlan({windowTokens:8192,full:false}).samples.find(s=>s.id===`0/0/${checkpoint}`)!,answer=interviewAnswer(sample).toolCalls[0]!
  let spawns=0
  let provider:AgentProvider
  if(backend==='openai'){
    const {createOpenAiAgentProvider}=await import('../../adapters/executors/openai/openai-agent-provider')
    const {scriptedOpenAiModel}=await import('../../test-support/executors/openai-scripted')
    const {createApiModel}=await import('../../adapters/executors/openai/api-model')
    const exhausted=createApiModel({baseURL:'http://fixture.invalid/v1',model:'invented',apiKey:'fictional'},()=>({specificationVersion:'v2',provider:'fixture',modelId:'invented',supportedUrls:{},async doStream(){return{stream:new ReadableStream({start(c){c.enqueue({type:'reasoning-start',id:'r'});c.enqueue({type:'reasoning-delta',id:'r',delta:'思考中'});c.enqueue({type:'reasoning-end',id:'r'});c.enqueue({type:'finish',finishReason:'length',usage:{inputTokens:1,outputTokens:4096,totalTokens:4097}});c.close()}})}},async doGenerate(){throw Error('unused')}} as any))
    provider=createOpenAiAgentProvider({makeMcpBridge:async()=>{throw Error('production')},makeChatModel:()=>{spawns++;const first=scriptedOpenAiModel([{calls:[answer]}]).model;let requests=0;return{...first,stream:(...args)=>++requests===1?first.stream(...args):exhausted.stream(...args)}}})
  }else if(backend==='claude'){
    const {createClaudeAgentProvider}=await import('../../adapters/executors/claude/claude-agent-provider')
    provider=createClaudeAgentProvider({sdkOptionsForProject:()=>{throw Error('production')},queryImpl:((args:any)=>{
      spawns++
      return(async function*(){
        const client=new Client({name:'offline',version:'1'})
        try{await client.connect(new StreamableHTTPClientTransport(new URL(args.options.mcpServers.wechat.url)));await client.callTool({name:answer.name,arguments:answer.input as Record<string,unknown>});yield{type:'result',subtype:'success',session_id:'fixture',result:'',stop_reason:'max_tokens'}}finally{await client.close()}
      })()
    }) as any})
  }else{
    const {createGeminiAgentProvider}=await import('../../adapters/executors/gemini/gemini-agent-provider')
    let requests=0
    provider=createGeminiAgentProvider({model:'invented',systemInstruction:'production',mcpConnect:async()=>{throw Error('production')},buildGate:()=>{throw Error('production')},genai:{models:{generateContent:async()=>{if(++requests===1){spawns++;return{functionCalls:[{name:answer.name,args:answer.input as Record<string,unknown>}]}}return{candidates:[{finishReason:'MAX_TOKENS'}]}}}}})
  }
  const turn=await makeCheckupTurn(()=>provider)(sample,target,new AbortController().signal)
  expect(turn.toolCalls).toEqual([answer])
  expect(scoreInterview(sample,turn)).toMatchObject({observed:true,business:true,qualities:checkpoint==='honesty'?{honesty:true}:{memory:true,tracking:true}})
  expect(spawns).toBe(1)
})
