import {afterEach,describe,expect,it,vi} from 'vitest'
import {Window} from 'happy-dom'
import {PHONE_API_SCHEMAS} from '../../packages/protocol/src/index'
import {assembleMobilePage} from './assemble'
import {readMobileSource} from './sources'

// 「一起做」里的终端会话(2026-10-14):列表、允许 / 拒绝(同微信 y/n)、接着说一句(同微信 @码)。
const windows:Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(window=>window.happyDOM.abort()))})
const response=(body:any,status=200)=>({status,json:async()=>body})
const NOW=Date.now()
const waiting={session_id:'s-wait',code:'s-wait',source:'claude',status:'waiting',stale:false,project:'blog',machine:null,last_summary:'上一句',last_event_at:NOW,last_prompt_at:null,created_at:1,pending:{tool:'Bash',summary:'npm run deploy',since:NOW,hash:'ab12c',actionable:true}}
const local={...waiting,session_id:'s-local',project:'notes',pending:{...waiting.pending,hash:null,actionable:false}}
const idle={...waiting,session_id:'s-idle',source:'codex',status:'idle',project:'api',last_summary:'测试全过了',pending:null}
const ended={...idle,session_id:'s-end',status:'ended'}
const viaCursor={...idle,session_id:'s-cur',source:'cursor',project:'site'}
const LIST={ok:true,sessions:[waiting,local,idle,viaCursor,ended]}
function load(api=vi.fn(async(path:string,_opts?:any)=>response(path==='/m/api/cli/sessions'?LIST:{ok:true,accepted:true}))){
 const window=new Window({url:'https://fixture.test/m'});windows.push(window)
 const document=window.document;document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 const env={document,window,CustomEvent:window.CustomEvent,api,setTimeout:window.setTimeout.bind(window),clearTimeout:window.clearTimeout.bind(window),
  esc:(text:unknown)=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!)}
 const fns=new Function(...Object.keys(env),`${readMobileSource('terminal.js')}\nreturn {tmLoad,state:function(){return tm}}`)(...Object.values(env)) as any
 const pane=(name:string)=>document.dispatchEvent(new window.CustomEvent('cc:pane',{detail:{pane:name}}))
 const el=(id:string)=>document.getElementById(id)!
 return{...fns,window,document,api,pane,el}
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,5))

describe('phone page: terminal sessions in 一起做',()=>{
 it('夹具过真 schema',()=>{expect(PHONE_API_SCHEMAS['GET /m/api/cli/sessions']!.safeParse(LIST).success).toBe(true)})
 it('只在「一起做」可见时拉;列出项目 / 状态 / 哪家,结束了的不列;能拍的才有允许 / 拒绝',async()=>{
  const h=load()
  await wait();expect(h.api).not.toHaveBeenCalled();expect(h.el('terminal-root').hidden).toBe(true)
  h.pane('matters');await wait()
  expect(h.api).toHaveBeenCalledWith('/m/api/cli/sessions',undefined)
  const text=h.el('terminal-list').textContent!
  expect(h.el('terminal-root').hidden).toBe(false)
  expect(text).toContain('blog');expect(text).toContain('等你批准');expect(text).toContain('Bash: npm run deploy');expect(text).toContain('Codex');expect(text).toContain('Cursor');expect(text).toContain('歇着')
  expect(h.document.querySelector('[data-tm-row="s-end"]')).toBeNull()
  expect(h.document.querySelector('[data-tm-decide="allow"][data-tm-id="s-wait"]')).not.toBeNull()
  expect(h.document.querySelector('[data-tm-decide][data-tm-id="s-local"]')).toBeNull()
  expect(h.document.querySelector('[data-tm-row="s-local"]')!.textContent).toContain('回电脑上答')
 })
 it('允许:带会话 id 与码 POST /m/api/cli/permission;码失效 ⇒ 说清楚',async()=>{
  let n=0
  const api=vi.fn(async(path:string,_opts?:any)=>path==='/m/api/cli/sessions'?response(LIST):n++===0?response({ok:true}):response({ok:false,error:'cli_permission_stale'},409))
  const h=load(api);h.pane('matters');await wait()
  ;(h.document.querySelector('[data-tm-decide="allow"][data-tm-id="s-wait"]') as any).click();await wait()
  const post=api.mock.calls.find(([p])=>p==='/m/api/cli/permission')!
  expect(JSON.parse(post[1].body)).toEqual({session_id:'s-wait',hash:'ab12c',decision:'allow'})
  expect(h.document.querySelector('[data-tm-row="s-wait"]')!.textContent).toContain('接着做')
  ;(h.document.querySelector('[data-tm-decide="deny"][data-tm-id="s-wait"]') as any).click();await wait()
  expect(h.document.querySelector('[data-tm-row="s-wait"]')!.textContent).toContain('已经处理过或过期')
 })
 it('接着说:歇着的展开后能发;在跑的输入框关着;发出去 POST /m/api/cli/say',async()=>{
  const h=load();h.pane('matters');await wait()
  ;(h.document.querySelector('[data-tm-open="s-wait"]') as any).click()
  expect((h.document.getElementById('terminal-say-s-wait') as any).disabled).toBe(true)
  ;(h.document.querySelector('[data-tm-open="s-idle"]') as any).click()
  expect(h.document.querySelector('[data-tm-row="s-idle"]')!.textContent).toContain('测试全过了')
  const box=h.document.getElementById('terminal-say-s-idle') as any
  expect(box.disabled).toBe(false);box.value='  再跑一遍  '
  ;(h.document.querySelector('[data-tm-say="s-idle"]') as any).click();await wait()
  const post=h.api.mock.calls.find(([p]:any)=>p==='/m/api/cli/say')!
  expect(JSON.parse(post[1].body)).toEqual({session_id:'s-idle',text:'再跑一遍'})
  expect(h.document.querySelector('[data-tm-row="s-idle"]')!.textContent).toContain('回复会出现在这里')
 })
 it('老电脑没有这条路由 ⇒ 整段不显示;离开「一起做」不再拉',async()=>{
  const api=vi.fn(async()=>response({error:'route_not_allowed'},403))
  const h=load(api);h.pane('matters');await wait()
  expect(h.el('terminal-root').hidden).toBe(true)
  h.pane('today');const n=api.mock.calls.length;await h.tmLoad();expect(api.mock.calls.length).toBe(n)
 })
})
