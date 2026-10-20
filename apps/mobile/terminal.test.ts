import {afterEach,describe,expect,it,vi} from 'vitest'
import {Window} from 'happy-dom'
import {PHONE_API_SCHEMAS} from '../../packages/protocol/src/index'
import {assembleMobilePage} from './assemble'
import {readMobileSource} from './sources'
import {createAgentAvatars} from '../desktop/src/shared/agent-avatars.js'

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
function load(api=vi.fn(async(path:string,_opts?:any)=>response(path==='/m/api/cli/sessions'?LIST:path.startsWith('/m/api/cli/activity')?{ok:true,items:[]}:{ok:true,accepted:true})),timers?:{setTimeout:any,clearTimeout:any}){
 const window=new Window({url:'https://fixture.test/m'});windows.push(window)
 const document=window.document;document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 // mAgents 在页面里由 workbench.js 顶上内联的那份工厂给(sources.ts);这里只载 terminal.js,直接给一份。
 const env={document,window,CustomEvent:window.CustomEvent,api,mAgents:createAgentAvatars(),setTimeout:timers?.setTimeout??window.setTimeout.bind(window),clearTimeout:timers?.clearTimeout??window.clearTimeout.bind(window),
  esc:(text:unknown)=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!)}
 const fns=new Function(...Object.keys(env),`${readMobileSource('terminal.js')}\nreturn {tmLoad,tmOpenSession,state:function(){return tm}}`)(...Object.values(env)) as any
 const pane=(name:string)=>document.dispatchEvent(new window.CustomEvent('cc:pane',{detail:{pane:name}}))
 const el=(id:string)=>document.getElementById(id)!
 return{...fns,window,document,api,pane,el}
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,5))

