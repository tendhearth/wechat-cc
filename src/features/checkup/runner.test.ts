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

it('does not tell an action-only interview to send final text or use unavailable memory tools',async()=>{
  const {interviewInstructions}=await import('./instructions')
  const prompt=interviewInstructions('claude','synthetic')
  expect(prompt).not.toMatch(/说话:不用工具|不需要调任何工具来「发送」|memory_read|memory_write|a2a_send|wxvault|Read\/Bash/)
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
  const {buildInterviewPlan,scoreInterview,estimateInterview}=await import('../../domain/checkup-interview')
  const {createOpenAiAgentProvider}=await import('../../adapters/executors/openai/openai-agent-provider')
  const {scriptedOpenAiModel}=await import('../../test-support/executors/openai-scripted')
  const sample=buildInterviewPlan({windowTokens:8192,full:false,executors:['private-id']}).samples.find(s=>s.expected.action==='delegate')!
  const model=scriptedOpenAiModel([{calls:[{name:'delegate',input:{executor:sample.expected.executor!,instruction:`整理 ${sample.expected.task}，交付清单。`}}]},{calls:[{name:'reply',input:{text:'交代好了。'}}]},{text:['done']}])
  const provider=createOpenAiAgentProvider({makeChatModel:()=>model.model,makeMcpBridge:async()=>{throw Error('production tools')}})
  const result=await makeCheckupTurn(()=>provider)(sample,target,new AbortController().signal)
  expect(result.toolError).toBeUndefined()
  expect(scoreInterview(sample,result).business).toBe(true)
  const estimate=estimateInterview({windowTokens:8192,full:false,executors:['private-id']})
  expect(estimate.requests).toBe(72)
  expect(estimate.maxRequests).toBe(216)
  expect(estimate.outputTokens).toBe(110592)
})

it('does not bypass the registry network guard when preparing model capacity',async()=>{
  let calls=0
  const provider:AgentProvider={spawn:async()=>{throw Error('no generation')},callTarget:()=>({provider:'gemini',model:'m'}),prepareContextWindow:async()=>{calls++}}
  const gated=withNetworkGate(provider,{check:async()=>({safe:false,source:'probe',detail:'offline'})},'gemini')
  await expect(gated.prepareContextWindow?.('m')).rejects.toMatchObject({code:'network_unprotected'})
  expect(calls).toBe(0)
})
