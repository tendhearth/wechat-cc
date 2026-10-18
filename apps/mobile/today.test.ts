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
function load(api=vi.fn(async(_path:string,_opts?:any)=>response(BODY)),leftAt?:number){
 const window=new Window({url:'https://fixture.test/m'});windows.push(window)
 if(leftAt!==undefined)window.localStorage.setItem('cc.lastLeft',String(leftAt))
 const document=window.document;document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 const panes:string[]=[],opened:string[]=[],terminals:string[]=[]
 const env={document,window,CustomEvent:window.CustomEvent,api,setTimeout:window.setTimeout.bind(window),clearTimeout:window.clearTimeout.bind(window),
  localStorage:window.localStorage,mobilePane:(n:string)=>panes.push(n),openMatter:(id:string)=>opened.push(id),tmOpenSession:(id:string)=>terminals.push(id),
  esc:(text:unknown)=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!)}
 const fns=new Function(...Object.keys(env),`${readMobileSource('today.js')}\nreturn {tdLoad,state:function(){return td}}`)(...Object.values(env)) as any
 const pane=(name:string)=>document.dispatchEvent(new window.CustomEvent('cc:pane',{detail:{pane:name}}))
 const el=(id:string)=>document.getElementById(id)!
 return{...fns,window,document,api,pane,el,panes,opened,terminals}
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,5))

describe('phone page: 今天 on 此刻',()=>{
 it('夹具过真 schema',()=>{expect(PHONE_API_SCHEMAS['GET /m/api/today']!.safeParse(BODY).success).toBe(true)})
 it('一打开就拉;几个数一行;最近做完的前三件',async()=>{
  const h=load();await wait()
  expect(h.api).toHaveBeenCalledWith('/m/api/today')
  expect(h.el('today-root').hidden).toBe(false)
  // 等你的不在这里数(下面「等你的事」已经列着);是 0 的不写
  expect(h.el('today-counts').textContent).toBe('4 件做完 · 1 件可能卡住')
  const rows=h.document.querySelectorAll('#today-list .today-row')
  expect(rows.length).toBe(3)
  expect(rows[0]!.textContent).toContain('blog');expect(rows[0]!.textContent).toContain('Claude Code · 改好了')
  expect(rows[1]!.textContent).toContain('修打包')
  expect(h.el('today-partial').hidden).toBe(true)
 })
 it('离开一小时以上、这期间有做完的 ⇒「你不在的这 N 小时」只数只列这段;页面藏起来时记下离开时间',async()=>{
  const fresh=item({id:'new',project:'fresh',at:NOW-10*60_000}),old=item({id:'old',project:'old',at:NOW-5*3_600_000})
  const h=load(vi.fn(async()=>response({ok:true,today:{...TODAY,done:[fresh,old],counts:{...TODAY.counts,done:2}}})),NOW-3*3_600_000);await wait()
  expect(h.el('today-title').textContent).toBe('你不在的这 3 小时')
  expect(h.el('today-counts').textContent).toBe('1 件做完 · 1 件可能卡住')
  expect(h.document.querySelectorAll('#today-list .today-row').length).toBe(1)
  const h2=load(vi.fn(async()=>response({ok:true,today:{...TODAY,done:[old],counts:{...TODAY.counts,done:1}}})),NOW-3*3_600_000);await wait()
  expect(h2.el('today-title').textContent).toBe('过去 24 小时')
  Object.defineProperty(h2.document,'hidden',{configurable:true,get:()=>true})
  h2.document.dispatchEvent(new h2.window.Event('visibilitychange'))
  expect(Number(h2.window.localStorage.getItem('cc.lastLeft'))).toBeGreaterThanOrEqual(NOW)
 })
 it('点一起做的事 ⇒ 到一起做并打开那件;点终端 ⇒ 到一起做并展开那一条;点数字 ⇒ 到一起做',async()=>{
  const h=load();await wait()
  ;(h.document.querySelector('[data-td-id="a1b2c3d4"]') as any).click()
  expect(h.panes).toEqual(['matters']);expect(h.opened).toEqual(['a1b2c3d4'])
  ;(h.document.querySelector('#today-list [data-td-id="sess-1"]') as any).click()
  expect(h.opened).toEqual(['a1b2c3d4']);expect(h.terminals).toEqual(['sess-1'])
  ;(h.el('today-counts-open') as any).click()
  expect(h.panes).toEqual(['matters','matters','matters'])
 })
 it('终端里等你批准、手机拍得了的(有码)列在此刻的等你的事里;点「看清楚 ›」⇒ 展开那一条;没码的不列',async()=>{
  const local={...TODAY.needsYou[0],id:'w-local',replyRef:null}
  const together={...TODAY.needsYou[0],source:'together',id:'a1b2c3d4',replyRef:null}
  const h=load(vi.fn(async()=>response({ok:true,today:{...TODAY,needsYou:[TODAY.needsYou[0],local,together],counts:{...TODAY.counts,needsYou:3}}})));await wait()
  expect(h.el('today-waiting').hidden).toBe(false)
  const rows=h.document.querySelectorAll('#today-waiting .today-row')
  expect(rows.length).toBe(1)
  expect(rows[0]!.textContent).toContain('改好了');expect(rows[0]!.textContent).toContain('等你批准 · blog · Claude Code');expect(rows[0]!.textContent).toContain('看清楚 ›')
  ;(rows[0] as any).click()
  expect(h.panes).toEqual(['matters']);expect(h.terminals).toEqual(['w'])
 })
 it('只有等你的 ⇒「过去 24 小时」不放(等你的已经列着)',async()=>{
  const h=load(vi.fn(async()=>response({ok:true,today:{...TODAY,done:[],stuck:[],counts:{needsYou:1,done:0,running:0,stuck:0}}})));await wait()
  expect(h.el('today-root').hidden).toBe(true)
  expect(h.el('today-waiting').hidden).toBe(false)
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
