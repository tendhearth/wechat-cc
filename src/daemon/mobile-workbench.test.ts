import {describe,expect,it,vi} from 'vitest'
import {mobileMatterError,mobileSessionContinueRoute,mobileWorkbenchRoute} from './mobile-workbench'
import {entryFailureKind} from '../core/workbench/task-entry'

describe('phone entry rejection wire contract',()=>{
  it.each([
    ['invalid_entry',400,'rejected'],['invalid_request_id',400,'rejected'],
    ['invalid_text',400,'rejected'],['invalid_title',400,'rejected'],['invalid_context',400,'rejected'],
    ['invalid_target',400,'rejected'],['invalid_execution',400,'rejected'],['invalid_provider',400,'rejected'],
    ['invalid_attachment',400,'rejected'],['invalid_path',400,'rejected'],
    ['api_task_input_invalid',400,'rejected'],['api_task_attachment_invalid',400,'rejected'],
    ['api_task_attachment_unsupported',422,'rejected'],['unattended_ack_required',422,'rejected'],
    ['workbench_attachments_unsupported',422,'rejected'],['workbench_execution_unsupported',422,'rejected'],
    ['project_stale',409,'unknown'],['attachment_changed',409,'unknown'],['entry_expired',410,'expired'],
    ['creation_conflict',409,'unknown'],['unavailable_provider',503,'unknown'],['provider_quota_exhausted',503,'unknown'],
  ] as const)('maps create %s to HTTP %s and a %s client outcome',async(code,status,kind)=>{
    const url=new URL('http://phone.test/m/api/matter/create')
    const req=new Request(url,{method:'POST',body:JSON.stringify({requestId:crypto.randomUUID(),text:'要求',target:{kind:'managed'}})})
    const response=await mobileWorkbenchRoute(undefined,url,req,{
      entryOptions:()=>({status:'ready',defaultProviderId:null,providers:[],projects:[]}),
      createEntry:()=>{throw Error(code)},entryReceipt:()=>null,
    })
    expect(response?.status).toBe(status)
    expect(await response!.json()).toEqual({ok:false,error:code})
    expect(entryFailureKind(code,{surface:'phone',method:'POST',status:response!.status})).toBe(kind)
    expect(entryFailureKind(code,{surface:'phone',method:'GET',status:response!.status})).toBe('unknown')
  })

  it('returns invalid uploaded content as HTTP 400 without making it an entry identity rejection',async()=>{
    const url=new URL('http://phone.test/m/api/attachment/chunk')
    const req=new Request(url,{method:'POST',body:JSON.stringify({id:crypto.randomUUID(),draftId:crypto.randomUUID(),name:'bad.png',mime:'image/png',size:1,sha256:'a'.repeat(64),offset:0,contentBase64:'eA=='})})
    const response=await mobileWorkbenchRoute(undefined,url,req,undefined,{
      chunk:()=>{throw Error('upload_invalid_content')},status:()=>{throw Error('unexpected')},discard:()=>{},
    })
    expect(response?.status).toBe(400)
    expect(await response!.json()).toEqual({ok:false,error:'upload_invalid_content'})
    expect(entryFailureKind('upload_invalid_content',{surface:'phone',method:'POST',status:400})).toBe('unknown')
  })
})

