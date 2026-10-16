import {afterEach,describe,expect,it,vi} from 'vitest'
import {Window} from 'happy-dom'
import {PHONE_API_SCHEMAS} from '../../packages/protocol/src/index'
import {assembleMobilePage} from './assemble'
import {readMobileSource} from './sources'

// 「此刻」里的「今天」(2026-10-14):几个数 + 最近做完的三件;点一行进现成的地方。
const windows:Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(window=>window.happyDOM.abort()))})
const response=(body:any,status=200)=>({status,json:async()=>body})
const NOW=Date.now()
const item=(over:any={})=>({source:'terminal',id:'sess-1',code:'sess-1',project:'blog',agent:'Claude Code',title:null,summary:'改好了',at:NOW-5*60_000,machine:null,...over})
const TODAY={generatedAt:NOW,since:NOW-86_400_000,windowHours:24,
 needsYou:[{...item({id:'w'}),kind:'permission',count:1,replyRef:'07'}],
 done:[item(),item({source:'together',id:'a1b2c3d4',code:'a1b2c3d4',title:'修打包',project:'melu',agent:'Codex',summary:null}),item({id:'s3',project:'three'}),item({id:'s4',project:'four'})],
 running:[],stuck:[item({id:'q'}) as any].map(s=>({...s,reason:'quiet'})),
 counts:{needsYou:1,done:4,running:0,stuck:1},unavailable:[]}
const BODY={ok:true,today:TODAY}
function load(api=vi.fn(async(_path:string,_opts?:any)=>response(BODY))){
 const window=new Window({url:'https://fixture.test/m'});windows.push(window)
 const document=window.document;document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 const panes:string[]=[],opened:string[]=[]
 const env={document,window,CustomEvent:window.CustomEvent,api,setTimeout:window.setTimeout.bind(window),clearTimeout:window.clearTimeout.bind(window),
  mobilePane:(n:string)=>panes.push(n),openMatter:(id:string)=>opened.push(id),
  esc:(text:unknown)=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!)}
 const fns=new Function(...Object.keys(env),`${readMobileSource('today.js')}\nreturn {tdLoad,state:function(){return td}}`)(...Object.values(env)) as any
 const pane=(name:string)=>document.dispatchEvent(new window.CustomEvent('cc:pane',{detail:{pane:name}}))
 const el=(id:string)=>document.getElementById(id)!
 return{...fns,window,document,api,pane,el,panes,opened}
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,5))

describe('phone page: 今天 on 此刻',()=>{
 it('夹具过真 schema',()=>{expect(PHONE_API_SCHEMAS['GET /m/api/today']!.safeParse(BODY).success).toBe(true)})
 it('一打开就拉;几个数一行;最近做完的前三件',async()=>{
  const h=load();await wait()
  expect(h.api).toHaveBeenCalledWith('/m/api/today')
  expect(h.el('today-root').hidden).toBe(false)
  expect(h.el('today-counts').textContent).toBe('1 件等你 · 4 件做完 · 0 件在跑 · 1 件可能卡住')
  const rows=h.document.querySelectorAll('.today-row')
  expect(rows.length).toBe(3)
  expect(rows[0]!.textContent).toContain('blog');expect(rows[0]!.textContent).toContain('Claude Code · 改好了')
  expect(rows[1]!.textContent).toContain('修打包')
  expect(h.el('today-partial').hidden).toBe(true)
 })
 it('点一起做的事 ⇒ 到一起做并打开那件;点终端 ⇒ 到一起做;点数字 ⇒ 到一起做',async()=>{
  const h=load();await wait()
  ;(h.document.querySelector('[data-td-id="a1b2c3d4"]') as any).click()
  expect(h.panes).toEqual(['matters']);expect(h.opened).toEqual(['a1b2c3d4'])
  ;(h.document.querySelector('[data-td-id="sess-1"]') as any).click()
  expect(h.opened).toEqual(['a1b2c3d4'])
  ;(h.el('today-counts-open') as any).click()
  expect(h.panes).toEqual(['matters','matters','matters'])
 })
 it('什么都没有 / 老电脑没这条路由 ⇒ 整段不显示;有一路读不到 ⇒ 标出来;离开此刻不再拉',async()=>{
  const empty={...TODAY,needsYou:[],done:[],stuck:[],counts:{needsYou:0,done:0,running:0,stuck:0}}
  const a=load(vi.fn(async()=>response({ok:true,today:empty})));await wait()
  expect(a.el('today-root').hidden).toBe(true)
  const b=load(vi.fn(async()=>response({ok:false,error:'not_found'},404)));await wait()
  expect(b.el('today-root').hidden).toBe(true)
  const c=load(vi.fn(async()=>response({ok:true,today:{...empty,unavailable:['terminal']}})));await wait()
  expect(c.el('today-root').hidden).toBe(false);expect(c.el('today-partial').hidden).toBe(false)
  c.pane('matters');expect(c.state().active).toBe(false)
 })
})
