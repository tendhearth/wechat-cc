import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../lib/db'
import {removeTempDir} from '../lib/test-temp'
import {createProviderRegistry} from '../core/provider-registry'
import {makeMatterStore} from '../core/matters/store'
import {makeMattersService} from '../core/matters/service'
import {makeWorkbenchStore} from '../core/workbench/store'
import {makeWorkbenchService,type WorkbenchService} from '../core/workbench/service'
import {MANAGED_NATIVE_CAPABILITIES} from '../core/workbench/executor-capabilities'
import {saveArtifactSnapshot} from '../core/workbench/artifacts'
import {makeSettingsPanel,type SettingsPanel} from './settings-panel'
import {makeTunnelHub} from '../../relay/tunnel'
import {makeTunnelClient,type TunnelWS} from './tunnel-client'
import {generateTunnelKeypair,exportPublicKeyB64,importPublicKeyB64,deriveSharedKey,sealFrame,openFrame} from '../lib/tunnel-crypto'
import {AsyncQueue} from '../core/async-queue'
import type {AgentEvent} from '../core/agent-provider'

// Real stores, service and HTTP router; only the external native executor is a fixture.
let root:string,db:Db,workbench:WorkbenchService,panel:SettingsPanel,base:string,token:string
let store:ReturnType<typeof makeWorkbenchStore>,matters:ReturnType<typeof makeMatterStore>
const seen=new Map<string,{permission?:boolean;answers?:unknown;inputs:string[]}>()
const runtimeReplies=new Map<string,{finish:(failed:boolean)=>void;submissions:string[]}>()
const terminalFinishes=new Map<string,()=>void>()
beforeEach(async()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),'cc-phone-workbench-')))
  db=openDb({path:join(root,'state.db')});matters=makeMatterStore(db);store=makeWorkbenchStore(db);seen.clear();runtimeReplies.clear()
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(project,ctx){
    if(project.path.endsWith('async-runtime')){
      const events=new AsyncQueue<AgentEvent>(),pending:Array<{resolve:()=>void;reject:(e:Error)=>void}>=[],submissions:string[]=[]
      runtimeReplies.set(project.path,{submissions,finish(failed){for(const p of pending.splice(0))failed?p.reject(Error('native delivery unconfirmed')):p.resolve()}})
      return {async *dispatch(){},workbenchRuntime:{events:events.iterable(),snapshot:()=>({retained:true,foreground:'running' as const,backgroundCount:0,input:'send' as const}),start(){events.push({kind:'init',sessionId:'phone-native'})},submit:async(_requestId,text)=>{submissions.push(text);await new Promise<void>((resolve,reject)=>pending.push({resolve,reject}))}},async close(){runtimeReplies.get(project.path)!.finish(true);events.end()}}
    }
    const receipt={inputs:[]} as {permission?:boolean;answers?:unknown;inputs:string[]};seen.set(project.path,receipt)
    let finish!:()=>void;const gate=new Promise<void>(r=>{finish=r})
    terminalFinishes.set(project.path,finish)
    return {async *dispatch(){
      yield {kind:'init' as const,sessionId:'phone-native'}
      if(project.path.endsWith('terminal')){if(ctx.resumeSessionId)await gate;yield {kind:'text' as const,text:'完成当前轮'};yield {kind:'result' as const,sessionId:'phone-native',numTurns:1,durationMs:1};return}
      receipt.permission=await ctx.requestPermission!({tool:'Bash',description:'Remove the one scratch probe file'})
      receipt.answers=await ctx.requestUserInput!({questions:[{id:'format',header:'格式',question:'保存成哪种？',options:[{label:'文字',description:'纯文本'}],allowOther:true}]})
      yield {kind:'text' as const,text:'已保存'};await gate
    },async steer(text){receipt.inputs.push(text)},async close(){finish()}}
  }},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  workbench=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>'owner',matters})
  const service=makeMattersService({store:matters,workbench})
  panel=makeSettingsPanel({stateDir:root,ownerChatId:()=>'owner',chatPrefs:{get:()=>({}),set:()=>({})},getUserName:()=>null,setUserName:async()=>{},log:()=>{},matters:{...service,say:(id,text,input)=>service.say(id,text,'phone',input),seenOnPhone:id=>{matters.bind(id,'phone','pwa')}}})
  const {port}=await panel.start(0);base=`http://127.0.0.1:${port}`;token=panel.issueToken()
})
// 用 removeTempDir 而不是裸 rmSync:Windows 上 daemon 刚关、句柄还没落地时
// rm 会抛 EBUSY,而这里是 afterEach ⇒ 抛出来就把整块 9 条用例判红。helper 会
// 重试 20 次再降级成一条 warning(仓库约定,见 AGENTS.md 的临时目录那条)。
afterEach(async()=>{await panel?.stop();await workbench?.shutdown();db?.close();removeTempDir(root)})
function create(name:string){const path=join(root,name);mkdirSync(path);return workbench.create({path,providerId:'claude',text:name})}
function request(path:string,body?:unknown,auth=token){return fetch(base+path+(path.includes('?')?'&':'?')+'t='+encodeURIComponent(auth),body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})}
async function ready(id:string){await expect.poll(()=>workbench.detail(id).permissions.length).toBe(1);return workbench.detail(id)}

