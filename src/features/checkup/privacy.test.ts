import { mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect,it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { makeCheckupStore } from '../../adapters/store/checkup-store'
import { createClaudeAgentProvider } from '../../adapters/executors/claude/claude-agent-provider'
import { createGeminiAgentProvider } from '../../adapters/executors/gemini/gemini-agent-provider'
import { createOpenAiAgentProvider } from '../../adapters/executors/openai/openai-agent-provider'
import { scriptedOpenAiModel } from '../../test-support/executors/openai-scripted'
import { createScriptedClaude } from '../../test-support/executors/claude-scripted'
import type { AgentProvider } from '../../ports/agent-provider'
import { makeCheckupService } from './service'
import { makeCheckupTurn } from './runner'

for(const backend of ['claude','openai','gemini'])it(`${backend}: no real-state canary leaves in system, user or complete tool definitions`,async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'checkup-privacy-')),outbound:unknown[]=[]
  const secrets=['PRIVATE_REAL_MEMORY_823','PRIVATE_TOPIC_234','PRIVATE_CONVERSATION_134','PRIVATE_EXECUTOR_835','PRIVATE_PRODUCTION_TOOL_332']
  for(const [i,name] of ['memory.md','topics.json','messages.json'].entries())writeFileSync(join(stateDir,name),secrets[i]!)
  const forbidden=()=>{throw Error(secrets[4])}
  let provider:AgentProvider
  if(backend==='openai'){
    const scripted=scriptedOpenAiModel(()=>({text:'done'}))
    provider=createOpenAiAgentProvider({makeChatModel:()=>({...scripted.model,stream(messages,specs,signal){outbound.push(structuredClone({messages,specs}));return scripted.model.stream(messages,specs,signal)}}),makeMcpBridge:forbidden,makeBuiltins:forbidden})
  }else if(backend==='gemini'){
    provider=createGeminiAgentProvider({model:'m',systemInstruction:secrets[0]!,mcpConnect:forbidden,buildGate:forbidden,genai:{models:{generateContent:async req=>{outbound.push(structuredClone({contents:req.contents,system:req.config?.systemInstruction,tools:req.config?.tools}));return {text:'done'}}}}})
  }else{
    provider=createClaudeAgentProvider({sdkOptionsForProject:forbidden,queryImpl:((args:any)=>{
      const options=args.options
      outbound.push(structuredClone({system:options.systemPrompt,tools:options.tools,allowed:options.allowedTools,plugins:options.plugins,settings:options.settings}))
      const prompt=(async function*(){for await(const message of args.prompt){
        outbound.push(structuredClone(message))
        const client=new Client({name:'offline-canary',version:'1'})
        try{
          await client.connect(new StreamableHTTPClientTransport(new URL(options.mcpServers.wechat.url)))
          const list=await client.listTools();outbound.push(structuredClone(list))
          await client.callTool({name:'reply',arguments:{text:'收到。'}})
        }finally{await client.close()}
        yield message
      }})()
      return createScriptedClaude({turns:()=>({steps:[{say:'done'}]})}).query({...args,prompt})
    }) as any})
  }
  const service=makeCheckupService({store:makeCheckupStore(stateDir),version:'test',resolveTarget:()=>({provider:backend,model:'m',address:'default',windowTokens:8192,windowKnown:false}),persona:()=>`名字：小禾\n自称：小禾\n记忆：${secrets[0]}\n${secrets[1]} ${secrets[2]}`,executors:()=>[secrets[3]!],run:makeCheckupTurn(()=>provider)})
  try{
    await service.start().done
    expect(outbound.length).toBeGreaterThanOrEqual(24)
    if(backend==='claude')expect(service.view().attempt?.status).toBe('completed')
    const serialized=JSON.stringify(outbound)
    for(const secret of [...secrets,stateDir])expect(serialized.includes(secret),secret).toBe(false)
    expect(serialized).toContain('小禾')
    expect(serialized).toContain('delegate')
    expect(serialized).toContain('阿禾')
    expect(serialized).toContain('instruction')
    expect(serialized).toContain('青匣')
    expect(service.view().attempt?.errorCode).not.toBe('provider_error')
  }finally{await service.stop();rmSync(stateDir,{recursive:true,force:true})}
})
