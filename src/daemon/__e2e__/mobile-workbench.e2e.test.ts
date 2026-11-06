/// <reference lib="dom" />
// T5 决策 4：设备入口提供主人对话与已支持的响应；LINK 保留受限状态页。
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {phoneHtml} from '../../features/phone/settings-panel-html'

const icon=readFileSync(new URL('../../../apps/desktop/src/assets/pet/cc-v1/canonical/unlit/front.png',import.meta.url))

interface Locator {click():Promise<void>;count():Promise<number>;textContent():Promise<string|null>;isVisible():Promise<boolean>;isDisabled():Promise<boolean>}
interface Route {request():{url():string;method():string;postDataJSON():unknown};fulfill(options:{status?:number;json?:unknown;contentType?:string;body?:string|Buffer}):Promise<void>}
interface Page {route(url:string,handler:(route:Route)=>Promise<void>):Promise<void>;goto(url:string):Promise<unknown>;locator(selector:string):Locator;close():Promise<void>;on(event:'pageerror',fn:(e:Error)=>void):void}
interface Browser {newPage(options:{viewport:{width:number;height:number}}):Promise<Page>;close():Promise<void>}
const {chromium}=createRequire(new URL('../../../apps/desktop/package.json',import.meta.url))('@playwright/test') as {chromium:{launch(options:{headless:boolean}):Promise<Browser>}}

let browser:Browser,page:Page
const TASK='deadbeef',RUN='11111111-1111-4111-8111-111111111111'
const matter={id:TASK,kind:'task',title:'**原任务**',status:'open',agents:['codex']}
let detail:Record<string,any>,home:Record<string,any>,sent:Array<{path:string;body:any}>,paths:string[],errors:string[]
beforeAll(async()=>{browser=await chromium.launch({headless:true})})
afterAll(async()=>{await browser?.close()})
beforeEach(async()=>{
  page=await browser.newPage({viewport:{width:390,height:844}});sent=[];paths=[];errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  detail={matter,task:{id:TASK,providerId:'codex',phase:'working',status:'running',error:null},runId:RUN,
    events:[{kind:'user',text:'公开要求',createdAt:1},{kind:'text',text:'公开答复',createdAt:2},{kind:'tool_call',text:'bun test',createdAt:3,activity:{type:'command',status:'running',label:'跑测试'}}],
    permissions:[],questions:[],artifacts:[{id:'a1',taskId:TASK,name:'报告.md',mime:'text/markdown',size:10,sha256:'x',createdAt:1,approvedAt:null}],inputs:[]}
  home={ok:true,synced_at:new Date().toISOString(),today:'2026-10-21',presence:{presence:'ok',activity:{kind:'working',label:'在帮你改首页',since:null},news:{unread:0,latest_kind:null,latest_title:null}},
    work:{focus:null,partial:false},unread:0,seen_until:null,events:[],next_cursor:null,sources_degraded:[]}
  await page.route('http://localhost/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname
    paths.push(route.request().method()+' '+path)
    if(path==='/m')return route.fulfill({contentType:'text/html',body:phoneHtml(url.searchParams.get('t')?'tLINK':'device-test',null)})
    if(path==='/m/icon.png')return route.fulfill({contentType:'image/png',body:icon})
    // Match the page's v1 LAN calls; retired /m/api aliases must stay unavailable.
    if(path==='/v1/phone/art/presence')return route.fulfill({json:{ok:false}})
    if(path==='/v1/matter/owner-chat/page')return route.fulfill({json:{ok:true,conversation:'v1',matterId:'owner-chat',messages:[{id:'u1',role:'me',text:'主人提问',at:1},{id:'c1',role:'cc',text:'CC 回复',at:2}],hasMore:false,nextBefore:null}})
    if(path==='/v1/home')return route.fulfill({json:home})
    if(path==='/v1/matters')return route.fulfill({json:{ok:true,matters:[matter]}})
    if(path==='/v1/matter')return route.fulfill({json:{ok:true,bindings:[],sessions:[],...structuredClone(detail)}})
    if(path==='/v1/matter/stop'&&route.request().method()==='POST'){sent.push({path,body:route.request().postDataJSON()});return route.fulfill({json:{ok:true}})}
    return route.fulfill({status:404,json:{ok:false,error:'not_found'}})
  })
})
afterEach(async()=>{await page?.close()})
// LINK 继续从状态列表打开；设备按 T5 事项深链进入，避免依赖已撤掉的首页列表。
async function open(device=false){await page.goto(device?'http://localhost/m?matter='+TASK:'http://localhost/m?t=tLINK');if(device)await expect.poll(()=>page.locator('#chat-messages').textContent()).toContain('CC 回复');else await page.locator('[data-mid="'+TASK+'"]').click()}

