import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import {makeWorkbenchStore,type WorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {saveArtifactSnapshot} from './artifacts'
import {wechatTaskMessageKey} from './wechat-control'
import {wireWorkbenchArtifacts} from '../../daemon/bootstrap/wire-workbench-artifacts'

let root:string,db:Db,store:WorkbenchStore,service:WorkbenchService,owner:string|null,account:string
let wiring:ReturnType<typeof wireWorkbenchArtifacts>|undefined
const identity={accountId:'account-one',userId:'owner',msgId:'file-one',createTimeMs:1}
const item={type:4 as const,file_item:{media:{encrypt_query_param:'encrypted',aes_key:'key',encrypt_type:1 as const},file_name:'report.md',len:'15'}}
function setup(){service=makeWorkbenchService({store,registry:createProviderRegistry(),stateDir:root,ownerChatId:()=>owner})}
function artifact(text='original report',taskOwner='owner'){
  const task=store.create({title:'报告',path:root,providerId:'claude',ownerChatId:taskOwner})
  store.update(task.id,'completed')
  saveArtifactSnapshot(store,task.id,{name:'report.md',mime:'text/markdown',bytes:Buffer.from(text)},root)
  const artifact=store.artifacts(task.id)[0]!
  return{task,artifact,storagePath:store.artifact(task.id,artifact.id).storagePath,text}
}
function transport(){
  const upload=vi.fn(async()=>({status:'uploaded' as const,item}))
  const send=vi.fn(async()=>({status:'accepted' as const}))
  wiring=wireWorkbenchArtifacts({workbench:service,ilink:{chatAccountId:()=>account,uploadWorkbenchArtifact:upload,sendWorkbenchArtifact:send}})
  return{upload,send}
}
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-phone-artifact-')));mkdirSync(join(root,'artifacts'));db=openDb({path:join(root,'state.db')});store=makeWorkbenchStore(db);owner='owner';account='account-one';setup()})
afterEach(async()=>{await wiring?.close();wiring=undefined;await service.shutdown();db.close();rmSync(root,{recursive:true,force:true})})

describe('explicit owner artifact delivery through the shared workbench',()=>{
  it('sends a saved version once, consumes accepted replay, and keeps ordinary result queries silent',async()=>{
    const f=artifact(),{upload,send}=transport(),command=`任务 ${f.task.id} 文件 ${f.artifact.id}`
    expect(await service.handleWechat('owner',`任务 ${f.task.id} 结果`,identity)).toContain(command)
    expect(upload).not.toHaveBeenCalled()
    const reply=await service.handleWechat('owner',command,identity)
    expect(reply).toMatchObject({kind:'artifact_delivered'})
    expect(upload).toHaveBeenCalledOnce();expect(send).toHaveBeenCalledOnce()
    const receipt=service.artifactDeliveryStore.get((reply as {receiptId:string}).receiptId)!
    expect(wechatTaskMessageKey({...identity,chatId:'owner',text:command})).toBe('workbench:'+receipt.id)
    expect(receipt).toMatchObject({taskId:f.task.id,artifactId:f.artifact.id,artifactSha256:f.artifact.sha256,ownerChatId:'owner',accountId:'account-one',status:'accepted'})
    expect(await service.handleWechat('owner',command,identity)).toEqual(reply)
    expect(upload).toHaveBeenCalledOnce();expect(send).toHaveBeenCalledOnce()
    await wiring!.close();await service.shutdown();db.close()
    db=openDb({path:join(root,'state.db')});store=makeWorkbenchStore(db);setup();const again=transport()
    expect(await service.handleWechat('owner',command,identity)).toEqual(reply)
    expect(again.upload).not.toHaveBeenCalled();expect(again.send).not.toHaveBeenCalled()
  })
  it('rejects foreign, changed, missing and malformed artifacts before upload without dispatching a task',async()=>{
    const f=artifact(),foreign=artifact('private','other'),{upload,send}=transport()
    for(const suffix of ['文件','文件 /tmp/report.md',`文件 ${foreign.artifact.id}`,`文件 ${f.artifact.id} extra`]){
      expect(await service.handleWechat('owner',`任务 ${f.task.id} ${suffix}`,identity)).toMatch(/文件|用法|成果/)
    }
    expect(await service.handleWechat('other',`任务 ${foreign.task.id} 文件 ${foreign.artifact.id}`,{...identity,userId:'other'})).toBeNull()
    expect(await service.handleWechat('owner',`任务 ${f.task.id} 文件 ${f.artifact.id}`,{...identity,userId:'other'})).toBeNull()
    writeFileSync(f.storagePath,'tampered')
    expect(await service.handleWechat('owner',`任务 ${f.task.id} 文件 ${f.artifact.id}`,identity)).toMatch(/变化|校验|文件/)
    expect(upload).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled()
    expect(store.events(f.task.id).filter(e=>e.kind==='user')).toEqual([])
  })
  it('rejects changed payload under an accepted request identity and never redirects a pending delivery',async()=>{
    const f=artifact(),other=artifact('second report'),{upload,send}=transport()
    await service.handleWechat('owner',`任务 ${f.task.id} 文件 ${f.artifact.id}`,identity)
    expect(await service.handleWechat('owner',`任务 ${f.task.id} 文件 ${other.artifact.id}`,identity)).toMatch(/不一致|冲突/)
    expect(await service.handleWechat('owner',`任务 ${other.task.id} 文件 ${other.artifact.id}`,identity)).toMatch(/不一致|冲突/)
    expect(await service.handleWechat('owner',`任务 ${other.task.id} 补充 changed command`,identity)).toMatch(/不一致|冲突/)
    expect(send).toHaveBeenCalledOnce()
    account='different-account'
    expect(await service.handleWechat('owner',`任务 ${other.task.id} 文件 ${other.artifact.id}`,{...identity,msgId:'file-two'})).toMatch(/账号|发送|文件/)
    expect(upload).toHaveBeenCalledOnce();expect(send).toHaveBeenCalledOnce()
  })
  it.each(['creation','control','supplement'])('does not reinterpret a recorded %s message as a file request',async kind=>{
    const f=artifact(),{upload,send}=transport()
    const old=kind==='creation'?'任务 新建 p-aaaaaaaaaaaaaaaaaaaa original':`任务 ${f.task.id} ${kind==='control'?'停止':'补充 original'}`
    const requestId=wechatTaskMessageKey({...identity,chatId:'owner',text:old})!.slice('workbench:'.length)
    const commandHash=createHash('sha256').update(old).digest('hex')
    if(kind==='creation')store.creationReceipts.add({id:requestId,accountId:identity.accountId,ownerChatId:'owner',commandHash,projectId:'p-aaaaaaaaaaaaaaaaaaaa',path:root,providerId:'claude',taskId:f.task.id,runId:crypto.randomUUID(),reply:'created'})
    else if(kind==='control')store.controlReceipts.reserve({id:requestId,taskId:f.task.id,runId:null,action:'stop',textHash:commandHash})
    else store.liveInputs.add({id:requestId,taskId:f.task.id,runId:crypto.randomUUID(),text:'original'})
    expect(await service.handleWechat('owner',`任务 ${f.task.id} 文件 ${f.artifact.id}`,identity)).toMatch(/不一致|冲突/)
    expect(upload).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled()
  })
  it('rechecks owner after upload and never sends when ownership changes mid-flight',async()=>{
    const f=artifact()
    const send=vi.fn(async()=>({status:'accepted' as const}))
    wiring=wireWorkbenchArtifacts({workbench:service,ilink:{chatAccountId:()=>account,uploadWorkbenchArtifact:async()=>{owner='new-owner';return{status:'uploaded',item}},sendWorkbenchArtifact:send}})
    expect(await service.handleWechat('owner',`任务 ${f.task.id} 文件 ${f.artifact.id}`,identity)).toMatch(/发送|文件|绑定/)
    expect(send).not.toHaveBeenCalled()
  })
})