describe('手机「交给另一位继续」路由(POST /m/api/matter/handoff,spec continue-sessions §7-3)',()=>{
  const url=new URL('http://phone.test/m/api/matter/handoff')
  const REQ='5a7e0000-0000-4000-8000-000000000001'
  const post=(body:unknown)=>new Request(url,{method:'POST',body:typeof body==='string'?body:JSON.stringify(body)})
  it('成功 ⇒ {ok,matterId,created};按原样把 id / requestId / providerId 交给 handoff,surface = phone',async()=>{
    const handoff=vi.fn(async()=>({matterId:'deadbeef',created:true}))
    const r=await mobileWorkbenchRoute({handoff},url,post({id:'cafebabe',requestId:REQ,providerId:'codex'}))
    expect(r?.status).toBe(200)
    expect(await r!.json()).toEqual({ok:true,matterId:'deadbeef',created:true})
    expect(handoff).toHaveBeenCalledWith('cafebabe',{requestId:REQ,providerId:'codex'},'phone')
  })
  it('GET ⇒ 405;没接 ⇒ 503 unavailable;坏正文 / 多余键 / 坏 id ⇒ 400',async()=>{
    expect((await mobileWorkbenchRoute({},url,new Request(url)))?.status).toBe(405)
    const unwired=await mobileWorkbenchRoute({},url,post({id:'cafebabe',requestId:REQ,providerId:'codex'}))
    expect(unwired?.status).toBe(503);expect(await unwired!.json()).toEqual({ok:false,error:'unavailable'})
    const handoff=vi.fn()
    for(const body of ['{',{id:'cafebabe',requestId:REQ,providerId:'codex',extra:1},{id:'nope',requestId:REQ,providerId:'codex'},{id:'cafebabe',requestId:'x',providerId:'codex'},{id:'cafebabe',requestId:REQ}]){
      expect((await mobileWorkbenchRoute({handoff},url,post(body)))?.status).toBe(400)
    }
    expect(handoff).not.toHaveBeenCalled()
  })
  it.each([
    ['quota_handoff_not_needed',409],['quota_handoff_changed',409],['quota_handoff_unavailable',503],['workbench_busy',409],
    ['creation_conflict',409],['invalid_entry_owner',403],['matter_not_found',404],['provider_quota_exhausted',503],['native_session_busy',409],
  ] as const)('%s ⇒ HTTP %s,错误码原样',async(code,status)=>{
    const r=await mobileWorkbenchRoute({handoff:async()=>{throw Error(code)}},url,post({id:'cafebabe',requestId:REQ,providerId:'codex'}))
    expect(r?.status).toBe(status);expect(await r!.json()).toEqual({ok:false,error:code})
  })
})

