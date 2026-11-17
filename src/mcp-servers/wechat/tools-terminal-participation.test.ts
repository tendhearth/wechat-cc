import {expect,it} from 'vitest'
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {registerTerminalParticipationTools} from './tools-terminal-participation'
it('工具传挂摘参数，接入说明原样交还，不发起计划',async()=>{
  const server=new McpServer({name:'test',version:'1'})
  const calls:Array<{path:string;body:unknown}>=[]
  registerTerminalParticipationTools(server,{async request(_method,path,body){calls.push({path,body});return {instructions:'把这段原样转给主人'} as never}})
  const client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a),client.connect(b)])
  try{
    const result=await client.callTool({name:'terminal_attach',arguments:{code:'abcdef',matter:'12345678'}})
    expect(JSON.stringify(result)).toContain('把这段原样转给主人')
    await client.callTool({name:'terminal_detach',arguments:{matter:'12345678'}})
    expect(calls).toEqual([{path:'/v1/cli/attach',body:{code:'abcdef',matter:'12345678'}},{path:'/v1/cli/detach',body:{matter:'12345678'}}])
  }finally{await client.close();await server.close()}
})
it('挂摘工具沿 daemon 操作分类触发已有确认卡',async()=>{
  const {classifyToolUse}=await import('../../domain/user-tier')
  expect(classifyToolUse('mcp__wechat__terminal_attach',{})).toBe('daemon_remediate')
  expect(classifyToolUse('mcp__wechat__terminal_detach',{})).toBe('daemon_remediate')
})
