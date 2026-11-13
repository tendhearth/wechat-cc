import {expect,it} from 'vitest'
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {registerMatterTools} from './tools'

it('exposes only the bound matter notebook and rejects caller-supplied matter or author identities',async()=>{
  const calls:unknown[]=[]
  const server=new McpServer({name:'matter-test',version:'0'})
  registerMatterTools(server,{async request(method,path,body){calls.push([method,path,body]);return {ok:true} as never}})
  const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'test',version:'0'})
  await Promise.all([server.connect(a),client.connect(b)])
  try{
    expect((await client.listTools()).tools.map(t=>t.name)).toEqual(['matter_notes','matter_note'])
    expect((await client.callTool({name:'matter_notes',arguments:{}})).isError).not.toBe(true)
    expect((await client.callTool({name:'matter_note',arguments:{text:'Use dark.webp'}})).isError).not.toBe(true)
    expect(calls).toEqual([['GET','/v1/matter/notes',undefined],['POST','/v1/matter/note',{text:'Use dark.webp'}]])
    for(const args of [{matter:'other'},{matter_id:'other'},{author:'owner'}]){
      expect((await client.callTool({name:'matter_notes',arguments:args})).isError).toBe(true)
      expect((await client.callTool({name:'matter_note',arguments:{text:'forged',...args}})).isError).toBe(true)
    }
    expect(calls).toHaveLength(2)
  }finally{await client.close();await server.close()}
})

it('passes bounded notebook pagination and baton filters while rejecting invalid cursors',async()=>{
  const calls:string[]=[]
  const server=new McpServer({name:'matter-page-test',version:'0'})
  registerMatterTools(server,{async request(_method,path){calls.push(path);return {notes:[],notesTotal:10,nextBefore:8,truncated:true} as never}})
  const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'test',version:'0'})
  await Promise.all([server.connect(a),client.connect(b)])
  try{
    const page=await client.callTool({name:'matter_notes',arguments:{runId:'baton-one',before:9,limit:5}})
    expect(page.isError).not.toBe(true)
    expect(calls).toEqual(['/v1/matter/notes?runId=baton-one&before=9&limit=5'])
    expect(JSON.stringify(page)).toContain('nextBefore')
    for(const args of [{before:0},{before:1.5},{limit:0},{limit:51},{runId:''}])expect((await client.callTool({name:'matter_notes',arguments:args})).isError).toBe(true)
    expect(calls).toHaveLength(1)
  }finally{await client.close();await server.close()}
})