describe('手机「接着做」路由(/m/api/session/continue)',()=>{
  const KEY='eyJ2IjoxfQ'
  const url=(q='')=>new URL(`http://phone.test/m/api/session/continue${q}`)
  const ready={state:'ready' as const,providerId:'claude' as const,project:'proj',mode:'native_resume' as const,taskId:null}
  const actions=(o:{preview?:()=>Promise<unknown>;adopt?:()=>Promise<unknown>}={})=>({
    preview:(o.preview??(async()=>ready)) as never,
    adopt:(o.adopt??(async()=>({taskId:'deadbeef',created:true}))) as never,
  })
  const post=(body:unknown)=>new Request(url(),{method:'POST',body:typeof body==='string'?body:JSON.stringify(body)})
  it('不是这条路径 ⇒ null;方法不对 ⇒ 405;没接 ⇒ 503 sessions_not_wired',async()=>{
    const other=new URL('http://phone.test/m/api/session')
    expect(await mobileSessionContinueRoute(actions(),other,new Request(other))).toBeNull()
    expect((await mobileSessionContinueRoute(actions(),url(),new Request(url(),{method:'PUT'})))!.status).toBe(405)
    const r=await mobileSessionContinueRoute(undefined,url(`?key=${KEY}`),new Request(url(`?key=${KEY}`)))
    expect(r!.status).toBe(503);expect(await r!.json()).toEqual({ok:false,error:'sessions_not_wired'})
  })
  it('GET:key 缺 / 重复 / 超长 ⇒ 400;好的 ⇒ 预览(taskId 对外叫 matterId,providerId 叫 provider)',async()=>{
    for(const q of ['','?key=a&key=b',`?key=${'a'.repeat(2049)}`]){
      const r=await mobileSessionContinueRoute(actions(),url(q),new Request(url(q)))
      expect(r!.status,q).toBe(400);expect(await r!.json()).toEqual({ok:false,error:'invalid'})
    }
    const r=await mobileSessionContinueRoute(actions({preview:async()=>({...ready,state:'managed',mode:null,taskId:'deadbeef'})}),url(`?key=${KEY}`),new Request(url(`?key=${KEY}`)))
    expect(await r!.json()).toEqual({ok:true,state:'managed',provider:'claude',project:'proj',mode:null,matterId:'deadbeef'})
  })
  it('GET 回包形状固定:不带路径 / 原生 id(D13),即使核心多给了字段',async()=>{
    const leaky={...ready,cwd:'/Users/x/secret/proj',nativeId:'native-123',sourceFingerprint:'fp'}
    const r=await mobileSessionContinueRoute(actions({preview:async()=>leaky}),url(`?key=${KEY}`),new Request(url(`?key=${KEY}`)))
    const text=await r!.text()
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['matterId','mode','ok','project','provider','state'])
    expect(text).not.toContain('/Users');expect(text).not.toContain('native-123')
  })
  it('R9 GET 预览:未知读错 ⇒ 503 unavailable;超 10 秒预算 ⇒ 503;在途满 ⇒ 503 且不再调预览',async()=>{
    const boom=await mobileSessionContinueRoute(actions({preview:async()=>{throw new Error('ENOENT weird')}}),url(`?key=${KEY}`),new Request(url(`?key=${KEY}`)))
    expect(boom!.status).toBe(503);expect(await boom!.json()).toEqual({ok:false,error:'unavailable'})
    const unsupported=await mobileSessionContinueRoute(actions({preview:async()=>{throw new Error('native_history_unsupported')}}),url(`?key=${KEY}`),new Request(url(`?key=${KEY}`)))
    expect(unsupported!.status).toBe(404)
  })
  it('R9 修正:超时放名额;同键重试合并;迟到结果丢弃',async()=>{
    const calls:string[]=[],late:Array<(v:unknown)=>void>=[]
    const a=actions({preview:((key:string)=>{calls.push(key);return key==='hung'||key==='late'?new Promise(r=>late.push(r)):Promise.resolve(ready)}) as never})
    const get=(k:string,o={budgetMs:5,maxInflight:1})=>mobileSessionContinueRoute(a,url(`?key=${k}`),new Request(url(`?key=${k}`)),undefined,o)
    // 同键在途:两个并发请求只扫一次
    const [r1,r2]=await Promise.all([get('hung',{budgetMs:5,maxInflight:1}),get('hung',{budgetMs:5,maxInflight:1})])
    expect([r1!.status,r2!.status]).toEqual([503,503]);expect(calls.filter(k=>k==='hung')).toHaveLength(1)
    // 挂住的那次超时后名额已放:另一个键(cap=1)立刻成功
    const ok=await get('other');expect(ok!.status).toBe(200)
    // 迟到结果:超时后才落定,不送达也不缓存(再来一次是新的扫描)
    const l=await get('late');expect(l!.status).toBe(503)
    late[late.length-1]!(ready)
    await new Promise(r=>setTimeout(r,0))
    const again=await get('late');expect(again!.status).toBe(503);expect(calls.filter(k=>k==='late')).toHaveLength(2)
  })
  it('超时后同键重试:并进还挂着的那次扫描,不另起(挂住的扫描不会越堆越多)',async()=>{
    const calls:string[]=[],hang:Array<(v:unknown)=>void>=[]
    const a=actions({preview:((key:string)=>{calls.push(key);return new Promise(r=>hang.push(r))}) as never})
    const get=()=>mobileSessionContinueRoute(a,url('?key=stuck'),new Request(url('?key=stuck')),undefined,{budgetMs:5,maxInflight:4})
    for(let i=0;i<3;i++)expect((await get())!.status).toBe(503)
    expect(calls).toHaveLength(1)
    hang[0]!(ready);await new Promise(r=>setTimeout(r,0))
    expect((await get())!.status).toBe(503);expect(calls).toHaveLength(2)
  })
  it('名额满:不同键都还在预算内 ⇒ 新键 503,不起扫描',async()=>{
    const calls:string[]=[],hang:Array<(v:unknown)=>void>=[]
    const a=actions({preview:((key:string)=>{calls.push(key);return new Promise(r=>hang.push(r))}) as never})
    const first=mobileSessionContinueRoute(a,url('?key=k1'),new Request(url('?key=k1')),undefined,{budgetMs:1000,maxInflight:1})
    await new Promise(r=>setTimeout(r,0))
    const second=await mobileSessionContinueRoute(a,url('?key=k2'),new Request(url('?key=k2')),undefined,{budgetMs:1000,maxInflight:1})
    expect(second!.status).toBe(503);expect(calls).toEqual(['k1'])
    hang[0]!(ready);expect((await first)!.status).toBe(200)
  })
  it('POST:只认 {key};坏 JSON / 多余键 ⇒ 400;成功 ⇒ matterId + created,并登记手机露面',async()=>{
    const seen=vi.fn()
    expect((await mobileSessionContinueRoute(actions(),url(),post({key:KEY,x:1}),seen))!.status).toBe(400)
    expect((await mobileSessionContinueRoute(actions(),url(),post('{'),seen))!.status).toBe(400)
    expect((await mobileSessionContinueRoute(actions(),url(),post({key:5}),seen))!.status).toBe(400)
    expect(seen).not.toHaveBeenCalled()
    const r=await mobileSessionContinueRoute(actions(),url(),post({key:KEY}),seen)
    expect(await r!.json()).toEqual({ok:true,matterId:'deadbeef',created:true});expect(seen).toHaveBeenCalledWith('deadbeef')
  })
  it.each([
    ['native_session_busy',409,'native_session_busy'],['native_folder_busy',409,'native_folder_busy'],
    ['native_history_changed',409,'native_history_changed'],['native_history_empty',409,'native_history_empty'],
    ['invalid_path',400,'invalid_path'],['unavailable_provider',503,'unavailable_provider'],
    ['provider_quota_exhausted',503,'provider_quota_exhausted'],['native_history_unsupported',404,'unsupported'],
    ['invalid_native_history_key',400,'invalid'],['matters_not_wired',503,'unavailable'],
  ] as const)('adopt 抛 %s ⇒ HTTP %s %s',async(code,status,error)=>{
    const r=await mobileSessionContinueRoute(actions({adopt:async()=>{throw new Error(code)}}),url(),post({key:KEY}))
    expect(r!.status).toBe(status);expect(await r!.json()).toEqual({ok:false,error})
  })
  it('第一句 matter/say 抛会话忙 / 文件夹忙 / 会话变了 ⇒ 409 原码(以前落成 500)',async()=>{
    for(const code of ['native_session_busy','native_folder_busy','native_history_changed']){
      const r=mobileMatterError(new Error(code));expect(r.status,code).toBe(409);expect(await r.json()).toEqual({ok:false,error:code})
    }
  })
})

