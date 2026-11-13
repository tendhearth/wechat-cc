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
