import {afterEach,expect,it,vi} from 'vitest'
import {readMobileSource} from './sources'

const TASK='abcdef12',OTHER='1234abcd',RUN='run-original'
const reply=(value:unknown,status=200)=>({status,json:async()=>value})
const photo=(name='参考.png')=>new File([Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3])],name,{type:'image/png'})
function deferred<T=any>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}
function element(){
  const listeners:Record<string,((event:any)=>void)[]>={}
  return{value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,dataset:{} as Record<string,string>,style:{},
    addEventListener:(kind:string,fn:(e:any)=>void)=>{(listeners[kind]??=[]).push(fn)},
    fire(kind:string,event:any={}){for(const fn of listeners[kind]??[])fn.call(this,event)},
    replaceChildren(){this.innerHTML=''},appendChild(){},querySelectorAll:()=>[],focus(){},setAttribute(){},
  }
}
type Input={id:string;taskId:string;runId:string;text:string;status:string;attachments?:any[]}
function setup(onSay?:(body:any,valid:Input)=>Promise<any>,storage=new Map<string,string>()){
  const els=new Map<string,ReturnType<typeof element>>(),get=(id:string)=>{if(!els.has(id))els.set(id,element());return els.get(id)!}
  const uploads=new Map<string,any>(),sends:any[]=[],discards:string[]=[],details:Record<string,any>={}
  let pauseUpload:Promise<void>|undefined
  const detail=(id:string)=>details[id]??{ok:true,matter:{id,kind:'task',title:'任务',status:'open'},runId:RUN,events:[],inputs:[],permissions:[],questions:[],artifacts:[]}
  const api=async(path:string,opts?:{method?:string;body?:string})=>{
    if(path.startsWith('/m/api/matter?id='))return reply(detail(new URL('https://cc.invalid'+path).searchParams.get('id')!))
    if(path.startsWith('/m/api/matters?'))return reply({ok:true,matters:[]})
    if(path.includes('/attachment/chunk')){
      const body=JSON.parse(opts!.body!);if(pauseUpload)await pauseUpload
      const nextOffset=body.offset+Buffer.from(body.contentBase64,'base64').length
      const attachment={id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}
      uploads.set(body.id,attachment)
      return reply({ok:true,id:body.id,draftId:body.draftId,taskId:body.taskId,size:body.size,sha256:body.sha256,nextOffset,status:'ready',attachment})
    }
    if(path.includes('/attachment/discard')){discards.push(JSON.parse(opts!.body!).id);return reply({ok:true})}
    if(path==='/m/api/matter/say'){
      const body=JSON.parse(opts!.body!);sends.push(body)
      const valid={id:body.requestId,taskId:body.id,runId:body.runId??RUN,text:body.text,status:'delivered',attachments:(body.attachmentIds??[]).map((id:string)=>uploads.get(id))}
      return onSay?onSay(body,valid):reply({ok:true,result:{kind:'task',task:{id:body.id},input:valid}})
    }
    throw Error('Unexpected path '+path)
  }
  const document={hidden:false,getElementById:get,querySelectorAll:()=>[],addEventListener(){},createElement:()=>element()}
  const env={document,window:{addEventListener(){}},localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},REMOTE:{id:'fixture'},location:{host:'local'},api,crypto,Uint8Array,DataView,TextEncoder,TextDecoder,Blob,URL:class extends URL{static createObjectURL(){return'blob:fixture'}static revokeObjectURL(){}},atob,btoa,setTimeout,clearTimeout,esc:(s:unknown)=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),ago:()=> '刚刚'}
  const fns=new Function(...Object.keys(env),`${readMobileSource('markdown.js')}\n${readMobileSource('workbench.js')}\n${readMobileSource('attachments.js')}\nreturn {openMatter,renderMatter,mObserveInput}`)(...Object.values(env)) as {openMatter:(id:string)=>Promise<void>;renderMatter:(d:any)=>void;mObserveInput:(id:string,input:Input,notify:boolean)=>void}
  const draft=(id=TASK)=>JSON.parse(storage.get('cc.phone.matter.v1:fixture:'+id+':say')??'null')
  const items=()=>[...storage].filter(([k])=>k.startsWith('cc.phone.attachments.v1:')).flatMap(([,v])=>JSON.parse(v).items)
  return{...fns,get,storage,uploads,sends,discards,details,detail,draft,items,
    edit(text:string){get('m-say').value=text;get('m-say').fire('input')},
    send(){get('m-send').fire('click')},
    add(file:File){get('m-say-materials').fire('change',{target:{hasAttribute:(name:string)=>name==='data-pa-files',files:[file]}})},
    pause(p:Promise<void>){pauseUpload=p},
    async settle(){await vi.advanceTimersByTimeAsync(0)},
  }
}
afterEach(()=>vi.useRealTimers())

