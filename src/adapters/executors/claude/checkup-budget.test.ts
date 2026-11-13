import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {createClaudeAgentProvider} from './claude-agent-provider'
import * as proxy from './checkup-proxy'
import {makeCheckupBudget} from '../../../domain/checkup-budget'
import {TIER_PROFILES} from '../../../domain/user-tier'
import {collectTurn,type SpawnContext} from '../../../ports/agent-provider'
import {makeCheckupService} from '../../../features/checkup/service'
import {makeCheckupTurn} from '../../../features/checkup/runner'
import {makeCheckupStore} from '../../store/checkup-store'
import {sessionSubprocessEnv} from '../subprocess-env'

beforeEach(()=>{
  for(const key of ['ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_UNIX_SOCKET','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_USE_ANTHROPIC_AWS','CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD','CLAUDE_CODE_USE_MANTLE'])vi.stubEnv(key,undefined)
})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs()})
const project={alias:'fictional-checkup',path:tmpdir()}
const context=(budget:ReturnType<typeof makeCheckupBudget>):SpawnContext=>({tierProfile:TIER_PROFILES.guest,permissionMode:'strict',chatId:'fictional',evaluation:{maxSteps:3,maxOutputTokens:4096,budget,mcpServer:{url:'http://127.0.0.1:12345/fictional'},tools:{tools:[],call:async()=>'',close:async()=>{},serverOf:()=>undefined}}})
const result=(usage?:unknown)=>({type:'result',subtype:'success',session_id:'fictional',num_turns:2,result:'done',...(usage?{usage}:{})})
const assistant=(id:string,output_tokens?:number)=>({type:'assistant',message:{id,model:'fictional',content:[],usage:{output_tokens}}})

for(const socket of [undefined,'/fictional/socket'])for(const base of [undefined,'https://anthropic.com','https://api.anthropic.com','https://API.Anthropic.Com:8443/v1','https://sub.api.anthropic.com'])it(`keeps official subprocess transport identical to baseline and never starts a proxy: ${String(base)}, socket=${!!socket}`,async()=>{
  vi.stubEnv('ANTHROPIC_BASE_URL',base)
  vi.stubEnv('ANTHROPIC_API_KEY','fictional')
  vi.stubEnv('NO_PROXY','fictional-baseline')
  vi.stubEnv('no_proxy','fictional-baseline')
  vi.stubEnv('ANTHROPIC_UNIX_SOCKET',socket)
  const baselineEnv=sessionSubprocessEnv()
  const baseline=Object.fromEntries(['ANTHROPIC_BASE_URL','NO_PROXY','no_proxy','ANTHROPIC_UNIX_SOCKET'].map(key=>[key,baselineEnv[key]]))
  const makeProxy=vi.spyOn(proxy,'makeCheckupProxy'),sent=vi.fn()
  let matches:Record<string,boolean>={},socketUntouched=false,capped=false
  const provider=createClaudeAgentProvider({sdkOptionsForProject:()=>{throw Error('production builder')},checkupFetch:sent as unknown as typeof fetch,queryImpl:((args:any)=>{
    matches=Object.fromEntries(Object.entries(baseline).map(([key,value])=>[key,args.options.env[key]===value]))
    socketUntouched=args.options.settings?.env?.ANTHROPIC_UNIX_SOCKET===undefined
    capped=args.options.maxTurns===3&&args.options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS==='4096'
    return(async function*(){for await(const _ of args.prompt){yield result({output_tokens:250});return}})()
  }) as any})
  const budget=makeCheckupBudget({maxOutputTokens:20_000,maxRequests:10})
  const session=await provider.spawn(project,context(budget))
  try{await collectTurn(session.dispatch('invented'))}finally{await session.close()}
  for(const [key,matched] of Object.entries(matches))expect(matched,key).toBe(true)
  expect(socketUntouched).toBe(true);expect(capped).toBe(true)
  expect(makeProxy).not.toHaveBeenCalled();expect(sent).not.toHaveBeenCalled()
  expect(provider.isolatedEvaluationBudgetMode?.()).toBe('question')
  expect(budget.usage).toEqual({requests:2,outputTokens:250})
})