describe('phone page: terminal sessions in 一起做',()=>{
 it('夹具过真 schema',()=>{expect(PHONE_API_SCHEMAS['GET /m/api/cli/sessions']!.safeParse(LIST).success).toBe(true)})
 it('只在「一起做」可见时拉;列出项目 / 状态 / 哪家,结束了的不列;一行只有一个动作:能拍的写「看清楚 ›」,允许 / 拒绝只在展开后',async()=>{
  const h=load()
  await wait();expect(h.api).not.toHaveBeenCalled();expect(h.el('terminal-root').hidden).toBe(true)
  h.pane('matters');await wait()
  expect(h.api).toHaveBeenCalledWith('/m/api/cli/sessions',undefined)
  const text=h.el('terminal-list').textContent!
  expect(h.el('terminal-root').hidden).toBe(false)
  expect(text).toContain('blog');expect(text).toContain('等你决定');expect(text).toContain('Bash: npm run deploy');expect(text).toContain('歇着')
  // 哪家:行里不写名字,状态行尾一个圆头像,名字在读屏标签里(2026-10-19)
  expect(text).not.toContain('Claude Code');expect(text).not.toContain('Codex')
  expect(h.document.querySelector('[data-tm-row="s-wait"] small [role="img"]')!.getAttribute('aria-label')).toBe('Claude Code')
  expect(h.document.querySelector('[data-tm-row="s-idle"] small [role="img"]')!.getAttribute('aria-label')).toBe('Codex')
  expect(h.document.querySelector('[data-tm-row="s-cur"] small [role="img"]')!.getAttribute('aria-label')).toBe('Cursor')
  expect(h.document.querySelector('[data-tm-row="s-cur"] .th-agent svg')).not.toBeNull()
  expect(h.document.querySelector('[data-tm-row="s-end"]')).toBeNull()
  expect(h.document.querySelector('[data-tm-decide]')).toBeNull()
  expect(h.document.querySelector('[data-tm-row="s-wait"] .terminal-review')!.textContent).toBe('看清楚 ›')
  expect(h.document.querySelector('[data-tm-row="s-local"] .terminal-review')).toBeNull()
  expect(h.document.querySelector('[data-tm-row="s-local"]')!.textContent).toContain('回电脑上答')
  for(const row of h.document.querySelectorAll('[data-tm-row]'))expect(row.querySelectorAll('button').length).toBe(1)
  ;(h.document.querySelector('[data-tm-open="s-wait"]') as any).click()
  expect(h.document.querySelector('[data-tm-decide="allow"][data-tm-id="s-wait"]')).not.toBeNull()
  expect(h.document.querySelector('[data-tm-row="s-wait"] .terminal-review')).toBeNull()
  ;(h.document.querySelector('[data-tm-open="s-local"]') as any).click()
  expect(h.document.querySelector('[data-tm-decide][data-tm-id="s-local"]')).toBeNull()
 })
 it('允许:带会话 id 与码 POST /m/api/cli/permission;码失效 ⇒ 说清楚',async()=>{
  let n=0
  const api=vi.fn(async(path:string,_opts?:any)=>path==='/m/api/cli/sessions'?response(LIST):path.startsWith('/m/api/cli/activity')?response({ok:true,items:[]}):n++===0?response({ok:true}):response({ok:false,error:'cli_permission_stale'},409))
  const h=load(api);h.pane('matters');await wait()
  ;(h.document.querySelector('[data-tm-open="s-wait"]') as any).click()
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
  // 等批准时说的是「先拍板」,不是「还在跑」
  expect(h.document.querySelector('[data-tm-row="s-wait"]')!.textContent).toContain('它在等你决定，先拍板再说下一句。')
  expect(h.document.querySelector('[data-tm-row="s-wait"]')!.textContent).not.toContain('它还在跑')
  ;(h.document.querySelector('[data-tm-open="s-idle"]') as any).click()
  expect(h.document.querySelector('[data-tm-row="s-idle"]')!.textContent).toContain('测试全过了')
  const box=h.document.getElementById('terminal-say-s-idle') as any
  expect(box.disabled).toBe(false);box.value='  再跑一遍  '
  ;(h.document.querySelector('[data-tm-say="s-idle"]') as any).click();await wait()
  const post=h.api.mock.calls.find(([p]:any)=>p==='/m/api/cli/say')!
  expect(JSON.parse(post[1].body)).toEqual({session_id:'s-idle',text:'再跑一遍'})
  expect(h.document.querySelector('[data-tm-row="s-idle"]')!.textContent).toContain('回复会出现在这里')
 })
 it('拒绝 ⇒「已拒绝。」;此刻点一条 ⇒ 展开那一条(列表到了再展开)',async()=>{
  const h=load(),fns=h as any
  h.pane('matters');await wait()
  ;(h.document.querySelector('[data-tm-open="s-wait"]') as any).click()
  ;(h.document.querySelector('[data-tm-decide="deny"][data-tm-id="s-wait"]') as any).click();await wait()
  expect(h.document.querySelector('[data-tm-row="s-wait"]')!.textContent).toContain('已拒绝。')
  fns.tmOpenSession('s-idle')
  expect(h.state().open).toBe('s-idle')
  expect(h.document.querySelector('[data-tm-row="s-idle"] textarea')).not.toBeNull()
 })
 it('老电脑没有这条路由 ⇒ 整段不显示;离开「一起做」不再拉',async()=>{
  const api=vi.fn(async()=>response({error:'route_not_allowed'},403))
  const h=load(api);h.pane('matters');await wait()
  expect(h.el('terminal-root').hidden).toBe(true)
  h.pane('today');const n=api.mock.calls.length;await h.tmLoad();expect(api.mock.calls.length).toBe(n)
 })
 it('看着它跑:展开一行 ⇒ 拉最近几步,在跑时最后一步标「正在」;每 4 秒再拉;收起就停;读不到 ⇒ 退回最后一句',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
  try{
   const running={...idle,session_id:'s-run',status:'running',project:'web'}
   const ACT={ok:true,items:[{kind:'you',text:'修测试',at:NOW},{kind:'said',text:'先跑一遍',at:NOW},{kind:'step',text:'运行 npm test',at:NOW}]}
   expect(PHONE_API_SCHEMAS['GET /m/api/cli/activity']!.safeParse(ACT).success).toBe(true)
   const api=vi.fn(async(path:string)=>path==='/m/api/cli/sessions'?response({ok:true,sessions:[running,idle]}):path.includes('s-run')?response(ACT):response({ok:false,error:'cli_session_remote'},409))
   const h=load(api,{setTimeout:(f:any,ms:number)=>setTimeout(f,ms),clearTimeout:(t:any)=>clearTimeout(t)});h.pane('matters');await vi.advanceTimersByTimeAsync(5)
   ;(h.document.querySelector('[data-tm-open="s-run"]') as any).click();await vi.advanceTimersByTimeAsync(5)
   expect(api).toHaveBeenCalledWith('/m/api/cli/activity?session_id=s-run',undefined)
   const row=h.document.querySelector('[data-tm-row="s-run"]')!
   expect(row.textContent).toContain('它在做的事');expect(row.textContent).toContain('修测试');expect(row.textContent).toContain('先跑一遍')
   expect(row.querySelector('.ta-step.is-now')!.textContent).toContain('运行 npm test')
   expect(row.textContent).toContain('刚刚') // 页头时间取过程里较新的那个
   const n=()=>api.mock.calls.filter(([p])=>String(p).startsWith('/m/api/cli/activity')).length
   const before=n();await vi.advanceTimersByTimeAsync(4100);expect(n()).toBe(before+1)
   ;(h.document.querySelector('[data-tm-open="s-run"]') as any).click()
   const closed=n();await vi.advanceTimersByTimeAsync(12000);expect(n()).toBe(closed)
   ;(h.document.querySelector('[data-tm-open="s-idle"]') as any).click();await vi.advanceTimersByTimeAsync(5)
   const other=h.document.querySelector('[data-tm-row="s-idle"]')!.textContent!
   expect(other).toContain('另一台电脑');expect(other).toContain('测试全过了')
  }finally{vi.useRealTimers()}
 })
 it('点开一步:改文件看 diff(上色)、命令看输出;展开着的 4 秒重画后还开着;报错的标出来',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
  try{
   const running={...idle,session_id:'s-run',status:'running',project:'web'}
   const ACT={ok:true,items:[{kind:'step',text:'改 a.ts',at:NOW,detail:'- old\n+ new'},{kind:'step',text:'运行 npm test',at:NOW,detail:'1 failed',error:true}]}
   expect(PHONE_API_SCHEMAS['GET /m/api/cli/activity']!.safeParse(ACT).success).toBe(true)
   const api=vi.fn(async(path:string)=>path==='/m/api/cli/sessions'?response({ok:true,sessions:[running]}):response(ACT))
   const h=load(api,{setTimeout:(f:any,ms:number)=>setTimeout(f,ms),clearTimeout:(t:any)=>clearTimeout(t)});h.pane('matters');await vi.advanceTimersByTimeAsync(5)
   ;(h.document.querySelector('[data-tm-open="s-run"]') as any).click();await vi.advanceTimersByTimeAsync(5)
   const more=()=>[...h.document.querySelectorAll('.ta-more')] as any[]
   expect(more()).toHaveLength(2)
   expect(more()[0].querySelector('.ta-add').textContent).toBe('+ new')
   expect(more()[0].querySelector('.ta-del').textContent).toBe('- old')
   expect(more()[1].querySelector('summary').className).toContain('is-error')
   expect(more()[1].querySelector('.ta-add')).toBeNull() // 命令输出不上 diff 色
   more()[0].open=true;more()[0].dispatchEvent(new h.window.Event('toggle'))
   await vi.advanceTimersByTimeAsync(4100)
   expect(more()[0].open).toBe(true);expect(more()[1].open).toBe(false)
  }finally{vi.useRealTimers()}
 })
 it('列表一眼:在跑的带 now ⇒ 收起时显示「正在 · …」代替上一句',async()=>{
  const running={...idle,session_id:'s-run',status:'running',project:'web',last_summary:'上一轮的话',now:{kind:'step',text:'运行 npm test',at:NOW,verb:'run',target:'npm test'}}
  expect(PHONE_API_SCHEMAS['GET /m/api/cli/sessions']!.safeParse({ok:true,sessions:[running]}).success).toBe(true)
  const h=load(vi.fn(async(path:string)=>response(path==='/m/api/cli/sessions'?{ok:true,sessions:[running]}:{ok:true,items:[]})));h.pane('matters');await wait()
  const row=h.document.querySelector('[data-tm-row="s-run"]')!
  expect(row.querySelector('.terminal-summary.is-now')!.textContent).toBe('正在 运行 npm test')
  expect(row.textContent).not.toContain('上一轮的话')
 })
})
