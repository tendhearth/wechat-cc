import {afterEach,expect,it,vi} from 'vitest'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import type {McpSdkServerConfigWithInstance} from '@anthropic-ai/claude-agent-sdk'
import {workbenchClaudeOptions} from './wire'
import {createClaudeAgentProvider,makeWorkbenchClaudeCanUseTool} from '../../adapters/executors/claude/claude-agent-provider'
import {TIER_PROFILES} from '../../domain/user-tier'

afterEach(()=>{vi.unstubAllGlobals()})

it.each(['transport','session','preparation','spawn failure'] as const)('cancels in-flight notebook HTTP work on %s close',async kind=>{
  let requestSignal:AbortSignal|undefined
  let started=false
  let release:()=>void=()=>{}
  vi.stubGlobal('fetch',(_url:string,init:RequestInit)=>{
    started=true
    requestSignal=init.signal??undefined
    return new Promise<Response>((resolve,reject)=>{
      release=()=>resolve(Response.json({notes:[]}))
      init.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true})
    })
  })
  const baseAbort=new AbortController(),preparation=new AbortController()
  const spec={command:'unused',env:{WECHAT_INTERNAL_API:'http://offline.invalid',WECHAT_SESSION_TOKEN:'notebook-baton'}}
  const options=await workbenchClaudeOptions({cwd:'/offline',abortController:baseAbort},'task',vi.fn(),{servers:{},omitted:[]},undefined,preparation.signal,spec)
  const config=options.mcpServers!['wechat-cc-matter'] as McpSdkServerConfigWithInstance
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair()
  const client=new Client({name:'offline',version:'1'})
  await config.instance.connect(serverTransport)
  await client.connect(clientTransport)
  const work=client.callTool({name:'matter_notes',arguments:{}}).catch(()=>undefined)
  try{
    await expect.poll(()=>started).toBe(true)
    if(kind==='transport')await client.close()
    else if(kind==='session')options.abortController?.abort()
    else if(kind==='preparation')preparation.abort()
    else{
      const provider=createClaudeAgentProvider({sdkOptionsForProject:()=>({...options,spawnClaudeCodeProcess:()=>{throw Error('must not spawn')}})})
      await expect(provider.spawn({alias:'workbench:offline',path:'/offline'},{tierProfile:TIER_PROFILES.trusted,permissionMode:'strict',chatId:'owner',workbenchLifecycle:true})).rejects.toThrow(/claude_workbench_(custom_spawn|process_groups)_unsupported/)
    }
    expect(requestSignal?.aborted===true).toBe(true)
    expect(baseAbort.signal.aborted).toBe(true)
  }finally{release();await client.close();await work}
})

it('admits only the two daemon-owned notebook tools, without exposing companion tools or putting credentials in shell env',async()=>{
  const spec={command:'/cc',args:['mcp-server','matter'],env:{WECHAT_INTERNAL_API:'http://127.0.0.1:1',WECHAT_SESSION_TOKEN:'bound-token'}}
  const gate=makeWorkbenchClaudeCanUseTool(undefined,undefined,[],[],true)
  const options=await workbenchClaudeOptions({cwd:'/project'},'task instructions',gate,{servers:{},omitted:[]},undefined,undefined,spec)
  expect(options.mcpServers?.['wechat-cc-matter']).toMatchObject({type:'sdk',name:'wechat-cc-matter'})
  expect(options.allowedTools).toEqual(['mcp__wechat-cc-matter__matter_notes','mcp__wechat-cc-matter__matter_note'])
  expect(Object.hasOwn(options.env??{},'WECHAT_SESSION_TOKEN')).toBe(false)
  for(const name of ['matter_notes','matter_note']){
    expect(await gate(`mcp__wechat-cc-matter__${name}`,{}, {signal:new AbortController().signal} as never)).toMatchObject({behavior:'allow'})
  }
  for(const name of ['mcp__wechat-cc-matter__memory_read','mcp__wechat__matter_notes','mcp__wechat__memory_read']){
    expect(await gate(name,{}, {signal:new AbortController().signal} as never)).toMatchObject({behavior:'deny'})
  }
  expect(await makeWorkbenchClaudeCanUseTool(undefined,undefined,[],[])('mcp__wechat-cc-matter__matter_notes',{}, {signal:new AbortController().signal} as never)).toMatchObject({behavior:'deny'})
  const aborted=AbortSignal.abort()
  expect(await gate('mcp__wechat-cc-matter__matter_note',{text:'late'},{signal:aborted} as never)).toMatchObject({behavior:'deny'})
})

it('Claude argv never contains the baton token: real SDK process serialization uses an in-process MCP',async()=>{
  const {query}=await import('@anthropic-ai/claude-agent-sdk')
  const token='ARGV_SECRET_CANARY'
  const spec={command:'/cc',args:['mcp-server','matter'],env:{WECHAT_INTERNAL_API:'http://127.0.0.1:1',WECHAT_SESSION_TOKEN:token}}
  const options=await workbenchClaudeOptions({cwd:process.cwd()},'task',makeWorkbenchClaudeCanUseTool(undefined,undefined,[],[],true),{servers:{},omitted:[]},undefined,undefined,spec)
  let argv:string[]=[]
  try{
    const run=query({prompt:'task',options:{...options,executable:'node',pathToClaudeCodeExecutable:'/offline/fake-claude.js',spawnClaudeCodeProcess:opts=>{argv=opts.args;throw Error('captured_offline_spawn')}}})
    for await(const event of run)void event
  }catch(error){expect((error as Error).message).toContain('captured_offline_spawn')}
  expect(argv).toContain('/offline/fake-claude.js')
  expect(argv.join(' ')).not.toContain(token)
  expect(Object.hasOwn(options.env??{},'WECHAT_SESSION_TOKEN')).toBe(false)
})

it('handoff is a mutating admin action and follows the existing owner relay gate',async()=>{
  const {classifyToolUse,TIER_PROFILES}=await import('../../domain/user-tier')
  expect(classifyToolUse('mcp__wechat__matter_handoff',{})).toBe('daemon_remediate')
  expect(TIER_PROFILES.admin.relay.has(classifyToolUse('mcp__wechat__matter_handoff',{}))).toBe(true)
  expect(TIER_PROFILES.trusted.deny.has(classifyToolUse('mcp__wechat__matter_handoff',{}))).toBe(true)
})

it('a user MCP named matter or matter-* remains eligible for ordinary explicit approval',async()=>{
  const {isCompanionMcp}=await import('../../domain/workbench/native-tools')
  expect(isCompanionMcp('matter',{command:'user-mcp'})).toBe(false)
  expect(isCompanionMcp('matter-user',{command:'user-mcp'})).toBe(false)
  expect(isCompanionMcp('wechat-cc-matter',{command:'/cc'})).toBe(true)
})
