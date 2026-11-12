import { expect,it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerProjectsActivityTool } from './tools-projects'
import { classifyToolUse } from '../../domain/user-tier'
import { topicSearchSection } from '../../domain/prompt-builder'
import { readFileSync } from 'node:fs'
it('projects_activity is an admin-only read with explicit time and project filters',async()=>{
 const server=new McpServer({name:'t',version:'0'}),calls:unknown[]=[]
 registerProjectsActivityTool(server,{async request(method,path,body){calls.push([method,path,body]);return {projects:[]} as never}})
 const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'t',version:'0'})
 await Promise.all([server.connect(a),client.connect(b)])
 try{
  const args={since:'2026-11-10T00:00:00-08:00',until:'2026-11-11T00:00:00-08:00',projects:['bx','1in8b']}
  const result=await client.callTool({name:'projects_activity',arguments:args})
  expect(result.isError).not.toBe(true)
  expect(calls).toEqual([['POST','/v1/memory/projects/activity',args]])
  expect(classifyToolUse('mcp__wechat__projects_activity',{})).toBe('daemon_introspect')
  const main=readFileSync(new URL('./main.ts',import.meta.url),'utf8')
  expect(main.slice(main.indexOf('if (SESSION_IS_ADMIN)'))).toContain('registerProjectsActivityTool(server, client)')
  const prompt=topicSearchSection()
  for(const text of ['projects_activity','先','一两句','会话码','没有','时区','周一'])expect(prompt).toContain(text)
 }finally{await client.close();await server.close()}
})
