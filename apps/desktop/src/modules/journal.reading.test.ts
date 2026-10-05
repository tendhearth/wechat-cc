import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
import {Window} from 'happy-dom'
const api=vi.fn(),toast=vi.fn()
vi.mock('../api.js',()=>({invokeApi:(...args:unknown[])=>api(...args)}))
vi.mock('../view.js',()=>({escapeHtml:(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)),showToast:(...args:unknown[])=>toast(...args)}))
let win:Window,mod:typeof import('./journal.js')
const record={id:'r1',ts:'2026-10-03T09:00:00Z',chat_id:'demo',title:'能一起种的花园',url:'https://example.test/garden',note:'第一段推荐。\n第二段讲用法。\n第三段是一段完整的推荐理由，应该能够完整阅读。',status:'new',kind:'hunt'}
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve()}
beforeEach(async()=>{
 win=new Window({url:'http://localhost'})
 for(const key of ['window','document','HTMLElement','HTMLButtonElement','HTMLDialogElement','Node'] as const)vi.stubGlobal(key,key==='window'?win:win[key])
 ;(win.HTMLDialogElement.prototype as any).showModal=function(){this.open=true}
 ;(win.HTMLDialogElement.prototype as any).close=function(){this.open=false}
 document.body.innerHTML='<div id="fd-catch"></div><span id="fd-catch-count"></span>'
 api.mockReset();toast.mockReset();vi.resetModules();mod=await import('./journal.js');mod.initHuntBag()
})
afterEach(async()=>{(mod as any).deactivateHuntBag?.();await win.happyDOM.abort();vi.unstubAllGlobals()})
const button=(selector:string)=>document.querySelector<HTMLButtonElement>(selector)!
async function open(){mod.renderHuntBag({items:[record]});button('[data-hb-action="open"]').click();await tick();return document.querySelector<HTMLDialogElement>('dialog')!}
describe('带回来的先读再操作',()=>{
 it('列表只有阅读入口，状态/复制/删除留在完整详情',async()=>{
  mod.renderHuntBag({items:[record]})
  expect(document.querySelector('[data-hb-action="open"]')).not.toBeNull()
  expect(document.querySelector('[data-hb-action="status"]')).toBeNull()
  expect(document.querySelector('[data-hb-action="remove"]')).toBeNull()
  const dialog=await open();expect(dialog.textContent).toContain('第三段是一段完整的推荐理由')
  expect(dialog.querySelector('a')?.getAttribute('href')).toBe(record.url)
  expect(dialog.querySelector('[data-hb-action="status"]')?.closest('details')).not.toBeNull()
 })
 it('状态等待中禁用重复提交，成功更新当前详情',async()=>{
  let done!:(r:unknown)=>void
  api.mockImplementation((_m:string,path:string)=>path==='/v1/journal/status'?new Promise(r=>{done=r}):Promise.resolve({items:[{...record,status:'using'}]}))
  const dialog=await open();const status=button('dialog [data-hb-status="using"]')
  status.click();status.click();await tick()
  expect(api.mock.calls.filter(c=>c[1]==='/v1/journal/status')).toHaveLength(1);expect(status.disabled).toBe(true)
  done({ok:true});await tick();expect(dialog.querySelector('[data-hb-status="using"]')?.getAttribute('aria-pressed')).toBe('true')
 })
 it('读取失败给原地重试，不冒充空收获',async()=>{
  api.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({items:[record]})
  await mod.refreshHuntBag();expect(document.getElementById('fd-catch')?.textContent).toContain('暂时无法读取')
  const retry=button('[data-hb-action="retry"]');expect(retry).not.toBeNull();retry.click();await tick();expect(document.getElementById('fd-catch')?.textContent).toContain(record.title)
 })
 it('离开后迟到读取不覆盖新列表',async()=>{
  let done!:(r:unknown)=>void
  api.mockImplementationOnce(()=>new Promise(r=>{done=r}));const old=mod.refreshHuntBag()
  expect(typeof (mod as any).deactivateHuntBag).toBe('function');(mod as any).deactivateHuntBag()
  mod.renderHuntBag({items:[{...record,title:'当前的新记录'}]});done({items:[record]});await old
  expect(document.getElementById('fd-catch')?.textContent).toContain('当前的新记录')
 })
 it('见闻的SVG作为图片打开，不把活动标签注入主文档',async()=>{
  mod.renderHuntBag({items:[{...record,kind:'visit',image_svg:'<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>'}]})
  expect(document.getElementById('fd-catch')?.querySelector('script')).toBeNull();button('[data-hb-action="open"]').click();await tick()
  expect(document.querySelector('dialog script')).toBeNull();expect(document.querySelector('dialog img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
 })
})

describe('收获的失败与离页协调',()=>{
 it('删除最后一条保留记录后，焦点回到可见的不要了标题',async()=>{
  const dropped={...record,id:'dropped',status:'dropped'}
  api.mockImplementation((_m:string,path:string)=>Promise.resolve(path==='/v1/journal/remove'?{ok:true}:{items:[dropped]}))
  mod.renderHuntBag({items:[record,dropped]});button('[data-hb-action="open"]').click();await tick()
  button('dialog [data-hb-action="remove"]').click();await tick()
  expect(document.querySelector('dialog')).toBeNull()
  expect(document.activeElement).toBe(document.querySelector('.hb-dropped>summary'))
 })
 it('旧重试不覆盖后来的完整列表渲染',async()=>{
  let done!:(value:unknown)=>void
  api.mockImplementationOnce(()=>new Promise(r=>{done=r}));const old=mod.refreshHuntBag()
  mod.renderHuntBag({items:[{...record,title:'后来已确认的新内容'}]});done({items:[record]});await old
  expect(document.getElementById('fd-catch')?.textContent).toContain('后来已确认的新内容')
 })
 it('已确认的状态不因随后读取失败退回，详情中可重新读取',async()=>{
  let failed=true
  api.mockImplementation((_m:string,path:string)=>path==='/v1/journal/status'?Promise.resolve({ok:true}):failed?Promise.reject(new Error('offline')):Promise.resolve({items:[{...record,status:'using'}]}))
  const dialog=await open();button('dialog [data-hb-status="using"]').click();await tick()
  expect(button('dialog [data-hb-status="using"]').getAttribute('aria-pressed')).toBe('true')
  expect(dialog.textContent).toContain('暂时无法重新读取')
  expect(button('dialog [data-hb-action="retry"]')).not.toBeNull()
  failed=false;button('dialog [data-hb-action="retry"]').click();await tick()
  expect(dialog.querySelector('.hb-detail-feedback')).toBeNull()
 })
 it('网络失败不声称记录已不存在，保留详情重试',async()=>{
  api.mockImplementation((_m:string,path:string)=>path==='/v1/journal/status'?Promise.reject(new Error('offline')):Promise.resolve({items:[record]}))
  const dialog=await open();button('dialog [data-hb-status="using"]').click();await tick()
  expect(toast).toHaveBeenCalledWith('暂时没能更新这条记录，请重试。');expect(dialog.isConnected).toBe(true);expect(button('dialog [data-hb-status="using"]').disabled).toBe(false)
 })
 it('离页后的迟到删除不重新读取隐藏页面或关闭新的阅读器',async()=>{
  let done!:(r:unknown)=>void
  api.mockImplementation(()=>new Promise(r=>{done=r}));await open();button('dialog [data-hb-action="remove"]').click();await tick();(mod as any).deactivateHuntBag()
  done({ok:true});await tick();expect(api.mock.calls.filter(c=>c[0]==='GET')).toHaveLength(0);expect(toast).not.toHaveBeenCalled()
 })
 it('完整详情也拒绝不安全链接',async()=>{
  mod.renderHuntBag({items:[{...record,url:'javascript:alert(1)'}]});button('[data-hb-action="open"]').click();await tick()
  expect(document.querySelector('dialog a')).toBeNull()
 })
})
