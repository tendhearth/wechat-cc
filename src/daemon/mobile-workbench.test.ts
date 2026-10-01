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
    const spy=vi.fn(()=>new Promise<never>(()=>{}))
    const slowActions=actions({preview:spy})
    const slow=await mobileSessionContinueRoute(slowActions,url(`?key=${KEY}`),new Request(url(`?key=${KEY}`)),undefined,{budgetMs:5})
    expect(slow!.status).toBe(503);expect(await slow!.json()).toEqual({ok:false,error:'unavailable'})
    // 上面那次扫描仍悬着,占着一个名额;cap=1 ⇒ 同一 actions 再来立刻 busy
    spy.mockClear()
    const again=await mobileSessionContinueRoute(slowActions,url(`?key=${KEY}`),new Request(url(`?key=${KEY}`)),undefined,{budgetMs:5,maxInflight:1})
    expect(again!.status).toBe(503);expect(spy).not.toHaveBeenCalled()
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