for(const transport of ['CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_USE_ANTHROPIC_AWS','CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD','CLAUDE_CODE_USE_MANTLE'])it(`allows native transport with the question gate: ${transport}`,async()=>{
  vi.stubEnv(transport,'1')
  vi.stubEnv('ANTHROPIC_BASE_URL','https://gateway.invalid')
  vi.stubEnv('ANTHROPIC_API_KEY','fictional')
  const makeProxy=vi.spyOn(proxy,'makeCheckupProxy')
  let native=false
  const provider=createClaudeAgentProvider({sdkOptionsForProject:()=>{throw Error('production')},queryImpl:((args:any)=>{
    native=args.options.env[transport]==='1'&&args.options.env.ANTHROPIC_BASE_URL==='https://gateway.invalid'
    return(async function*(){for await(const _ of args.prompt){yield result({output_tokens:100});return}})()
  }) as any})
  const budget=makeCheckupBudget({maxOutputTokens:20_000,maxRequests:10}),session=await provider.spawn(project,context(budget))
  try{await collectTurn(session.dispatch('fictional'))}finally{await session.close()}
  expect(native).toBe(true);expect(makeProxy).not.toHaveBeenCalled()
  expect(budget.usage).toEqual({requests:2,outputTokens:100})
})

for(const dimension of ['output','requests'])it(`refuses an incomplete question reservation before SDK startup: ${dimension}`,async()=>{
  const query=vi.fn(()=>{throw Error('must not start')})
  const provider=createClaudeAgentProvider({sdkOptionsForProject:()=>{throw Error('production')},queryImpl:query as any})
  const budget=makeCheckupBudget({maxOutputTokens:dimension==='output'?12287:20000,maxRequests:dimension==='requests'?2:10})
  await expect(provider.spawn(project,context(budget))).rejects.toMatchObject({code:'checkup_usage_limit'})
  expect(query.mock.calls.length===0).toBe(true)
  expect(budget.usage).toEqual({requests:0,outputTokens:0})
})

for(const shape of ['result','assistant','missing','partial','missing-step','interrupted'] as const)it(`settles question usage conservatively from ${shape}`,async()=>{
  const messages=shape==='missing'?[result()]:shape==='partial'?[assistant('a',50),assistant('b'),result()]:shape==='missing-step'?[assistant('a',50),result()]:shape==='interrupted'?[assistant('a',50)]:[assistant('a',20),assistant('a',50),assistant('b',70),result(shape==='result'?{output_tokens:90}:undefined)]
  const provider=createClaudeAgentProvider({sdkOptionsForProject:()=>{throw Error('production')},queryImpl:((args:any)=>(async function*(){for await(const _ of args.prompt){for(const message of messages)yield message;if(shape==='interrupted')throw Error('Fictional interruption');return}})()) as any})
  const budget=makeCheckupBudget({maxOutputTokens:20000,maxRequests:10}),session=await provider.spawn(project,context(budget))
  try{await collectTurn(session.dispatch('fictional'))}finally{await session.close()}
  expect(budget.usage).toEqual(shape==='result'||shape==='assistant'?{requests:2,outputTokens:shape==='result'?90:120}:{requests:3,outputTokens:12288})
})

for(const dimension of ['output','requests'])it(`stops between questions and retains measured reviews at the soft ${dimension} gate`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'checkup-question-gate-'))
  let spawned=0
  const provider=createClaudeAgentProvider({sdkOptionsForProject:()=>{throw Error('production')},queryImpl:((args:any)=>{
    spawned++
    return(async function*(){for await(const _ of args.prompt){
      const client=new Client({name:'offline',version:'1'})
      try{
        await client.connect(new StreamableHTTPClientTransport(new URL(args.options.mcpServers.wechat.url)))
        await client.callTool({name:'reply',arguments:{text:'不知道，我不能确认。'}})
        yield{...result({output_tokens:4096}),num_turns:1}
      }finally{await client.close()}
      return
    }})()
  }) as any})
  const service=makeCheckupService({store:makeCheckupStore(dir),version:'test',resolveTarget:()=>({provider:'claude',address:'default',model:'fictional',windowTokens:8192,windowKnown:false}),run:makeCheckupTurn(()=>provider),limits:()=>({maxOutputTokens:dimension==='output'?12288:300000,maxRequests:dimension==='requests'?3:120}),budgetMode:()=>provider.isolatedEvaluationBudgetMode!()})
  try{
    await service.start().done
    const view=service.view()
    expect(spawned).toBe(1)
    expect(view.attempt).toMatchObject({status:'completed',errorCode:'checkup_usage_limit',completedRequests:1,usage:{requests:1,outputTokens:4096}})
    expect(view.profile?.interview?.business.total).toBe(1)
    expect(view.profile?.interview?.business.unmeasured).toBeGreaterThan(0)
    expect(view.review?.status).toContain('到了本次体检的用量上限')
  }finally{await service.stop();rmSync(dir,{recursive:true,force:true})}
})
