import {afterEach,describe,expect,it,vi} from 'vitest'
import {Window} from 'happy-dom'
import {PHONE_API_SCHEMAS} from '../../packages/protocol/src/index'
import {assembleMobilePage} from './assemble'
import {readMobileSource} from './sources'

// 项目经验(10-20,接 #443):「一起做」底下一行,点开才拉;看 / 加 / 删,删要点两下。
const windows:Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(window=>window.happyDOM.abort()))})
const response=(body:any,status=200)=>({status,ok:status<400,json:async()=>body})
const P='p-'+'a'.repeat(20),Q='p-'+'b'.repeat(20)
const LIST={ok:true,projects:[{id:P,name:'wechat-cc',lessons:[{id:'aaaa0001',text:'用 bun <b>'}]}],choices:[{id:P,name:'wechat-cc'},{id:Q,name:'rici'}]}
function load(api:any=vi.fn(async(path:string,_o?:any)=>response(path==='/m/api/lessons'?LIST:{ok:true,id:'bbbb0002'}))){
 const window=new Window({url:'https://fixture.test/m'});windows.push(window)
 const document=window.document;document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 const env={document,window,api,esc:(text:unknown)=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!)}
 new Function(...Object.keys(env),readMobileSource('lessons.js'))(...Object.values(env))
 const el=(id:string)=>document.getElementById(id)! as any
 return{window,document,api,el}
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,5))

describe('项目经验 on the phone',()=>{
 it('fixture matches the schema',()=>{expect(PHONE_API_SCHEMAS['GET /m/api/lessons']!.safeParse(LIST).success).toBe(true)})
 it('collapsed until opened; opening lists lessons by project (escaped) and fills the project picker',async()=>{
  const t=load()
  expect(t.el('lessons-body').hidden).toBe(true)
  expect(t.api).not.toHaveBeenCalled()
  t.el('lessons-open').click();await wait()
  expect(t.el('lessons-list').textContent).toContain('wechat-cc')
  expect(t.el('lessons-list').innerHTML).toContain('用 bun &lt;b&gt;')
  expect([...t.el('lessons-project').options].map((o:any)=>o.value)).toEqual([P,Q])
 })
 it('add posts exactly {project,text}, then reloads; a refusal says why',async()=>{
  const t=load();t.el('lessons-open').click();await wait()
  t.el('lessons-project').value=Q;t.el('lessons-text').value='不要动 assets'
  t.el('lessons-form').dispatchEvent(new t.window.Event('submit',{cancelable:true}));await wait()
  const post=t.api.mock.calls.find((c:any[])=>c[0]==='/m/api/lessons/add')
  expect(post[1].method).toBe('POST');expect(JSON.parse(post[1].body)).toEqual({project:Q,text:'不要动 assets'})
  expect(t.api.mock.calls.filter((c:any[])=>c[0]==='/m/api/lessons').length).toBe(2)
  const r=load(vi.fn(async(path:string)=>response(path==='/m/api/lessons'?LIST:{ok:false,error:'duplicate'})));r.el('lessons-open').click();await wait()
  r.el('lessons-text').value='用 bun';r.el('lessons-form').dispatchEvent(new r.window.Event('submit',{cancelable:true}));await wait()
  expect(r.el('lessons-note').textContent).toContain('已经记着了')
 })
 it('delete takes two taps and posts {project,id}',async()=>{
  const t=load();t.el('lessons-open').click();await wait()
  const btn=()=>t.document.querySelector('[data-lesson-id="aaaa0001"]') as any
  btn().click();await wait()
  expect(t.api.mock.calls.some((c:any[])=>c[0]==='/m/api/lessons/remove')).toBe(false)
  expect(btn().textContent).toContain('确定删')
  btn().click();await wait()
  const post=t.api.mock.calls.find((c:any[])=>c[0]==='/m/api/lessons/remove')
  expect(JSON.parse(post[1].body)).toEqual({project:P,id:'aaaa0001'})
 })
 it('offline ⇒ a plain line, no throw',async()=>{
  const t=load(vi.fn(async()=>{throw Error('offline')}));t.el('lessons-open').click();await wait()
  expect(t.el('lessons-list').textContent).toContain('连不上')
 })
})
