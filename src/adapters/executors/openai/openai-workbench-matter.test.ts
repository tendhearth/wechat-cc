import {expect,it} from 'vitest'
import {createServer} from 'node:http'
import {mkdtempSync,mkdirSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {openDb} from '../../../lib/db'
import {removeTempDir} from '../../../lib/test-temp'
import {makeWorkbenchStore} from '../../store/workbench/store'
import {makeApiSessionStore} from './api-sessions'
import {createOpenAiWorkbenchProvider} from './openai-workbench-provider'
import {scriptedOpenAiModel} from '../../../test-support/executors/openai-scripted'
import {TIER_PROFILES} from '../../../domain/user-tier'

it('API executors use the same task-only stdio notebook tools with their bound token',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-api-matter-'))),project=join(root,'project')
  mkdirSync(project)
  const db=openDb({path:join(root,'state.db')}),calls:unknown[]=[]
  const http=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=String(part)
    calls.push([req.method,req.url,req.headers.authorization,body?JSON.parse(body):null])
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({notes:[{text:'first agent note'}]}))
  })
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve))
  let session:Awaited<ReturnType<ReturnType<typeof createOpenAiWorkbenchProvider>['spawn']>>|undefined
  try{
    const port=(http.address() as {port:number}).port
    const task=makeWorkbenchStore(db).create({title:'read notes',path:project,ownerChatId:'owner',providerId:'openai'})
    const fixture=scriptedOpenAiModel([
      {calls:[{id:'read',name:'matter_notes',input:{}}]},
      {calls:[{id:'write',name:'matter_note',input:{text:'handoff verified'}}]},
      {text:'Notebook updated.'},
    ])
    const p=createOpenAiWorkbenchProvider({sessions:makeApiSessionStore(db),model:fixture.model,configHash:'a'.repeat(64),configuredModel:'fixture',matterMcp:ctx=>({command:process.execPath,args:[fileURLToPath(new URL('../../../mcp-servers/matter/main.ts',import.meta.url))],env:{WECHAT_INTERNAL_API:`http://127.0.0.1:${port}`,WECHAT_SESSION_TOKEN:ctx.mcpEnv!.WECHAT_SESSION_TOKEN!}})})
    session=await p.spawn({alias:`workbench:${task.id}`,path:project},{tierProfile:TIER_PROFILES.trusted,permissionMode:'strict',chatId:'owner',mcpEnv:{WECHAT_SESSION_TOKEN:'bound-api-token'},requestPermission:async()=>{throw Error('notebook does not ask for file permission')}})
    const events=[];for await(const event of session.dispatch('read and note'))events.push(event)
    expect(events.at(-1)?.kind).toBe('result')
    expect(calls).toEqual([['GET','/v1/matter/notes','Bearer bound-api-token',null],['POST','/v1/matter/note','Bearer bound-api-token',{text:'handoff verified'}]])
    expect(JSON.stringify(fixture.seen)).toContain('first agent note')
  }finally{await session?.close();await new Promise<void>(resolve=>http.close(()=>resolve()));db.close();removeTempDir(root)}
})
