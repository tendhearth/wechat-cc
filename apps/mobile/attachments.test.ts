import {describe,expect,it,vi} from 'vitest'
import {createHash,webcrypto} from 'node:crypto'
import {readMobileSource} from './sources'

const DRAFT='94455eae-7cb5-4b47-ae13-e769fba0e743'
const TASK='deadbeef',BLOCK=128*1024
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex')
const reply=(body:unknown,status=200)=>({status,json:async()=>body})
type Api=(path:string,opts?:{body?:string})=>Promise<ReturnType<typeof reply>>
type Item={id:string;draftId:string;taskId:string|null;name:string;mime:string;size:number;sha256:string;nextOffset:number;status:string;frozen?:boolean}
type Control={select:(files:File[])=>Promise<void>;resume:(files:File[])=>Promise<void>;remove:(id:string)=>Promise<void>;readyIds:()=>string[];signature:()=>string;dispose:()=>void;mount:(root:Root)=>void;items:()=>Item[];isReady:()=>boolean;freeze:(ids?:string[])=>void;acknowledge:(ids:string[])=>void}
type Root={innerHTML:string;addEventListener:ReturnType<typeof vi.fn>;removeEventListener:ReturnType<typeof vi.fn>}
function root():Root{return{innerHTML:'',addEventListener:vi.fn(),removeEventListener:vi.fn()}}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve}}
function hashFunction(cryptoImpl:unknown=webcrypto,timer:unknown=setTimeout){
  const source=readMobileSource('workbench.js'),hashSource=source.slice(source.indexOf('async function mSha256('),source.indexOf('async function mArtifact('))
  return new Function('crypto','setTimeout',hashSource+'\nreturn mSha256')(cryptoImpl,timer) as (bytes:Uint8Array)=>Promise<string>
}
function load(api:Api,storage=new Map<string,string>()){
  const revokeObjectURL=vi.fn(),createObjectURL=vi.fn(()=>`blob:preview-${crypto.randomUUID()}`)
  const mSha256=hashFunction()
  const env={api,REMOTE:{id:'phone-test'},location:{host:'localhost'},crypto:webcrypto,btoa,
    localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},
    mUuid:()=>crypto.randomUUID(),mSha256,esc:(v:unknown)=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),
    URL:{createObjectURL,revokeObjectURL},setTimeout,clearTimeout,
  }
  const create=new Function(...Object.keys(env),readMobileSource('attachments.js')+'\nreturn createPhoneAttachments')(...Object.values(env)) as (options:{draftId:string;taskId?:string;onChange?:()=>void})=>Control
  return{create,storage,revokeObjectURL,createObjectURL}
}
function server(){
  const chunks:any[]=[],uploads=new Map<string,any>()
  const api=vi.fn<Api>(async(path,opts)=>{
    if(path.includes('/upload?')){const id=new URL('https://cc.invalid'+path).searchParams.get('id')!;return uploads.has(id)?reply({ok:true,...uploads.get(id)}):reply({ok:false,error:'not_found'},404)}
    const body=JSON.parse(opts!.body!)
    if(path.endsWith('/discard')){uploads.delete(body.id);return reply({ok:true})}
    chunks.push(body)
    const nextOffset=body.offset+Buffer.from(body.contentBase64,'base64').length
    const state={id:body.id,draftId:body.draftId,taskId:body.taskId??null,size:body.size,sha256:body.sha256,nextOffset,status:nextOffset===body.size?'ready':'uploading',
      ...(nextOffset===body.size?{attachment:{id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}}:{})}
    uploads.set(body.id,state);return reply({ok:true,...state})
  })
  return{api,chunks,uploads}
}

