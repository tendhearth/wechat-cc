/// <reference lib="dom" />
// 手机网页(/m)在真浏览器里:收敛 5b(2026-10-21)之后「一起做」的详情只看状态 —— 标题、执行者、到哪了、额度这类状态,
// 外加「停下」。对话记录、成果、接着说、批准 / 回答都不在网页上;此刻页「等你」那张卡只看,点进来就是这一页。
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
    if(path==='/m/api/home')return route.fulfill({json:home})
    if(path==='/m/api/matters')return route.fulfill({json:{ok:true,matters:[matter]}})
    if(path==='/m/api/matter')return route.fulfill({json:{ok:true,bindings:[],sessions:[],...structuredClone(detail)}})
    if(path==='/m/api/matter/stop'&&route.request().method()==='POST'){sent.push({path,body:route.request().postDataJSON()});return route.fulfill({json:{ok:true}})}
    return route.fulfill({status:404,json:{ok:false,error:'not_found'}})
  })
})
afterEach(async()=>{await page?.close()})
async function open(){await page.goto('http://localhost/m');await page.locator('nav [data-p="matters"]').click();await page.locator('[data-mid="'+TASK+'"]').click()}

describe('phone web page: a matter is status only',()=>{
  it('shows title, executor and where it is; no dialogue, artifacts, say box or decision controls',async()=>{
    await open()
    await expect.poll(()=>page.locator('#m-status .m-state').textContent()).toBe('在做')
    expect(await page.locator('#m-title').textContent()).toBe('原任务')
    expect(await page.locator('#m-agents').isVisible()).toBe(true)
    expect(await page.locator('#m-status .m-now').textContent()).toContain('跑测试')
    const body=await page.locator('body').textContent()
    for(const gone of ['公开要求','公开答复','报告.md'])expect(body).not.toContain(gone)
    for(const sel of ['textarea','#m-events','#m-artifacts','#m-say','[data-control]','[data-handoff]','[data-artifact]'])expect(await page.locator(sel).count(),sel).toBe(0)
    expect(errors).toEqual([])
  })

  it('a pending decision and an exhausted quota read as status, with no buttons to act on them',async()=>{
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

  it('keeps 停下: arm, confirm, exactly one POST',async()=>{
    await open()
    const stop=page.locator('#m-status [data-stop]')
    await expect.poll(()=>stop.textContent()).toBe('停止这一轮')
    await stop.click()
    await expect.poll(()=>stop.textContent()).toBe('再点一次，确认停止')
    expect(sent).toEqual([])
    await stop.click()
    await expect.poll(()=>page.locator('#m-notice').textContent()).toBe('已经请电脑停下这一轮。')
    expect(sent).toEqual([{path:'/m/api/matter/stop',body:{id:TASK,runId:RUN}}])
  })

  it('the 此刻 card is view-only and opens the status page when tapped',async()=>{
    home.work={focus:{id:TASK,title:'**原任务**',kind:'decision'},partial:false}
    await page.goto('http://localhost/m')
    const card=page.locator('#home-focus .home-action')
    await expect.poll(()=>card.count()).toBe(1)
    expect(await card.textContent()).toBe('有件事等你决定原任务到手机 App 或电脑上拍板')
    expect(await page.locator('#home-focus button button, #home-focus [data-control]').count()).toBe(0)
    await card.click()
    await expect.poll(()=>page.locator('#m-title').textContent()).toBe('原任务')
    expect(await page.locator('#p-matters').isVisible()).toBe(true)
    expect(paths.filter(p=>p.startsWith('POST '))).toEqual([])
  })

  it('a /set link session reads only the routes still open to link tokens',async()=>{
    await page.goto('http://localhost/m?t=tLINK')
    await page.locator('nav [data-p="matters"]').click();await page.locator('[data-mid="'+TASK+'"]').click()
    await expect.poll(()=>page.locator('#m-status .m-state').textContent()).toBe('在做')
    expect(await page.locator('#pairbar').isVisible()).toBe(true)
    const api=[...new Set(paths.filter(p=>p.includes('/api/')))].sort()
    expect(api).toEqual(['GET /m/api/art/presence','GET /m/api/home','GET /m/api/matter','GET /m/api/matters'])
  })
})