it('sends an image-only continuation with its ready draft and ordered material IDs, then acknowledges without deleting it',async()=>{
  vi.useFakeTimers();const gate=deferred(),h=setup(async(_body,input)=>{await gate.promise;return reply({ok:true,result:{kind:'task',input}})})
  await h.openMatter(TASK);h.add(photo());await vi.waitFor(()=>expect(h.uploads.size).toBe(1))
  h.send();await h.settle()
  expect(h.sends).toHaveLength(1)
  expect(h.sends[0]).toMatchObject({id:TASK,runId:RUN,text:'',draftId:expect.any(String),attachmentIds:[...h.uploads.keys()]})
  expect(h.items()[0].frozen).toBe(true)
  gate.resolve(undefined);await h.settle()
  expect(h.draft()?.text??'').toBe('');expect(h.items()).toEqual([]);expect(h.discards).toEqual([])
})

it('keeps new text and new photo separate from a late receipt for the frozen old photo',async()=>{
  vi.useFakeTimers();const gate=deferred(),h=setup(async(_body,input)=>{await gate.promise;return reply({ok:true,result:{kind:'task',input}})})
  await h.openMatter(TASK);h.edit('旧要求');h.add(photo('旧.png'));await vi.waitFor(()=>expect(h.uploads.size).toBe(1))
  h.send();await h.settle();const old=h.sends[0]
  h.edit('后来编辑的新要求');h.add(photo('新.png'));await vi.waitFor(()=>expect(h.uploads.size).toBe(2))
  expect(h.draft().draftId).not.toBe(old.draftId)
  gate.resolve(undefined);await h.settle()
  expect(h.get('m-say').value).toBe('后来编辑的新要求')
  expect(h.items().map((i:any)=>i.name)).toEqual(['新.png'])
})

it('blocks sending text while selected material is incomplete',async()=>{
  vi.useFakeTimers();const gate=deferred<void>(),h=setup();h.pause(gate.promise)
  await h.openMatter(TASK);h.edit('带上图片');h.add(photo());await h.settle();h.send();await h.settle()
  expect(h.sends).toEqual([])
  gate.resolve(undefined);await vi.waitFor(()=>expect(h.uploads.size).toBe(1));h.send();await h.settle();expect(h.sends).toHaveLength(1)
})

it.each(['task','run','request','text','hash','size','order'])('does not clear text or materials for a mismatched %s receipt',async mismatch=>{
  vi.useFakeTimers();const h=setup(async(_body,input)=>{
    if(mismatch==='task')input.taskId=OTHER
    if(mismatch==='run')input.runId='wrong-run'
    if(mismatch==='request')input.id=crypto.randomUUID()
    if(mismatch==='text')input.text='别的要求'
    if(mismatch==='hash')input.attachments![0]={...input.attachments![0],sha256:'f'.repeat(64)}
    if(mismatch==='size')input.attachments![0]={...input.attachments![0],size:999}
    if(mismatch==='order')input.attachments!.reverse()
    return reply({ok:true,result:{kind:'task',input}})
  })
  await h.openMatter(TASK);h.edit('图文要求');h.add(photo('一.png'));await vi.waitFor(()=>expect(h.uploads.size).toBe(1));h.add(photo('二.png'));await vi.waitFor(()=>expect(h.uploads.size).toBe(2))
  h.send();await h.settle()
  expect(h.get('m-say').value).toBe('图文要求');expect(h.items()).toHaveLength(2);expect(h.draft().requestId).toBe(h.sends[0].requestId)
})

it.each(['held','restart_confirmation_required','external_close_confirmation_required'])('retains text and photos when continuation is %s',async outcome=>{
  vi.useFakeTimers();const h=setup(async(_body,input)=>outcome==='held'?reply({ok:true,result:{kind:'task',input:{...input,status:'held'}}}):reply({ok:false,error:outcome},409))
  await h.openMatter(TASK);h.edit('保留图文');h.add(photo());await vi.waitFor(()=>expect(h.uploads.size).toBe(1));h.send();await h.settle()
  expect(h.get('m-say').value).toBe('保留图文');expect(h.items()).toHaveLength(1)
  expect(h.get('m-notice').textContent).toContain(outcome==='held'?'未确认':'桌面')
})

