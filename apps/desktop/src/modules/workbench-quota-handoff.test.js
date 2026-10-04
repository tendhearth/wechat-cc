// @vitest-environment happy-dom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {createQuotaHandoffAttempts,createQuotaHandoffController,mountQuotaHandoffDialog,renderQuotaHandoff} from './workbench-quota-handoff.js'
const source={id:'deadbeef',title:'修登录页',path:'/tmp/login'}
const offer={state:'offer',from:'claude',to:'codex',kind:'quota',resetAt:Date.now()+3600000}
const providers=[{id:'claude',displayName:'Claude'},{id:'codex',displayName:'Codex'},{id:'cursor',displayName:'Cursor'}]
const detail=q=>({task:source,quotaHandoff:q})
const settle=()=>new Promise(resolve=>setTimeout(resolve,0))
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
let cleanup
beforeEach(()=>{document.body.innerHTML='';sessionStorage.clear()})
afterEach(()=>{cleanup?.();cleanup=null;document.body.innerHTML='';vi.restoreAllMocks()})
function setup(invoke,options={}){
 const attempts=createQuotaHandoffAttempts(sessionStorage),opened=vi.fn(),changed=vi.fn()
 const controller=createQuotaHandoffController({invoke,source,initial:offer,attempts,opened,changed,current:()=>true,...options})
 cleanup=()=>controller.destroy();return{controller,attempts,opened,changed}
}
describe('desktop quota handoff confirmation and recovery',()=>{
 it('restores only the request identity and recipient from saved attempts',()=>{
  const requestId=crypto.randomUUID();sessionStorage.setItem('cc.workbench.quota-handoff.v1:deadbeef',JSON.stringify({requestId,providerId:'codex',id:'12345678',owner:'forged'}))
  expect(createQuotaHandoffAttempts(sessionStorage).get(source.id)).toEqual({requestId,providerId:'codex'})
 })
 it('blocks new handoffs when per-window persistence is unavailable or refuses the saved request',async()=>{
  for(const storage of [null,{getItem:()=>null,setItem:()=>{throw Error('storage full')},removeItem:()=>{}},{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}]){
   const attempts=createQuotaHandoffAttempts(storage),invoke=vi.fn(async()=>detail(offer)),opened=vi.fn()
   const controller=createQuotaHandoffController({invoke,source,initial:offer,attempts,opened,changed:()=>{},current:()=>true})
   await controller.refresh();await controller.submit()
   expect(invoke.mock.calls.filter(c=>c[0]==='POST')).toHaveLength(0);expect(attempts.get(source.id)).toBeNull();expect(controller.state.unknown).toBe(false);expect(controller.state.error).toContain('确认无法保存，尚未交接');controller.destroy()
  }
 })
 it('preserves an existing unknown identity when storage writes or deletion later fail',async()=>{
  const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)}
  const attempts=createQuotaHandoffAttempts(storage),original={requestId:crypto.randomUUID(),providerId:'codex'};expect(attempts.set(source.id,original)).toBe(true)
  storage.setItem=()=>{throw Error('storage failed')};storage.removeItem=()=>{throw Error('storage failed')}
  const invoke=vi.fn(async method=>{if(method==='GET')return detail({...offer,to:'cursor'});throw Error('quota_handoff_changed')})
  const controller=createQuotaHandoffController({invoke,source,initial:offer,attempts,opened:vi.fn(),changed:()=>{},current:()=>true})
  await controller.refresh();await controller.submit()
  expect(invoke.mock.calls.find(c=>c[0]==='POST')[2]).toEqual({id:source.id,...original});expect(attempts.get(source.id)).toEqual(original);expect(controller.state.unknown).toBe(true);expect(controller.state.error).toContain('暂时无法清理');controller.destroy()
 })
 it('shows actual candidates, unavailable and handed states in the default task detail',()=>{
  document.body.innerHTML=renderQuotaHandoff(detail(offer),providers)
  expect(document.body.textContent).toContain('Claude 的额度已用完');expect(document.body.textContent).toContain('交给 Codex 继续')
  document.body.innerHTML=renderQuotaHandoff(detail({...offer,state:'none',to:undefined}),providers)
  expect(document.body.textContent).toContain('目前没有可接手');expect(document.querySelector('button')).toBeNull()
  document.body.innerHTML=renderQuotaHandoff(detail({state:'handed',from:'claude',to:'codex',matterId:'abcdef12'}),providers)
  expect(document.querySelector('button').dataset.quotaTask).toBe('abcdef12')
 })
 it('opens a read-only dialog before consent and spells out folder, partial context and new quota use',async()=>{
  const invoke=vi.fn(async()=>detail(offer)),opened=vi.fn()
  cleanup=mountQuotaHandoffDialog({invoke,source,initial:offer,providers,attempts:createQuotaHandoffAttempts(sessionStorage),opened,current:()=>true})
  await settle()
  expect(invoke.mock.calls).toEqual([['GET','/v1/workbench/task?id=deadbeef']]);expect(opened).not.toHaveBeenCalled()
  expect(document.querySelector('dialog').textContent).toContain('同一个文件夹');expect(document.body.textContent).toContain('/tmp/login')
  expect(document.body.textContent).toContain('完整原聊天和附件不会自动带过去');expect(document.body.textContent).toContain('使用其额度')
  document.querySelector('[data-quota="close"]').click();expect(document.querySelector('dialog')).toBeNull()
 })
 it('requires another explicit confirmation when a refreshed candidate changes',async()=>{
  let latest=offer;const invoke=vi.fn(async(method)=>method==='GET'?detail(latest):{taskId:'abcdef12',created:true})
  const {controller,opened}=setup(invoke)
  await controller.refresh();latest={...offer,to:'cursor'};await controller.submit()
  expect(controller.state.offer.to).toBe('cursor');expect(controller.state.error).toContain('再确认一次');expect(invoke.mock.calls.filter(c=>c[0]==='POST')).toHaveLength(0)
  await controller.submit();expect(invoke.mock.calls.find(c=>c[0]==='POST')[2].providerId).toBe('cursor');expect(opened).toHaveBeenCalledExactlyOnceWith('abcdef12')
 })
 it('retains request identity on an unknown result and checks GET before manually resending the same request',async()=>{
  let succeed=false;const invoke=vi.fn(async(method)=>{if(method==='GET')return detail(offer);if(!succeed)throw Error('connection lost');return{taskId:'abcdef12',created:false}})
  const {controller,attempts,opened}=setup(invoke);await controller.refresh();await controller.submit()
  const prior=attempts.get(source.id);expect(prior.providerId).toBe('codex');expect(controller.state.unknown).toBe(true);expect(controller.state.ready).toBe(false)
  const stored=createQuotaHandoffAttempts(sessionStorage);expect(stored.get(source.id)).toEqual(prior)
  const count=invoke.mock.calls.length;await settle();expect(invoke.mock.calls).toHaveLength(count)
  await controller.refresh();expect(invoke.mock.calls.at(-1)[0]).toBe('GET');expect(invoke.mock.calls.filter(c=>c[0]==='POST')).toHaveLength(1)
  succeed=true;await controller.submit();const posts=invoke.mock.calls.filter(c=>c[0]==='POST');expect(posts[1][2]).toEqual(posts[0][2]);expect(opened).toHaveBeenCalledWith('abcdef12');expect(attempts.get(source.id)).toBeNull()
 })
 it('freezes an unknown request and recipient across candidate changes until the original retry is definitely rejected',async()=>{
  let latest=offer,posts=0
  const invoke=vi.fn(async(method)=>{if(method==='GET')return detail(latest);posts++;if(posts===1)throw Error('connection lost');if(posts===2)throw Error('quota_handoff_changed');return{taskId:'abcdef12',created:true}})
  const {controller,attempts}=setup(invoke);await controller.refresh();await controller.submit();const original=attempts.get(source.id)
  latest={...offer,to:'cursor'};await controller.refresh();expect(attempts.get(source.id)).toEqual(original);expect(controller.state.attempt.providerId).toBe('codex')
  await controller.submit();const sent=invoke.mock.calls.filter(c=>c[0]==='POST');expect(sent[1][2]).toEqual(sent[0][2]);expect(attempts.get(source.id)).toBeNull();expect(controller.state.ready).toBe(false)
  await controller.refresh();await controller.submit();const third=invoke.mock.calls.filter(c=>c[0]==='POST')[2][2];expect(third.providerId).toBe('cursor');expect(third.requestId).not.toBe(original.requestId)
 })
 it('keeps a disappeared offer unknown until a manual retry of the original identity returns not-needed',async()=>{
  let latest=offer,posts=0
  const invoke=vi.fn(async method=>{if(method==='GET')return detail(latest);if(++posts===1)throw Error('timeout');throw Error('quota_handoff_not_needed')})
  const {controller,attempts}=setup(invoke);await controller.refresh();await controller.submit();const original=attempts.get(source.id)
  latest=null;await controller.refresh();expect(attempts.get(source.id)).toEqual(original);await controller.submit()
  const sent=invoke.mock.calls.filter(c=>c[0]==='POST');expect(sent[1][2]).toEqual(sent[0][2]);expect(attempts.get(source.id)).toBeNull();expect(controller.state.error).toContain('已恢复')
 })
 it('treats same-source POST and handed IDs as unknown receipts without deleting the saved identity or navigating',async()=>{
  let latest=offer;const invoke=vi.fn(async method=>method==='GET'?detail(latest):{taskId:source.id,created:true})
  const {controller,attempts,opened}=setup(invoke);await controller.refresh();await controller.submit();const original=attempts.get(source.id)
  expect(original).not.toBeNull();expect(controller.state.unknown).toBe(true);expect(opened).not.toHaveBeenCalled()
  latest={state:'handed',from:'claude',to:'codex',matterId:source.id};await controller.refresh()
  expect(attempts.get(source.id)).toEqual(original);expect(controller.state.unknown).toBe(true);expect(controller.state.ready).toBe(false);expect(opened).not.toHaveBeenCalled();expect(invoke.mock.calls.filter(c=>c[0]==='POST')).toHaveLength(1)
 })
 it('after an unknown response opens the handed task from manual GET without another POST',async()=>{
  let latest=offer;const invoke=vi.fn(async(method)=>{if(method==='GET')return detail(latest);return{unexpected:'shape'}})
  const {controller,attempts,opened}=setup(invoke);await controller.refresh();await controller.submit();expect(attempts.get(source.id)).not.toBeNull()
  latest={state:'handed',from:'claude',to:'codex',matterId:'abcdef12'};await controller.refresh()
  expect(opened).toHaveBeenCalledExactlyOnceWith('abcdef12');expect(invoke.mock.calls.filter(c=>c[0]==='POST')).toHaveLength(1)
 })
 it('keeps an unknown attempt visible even after the quota offer disappears',()=>{
  document.body.innerHTML=renderQuotaHandoff(detail(null),providers,{requestId:crypto.randomUUID(),providerId:'codex'})
  expect(document.body.textContent).toContain('结果还未确认');expect(document.querySelector('button').dataset.action).toBe('quota-handoff')
 })
 it('blocks double clicks while the POST is pending and opens the response task ID',async()=>{
  const pending=deferred(),invoke=vi.fn(async method=>method==='GET'?detail(offer):pending.promise)
  const {controller,opened}=setup(invoke);await controller.refresh();const first=controller.submit();await settle();await controller.submit()
  expect(invoke.mock.calls.filter(c=>c[0]==='POST')).toHaveLength(1);pending.resolve({taskId:'abcdef12',created:true});await first;expect(opened).toHaveBeenCalledExactlyOnceWith('abcdef12')
 })
 it('ignores late success after navigation and preserves the other page draft and reading position',async()=>{
  document.body.innerHTML='<main><textarea>另一页未发送的草稿</textarea><article>另一页阅读内容</article></main>'
  const page=document.querySelector('main');page.scrollTop=77
  let current=true;const pending=deferred(),invoke=vi.fn(async method=>method==='GET'?detail(offer):pending.promise)
  const {controller,opened}=setup(invoke,{current:()=>current});await controller.refresh();const submission=controller.submit();await settle();current=false
  pending.resolve({taskId:'abcdef12',created:true});await submission
  expect(opened).not.toHaveBeenCalled();expect(document.querySelector('main')).toBe(page);expect(page.scrollTop).toBe(77);expect(document.querySelector('textarea').value).toBe('另一页未发送的草稿')
 })
 it('a definite busy rejection keeps the task intact and requires a fresh check',async()=>{
  const invoke=vi.fn(async method=>{if(method==='GET')return detail(offer);throw Error('workbench_busy')})
  const {controller,attempts,opened}=setup(invoke);await controller.refresh();await controller.submit()
  expect(controller.state.error).toContain('正在执行');expect(controller.state.ready).toBe(false);expect(attempts.get(source.id)).toBeNull();expect(opened).not.toHaveBeenCalled()
 })
})