describe('phone attachment controls',()=>{
  it('uploads dense bytes in ordered 128 KiB chunks with one identity and stores metadata only',async()=>{
    const data=Uint8Array.from({length:BLOCK*3+53},(_,i)=>i%256),backend=server(),env=load(backend.api),control=env.create({draftId:DRAFT,taskId:TASK})
    const view=root();control.mount(view)
    await control.select([new File([data],'参考.png',{type:'image/png'})])
    expect(backend.chunks.map(c=>Buffer.from(c.contentBase64,'base64').length)).toEqual([BLOCK,BLOCK,BLOCK,53])
    expect(backend.chunks.map(c=>c.offset)).toEqual([0,BLOCK,BLOCK*2,BLOCK*3])
    expect(new Set(backend.chunks.map(c=>c.id)).size).toBe(1)
    expect(Buffer.concat(backend.chunks.map(c=>Buffer.from(c.contentBase64,'base64')))).toEqual(Buffer.from(data))
    expect(backend.chunks[0]).toMatchObject({draftId:DRAFT,taskId:TASK,sha256:hash(data),size:data.length})
    expect(control.readyIds()).toEqual([backend.chunks[0].id]);expect(control.isReady()).toBe(true)
    expect(control.signature()).toBe(JSON.stringify([[backend.chunks[0].id,hash(data),data.length]]))
    const saved=Array.from(env.storage.values()).join('')
    expect(saved).not.toMatch(/contentBase64|arrayBuffer|blob:preview|"file"/)
    expect(view.innerHTML).toContain('已准备好')
  })

  it('keeps submission unavailable until the final ready acknowledgement',async()=>{
    const waiting=deferred<ReturnType<typeof reply>>(),backend=server()
    const api:Api=async(path,opts)=>path.endsWith('/chunk')?(await backend.api(path,opts),waiting.promise):backend.api(path,opts)
    const control=load(api).create({draftId:DRAFT})
    const uploading=control.select([new File(['photo'],'a.png',{type:'image/png'})])
    await vi.waitFor(()=>expect(backend.chunks).toHaveLength(1))
    expect(control.readyIds()).toEqual([]);expect(control.isReady()).toBe(false)
    waiting.resolve(reply({ok:true,...backend.uploads.values().next().value}));await uploading
    expect(control.readyIds()).toHaveLength(1)
  })

  it('after refresh requires the same reselected file and queries offset before sending the rest',async()=>{
    const data=new Uint8Array(BLOCK+7).fill(17),file=new File([data],'picture.png',{type:'image/png'}),backend=server()
    let broken=true
    const api=vi.fn<Api>(async(path,opts)=>{
      if(path.endsWith('/chunk')&&JSON.parse(opts!.body!).offset===BLOCK&&broken)throw Error('offline')
      return backend.api(path,opts)
    })
    const first=load(api),control=first.create({draftId:DRAFT,taskId:TASK});await control.select([file])
    const id=control.items()[0]!.id;control.dispose()
    const refreshed=load(api,first.storage).create({draftId:DRAFT,taskId:TASK})
    expect(refreshed.items()[0]!.status).toBe('needs_file')
    expect(api.mock.calls.some(([p])=>p.includes('/upload?'))).toBe(false)
    broken=false;await refreshed.resume([file])
    expect(api.mock.calls.find(([p])=>p.includes('/upload?'))![0]).toBe('/m/api/attachment/upload?id='+id+'&draftId='+DRAFT)
    expect(backend.chunks.map(c=>c.offset)).toEqual([0,BLOCK])
    expect(refreshed.readyIds()).toEqual([id])
  })

  it('rejects a same-name, same-size replacement with a different hash without querying or uploading',async()=>{
    const api=vi.fn<Api>(async()=>{throw Error('offline')}),first=load(api),control=first.create({draftId:DRAFT})
    await control.select([new File(['abc'],'same.txt',{type:'text/plain'})]);control.dispose()
    const refreshed=load(api,first.storage).create({draftId:DRAFT}),before=api.mock.calls.length
    await expect(refreshed.resume([new File(['xyz'],'same.txt',{type:'text/plain'})])).rejects.toThrow('reselect_mismatch')
    expect(api.mock.calls).toHaveLength(before);expect(refreshed.readyIds()).toEqual([])
  })

  it.each(['id','draftId','taskId','size','sha256','attachment'])('refuses a response with mismatched %s',async field=>{
    const backend=server()
    const api:Api=async(path,opts)=>{
      const r=await backend.api(path,opts),body:any=await r.json()
      if(field==='attachment')body.attachment={...body.attachment,name:'other.png'}
      else body[field]=field==='size'?body.size+1:'wrong'
      return reply(body)
    }
    const control=load(api).create({draftId:DRAFT,taskId:TASK})
    await control.select([new File(['x'],'a.png',{type:'image/png'})])
    expect(control.readyIds()).toEqual([]);expect(control.items()[0]!.status).toBe('paused')
  })

  it('cancellation invalidates a delayed chunk response, revokes preview, and reselecting allocates a fresh ID',async()=>{
    const waiting=deferred<ReturnType<typeof reply>>(),backend=server();let delay=true
    const api:Api=async(path,opts)=>{const r=await backend.api(path,opts);return path.endsWith('/chunk')&&delay?waiting.promise:r}
    const env=load(api),control=env.create({draftId:DRAFT}),file=new File(['x'],'a.png',{type:'image/png'})
    const uploading=control.select([file]);await vi.waitFor(()=>expect(backend.chunks).toHaveLength(1))
    const original=control.items()[0]!.id,late=backend.uploads.get(original)
    await control.remove(original);waiting.resolve(reply({ok:true,...late}));await uploading
    expect(control.items()).toEqual([]);expect(control.readyIds()).toEqual([]);expect(env.revokeObjectURL).toHaveBeenCalled()
    delay=false;await control.select([file]);expect(control.readyIds()[0]).not.toBe(original)
    expect(backend.api.mock.calls.find(([p])=>p.endsWith('/discard'))?.[1]?.body).toBe(JSON.stringify({id:original,draftId:DRAFT}))
  })

  it('disposing a control prevents late responses from touching a new task or overwriting its saved metadata',async()=>{
    const waiting=deferred<ReturnType<typeof reply>>(),backend=server()
    const api:Api=async(path,opts)=>{const r=await backend.api(path,opts);return path.endsWith('/chunk')?waiting.promise:r}
    const env=load(api),onChange=vi.fn(),control=env.create({draftId:DRAFT,taskId:TASK,onChange}),view=root();control.mount(view)
    const uploading=control.select([new File(['x'],'a.png',{type:'image/png'})]);await vi.waitFor(()=>expect(backend.chunks).toHaveLength(1))
    control.dispose();const calls=onChange.mock.calls.length,saved=Array.from(env.storage.values())
    waiting.resolve(reply({ok:true,...backend.uploads.values().next().value}));await uploading
    expect(onChange).toHaveBeenCalledTimes(calls);expect(Array.from(env.storage.values())).toEqual(saved)
    expect(view.removeEventListener).toHaveBeenCalledTimes(2)
    expect(env.create({draftId:crypto.randomUUID(),taskId:'12345678'}).items()).toEqual([])
  })

  it('freezes submitted materials across refresh and acknowledges locally without deleting server material',async()=>{
    const backend=server(),env=load(backend.api),control=env.create({draftId:DRAFT})
    await control.select([new File(['x'],'a.png',{type:'image/png'})]);const ids=control.readyIds();control.freeze()
    const refreshed=load(backend.api,env.storage).create({draftId:DRAFT})
    await expect(refreshed.remove(ids[0]!)).rejects.toThrow('attachment_frozen')
    expect(backend.api.mock.calls.some(([p])=>p.endsWith('/discard'))).toBe(false)
    refreshed.acknowledge(ids);expect(refreshed.items()).toEqual([])
    expect(backend.api.mock.calls.some(([p])=>p.endsWith('/discard'))).toBe(false)
  })

  it('explains HEIC and enforces file and batch limits before sending bytes',async()=>{
    const backend=server(),control=load(backend.api).create({draftId:DRAFT}),view=root();control.mount(view)
    await expect(control.select([new File(['x'],'IMG.HEIC',{type:'image/heic'})])).rejects.toThrow('heic_not_supported')
    expect(view.innerHTML).toContain('HEIC')
    await expect(control.select([new File([new Uint8Array(5*1024*1024+1)],'big.png',{type:'image/png'})])).rejects.toThrow('attachment_size')
    await expect(control.select(Array.from({length:9},(_,i)=>new File(['x'],i+'.txt',{type:'text/plain'})))).rejects.toThrow('attachment_limit')
    expect(backend.chunks).toEqual([])
  })

  it('infers supported MIME from an empty browser type without altering file content',async()=>{
    const backend=server(),control=load(backend.api).create({draftId:DRAFT})
    await control.select([new File(['%PDF-1.7'],'notes.pdf',{type:''})])
    expect(backend.chunks[0].mime).toBe('application/pdf')
    expect(Buffer.from(backend.chunks[0].contentBase64,'base64').toString()).toBe('%PDF-1.7')
  })

  it('treats a failed discard as removed locally and never lets a late success restore it',async()=>{
    const backend=server(),api:Api=async(path,opts)=>path.endsWith('/discard')?reply({ok:false,error:'unavailable'},503):backend.api(path,opts)
    const env=load(api),control=env.create({draftId:DRAFT}),view=root();control.mount(view)
    await control.select([new File(['x'],'a.png',{type:'image/png'})]);const id=control.readyIds()[0]!
    await expect(control.remove(id)).rejects.toThrow('unavailable')
    expect(control.items()).toEqual([]);expect(control.readyIds()).toEqual([])
    expect(view.innerHTML).toContain('重试移除')
    expect(load(api,env.storage).create({draftId:DRAFT}).readyIds()).toEqual([])
  })
})

describe('attachment hashing on LAN HTTP',()=>{
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc','ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq','248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ])('uses the existing fallback for standard SHA-256 vector %j',async(input,digest)=>{
    expect(await hashFunction({})(new TextEncoder().encode(input))).toBe(digest)
  })
  it('matches WebCrypto for block boundaries, real PNG, dense 8 MiB, and yields between compression batches',async()=>{
    const yieldTimer=vi.fn((fn:()=>void)=>{fn();return 0}),fallback=hashFunction({},yieldTimer),native=hashFunction()
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9kAAAAASUVORK5CYII=','base64')
    for(const bytes of [new Uint8Array(63),new Uint8Array(64),new Uint8Array(65),new Uint8Array(BLOCK+7),png,Uint8Array.from({length:8*1024*1024},(_,i)=>i%251)]){
      expect(await fallback(bytes)).toBe(await native(bytes))
    }
    expect(yieldTimer.mock.calls.length).toBeGreaterThanOrEqual(64)
  })
})
