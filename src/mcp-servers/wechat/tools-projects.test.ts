import { expect,it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerProjectsActivityTool } from './tools-projects'
import { classifyToolUse } from '../../domain/user-tier'
import { topicSearchSection } from '../../domain/prompt-builder'
import { createWechatMcpServer } from './server'
it('matter_plan is owner-only scheduling with the existing target shape and ordered legs',async()=>{
 const calls:unknown[]=[],server=await createWechatMcpServer({async request(method,path,body){calls.push([method,path,body]);return {task:{id:'12345678'}} as never}},{tier:'admin'})
 const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'plan',version:'0'})
 await Promise.all([server.connect(a),client.connect(b)])
 try{
  const args={requestId:'11111111-1111-4111-8111-111111111111',target:{kind:'project',projectId:'p-'+'a'.repeat(20),isolation:'worktree',base:'dev'},title:'插图',legs:[{executor:'codex',brief:'出图'},{executor:'claude',brief:'接图'}]}
  expect((await client.listTools()).tools.find(t=>t.name==='matter_plan')?.description).toContain('只有主人一句话里明确要多个执行者先后做时才用')
  expect((await client.callTool({name:'matter_plan',arguments:args})).isError).not.toBe(true)
  expect(calls.find(call=>Array.isArray(call)&&call[1]==='/v1/matter/plan')).toMatchObject(['POST','/v1/matter/plan',args])
  expect(classifyToolUse('mcp__wechat__matter_plan',{})).toBe('daemon_remediate')
  for(const tier of ['trusted','guest']){
   const other=await createWechatMcpServer({async request(){throw Error('forbidden')}},{tier}),[c,d]=InMemoryTransport.createLinkedPair(),viewer=new Client({name:'tier',version:'0'})
   await Promise.all([other.connect(c),viewer.connect(d)])
   try{expect((await viewer.listTools()).tools.some(t=>t.name==='matter_plan')).toBe(false)}finally{await viewer.close();await other.close()}
  }
 }finally{await client.close();await server.close()}
})
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
  for(const tier of ['admin','trusted','guest']) {
   const registered=await createWechatMcpServer({async request(){return {} as never}},{tier})
   const [c,d]=InMemoryTransport.createLinkedPair(),viewer=new Client({name:'tier-test',version:'0'})
   await Promise.all([registered.connect(c),viewer.connect(d)])
   try{expect((await viewer.listTools()).tools.some(t=>t.name==='projects_activity')).toBe(tier==='admin')}
   finally{await viewer.close();await registered.close()}
  }
  const prompt=topicSearchSection()
  for(const text of ['projects_activity','先','一两句','会话码','没有','时区','周一'])expect(prompt).toContain(text)
 }finally{await client.close();await server.close()}
})