describe('phone web page: T5 device conversation and restricted LINK status',()=>{
  it('device shows dialogue, say box, process and artifacts alongside matter status',async()=>{
    await page.goto('http://localhost/m')
    await expect.poll(()=>page.locator('#chat-messages').textContent()).toContain('CC 回复')
    // T5 设备首页的说话框必须实际可见，不能仅有隐藏的 textarea。
    expect(await page.locator('#chat-input').isVisible()).toBe(true)
    await open(true)
    await expect.poll(()=>page.locator('#m-status .m-state').textContent()).toBe('在做')
    expect(await page.locator('#m-title').textContent()).toBe('原任务')
    expect(await page.locator('#m-agents').isVisible()).toBe(true)
    expect(await page.locator('#m-status .m-now').textContent()).toContain('跑测试')
    const body=await page.locator('body').textContent()
    // T5 决策 4：设备可读主人对话、事项过程/结果和授权成果，旧的全文排除已过时。
    for(const text of ['主人提问','CC 回复','公开要求','公开答复','报告.md'])expect(body).toContain(text)
    // T5 使用 chat-input 和过程/成果折叠层，替代旧的 textarea/成果控件不存在断言。
    for(const sel of ['#chat-input','#m-status .matter-process','#m-status .matter-results','#m-status [data-artifact]'])expect(await page.locator(sel).count(),sel).toBe(1)
    // 旧容器和额度交接仍未开放；把已支持的输入/成果从排除列表移走。
    for(const sel of ['#m-events','#m-artifacts','#m-say','[data-control]','[data-handoff]'])expect(await page.locator(sel).count(),sel).toBe(0)
    expect(errors).toEqual([])
  })

  it('device exposes the approved permission and question responses',async()=>{
    detail.task.phase='replied'
    detail.permissions=[{id:'p1',taskId:TASK,tool:'Bash',description:'rm -rf tmp',createdAt:1}]
    detail.questions=[{id:'q1',taskId:TASK,questions:[{id:'choice',header:'选择',question:'继续吗？',options:[{label:'继续',description:'继续处理'}],multiSelect:false,allowOther:true}]}]
    await open(true)
    // T5 决策 4：批准/拒绝及问题回答是设备网页已批准支持的响应类型。
    for(const decision of ['allow','deny'])expect(await page.locator('#m-response [data-decision="'+decision+'"]').isVisible()).toBe(true)
    expect(await page.locator('#m-response').textContent()).toContain('rm -rf tmp')
    expect(await page.locator('#m-response [data-question="q1"]').isVisible()).toBe(true)
    expect(await page.locator('#m-response [data-question="q1"] button').isDisabled()).toBe(false)
    expect(errors).toEqual([])
  })

  it('LINK: a pending decision and an exhausted quota read as status, with no buttons to act on them',async()=>{
    detail.task.phase='replied';detail.events=[]
    detail.permissions=[{id:'p1',taskId:TASK,tool:'Bash',description:'rm -rf tmp',createdAt:1}]
    detail.quotaHandoff={state:'offer',from:'codex',to:'claude',kind:'quota',resetAt:Date.now()+20*60000}
    // 名字只读 daemon 下发的 agentNames(收敛清单 ⑥);这里伪装 daemon,就照它的样子带上
    detail.matter.agentNames={codex:'Codex',claude:'Claude'}
    await open()
    await expect.poll(()=>page.locator('#m-status .m-state').textContent()).toBe('等你决定')
    const status=await page.locator('#m-status').textContent()
    expect(status).toContain('有 1 项等你决定')
    expect(status).toContain('Codex 的额度已用完')
    expect(status).not.toContain('rm -rf tmp')
    expect(await page.locator('#m-status button').count()).toBe(0)
    // 老 daemon 不带 agentNames ⇒ 退回原始 id,不猜名字
    delete detail.matter.agentNames
    await open()
    await expect.poll(()=>page.locator('#m-status').textContent()).toContain('codex 的额度已用完')
  })

  it('LINK keeps 停下: arm, confirm, exactly one POST',async()=>{
    await open()
    const stop=page.locator('#m-status [data-stop]')
    await expect.poll(()=>stop.textContent()).toBe('停止这一轮')
    await stop.click()
    await expect.poll(()=>stop.textContent()).toBe('再点一次，确认停止')
    expect(sent).toEqual([])
    await stop.click()
    await expect.poll(()=>page.locator('#m-notice').textContent()).toBe('已经请电脑停下这一轮。')
    expect(sent).toEqual([{path:'/v1/matter/stop',body:{id:TASK,runId:RUN}}])
  })

  it('LINK: the 此刻 card is view-only and opens the status page when tapped',async()=>{
    home.work={focus:{id:TASK,title:'**原任务**',kind:'decision'},partial:false}
    // 旧只读此刻卡属于 LINK 后备页；设备首页已改为 T5 对话。
    await page.goto('http://localhost/m?t=tLINK')
    const card=page.locator('#home-focus .home-action')
    await expect.poll(()=>card.count()).toBe(1)
    expect(await card.textContent()).toBe('有件事等你决定原任务到手机 App 或电脑上拍板')
    expect(await page.locator('#home-focus button button, #home-focus [data-control]').count()).toBe(0)
    await card.click()
    await expect.poll(()=>page.locator('#m-title').textContent()).toBe('原任务')
    expect(await page.locator('#m-detail').isVisible()).toBe(true)
    expect(await page.locator('#m-home').isVisible()).toBe(false)
    expect(paths.filter(p=>p.startsWith('POST '))).toEqual([])
  })

  it('a /set link session reads only the routes still open to link tokens',async()=>{
    // 即使后台有待响应请求，LINK 也不能显示正文或动作。
    detail.permissions=[{id:'p1',taskId:TASK,tool:'Bash',description:'rm -rf tmp',createdAt:1}]
    await page.goto('http://localhost/m?t=tLINK')
    await page.locator('[data-mid="'+TASK+'"]').click()
    // 新增待批准 fixture 后应显示等你决定；这只是状态，不授予 LINK 响应能力。
    await expect.poll(()=>page.locator('#m-status .m-state').textContent()).toBe('等你决定')
    expect(await page.locator('#pairbar').isVisible()).toBe(true)
    // T5 不提升 LINK 权限：保留旧的内容排除，并检查新对话/响应控件不可见。
    const body=await page.locator('body').textContent()
    for(const gone of ['公开要求','公开答复','报告.md','主人提问','CC 回复','rm -rf tmp'])expect(body).not.toContain(gone)
    for(const sel of ['textarea','#chat-input','#conversation','#m-response [data-decision]','#m-response [data-question]'])expect(await page.locator(sel).isVisible(),sel).toBe(false)
    for(const sel of ['#m-events','#m-artifacts','#m-say','[data-control]','[data-handoff]','[data-artifact]'])expect(await page.locator(sel).count(),sel).toBe(0)
    const api=[...new Set(paths.filter(p=>/^(?:GET|POST) \/(?:v1|m\/api)\//.test(p)))].sort()
    expect(api).toEqual(['GET /v1/home','GET /v1/matter','GET /v1/matters','GET /v1/phone/art/presence'])
  })
})