it('settles a previous task receipt without changing the current task composer',async()=>{
  vi.useFakeTimers();const gate=deferred(),h=setup(async(_body,input)=>{await gate.promise;return reply({ok:true,result:{kind:'task',input}})})
  await h.openMatter(TASK);h.edit('A要求');h.add(photo());await vi.waitFor(()=>expect(h.uploads.size).toBe(1));h.send();await h.settle()
  await h.openMatter(OTHER);h.edit('B的新草稿');gate.resolve(undefined);await h.settle()
  expect(h.get('m-say').value).toBe('B的新草稿');expect(h.draft(OTHER).text).toBe('B的新草稿')
  expect(h.get('m-title').textContent).toContain('任务')
})

it('renders safe material names and sizes in public messages and pending inputs',async()=>{
  vi.useFakeTimers();const h=setup();await h.openMatter(TASK)
  const attachment={id:crypto.randomUUID(),name:'<img onerror=bad>.png',mime:'image/png',size:1025,sha256:'a'.repeat(64),storagePath:'/private/secret',ownerKey:'secret-owner'}
  h.renderMatter({...h.detail(TASK),events:[{kind:'user',text:'',createdAt:1,attachments:[attachment]}],inputs:[{id:crypto.randomUUID(),taskId:TASK,runId:RUN,text:'',status:'held',attachments:[attachment]}]})
  for(const id of ['m-events','m-inputs']){const html=h.get(id).innerHTML;expect(html).toContain('&lt;img onerror=bad&gt;.png');expect(html).toContain('2 KB');expect(html).not.toContain('/private/secret');expect(html).not.toContain('secret-owner')}
})

it('encodes and decodes more than 512 KiB in transport without an argument-stack overflow',()=>{
  const codec=new Function('btoa','atob','window','location',readMobileSource('transport.js')+'\nreturn b64u')(btoa,atob,{}, {protocol:'http:'})
  const bytes=Uint8Array.from({length:768*1024+17},(_,i)=>i%251)
  const encoded=codec.enc(bytes)
  expect(encoded).toBe(Buffer.from(bytes).toString('base64url'))
  expect(Buffer.from(codec.dec(encoded))).toEqual(Buffer.from(bytes))
})

it('keeps an unknown submitted photo visible and recoverable after editing a separate draft',async()=>{
  vi.useFakeTimers();const h=setup(async()=>{throw Error('connection lost')})
  await h.openMatter(TASK);h.edit('先前图文');h.add(photo());await vi.waitFor(()=>expect(h.uploads.size).toBe(1));h.send();await h.settle()
  const original=h.sends[0]
  h.edit('另一件补充');h.renderMatter(h.detail(TASK))
  expect(h.get('m-inputs').innerHTML).toContain('先前图文')
  expect(h.get('m-inputs').innerHTML).toContain('参考.png')
  expect(h.get('m-inputs').innerHTML).toContain('正在确认')
  h.edit('')
  h.get('m-inputs').fire('click',{target:{closest:()=>({dataset:{restoreInput:original.requestId}})}})
  expect(h.get('m-say').value).toBe('先前图文')
  expect(h.draft().requestId).toBe(original.requestId)
  h.send();await h.settle()
  expect(h.sends[1]).toEqual(original)
})

it('does not submit when its immutable continuation snapshot cannot be stored',async()=>{
  vi.useFakeTimers();const storage=new Map<string,string>(),h=setup(undefined,storage)
  await h.openMatter(TASK);h.edit('材料不能丢');h.add(photo());await vi.waitFor(()=>expect(h.uploads.size).toBe(1))
  const originalSet=storage.set.bind(storage)
  storage.set=(key:string,value:string)=>{if(key.endsWith(':say-pending'))throw Error('quota');return originalSet(key,value)}
  h.send();await h.settle()
  expect(h.sends).toEqual([])
  expect(h.get('m-say').value).toBe('材料不能丢')
  expect(h.items()[0].frozen).toBe(false)
})

it('reconciles a saved photo submission from the refreshed task receipt without sending again',async()=>{
  vi.useFakeTimers();const first=setup(async()=>{throw Error('reply lost')})
  await first.openMatter(TASK);first.edit('刷新前的图文');first.add(photo());await vi.waitFor(()=>expect(first.uploads.size).toBe(1));first.send();await first.settle()
  const sent=first.sends[0],refreshed=setup(undefined,first.storage)
  refreshed.details[TASK]={...refreshed.detail(TASK),inputs:[{id:sent.requestId,taskId:TASK,runId:RUN,text:sent.text,status:'delivered',attachments:[...first.uploads.values()]}]}
  await refreshed.openMatter(TASK)
  expect(refreshed.sends).toEqual([])
  expect(refreshed.get('m-say').value).toBe('')
  expect(refreshed.items()).toEqual([])
})
