import {afterEach,describe,expect,it,vi} from 'vitest'
import {Window} from 'happy-dom'
import {PHONE_API_SCHEMAS} from '../../packages/protocol/src/index'
import {assembleMobilePage} from './assemble'
import {readMobileSource} from './sources'

// 「CC 做过的事」(B9,2026-10-20):此刻页底下一行,点开才拉;往下「再早一点」翻页;点一行进那件事。
const windows:Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(window=>window.happyDOM.abort()))})
const response=(body:any,status=200)=>({status,ok:status<400,json:async()=>body})
const NOW=Date.now()
const P1={ok:true,items:[
 {id:'together:a1b2c3d4',kind:'together',at:NOW-60_000,title:'一起做「修测试」做完了',ref:{type:'task',id:'a1b2c3d4'}},
 {id:'proactive:1',kind:'proactive',at:NOW-120_000,title:'主动跟你说了一句'},
 {id:'terminal:s1',kind:'terminal',at:NOW-180_000,title:'终端 rici 这一轮做完了',ref:{type:'terminal',id:'sess-1'}},
],next:'abc',degraded:['letters']}
const P2={ok:true,items:[{id:'job:1',kind:'job',at:NOW-86_400_000,title:'早报:说了'}],next:null,degraded:[]}
function load(api=vi.fn(async(path:string)=>response(path.includes('cursor=')?P2:P1))){
 const window=new Window({url:'https://fixture.test/m'});windows.push(window)
 const document=window.document;document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 const panes:string[]=[],opened:string[]=[],terminals:string[]=[]
 const env={document,window,api,mobilePane:(n:string)=>panes.push(n),openMatter:(id:string)=>opened.push(id),tmOpenSession:(id:string)=>terminals.push(id),
  tdAgo:(at:number)=>`${Math.round((Date.now()-at)/60000)} 分钟前`,
  esc:(text:unknown)=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!)}
 new Function(...Object.keys(env),readMobileSource('activity.js'))(...Object.values(env))
 const el=(id:string)=>document.getElementById(id)! as any
 return{window,document,api,el,panes,opened,terminals}
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,5))

describe('phone page: CC 做过的事',()=>{
 it('fixtures pass the real schema',()=>{
  expect(PHONE_API_SCHEMAS['GET /m/api/activity']!.safeParse(P1).success).toBe(true)
  expect(PHONE_API_SCHEMAS['GET /m/api/activity']!.safeParse(P2).success).toBe(true)
 })
 it('does nothing until opened; then one page, degraded note, more button pages',async()=>{
  const h=load();await wait()
  expect(h.api).not.toHaveBeenCalled()
  ;(h.el('activity-open') as any).click();await wait()
  expect(h.api).toHaveBeenCalledWith('/m/api/activity')
  const rows=[...h.el('activity-list').querySelectorAll('.today-row')].map(r=>r.textContent)
  expect(rows[0]).toContain('一起做「修测试」做完了')
  expect(rows).toHaveLength(3)
  expect(h.el('activity-partial').hidden).toBe(false)
  expect(h.el('activity-more').hidden).toBe(false)
  ;(h.el('activity-more') as any).click();await wait()
  expect(h.api).toHaveBeenLastCalledWith('/m/api/activity?cursor=abc')
  expect(h.el('activity-list').querySelectorAll('.today-row')).toHaveLength(4)
  expect(h.el('activity-more').hidden).toBe(true)
 })
 it('tapping a task / terminal row opens it; a row without ref is not a button',async()=>{
  const h=load();(h.el('activity-open') as any).click();await wait()
  const rows=[...h.el('activity-list').querySelectorAll('.today-row')] as any[]
  rows[0].click();expect(h.opened).toEqual(['a1b2c3d4']);expect(h.panes).toContain('matters')
  rows[2].click();expect(h.terminals).toEqual(['sess-1'])
  expect(rows[1].tagName).toBe('DIV')
 })
 it('empty ⇒ says so; unreachable / link token ⇒ quiet note, no crash',async()=>{
  const e=load(vi.fn(async()=>response({ok:true,items:[],next:null,degraded:[]})));(e.el('activity-open') as any).click();await wait()
  expect(e.el('activity-list').textContent).toContain('这两周 CC 还没替你做过什么')
  const f=load(vi.fn(async()=>response({ok:false,error:'forbidden'},403)));(f.el('activity-open') as any).click();await wait()
  expect(f.el('activity-list').textContent).toContain('暂时看不到')
 })
})