describe('phone stop (2026-10-06)',()=>{
  const RUN='33333333-3333-4333-8333-333333333333'
  const post=(body:unknown)=>{const url=new URL('http://phone.test/m/api/matter/stop');return mobileWorkbenchRoute({stop},url,new Request(url,{method:'POST',body:JSON.stringify(body)}))}
  const stop=vi.fn(async(_id:string,_runId:string)=>{})
  it('stops exactly the run the phone saw',async()=>{
    const r=await post({id:'deadbeef',runId:RUN.toUpperCase()})
    expect(r?.status).toBe(200)
    expect(stop).toHaveBeenCalledWith('deadbeef',RUN)
  })
  it('rejects malformed or extra fields before touching the task',async()=>{
    stop.mockClear()
    for(const b of [{id:'deadbeef'},{id:'x',runId:RUN},{id:'deadbeef',runId:'nope'},{id:'deadbeef',runId:RUN,force:true}])expect((await post(b))?.status).toBe(400)
    expect(stop).not.toHaveBeenCalled()
  })
  it('a run that already changed is reported, not stopped',async()=>{
    const url=new URL('http://phone.test/m/api/matter/stop')
    const r=await mobileWorkbenchRoute({stop:async()=>{throw Error('input_stale')}},url,new Request(url,{method:'POST',body:JSON.stringify({id:'deadbeef',runId:RUN})}))
    expect(await r!.json()).toEqual({ok:false,error:'input_stale'})
    expect(r!.status).toBe(409)
  })
})