async function pageFixture(post){
 vi.resetModules();document.body.innerHTML='<main id="workbench-root"></main>'
 const module=await import('./workbench.js')
 const sourceTask={...source,providerId:'claude',status:'failed',createdAt:1,updatedAt:3,error:'provider_quota_exhausted'}
 const other={...sourceTask,id:'12345678',title:'另一件事',providerId:'codex',status:'completed',error:null}
 const target={...other,id:'abcdef12',title:'接手的任务'}
 const invoke=vi.fn(async(method,path,body)=>{
  if(path==='/v1/workbench/quota-handoff')return post(body)
  if(path.startsWith('/v1/workbench/task?')){if(path.includes('since='))return new Promise(()=>{});const id=new URL('http://fixture'+path).searchParams.get('id');return{task:id===source.id?sourceTask:id===target.id?target:other,events:[],artifacts:[],version:1,continuation:{mode:'new'},quotaHandoff:id===source.id?offer:null}}
  if(path.startsWith('/v1/workbench/review?'))return{reviews:[]}
  if(path.startsWith('/v1/matters?'))return{matters:[]}
  return{tasks:[sourceTask,other,target],providers,defaultProvider:'claude',canWechat:false}
 })
 const controller=module.initWorkbenchPage({invokeWorkbenchApi:invoke,pollMs:60000});cleanup=()=>module.stopWorkbenchPolling()
 await vi.waitFor(()=>expect(controller.state.selectedId).toBe(source.id))
 return{controller,invoke,root:document.getElementById('workbench-root')}
}
describe('actual desktop task-detail hooks',()=>{
 it('keeps a separate actionable execution failure visible alongside a later quota offer',async()=>{
  const f=await pageFixture(async()=>({taskId:'abcdef12',created:true}))
  f.controller.state.detail.task.error='execution_image_unsupported';f.controller.paint(true)
  expect(f.root.textContent).toContain('不接收图片');expect(f.root.querySelector('[data-action="quota-handoff"]')).not.toBeNull()
 })
 it('does not POST from the actual confirmation controls when saving the handoff identity fails',async()=>{
  const actual=window.sessionStorage
  vi.spyOn(window,'sessionStorage','get').mockReturnValue({getItem:actual.getItem.bind(actual),removeItem:actual.removeItem.bind(actual),setItem:(key,value)=>{if(key.startsWith('cc.workbench.quota-handoff.v1:'))throw Error('storage full');actual.setItem(key,value)}})
  const f=await pageFixture(async()=>({taskId:'abcdef12',created:true}))
  f.root.querySelector('[data-action="quota-handoff"]').click()
  await vi.waitFor(()=>expect(document.querySelector('[data-quota="confirm"]')).not.toBeNull());document.querySelector('[data-quota="confirm"]').click()
  await vi.waitFor(()=>expect(document.querySelector('dialog').textContent).toContain('确认无法保存，尚未交接'))
  expect(f.invoke.mock.calls.filter(c=>c[0]==='POST')).toHaveLength(0);expect(f.controller.state.selectedId).toBe(source.id)
 })
 it('opens the task ID actually returned by quota handOff through the visible confirmation controls',async()=>{
  const f=await pageFixture(async()=>({taskId:'abcdef12',created:true}))
  f.root.querySelector('[data-action="quota-handoff"]').click()
  await vi.waitFor(()=>expect(document.querySelector('[data-quota="confirm"]')).not.toBeNull())
  document.querySelector('[data-quota="confirm"]').click()
  await vi.waitFor(()=>expect(f.controller.state.selectedId).toBe('abcdef12'))
  expect(f.invoke.mock.calls.filter(c=>c[0]==='POST')).toHaveLength(1);expect(document.querySelector('dialog')).toBeNull()
 })
 it('a delayed reply cannot replace another selected task, its draft or its reading position',async()=>{
  const pending=deferred(),f=await pageFixture(async()=>pending.promise)
  f.root.querySelector('[data-action="quota-handoff"]').click()
  await vi.waitFor(()=>expect(document.querySelector('[data-quota="confirm"]')).not.toBeNull())
  document.querySelector('[data-quota="confirm"]').click()
  await vi.waitFor(()=>expect(f.invoke.mock.calls.some(c=>c[0]==='POST')).toBe(true))
  f.root.querySelector('[data-task-id="12345678"]').click()
  await vi.waitFor(()=>expect(f.controller.state.selectedId).toBe('12345678'))
  const input=f.root.querySelector('#wb-followup-text'),content=f.root.querySelector('.wb-content');input.value='别页保留草稿';input.dispatchEvent(new Event('input',{bubbles:true}));content.scrollTop=85
  pending.resolve({taskId:'abcdef12',created:true});await settle()
  expect(f.controller.state.selectedId).toBe('12345678');expect(f.root.querySelector('#wb-followup-text')).toBe(input);expect(input.value).toBe('别页保留草稿');expect(f.root.querySelector('.wb-content')).toBe(content);expect(content.scrollTop).toBe(85)
 })
})
