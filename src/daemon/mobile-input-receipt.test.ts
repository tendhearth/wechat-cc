import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MatterInputReceiptResult,PHONE_API_SCHEMAS} from '@wechat-cc/protocol'
import {openDb,type Db} from '../lib/db'
import {removeTempDir} from '../lib/test-temp'
import {createProviderRegistry} from '../core/provider-registry'
import {makeMatterStore} from '../core/matters/store'
import {makeMattersService} from '../core/matters/service'
import {makeWorkbenchStore} from '../core/workbench/store'
import {makeWorkbenchService,type WorkbenchService} from '../core/workbench/service'
import {makeSettingsPanel,type SettingsPanel} from './settings-panel'
import {mobileWorkbenchRoute} from './mobile-workbench'

let root:string,db:Db,workbench:WorkbenchService,panel:SettingsPanel,owner:string|null
let store:ReturnType<typeof makeWorkbenchStore>,matters:ReturnType<typeof makeMatterStore>,service:ReturnType<typeof makeMattersService>
let deviceToken:string
const registry=createProviderRegistry()
const makeWorkbench=()=>makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>owner,matters})

beforeEach(async()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),'phone-input-receipt-')))
  db=openDb({path:join(root,'state.db')});owner='owner'
  matters=makeMatterStore(db);store=makeWorkbenchStore(db);workbench=makeWorkbench()
  service=makeMattersService({store:matters,ownerChatId:()=>owner,workbench})
  panel=makeSettingsPanel({stateDir:root,ownerChatId:()=>owner,chatPrefs:{get:()=>({}),set:()=>({})},getUserName:()=>null,setUserName:async()=>{},log:()=>{},
    matters:{...service,say:(id,text,input)=>service.say(id,text,'phone',input),seenOnPhone:id=>matters.bind(id,'phone','pwa')}})
  const link=panel.issueToken()
  const paired=await (await panel.handleRequest(new Request('http://phone.test/set/api/pair?t='+link,{method:'POST',body:'{}',headers:{'content-type':'application/json'}}))).json()
  deviceToken=paired.device_token
})
afterEach(async()=>{vi.restoreAllMocks();await panel?.stop();await workbench?.shutdown();db?.close();removeTempDir(root)})

function task(taskOwner='owner'){
  const t=store.create({title:'原来的任务',path:root,providerId:'claude',ownerChatId:taskOwner})
  matters.create({id:t.id,kind:'task',title:t.title,ownerChatId:taskOwner});matters.linkTask(t.id)
  return t
}
function receipt(taskId:string,text='原始要求\r\n  不改空格'){
  const input=store.liveInputs.add({id:randomUUID(),taskId,runId:randomUUID(),text})
  store.liveInputs.set(input.id,'delivered')
  return store.liveInputs.get(input.id)!
}
const path=(id:string,requestId:string)=>'/m/api/matter/input-receipt?id='+id+'&requestId='+requestId
const request=(p:string,auth=deviceToken,method='GET')=>panel.handleRequest(new Request('http://phone.test'+p+(p.includes('?')?'&':'?')+'d='+encodeURIComponent(auth),{method}))

