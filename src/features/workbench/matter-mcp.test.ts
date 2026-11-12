import {expect,it} from 'vitest'
import {workbenchClaudeOptions} from './wire'
import {makeWorkbenchClaudeCanUseTool} from '../../adapters/executors/claude/claude-agent-provider'

it('admits only the two daemon-owned notebook tools, without exposing companion tools or putting credentials in shell env',async()=>{
  const spec={command:'/cc',args:['mcp-server','matter'],env:{WECHAT_INTERNAL_API:'http://127.0.0.1:1',WECHAT_SESSION_TOKEN:'bound-token'}}
  const gate=makeWorkbenchClaudeCanUseTool(undefined,undefined,[],[],true)
  const options=await workbenchClaudeOptions({cwd:'/project'},'task instructions',gate,{servers:{},omitted:[]},undefined,undefined,spec)
  expect(options.mcpServers).toEqual({matter:spec})
  expect(options.env).not.toHaveProperty('WECHAT_SESSION_TOKEN')
  for(const name of ['matter_notes','matter_note']){
    expect(await gate(`mcp__matter__${name}`,{}, {signal:new AbortController().signal} as never)).toMatchObject({behavior:'allow'})
  }
  for(const name of ['mcp__matter__memory_read','mcp__wechat__matter_notes','mcp__wechat__memory_read']){
    expect(await gate(name,{}, {signal:new AbortController().signal} as never)).toMatchObject({behavior:'deny'})
  }
  expect(await makeWorkbenchClaudeCanUseTool(undefined,undefined,[],[])('mcp__matter__matter_notes',{}, {signal:new AbortController().signal} as never)).toMatchObject({behavior:'deny'})
  const aborted=AbortSignal.abort()
  expect(await gate('mcp__matter__matter_note',{text:'late'},{signal:aborted} as never)).toMatchObject({behavior:'deny'})
})