describe('phone task controls keep the existing execution boundary',()=>{
  it('projects only this task requests and preserves original task/run/request identities',async()=>{
    const task=create('one'),live=await ready(task.id)
    const detail=await (await request('/m/api/matter?id='+task.id)).json()
    expect(detail.runId).toBe(live.runId);expect(detail.permissions).toEqual(live.permissions);expect(detail.questions).toEqual([]);expect(detail.artifacts).toEqual([])
    expect(detail).not.toHaveProperty('execution');expect(detail).not.toHaveProperty('storagePath')
  })
  it('allows one decision on the exact current task and run, rejecting cross-task, stale, duplicate and unauthenticated requests',async()=>{
    const a=create('a'),b=create('b'),one=await ready(a.id),two=await ready(b.id)
    const body={id:a.id,runId:one.runId,requestId:one.permissions[0]!.id,decision:'allow'}
    expect((await request('/m/api/matter/permission',body,'wrong')).status).toBe(401)
    expect((await request('/m/api/matter/permission',{...body,id:b.id,runId:two.runId})).status).toBe(409)
    expect((await request('/m/api/matter/permission',{...body,runId:randomUUID()})).status).toBe(409)
    expect((await request('/m/api/matter/permission',body)).status).toBe(200)
    expect((await request('/m/api/matter/permission',body)).status).toBe(409)
    await expect.poll(()=>seen.get(a.path)?.permission).toBe(true)
    expect(workbench.detail(b.id).permissions).toHaveLength(1)
    await workbench.cancel(b.id)
    expect((await request('/m/api/matter/permission',{id:b.id,runId:two.runId,requestId:two.permissions[0]!.id,decision:'deny'})).status).toBe(409)
  })
  it('validates answers against the original current question and never approves a permission through the answer endpoint',async()=>{
    const task=create('question'),live=await ready(task.id),permission=live.permissions[0]!
    expect((await request('/m/api/matter/answer',{id:task.id,runId:live.runId,requestId:permission.id,answers:null})).status).toBe(409)
    workbench.resolvePermission(task.id,permission.id,'deny')
    await expect.poll(()=>workbench.detail(task.id).questions.length).toBe(1)
    const question=workbench.detail(task.id).questions[0]!,body={id:task.id,runId:live.runId,requestId:question.id,answers:{format:['文字']}}
    expect((await request('/m/api/matter/answer',{...body,answers:{wrong:['文字']}})).status).toBe(400)
    expect((await request('/m/api/matter/answer',body)).status).toBe(200)
    expect((await request('/m/api/matter/answer',body)).status).toBe(409)
    await expect.poll(()=>seen.get(task.path)?.answers).toEqual({format:['文字']})
    expect(seen.get(task.path)?.permission).toBe(false)
  })
  it('delivers live-run supplements once with stable request identity, refusing stale runs',async()=>{
    const task=create('input'),live=await ready(task.id),body={id:task.id,runId:live.runId,requestId:randomUUID(),text:'补充条件'}
    expect((await request('/m/api/matter/say',{...body,runId:randomUUID()})).status).toBe(409)
    expect((await request('/m/api/matter/say',body)).status).toBe(200)
    expect((await request('/m/api/matter/say',body)).status).toBe(200)
    expect(seen.get(task.path)?.inputs).toEqual(['补充条件'])
    expect(matters.list({kind:'task'})).toHaveLength(1)
  })
  it('continues the same finished task idempotently and preserves the native recovery confirmation gate',async()=>{
    const task=create('terminal')
    await expect.poll(()=>workbench.detail(task.id).task.status).toBe('completed')
    const firstFinish=terminalFinishes.get(task.path)
    const body={id:task.id,requestId:randomUUID(),text:'继续这一件事'}
    expect((await request('/m/api/matter/say',body)).status).toBe(200)
    expect(matters.get(task.id)?.status).toBe('open')
    await expect.poll(()=>terminalFinishes.get(task.path)!==firstFinish).toBe(true)
    terminalFinishes.get(task.path)!()
    await expect.poll(()=>workbench.detail(task.id).task.status).toBe('completed')
    const replay=await (await request('/m/api/matter/say',body)).json()
    expect(matters.get(task.id)?.status).toBe('done')
    expect(replay.result.input).toMatchObject({id:body.requestId,status:'delivered'})
    workbench.setArchived(task.id,true)
    expect((await request('/m/api/matter/say',body)).status).toBe(200)
    expect(matters.get(task.id)?.status).toBe('archived')
    workbench.setArchived(task.id,false)
    expect(workbench.detail(task.id).events.filter(e=>e.kind==='user'&&e.text===body.text)).toHaveLength(1)
    expect(matters.list({kind:'task'})).toHaveLength(1)
    // A completed task whose native resume identity is gone must use the same
    // desktop recovery confirmation; the phone cannot silently restart it.
    store.session(task.id,null)
    const blocked=await request('/m/api/matter/say',{...body,requestId:randomUUID(),text:'身份丢失后的补充'})
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({error:'restart_confirmation_required'})
    expect(workbench.detail(task.id).task.status).toBe('completed')
  })
  it.each(['held','delivered'] as const)('exposes asynchronous native input receipts through sending to %s without resubmitting',async outcome=>{
    const task=create('async-runtime')
    await expect.poll(()=>workbench.detail(task.id).inputMode).toBe('send')
    const live=workbench.detail(task.id),body={id:task.id,runId:live.runId,requestId:randomUUID(),text:'等待原生执行者确认'}
    const sent=await (await request('/m/api/matter/say',body)).json()
    expect(sent.result.input.status).toBe('sending')
    const initial=await (await request('/m/api/matter?id='+task.id)).json()
    expect(initial.inputs).toEqual([{id:body.requestId,taskId:task.id,runId:live.runId,text:body.text,status:'sending'}])
    runtimeReplies.get(task.path)!.finish(outcome==='held')
    await expect.poll(()=>workbench.detail(task.id).inputs[0]?.status).toBe(outcome)
    const settled=await (await request('/m/api/matter?id='+task.id)).json()
    expect(settled.inputs[0]).toMatchObject({id:body.requestId,status:outcome,text:body.text})
    expect(settled.inputs[0]).not.toHaveProperty('error');expect(settled.inputs[0]).not.toHaveProperty('execution')
    const retry=await (await request('/m/api/matter/say',body)).json()
    expect(retry.result.input.status).toBe(outcome)
    expect(runtimeReplies.get(task.path)!.submissions).toEqual([body.text])
  })
  it('serves immutable chunks for a file larger than a tunnel frame, refusing wrong owner/hash/ranges',async()=>{
    const task=create('file'),other=create('other');await ready(task.id);await ready(other.id)
    const bytes=Buffer.alloc(700_123);for(let i=0;i<bytes.length;i++)bytes[i]=i%251
    saveArtifactSnapshot(store,task.id,{name:'report.txt',mime:'text/plain',bytes},root)
    const artifact=store.artifacts(task.id)[0]!,url='/m/api/matter/artifact?id='+task.id+'&artifactId='+artifact.id+'&sha256='+artifact.sha256
    expect((await request(url+'&offset=0','wrong','wrong')).status).toBe(401)
    expect((await request(url.replace(task.id,other.id)+'&offset=0')).status).toBe(404)
    expect((await request(url.replace(artifact.sha256,'0'.repeat(64))+'&offset=0')).status).toBe(409)
    expect((await request(url+'&offset=-1')).status).toBe(400)
    expect((await request(url+'&offset=0&length=999999')).status).toBe(400)
    const chunks:Buffer[]=[]
    for(let offset=0;offset<bytes.length;offset+=128*1024){
      const response=await request(url+'&offset='+offset),text=await response.text()
      expect(response.status).toBe(200)
      // Includes headroom for JSON + encryption's second base64 layer.
      expect(Buffer.byteLength(text)*4/3+1024).toBeLessThan(512*1024)
      const part=JSON.parse(text)
      expect(part).toMatchObject({ok:true,taskId:task.id,artifactId:artifact.id,sha256:artifact.sha256,offset,size:bytes.length})
      const decoded=Buffer.from(part.contentBase64,'base64');expect(decoded.length).toBeLessThanOrEqual(128*1024);chunks.push(decoded)
    }
    expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(artifact.sha256)
    expect(Buffer.concat(chunks)).toEqual(bytes)
  })
  it('completes decisions and a large file through the encrypted relay cap with a paired device, then rejects its revocation',async()=>{
    const task=create('tunnel'),live=await ready(task.id)
    const paired=await (await request('/set/api/pair',{})).json() as {device_token:string}
    const bytes=Buffer.alloc(710_123,73)
    saveArtifactSnapshot(store,task.id,{name:'large.txt',mime:'text/plain',bytes},root)
    const artifact=store.artifacts(task.id)[0]!,hub=makeTunnelHub(),received:string[]=[],frames:string[]=[]
    let incoming:((ev:{data?:unknown})=>void)|undefined
    const socket:TunnelWS={readyState:1,send(raw){frames.push(raw);hub.onDaemonFrame('test-daemon',raw)},close(){},addEventListener(type,handler){if(type==='message')incoming=handler}}
    hub.registerDaemon('test-daemon',{readyState:1,send(raw){incoming?.({data:raw})},close(){}})
    const phone=hub.attachPhone('test-daemon',{readyState:1,send(raw){received.push(raw)},close(){}})
    const client=makeTunnelClient({daemonId:'test-daemon',knownDeviceTokens:()=>[paired.device_token],handleRequest:panel.handleRequest,connect:()=>socket,log:()=>{}})
    client.start()
    try{
      const keys=await generateTunnelKeypair()
      hub.onPhoneFrame(phone.streamId!,JSON.stringify({hs:await exportPublicKeyB64(keys.publicKey)}))
      await expect.poll(()=>received.length).toBe(1)
      const key=await deriveSharedKey(keys.privateKey,await importPublicKeyB64(JSON.parse(received.shift()!).hs),new TextEncoder().encode(paired.device_token))
      const remote=async(path:string,body?:unknown)=>{
        hub.onPhoneFrame(phone.streamId!,JSON.stringify(await sealFrame(key,new TextEncoder().encode(JSON.stringify({path,method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)}),rid:randomUUID()})))))
        await expect.poll(()=>received.length).toBe(1)
        const decoded=JSON.parse(new TextDecoder().decode(await openFrame(key,JSON.parse(received.shift()!))))
        return {status:decoded.status,body:JSON.parse(decoded.body)}
      }
      expect((await remote('/m/api/matter/permission',{id:task.id,runId:live.runId,requestId:live.permissions[0]!.id,decision:'allow'})).status).toBe(200)
      await expect.poll(()=>workbench.detail(task.id).questions.length).toBe(1)
      const question=workbench.detail(task.id).questions[0]!
      expect((await remote('/m/api/matter/answer',{id:task.id,runId:live.runId,requestId:question.id,answers:{format:['文字']}})).status).toBe(200)
      const parts:Buffer[]=[]
      for(let offset=0;offset<bytes.length;offset+=128*1024){
        const part=await remote('/m/api/matter/artifact?id='+task.id+'&artifactId='+artifact.id+'&sha256='+artifact.sha256+'&offset='+offset)
        expect(part.status).toBe(200);parts.push(Buffer.from(part.body.contentBase64,'base64'))
      }
      expect(Buffer.concat(parts)).toEqual(bytes)
      expect(frames.every(frame=>Buffer.byteLength(frame)<512*1024)).toBe(true)
      // A large native reply must return an explicit error through the real
      // relay cap instead of silently dropping an oversized encrypted frame.
      for(let i=0;i<4;i++)store.addEvent(task.id,'text','很长的完整内容'.repeat(6_000))
      const oversized=await remote('/m/api/matter?id='+task.id)
      expect(oversized.status).toBe(413)
      expect(oversized.body).toEqual({ok:false,error:'detail_too_large'})
      await panel.apply({op:'forget_devices'})
      expect((await remote('/m/api/matter/answer',{id:task.id,runId:live.runId,requestId:question.id,answers:null})).status).toBe(401)
    }finally{client.stop();hub.dropPhone(phone.streamId!)}
  })
})