describe('single input receipt through real matter/workbench/phone layers',()=>{
  it('reads an old durable receipt after the newest-50 detail window, with no task/timeline mutation',async()=>{
    const t=task(),first=receipt(t.id)
    for(let i=0;i<55;i++)receipt(t.id,'后来的补充 '+i)
    expect((await service.detail(t.id)).inputs).toHaveLength(50)
    expect((await service.detail(t.id)).inputs.some(input=>input.id===first.id)).toBe(false)
    const timeline=vi.spyOn(workbench,'detail').mockImplementation(()=>{throw Error('must_not_read_detail')})
    const savedTask=store.get(t.id),savedMatter=matters.get(t.id),version=store.version(t.id),bindings=matters.bindings(t.id)
    const response=await request(path(t.id,first.id)),body=await response.json()
    expect(response.status).toBe(200)
    expect(MatterInputReceiptResult.parse(body)).toEqual({ok:true,input:{id:first.id,taskId:t.id,runId:first.runId,text:first.text,status:'delivered',error:null}})
    expect(timeline).not.toHaveBeenCalled()
    expect(store.get(t.id)).toEqual(savedTask);expect(matters.get(t.id)).toEqual(savedMatter)
    expect(store.version(t.id)).toBe(version);expect(matters.bindings(t.id)).toEqual(bindings)
    expect(store.liveInputs.get(first.id)).toEqual(first);expect(store.list()).toHaveLength(1)
  })

  it('still returns a receipt when the real phone detail rejects a large timeline with 413',async()=>{
    const t=task(),input=receipt(t.id)
    for(let i=0;i<4;i++)store.addEvent(t.id,'text','很长的完整内容'.repeat(6_000))
    const large=await request('/m/api/matter?id='+t.id+'&_via=tunnel')
    expect(large.status).toBe(413);expect(await large.json()).toEqual({ok:false,error:'detail_too_large'})
    const response=await request(path(t.id,input.id)+'&_via=tunnel'),body=await response.json()
    expect(response.status).toBe(200);expect(body.input).toMatchObject({id:input.id,taskId:t.id,text:input.text,status:'delivered',error:null})
    expect(PHONE_API_SCHEMAS['GET /m/api/matter/input-receipt']!.parse(body)).toEqual(body)
    expect(Buffer.byteLength(JSON.stringify(body))*4/3+1024).toBeLessThan(512*1024)
  })

  it('normalizes UUID case but rejects malformed, duplicated and injected identities before lookup',async()=>{
    const t=task(),input=receipt(t.id),lookup=vi.spyOn(store.liveInputs,'get')
    for(const p of [path(t.id,'nope'),path('invalid',input.id),path(t.id,input.id)+'&id='+t.id,path(t.id,input.id)+'&requestId='+input.id,path(t.id,input.id)+'&taskId='+t.id,path(t.id,input.id)+'&ownerChatId=other',path(t.id,input.id)+'&runId='+input.runId]){
      const response=await request(p);expect(response.status,p).toBe(400)
    }
    expect(lookup).not.toHaveBeenCalled()
    const response=await request(path(t.id,input.id.toUpperCase()))
    expect(response.status).toBe(200);expect((await response.json()).input.id).toBe(input.id)
    expect(()=>service.inputReceipt(t.id,'invalid')).toThrow('invalid_request')
    expect(()=>workbench.inputReceipt('bad',input.id)).toThrow('invalid_matter_id')
  })

  it('rejects absent pairing, an invalid token, revoked devices and a mutation method',async()=>{
    const t=task(),input=receipt(t.id),p=path(t.id,input.id),lookup=vi.spyOn(store.liveInputs,'get')
    expect((await panel.handleRequest(new Request('http://phone.test'+p))).status).toBe(401)
    expect((await request(p,'wrong')).status).toBe(401)
    expect((await request(p,deviceToken,'POST')).status).toBe(405)
    expect(lookup).not.toHaveBeenCalled()
    await panel.apply({op:'forget_devices'})
    expect((await request(p)).status).toBe(401);expect(lookup).not.toHaveBeenCalled()
  })

  it('never exposes another matter/task owner or a receipt from another task',async()=>{
    const mine=task(),other=task(),guest=task('guest'),input=receipt(mine.id),foreign=receipt(guest.id)
    const lookup=vi.spyOn(store.liveInputs,'get')
    const guestResponse=await request(path(guest.id,foreign.id))
    expect(guestResponse.status).toBe(404);expect(await guestResponse.json()).toEqual({ok:false,error:'not_found'})
    expect(lookup).not.toHaveBeenCalled()
    const wrongTask=await request(path(other.id,input.id))
    expect(wrongTask.status).toBe(404);expect(await wrongTask.json()).toEqual({ok:false,error:'not_found'})
    lookup.mockClear()
    db.query('UPDATE workbench_tasks SET owner_chat_id=? WHERE id=?').run('guest',mine.id)
    expect((await request(path(mine.id,input.id))).status).toBe(404);expect(lookup).not.toHaveBeenCalled()
    db.query('UPDATE workbench_tasks SET owner_chat_id=?,matter_id=? WHERE id=?').run('owner',other.id,mine.id)
    expect((await request(path(mine.id,input.id))).status).toBe(404);expect(lookup).not.toHaveBeenCalled()
    owner=null
    expect((await request(path(other.id,input.id))).status).toBe(404);expect(lookup).not.toHaveBeenCalled()
  })

  it('returns the same not_found for a missing receipt, missing matter/task or non-task matter',async()=>{
    const t=task(),input=receipt(t.id),chat=matters.ensureChat('owner')
    matters.create({id:'00000000',kind:'task',title:'记录还在',ownerChatId:'owner'})
    for(const p of [path(t.id,randomUUID()),path('deadbeef',input.id),path('00000000',input.id),path(chat.id,input.id)]){
      const response=await request(p);expect(response.status,p).toBe(404)
      const body=await response.json();expect(body).toEqual({ok:false,error:'not_found'})
      expect(PHONE_API_SCHEMAS['GET /m/api/matter/input-receipt']!.parse(body)).toEqual(body)
    }
  })

  it.each(['pending','sending','delivered','held','withdrawn'] as const)('projects the durable %s state and error verbatim without recovery or sending',async status=>{
    const t=task(),input=receipt(t.id)
    store.liveInputs.set(input.id,status,status==='held'?'daemon_restarted':null)
    const saved=store.liveInputs.get(input.id)!
    const response=await request(path(t.id,input.id)),body=await response.json()
    expect(response.status).toBe(200)
    expect(body).toEqual({ok:true,input:{id:input.id,taskId:t.id,runId:input.runId,text:input.text,status,error:saved.error}})
    expect(store.liveInputs.get(input.id)).toEqual(saved)
    expect(body.input).not.toHaveProperty('createdAt');expect(body.input).not.toHaveProperty('execution')
  })

  it('reads daemon_restarted after real workbench startup recovery, not only a hand-built public fixture',async()=>{
    const t=task(),input=receipt(t.id)
    store.liveInputs.set(input.id,'sending')
    await workbench.shutdown();workbench=makeWorkbench()
    service=makeMattersService({store:matters,ownerChatId:()=>owner,workbench})
    expect(store.liveInputs.get(input.id)).toMatchObject({status:'held',error:'daemon_restarted'})
    const read=service.inputReceipt(t.id,input.id)
    expect(read).toEqual({id:input.id,taskId:t.id,runId:input.runId,text:input.text,status:'held',error:'daemon_restarted'})
    const response=await request(path(t.id,input.id))
    expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,input:read})
  })

  it('strips private attachment fields while preserving the existing public metadata',async()=>{
    const t=task(),id=randomUUID(),runId=randomUUID(),attachment={id:randomUUID(),name:'材料.txt',mime:'text/plain',size:12,sha256:'1'.repeat(64),storagePath:'/private/secret',ownerKey:'owner',draftId:randomUUID()}
    store.liveInputs.add({id,taskId:t.id,runId,text:'看材料',attachments:[attachment]})
    store.liveInputs.set(id,'held','等待核对')
    const body=await (await request(path(t.id,id))).json()
    expect(body.input.attachments).toEqual([{id:attachment.id,name:attachment.name,mime:attachment.mime,size:attachment.size,sha256:attachment.sha256}])
    expect(JSON.stringify(body)).not.toContain('storagePath');expect(JSON.stringify(body)).not.toContain('/private/secret');expect(JSON.stringify(body)).not.toContain('ownerKey');expect(JSON.stringify(body)).not.toContain('draftId')
    expect(MatterInputReceiptResult.parse(body)).toEqual(body)
  })

  it('fails closed when older service wiring has no single-receipt action',async()=>{
    const url=new URL('http://phone.test'+path('deadbeef',randomUUID()))
    const response=await mobileWorkbenchRoute({},url,new Request(url))
    expect(response?.status).toBe(503);expect(await response!.json()).toEqual({ok:false,error:'unavailable'})
    const mutation=await mobileWorkbenchRoute({},url,new Request(url,{method:'POST'}))
    expect(mutation?.status).toBe(405)
  })

  it('does not fall back to a chat owner after the trusted receipt owner resolver reports no owner',()=>{
    const t=task(),input=receipt(t.id),lookup=vi.spyOn(store.liveInputs,'get')
    const detached=makeMattersService({store:matters,workbench,ownerChatId:()=>null,chat:{ownerChatId:()=>'owner',say:async()=>({reply:''})}})
    expect(detached.inputReceipt(t.id,input.id)).toBeNull();expect(lookup).not.toHaveBeenCalled()
  })
})
