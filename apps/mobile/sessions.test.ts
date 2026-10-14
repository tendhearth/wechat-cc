import {afterEach,describe,expect,it,vi} from 'vitest'
import {Window} from 'happy-dom'
import {assembleMobilePage} from './assemble'
import {readMobileSource} from './sources'

const windows:Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(window=>window.happyDOM.abort()))})
const response=(body:any,status=200)=>({status,json:async()=>body})
const row=(key='one',provider='claude')=>({key,provider,title:'**可读会话**',project:'project',updatedAt:1,active:true})
const ready=(state='ready',mode:string|null='native_resume',provider='claude')=>({ok:true,state,provider,project:'project',mode:state==='ready'?mode:null,matterId:state==='managed'?'deadbeef':null})
const page=(key='one',windowName:any='recent',messages:any[]=[{id:'u1',role:'user',text:'**用户原文**',truncated:false},{id:'a1',role:'assistant',text:'# 最近的结果\n\n- 第一项\n- 第二项',truncated:true}])=>({ok:true,session:row(key),messages,nextCursor:null,managed:false,...(windowName?{window:windowName}:{})})
function deferred(){let resolve!:(body:any)=>void;const promise=new Promise<any>(r=>{resolve=r});return{resolve,promise}}
function defaultApi(path:string,opts?:any){
 const url=new URL(path,'https://fixture.test')
 if(url.pathname==='/m/api/sessions')return Promise.resolve(response({ok:true,items:[row('one',url.searchParams.get('provider')||'claude'),row('two',url.searchParams.get('provider')||'claude')],nextCursor:null}))
 if(url.pathname==='/m/api/session')return Promise.resolve(response(page(url.searchParams.get('key')||'one',url.searchParams.get('window'))))
 if(url.pathname==='/m/api/session/continue')return Promise.resolve(response(opts?.method==='POST'?{ok:true,matterId:'deadbeef',created:true}:ready()))
 return Promise.resolve(response({ok:true}))
}
function load(api=vi.fn(defaultApi)){
 const window=new Window({url:'https://fixture.test/m'});windows.push(window)
 const document=window.document;document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 let online=true
 const openMatter=vi.fn(async()=>{}),localNavigator={get onLine(){return online}}
 const env={document,window,navigator:localNavigator,CustomEvent:window.CustomEvent,location:window.location,localStorage:window.localStorage,T:'dFixture',REMOTE:null,api,
  setTimeout:window.setTimeout.bind(window),clearTimeout:window.clearTimeout.bind(window),ccNav(){},resetTunnel(){},toast(){},openMatter,
  esc:(text:unknown)=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!),
 }
 const home=readMobileSource('home.js'),seen=home.slice(home.indexOf('function markMemoriesSeen'),home.indexOf('setInterval(function(){if(!document.hidden'))
 const presence=readMobileSource('presence.js'),mobilePane=presence.slice(presence.indexOf('function mobilePane'),presence.indexOf('function renderPresenceHome'))
 const fns=new Function(...Object.keys(env),`var isDevice=true,mActive=true,mPoll=null,mSeq=0,mDetailFresh=true,eViewEpoch=0;function mSetButtons(){};var homeState={synced_at:123};\n${readMobileSource('markdown.js')}\n${readMobileSource('nav.js')}\n${mobilePane}\n${seen}\n${readMobileSource('sessions.js')}\nreturn {openPhoneSessions,ssOpenSession,ssChangeWindow,ssLoadRead,ssLoadList,ssCheck,ssAdopt,ssBackToList,mobilePane,state:function(){return ss},workActive:function(){return mActive}}`)(...Object.values(env)) as any
 const get=(id:string)=>document.getElementById('sessions-'+id)!
 return{...fns,window,document,api,openMatter,get,offline:(value=true)=>{online=!value;window.dispatchEvent(new window.Event(value?'offline':'online'))}}
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,1))

