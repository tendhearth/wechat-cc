import {afterEach,describe,expect,it,vi} from 'vitest'
import {createDecipheriv,createHash} from 'node:crypto'
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {makeConversationStore} from '../../core/conversation-store'
import {makeMessagesStore} from '../../lib/messages-store'
import {createProviderRegistry} from '../../core/provider-registry'
import {makeWorkbenchStore} from '../../core/workbench/store'
import {makeWorkbenchService,type WorkbenchService} from '../../core/workbench/service'
import {saveArtifactSnapshot} from '../../core/workbench/artifacts'
import {makeIlinkAdapter} from '../ilink-glue'
import {makeMwWorkbench} from '../inbound/mw-workbench'
import {wireWorkbenchArtifacts} from './wire-workbench-artifacts'

type Server=ReturnType<typeof Bun.serve>
const cleanups:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup()})

async function fixture(finalResponses:unknown[]){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-artifact-wire-'))),project=join(root,'project');mkdirSync(project)
  const db:Db=openDb({path:join(root,'state.db')}),store=makeWorkbenchStore(db)
  const service:WorkbenchService=makeWorkbenchService({store,registry:createProviderRegistry(),stateDir:root,ownerChatId:()=> 'owner'})
  const task=store.create({title:'报告',path:project,providerId:'claude',ownerChatId:'owner'});store.update(task.id,'completed')
  const original=Buffer.from('immutable artifact snapshot\n第二行')
  saveArtifactSnapshot(store,task.id,{name:'结果报告.pdf',mime:'application/pdf',bytes:original},root)
  const artifact=store.artifacts(task.id)[0]!
  const uploads:Buffer[]=[],uploadDescriptors:Array<Record<string,unknown>>=[],sends:Array<Record<string,any>>=[]
  let server!:Server
  server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const path=new URL(request.url).pathname
    if(path==='/ilink/bot/getuploadurl'){
      uploadDescriptors.push(await request.json() as Record<string,unknown>)
      return Response.json({upload_full_url:`http://127.0.0.1:${server.port}/cdn`})
    }
    if(path==='/cdn'){
      uploads.push(Buffer.from(await request.arrayBuffer()))
      return new Response('',{headers:{'x-encrypted-param':`descriptor-${uploads.length}`}})
    }
    if(path==='/ilink/bot/sendmessage'){
      sends.push(await request.json() as Record<string,any>)
      return Response.json(finalResponses.shift()??{errcode:0})
    }
    return new Response('missing',{status:404})
  }})
  const adapter=makeIlinkAdapter({stateDir:root,accounts:[{id:'account-1',botId:'bot',userId:'user',baseUrl:`http://127.0.0.1:${server.port}`,token:'secret',syncBuf:''}],db,conversationStore:makeConversationStore(db)})
  adapter.routeChatToAccount('owner','account-1');adapter.captureContextToken('owner','context-1')
  const wiring=wireWorkbenchArtifacts({workbench:service,ilink:adapter}),ordinary=vi.fn(async()=>({msgId:'ordinary'}))
  const middleware=makeMwWorkbench({handleWechat:service.handleWechat,sendMessage:ordinary})
  const command=`任务 ${task.id} 文件 ${artifact.id}`
  const invoke=async()=>{const ctx={msg:{chatId:'owner',userId:'owner',accountId:'account-1',text:command,msgType:'text',createTimeMs:1,msgId:'artifact-command',contextToken:'context-1'},receivedAtMs:1,requestId:'artifact-command'};await middleware(ctx,async()=>{});return ctx}
  cleanups.push(async()=>{await wiring.close();await service.shutdown();server.stop(true);db.close();rmSync(root,{recursive:true,force:true})})
  return{db,service,task,artifact,original,uploads,uploadDescriptors,sends,ordinary,invoke,messages:makeMessagesStore(db)}
}

function decrypt(ciphertext:Buffer,descriptor:Record<string,unknown>){
  const decipher=createDecipheriv('aes-128-ecb',Buffer.from(String(descriptor.aeskey),'hex'),null)
  return Buffer.concat([decipher.update(ciphertext),decipher.final()])
}

describe('explicit artifact delivery through production bootstrap transport',()=>{
  it('uploads the saved snapshot, sends one bound media item, audits it, and consumes accepted replay without ordinary text',async()=>{
    const f=await fixture([{errcode:0}]);await f.invoke()
    expect(f.uploads).toHaveLength(1);expect(decrypt(f.uploads[0]!,f.uploadDescriptors[0]!)).toEqual(f.original)
    expect(f.sends).toHaveLength(1);const wire=f.sends[0]!.msg,item=wire.item_list[0]
    const receipt=f.db.query<any,[]>('SELECT * FROM workbench_artifact_deliveries').get()!
    expect(receipt).toMatchObject({task_id:f.task.id,artifact_id:f.artifact.id,artifact_sha256:createHash('sha256').update(f.original).digest('hex'),owner_chat_id:'owner',account_id:'account-1',status:'accepted'})
    expect(wire).toMatchObject({client_id:receipt.id,to_user_id:'owner',context_token:'context-1'});expect(wire.item_list).toHaveLength(1)
    expect(item).toMatchObject({type:4,file_item:{file_name:'结果报告.pdf',len:String(f.original.length),media:{encrypt_query_param:'descriptor-1',encrypt_type:1}}})
    await f.invoke();expect(f.uploads).toHaveLength(1);expect(f.sends).toHaveLength(1);expect(f.ordinary).not.toHaveBeenCalled()
    await expect(f.messages.listRange('owner',{limit:10})).resolves.toEqual([expect.objectContaining({kind:'file',text:'结果报告.pdf',source:'workbench'})])
  })

  it('reuses the uploaded descriptor after definitive window closure and sends only on explicit replay',async()=>{
    const f=await fixture([{errcode:-2},{errcode:0}]);await f.invoke()
    expect(f.uploads).toHaveLength(1);expect(f.sends).toHaveLength(1);expect(f.ordinary).toHaveBeenCalledTimes(1)
    await f.invoke();expect(f.uploads).toHaveLength(1);expect(f.sends).toHaveLength(2)
    expect(f.sends[1]!.msg.item_list).toEqual(f.sends[0]!.msg.item_list);expect(f.ordinary).toHaveBeenCalledTimes(1)
  })

  it('does not replay an ambiguous final send for the same explicit command',async()=>{
    const f=await fixture([{}]);await f.invoke();await f.invoke()
    expect(f.uploads).toHaveLength(1);expect(f.sends).toHaveLength(1)
    expect(f.db.query<{status:string},[]>('SELECT status FROM workbench_artifact_deliveries').get()?.status).toBe('unknown')
  })
})