describe('phone computer session journey',()=>{
 it('has two bottom destinations, keeps memories under 此刻, retains its read receipt and pauses hidden workbench polling',async()=>{
  const h=load();expect(Array.from(h.document.querySelectorAll('nav button')).map((button:any)=>button.textContent?.trim())).toEqual(['此刻','一起做'])
  h.mobilePane('matters');h.mobilePane('today');h.document.getElementById('memory-open')!.click();await wait()
  expect(h.document.getElementById('p-memory')!.classList.contains('on')).toBe(true)
  expect(h.document.querySelector('nav button.on')?.textContent?.trim()).toBe('此刻');expect(h.workActive()).toBe(false)
  expect(h.api).toHaveBeenCalledWith('/m/api/seen',expect.objectContaining({method:'POST',body:'{"until":123}'}))
  h.document.getElementById('memory-back')!.click();expect(h.document.getElementById('p-today')!.classList.contains('on')).toBe(true)
 })
 it('searches only on submit, limits queries, paginates without duplicates and ignores an old provider/search reply',async()=>{
  const old=deferred(),api=vi.fn((path:string)=>path.includes('q=old')?old.promise:defaultApi(path)),h=load(api)
  await h.openPhoneSessions();const initial=api.mock.calls.length
  ;(h.get('query') as any).value='old';h.get('query').dispatchEvent(new h.window.Event('input'));expect(api.mock.calls.length).toBe(initial)
  h.get('search-form').dispatchEvent(new h.window.Event('submit',{cancelable:true}));await wait()
  ;(h.get('provider') as any).value='codex';h.get('provider').dispatchEvent(new h.window.Event('change'))
  ;(h.get('query') as any).value='new';h.get('search-form').dispatchEvent(new h.window.Event('submit',{cancelable:true}));await wait()
  old.resolve(response({ok:true,items:[{...row('old'),title:'旧回包'}],nextCursor:null}));await wait()
  expect(h.state().provider).toBe('codex');expect(h.state().query).toBe('new');expect(h.get('list').textContent).not.toContain('旧回包')
  expect(api.mock.calls.some(([path])=>path.includes('provider=codex&q=new'))).toBe(true)
  ;(h.get('query') as any).value='字'.repeat(201);const before=api.mock.calls.length;h.get('search-form').dispatchEvent(new h.window.Event('submit',{cancelable:true}));await wait()
  expect(api.mock.calls.length).toBe(before);expect(h.get('list-notice').textContent).toContain('最多 200')
 })
 it('reads explicitly recent records, formats both roles safely, preserves exact user source and reports truncation without exposing paths or native ids',async()=>{
  const text='\n\r\n**用户原文**\r\n\r\n  <script>unsafe()</script>\r\n',data=page('one','recent',[{id:'u',role:'user',text,truncated:false},{id:'a',role:'assistant',text:'[危险](javascript:alert(1))\n\n**结果**',truncated:true}])
  Object.assign(data.session,{cwd:'/private/secret/path',nativeId:'native-secret'})
  const api=vi.fn((path:string,opts?:any)=>path.startsWith('/m/api/session?')?Promise.resolve(response(data)):defaultApi(path,opts)),h=load(api)
  await h.openPhoneSessions();await h.ssOpenSession('one')
  expect(api).toHaveBeenCalledWith('/m/api/session?key=one&window=recent',undefined)
  expect(h.get('messages').querySelector('strong')?.textContent).toBe('用户原文')
  expect(h.get('messages').querySelector('details code')?.textContent).toBe(text)
  expect(h.get('messages').querySelectorAll('script,a')).toHaveLength(0)
  expect(h.get('messages').textContent).toContain('这段记录已截短');expect(h.get('source').textContent).toContain('最近 2 段')
  expect(h.document.body.textContent).not.toContain('/private/secret');expect(h.document.body.textContent).not.toContain('native-secret')
 })
 it('paginates the submitted list query and deduplicates rows, without treating an unknown active value as current',async()=>{
  let invalid=false;const api=vi.fn((path:string,opts?:any)=>path.startsWith('/m/api/sessions?')?Promise.resolve(response({ok:true,items:invalid?[{...row(),active:'false'}]:path.includes('cursor=')?[row('one'),row('two')]:[row('one')],nextCursor:path.includes('cursor=')?null:'next-page'})):defaultApi(path,opts)),h=load(api)
  await h.openPhoneSessions();await h.ssLoadList(true)
  expect(api).toHaveBeenCalledWith('/m/api/sessions?provider=claude&q=&cursor=next-page',undefined)
  expect(h.get('list').querySelectorAll('[data-session-key]')).toHaveLength(2)
  invalid=true;await h.ssLoadList(false);expect(h.get('list').querySelector('.is-current')).toBeNull();expect(h.get('list-notice').textContent).toContain('上次看到')
 })
 it('never labels old head-only responses as recent and can explicitly switch to the old compatible head pagination',async()=>{
  const api=vi.fn((path:string,opts?:any)=>path.startsWith('/m/api/session?')?Promise.resolve(response({...page('one',null,[{id:'old',role:'assistant',text:'最早记录',truncated:false}]),nextCursor:path.includes('cursor=')?null:'page2'})):defaultApi(path,opts)),h=load(api)
  await h.openPhoneSessions();await h.ssOpenSession('one')
  expect(h.get('messages').textContent).not.toContain('最早记录');expect(h.get('read-notice').textContent).toContain('暂不支持最近')
  await h.ssChangeWindow('start');expect(h.get('source').textContent).toContain('从头读取');expect(h.get('messages').textContent).toContain('最早记录')
  await h.ssLoadRead(true);expect(api).toHaveBeenCalledWith('/m/api/session?key=one&window=start&cursor=page2',undefined)
  expect(h.get('messages').querySelectorAll('article')).toHaveLength(1)
 })
 it('ignores detail and preview replies for a previously selected key',async()=>{
  const read=deferred(),preview=deferred(),api=vi.fn((path:string,opts?:any)=>path==='/m/api/session?key=one&window=recent'?read.promise:path==='/m/api/session/continue?key=one'?preview.promise:defaultApi(path,opts)),h=load(api)
  await h.openPhoneSessions();const old=h.ssOpenSession('one');await h.ssOpenSession('two')
  read.resolve(response(page('one','recent',[{id:'late',role:'assistant',text:'旧会话秘密',truncated:false}])));preview.resolve(response(ready('busy_session')));await old
  expect(h.state().key).toBe('two');expect(h.get('messages').textContent).not.toContain('旧会话秘密');expect(h.state().preview.state).toBe('ready')
 })
 it.each(['ready','managed','busy_session','busy_folder','provider_missing','folder_missing','quota','empty'])('represents %s honestly and only offers an action when ready or managed',async state=>{
  const api=vi.fn((path:string,opts?:any)=>path.startsWith('/m/api/session/continue?')?Promise.resolve(response(ready(state))):defaultApi(path,opts)),h=load(api)
  await h.openPhoneSessions();await h.ssOpenSession('one')
  expect(h.get('continue-notice').textContent!.length).toBeGreaterThan(10)
  expect(h.get('continue-actions').querySelectorAll('button')).toHaveLength(['ready','managed'].includes(state)?1:0)
  if(state==='managed'){h.get('continue-actions').querySelector('button')!.click();expect(h.openMatter).toHaveBeenCalledWith('deadbeef')}
  expect(api.mock.calls.every(([,opts])=>opts?.method!=='POST')).toBe(true)
 })
 it.each(['native_resume','fresh_context'])('requires one concrete %s confirmation and posts only the key, once, before opening without starting a run',async mode=>{
  const post=deferred(),api=vi.fn((path:string,opts?:any)=>opts?.method==='POST'?post.promise:path.startsWith('/m/api/session/continue?')?Promise.resolve(response(ready('ready',mode))):defaultApi(path,opts)),h=load(api)
  await h.openPhoneSessions();await h.ssOpenSession('one')
  h.get('continue-actions').querySelector('button')!.click()
  expect(h.get('continue-actions').textContent).toContain('发送第一句才会开始');expect(h.get('continue-actions').textContent).toContain(mode==='native_resume'?'沿用原会话':'新开一轮')
  const confirm=h.get('continue-actions').querySelector('[data-ss-action="confirm"]')!;confirm.click();confirm.click();await h.ssAdopt()
  const sent=api.mock.calls.filter(([,opts])=>opts?.method==='POST');expect(sent).toHaveLength(1);expect(JSON.parse(sent[0]![1].body)).toEqual({key:'one'})
  post.resolve(response({ok:true,matterId:'deadbeef',created:true}));await vi.waitFor(()=>expect(h.openMatter).toHaveBeenCalledWith('deadbeef'))
  expect(api.mock.calls.some(([path])=>/matter\/(say|create)/.test(path))).toBe(false)
 })
 it('invalidates an open confirmation when preview is refreshed or connectivity changes',async()=>{
  let state='ready';const api=vi.fn((path:string,opts?:any)=>path.startsWith('/m/api/session/continue?')?Promise.resolve(response(ready(state))):defaultApi(path,opts)),h=load(api)
  await h.openPhoneSessions();await h.ssOpenSession('one');h.get('continue-actions').querySelector('button')!.click()
  state='busy_session';await h.ssCheck();await h.ssAdopt();expect(h.get('continue-actions').querySelector('[data-ss-action="confirm"]')).toBeNull()
  state='ready';await h.ssCheck();h.get('continue-actions').querySelector('button')!.click();h.offline();await h.ssAdopt()
  expect(h.get('continue-notice').textContent).toContain('上次看到');expect(h.get('meta').querySelector('.is-current')).toBeNull()
  expect(api.mock.calls.every(([,opts])=>opts?.method!=='POST')).toBe(true)
 })
 it('keeps cached list status gray after refresh failure and never presents a cached ready preview as actionable',async()=>{
  let fail=false;const api=vi.fn((path:string,opts?:any)=>fail?Promise.reject(new Error('network')):defaultApi(path,opts)),h=load(api)
  await h.openPhoneSessions();fail=true;await h.ssLoadList(false)
  expect(h.get('list-notice').textContent).toContain('上次看到');expect(h.get('list').querySelector('.is-current')).toBeNull();expect(h.get('list').textContent).toContain('上次看到：原工具报告正在执行')
  fail=false;await h.ssOpenSession('one');fail=true;await h.ssCheck()
  expect(h.get('continue-notice').textContent).toContain('上次看到');expect(h.get('continue-actions').children).toHaveLength(0);expect(h.get('meta').querySelector('.is-current')).toBeNull()
 })
 it('reports a busy rejection without opening or retrying and reconciles an unknown result through a read-only managed preview',async()=>{
  let result='busy',state='ready';const api=vi.fn((path:string,opts?:any)=>opts?.method==='POST'?result==='busy'?Promise.resolve(response({ok:false,error:'native_session_busy'},409)):Promise.reject(new Error('network')):path.startsWith('/m/api/session/continue?')?Promise.resolve(response(ready(state))):defaultApi(path,opts)),h=load(api)
  await h.openPhoneSessions();await h.ssOpenSession('one');h.get('continue-actions').querySelector('button')!.click();await h.ssAdopt()
  expect(h.get('continue-notice').textContent).toContain('原工具报告正在执行');expect(h.openMatter).not.toHaveBeenCalled()
  result='unknown';await h.ssCheck();h.get('continue-actions').querySelector('button')!.click();await h.ssAdopt()
  expect(h.get('continue-notice').textContent).toContain('无法确认接入是否完成');state='managed';await h.ssCheck()
  expect(h.get('continue-actions').textContent).toBe('打开这件事');expect(api.mock.calls.filter(([,opts])=>opts?.method==='POST')).toHaveLength(2)
 })
 it('does not navigate a late successful continuation into another selected session',async()=>{
  const post=deferred(),api=vi.fn((path:string,opts?:any)=>opts?.method==='POST'?post.promise:defaultApi(path,opts)),h=load(api)
  await h.openPhoneSessions();await h.ssOpenSession('one');h.get('continue-actions').querySelector('button')!.click();const adoption=h.ssAdopt()
  await h.ssBackToList();await h.ssOpenSession('two');post.resolve(response({ok:true,matterId:'deadbeef',created:true}));await adoption
  expect(h.openMatter).not.toHaveBeenCalled();expect(h.state().key).toBe('two')
 })
 it('rechecks preview on visibility/online without replacing read nodes, selection, source disclosures or horizontal code position',async()=>{
  const text='保持选区\n\n[链接](https://example.test)\n\n```ts\nwide code\n```',api=vi.fn((path:string,opts?:any)=>path.startsWith('/m/api/session?')?Promise.resolve(response(page('one','recent',[{id:'u',role:'user',text:'**原文**',truncated:false},{id:'a',role:'assistant',text,truncated:false}]))):defaultApi(path,opts)),h=load(api)
  await h.openPhoneSessions();await h.ssOpenSession('one')
  const source=h.get('messages').querySelector('details')!,pre=h.get('messages').querySelector('pre')!,paragraph=h.get('messages').querySelectorAll('article')[1]!.querySelector('p')!.nextElementSibling!.querySelector('p')!,link=h.get('messages').querySelector('a')!
  source.open=true;pre.scrollLeft=77;link.focus();const range=h.document.createRange();range.setStart(paragraph.firstChild!,2);range.setEnd(paragraph.firstChild!,4);h.document.getSelection()!.addRange(range)
  const reads=api.mock.calls.filter(([path])=>path.startsWith('/m/api/session?')).length
  h.document.dispatchEvent(new h.window.Event('visibilitychange'));await wait();h.offline(false);await wait()
  expect(api.mock.calls.filter(([path])=>path.startsWith('/m/api/session?'))).toHaveLength(reads)
  expect(h.get('messages').querySelector('details')).toBe(source);expect(source.open).toBe(true);expect(h.document.getSelection()!.toString()).toBe('选区')
  expect(h.document.activeElement).toBe(link);expect(pre.scrollLeft).toBe(77)
 })
})
