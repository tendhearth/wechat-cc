/// <reference lib="dom" />
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {phoneHtml} from '../settings-panel-html'

const icon=readFileSync(new URL('../../../apps/desktop/src/assets/pet/cc-v1/canonical/unlit/front.png',import.meta.url))

interface Locator {click():Promise<void>;count():Promise<number>;textContent():Promise<string|null>;fill(text:string):Promise<void>;inputValue():Promise<string>;evaluate<T>(fn:(el:any)=>T):Promise<T>}
interface Route {request():{url():string;method():string;postDataJSON():unknown};fulfill(options:{status?:number;json?:unknown;contentType?:string;body?:string|Buffer}):Promise<void>}
interface Page {route(url:string,handler:(route:Route)=>Promise<void>):Promise<void>;goto(url:string):Promise<unknown>;locator(selector:string):Locator;getByRole(role:string,options:{name:string;exact?:boolean}):Locator;evaluate<T>(fn:()=>T):Promise<T>;close():Promise<void>;addInitScript(fn:()=>void):Promise<void>;screenshot(options:{path:string;fullPage:boolean}):Promise<unknown>}
interface Browser {newPage(options:{viewport:{width:number;height:number}}):Promise<Page>;close():Promise<void>}
const {chromium}=createRequire(new URL('../../../apps/desktop/package.json',import.meta.url))('@playwright/test') as {chromium:{launch(options:{headless:boolean}):Promise<Browser>}}

let browser:Browser,page:Page
const TASK='deadbeef',OTHER='cafefeed',RUN='11111111-1111-4111-8111-111111111111',REQUEST='22222222-2222-4222-8222-222222222222'
const matter=(id=TASK)=>({id,kind:'task',title:id===TASK?'原任务':'另一件事',status:'open'})
const permission={id:REQUEST,taskId:TASK,tool:'Bash',description:'删除临时探针 <script>evil()</script>',createdAt:1}
const question={id:REQUEST,taskId:TASK,createdAt:1,questions:[{id:'format',header:'格式',question:'写成哪种？',options:[{label:'文字',description:'纯文本'}],allowOther:true,multiSelect:false}]}
let detail:Record<string,any>,sent:Array<{path:string;body:any}>,requests:number
let responseGate:Promise<void>|null,release:()=>void
beforeAll(async()=>{browser=await chromium.launch({headless:true})})
afterAll(async()=>{await browser?.close()})
beforeEach(async()=>{
  page=await browser.newPage({viewport:{width:390,height:844}});sent=[];requests=0;responseGate=null
  detail={matter:matter(),task:{id:TASK},events:[],runId:RUN,permissions:[],questions:[],artifacts:[],inputs:[]}
  await page.route('http://localhost/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname
    if(path==='/m')return route.fulfill({contentType:'text/html',body:phoneHtml('device-test',null)})
    if(path==='/m/icon.png')return route.fulfill({contentType:'image/png',body:icon})
    if(path==='/m/api/matters')return route.fulfill({json:{ok:true,matters:[matter(),matter(OTHER)]}})
    if(path==='/m/api/matter'){
      requests++;const copy=url.searchParams.get('id')===TASK?structuredClone(detail):{...structuredClone(detail),matter:matter(OTHER),task:{id:OTHER},permissions:[],questions:[]}
      if(responseGate&&url.searchParams.get('id')===TASK)await responseGate
      return route.fulfill({json:{ok:true,...copy}})
    }
    if(route.request().method()==='POST'&&['/m/api/matter/permission','/m/api/matter/answer','/m/api/matter/say'].includes(path)){
      sent.push({path,body:route.request().postDataJSON()});if(responseGate)await responseGate
      detail.permissions=[];detail.questions=[]
      return route.fulfill({json:{ok:true,result:{kind:'task',task:{id:TASK}}}})
    }
    return route.fulfill({json:{ok:true,events:[],todos:{active:[],settled:[]},stickers:[],portrait:null,unread:0}})
  })
})
afterEach(async()=>{release?.();await page?.close()})
async function open(){await page.goto('http://localhost/m');await page.locator('nav [data-p="matters"]').click();await page.locator('[data-mid="'+TASK+'"]').click()}

describe('mobile task page in a real browser',()=>{
  it.each(['held','delivered','withdrawn'])('keeps a sending supplement until its matching late %s receipt and reuses its request id',async outcome=>{
    await page.route('http://localhost/m/api/matter/say?**',route=>{
      const body=route.request().postDataJSON() as any;sent.push({path:'/m/api/matter/say',body})
      detail.inputs=[{id:body.requestId,taskId:TASK,runId:RUN,text:body.text,status:'sending'}]
      return route.fulfill({json:{ok:true,result:{kind:'task',task:{id:TASK},input:detail.inputs[0]}}})
    })
    await open();await page.locator('#m-say').fill('不能丢失的补充');await page.locator('#m-send').click()
    await expect.poll(()=>sent.length).toBe(1)
    await expect.poll(()=>page.locator('#m-notice').textContent()).toContain('等待执行者确认')
    expect(await page.locator('#m-say').inputValue()).toBe('不能丢失的补充')
    await page.locator('#m-send').click();await expect.poll(()=>sent.length).toBe(2)
    expect(sent[1]!.body.requestId).toBe(sent[0]!.body.requestId)
    detail.inputs[0].status=outcome
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))
    await expect.poll(()=>page.locator(outcome==='delivered'?'#m-notice':'#m-inputs').textContent()).toContain(outcome==='held'?'未确认送达':outcome==='withdrawn'?'已撤回':'已送达')
    if(outcome==='delivered')expect(await page.locator('#m-inputs .card').count()).toBe(0)
    await expect.poll(()=>page.locator('#m-say').inputValue()).toBe(outcome==='delivered'?'':'不能丢失的补充')
    await open()
    expect(await page.locator('#m-say').inputValue()).toBe(outcome==='delivered'?'':'不能丢失的补充')
  })
  it.each(['held','delivered'])('never replaces a later edit with an older %s receipt and keeps unconfirmed text recoverable',async outcome=>{
    await page.route('http://localhost/m/api/matter/say?**',route=>{
      const body=route.request().postDataJSON() as any;sent.push({path:'/m/api/matter/say',body})
      detail.inputs=[{id:body.requestId,taskId:TASK,runId:RUN,text:body.text,status:'pending'}]
      return route.fulfill({json:{ok:true,result:{kind:'task',task:{id:TASK},input:detail.inputs[0]}}})
    })
    await open();await page.locator('#m-say').fill('原先那条补充');await page.locator('#m-send').click()
    await expect.poll(()=>page.locator('#m-notice').textContent()).toContain('等待执行者')
    await page.locator('#m-say').fill('后来编辑的新补充')
    detail.inputs[0].status=outcome
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))
    if(outcome==='held')await expect.poll(()=>page.locator('#m-inputs').textContent()).toContain('未确认送达')
    else await expect.poll(()=>page.locator('#m-inputs .card').count()).toBe(0)
    expect(await page.locator('#m-say').inputValue()).toBe('后来编辑的新补充')
    if(outcome==='held'){
      expect(await page.locator('#m-inputs').textContent()).toContain('原先那条补充')
      await page.getByRole('button',{name:'取回这条补充',exact:true}).click()
      expect(await page.locator('#m-say').inputValue()).toBe('后来编辑的新补充')
    }
    await open();expect(await page.locator('#m-say').inputValue()).toBe('后来编辑的新补充')
    if(outcome==='held'){
      await page.locator('#m-say').fill('');await page.getByRole('button',{name:'取回这条补充',exact:true}).click()
      expect(await page.locator('#m-say').inputValue()).toBe('原先那条补充')
      await page.locator('#m-send').click();await expect.poll(()=>sent.length).toBe(2)
      expect(sent[1]!.body.requestId).toBe(sent[0]!.body.requestId)
    }
  })
  it('keeps the draft and waits for confirmation when an older task receipt is absent from the detail window',async()=>{
    await open();await page.locator('#m-say').fill('还没有找到回执的补充');await page.locator('#m-send').click()
    await expect.poll(()=>page.locator('#m-notice').textContent()).toContain('等待执行者确认')
    expect(await page.locator('#m-say').inputValue()).toBe('还没有找到回执的补充')
    await open();expect(await page.locator('#m-say').inputValue()).toBe('还没有找到回执的补充')
  })
  it('shows a single-use permission card bound to its original task/run/request',async()=>{
    detail.permissions=[permission,{...permission,id:'foreign',taskId:OTHER,description:'OTHER SECRET'}]
    detail.questions=[question]
    await open()
    const allow=page.getByRole('button',{name:'允许这一次',exact:true})
    await expect.poll(()=>allow.count()).toBe(1)
    expect(await page.locator('#m-detail').textContent()).not.toContain('OTHER SECRET')
    if(process.env.MOBILE_WORKBENCH_SCREENSHOT)await page.screenshot({path:process.env.MOBILE_WORKBENCH_SCREENSHOT,fullPage:true})
    responseGate=new Promise<void>(r=>{release=r})
    await allow.click();await allow.evaluate((el:any)=>el.click())
    await expect.poll(()=>sent.length).toBe(1)
    expect(sent[0]).toEqual({path:'/m/api/matter/permission',body:{id:TASK,runId:RUN,requestId:REQUEST,decision:'allow'}})
    release();responseGate=null
    await expect.poll(()=>allow.count()).toBe(0)
    expect(await page.evaluate(()=>typeof (window as any).evil)).toBe('undefined')
  })
  it('refreshes foreground detail without destroying question or supplemental drafts, and retains them after reload',async()=>{
    detail.questions=[question];await open()
    const other=page.locator('[data-answer-other="format"]')
    await expect.poll(()=>other.count()).toBe(1)
    await other.fill('我自己的格式');await page.locator('#m-say').fill('正在写的补充')
    detail.events=[{kind:'text',text:'新的进度',createdAt:1}]
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))
    await expect.poll(()=>page.locator('#m-events').textContent()).toContain('新的进度')
    expect(await other.inputValue()).toBe('我自己的格式');expect(await page.locator('#m-say').inputValue()).toBe('正在写的补充')
    await open()
    expect(await other.inputValue()).toBe('我自己的格式');expect(await page.locator('#m-say').inputValue()).toBe('正在写的补充')
  })
  it('holds question fields steady until the original answer submission completes',async()=>{
    detail.questions=[question];await open()
    const other=page.locator('[data-answer-other="format"]')
    await other.fill('我自己的格式')
    responseGate=new Promise<void>(r=>{release=r})
    await page.getByRole('button',{name:'提交回答',exact:true}).click()
    await expect.poll(()=>sent.length).toBe(1)
    expect(sent[0]).toEqual({path:'/m/api/matter/answer',body:{id:TASK,runId:RUN,requestId:REQUEST,answers:{format:['我自己的格式']}}})
    expect(await other.evaluate((el:any)=>el.disabled)).toBe(true)
    release();responseGate=null
  })
  it('discards an old detail response after switching to a different task',async()=>{
    responseGate=new Promise<void>(r=>{release=r})
    await open();await expect.poll(()=>requests).toBe(1)
    await page.locator('#m-back').click();await page.locator('[data-mid="'+OTHER+'"]').click()
    await expect.poll(()=>page.locator('#m-title').textContent()).toContain('另一件事')
    release();responseGate=null
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))
    await expect.poll(()=>requests).toBeGreaterThanOrEqual(3)
    expect(await page.locator('#m-title').textContent()).toContain('另一件事')
  })
  it.each(['webcrypto','lan-http'])('assembles a large artifact in bounded chunks and previews markup as inert text (%s)',async mode=>{
    if(mode==='lan-http')await page.addInitScript(()=>{Object.defineProperty(crypto,'subtle',{value:undefined})})
    const bytes=Buffer.from('<script>window.artifactRan=true</script>'+ '报告'.repeat(110000)),sha256=createHash('sha256').update(bytes).digest('hex')
    const artifact={id:REQUEST,taskId:TASK,name:'report.html',mime:'text/html',size:bytes.length,sha256,createdAt:1}
    detail.artifacts=[artifact];let chunks=0
    await page.route('http://localhost/m/api/matter/artifact?**',async route=>{
      const q=new URL(route.request().url()).searchParams,offset=Number(q.get('offset')),part=bytes.subarray(offset,offset+128*1024);chunks++
      expect(q.get('sha256')).toBe(sha256)
      return route.fulfill({json:{ok:true,taskId:TASK,artifactId:REQUEST,name:artifact.name,mime:artifact.mime,size:bytes.length,sha256,offset,nextOffset:offset+part.length,contentBase64:part.toString('base64')}})
    })
    await open();await page.getByRole('button',{name:'查看 report.html',exact:true}).click()
    await expect.poll(()=>page.locator('#m-artifact-preview').textContent()).toContain('<script>window.artifactRan=true</script>')
    expect(chunks).toBeGreaterThan(4);expect(await page.evaluate(()=>(window as any).artifactRan)).toBeUndefined()
    expect(await page.locator('#m-artifact-preview script').count()).toBe(0)
  })
  it('refuses to open a file whose received bytes fail the saved hash',async()=>{
    const bytes=Buffer.from('changed content'),sha256=createHash('sha256').update('original content').digest('hex')
    detail.artifacts=[{id:REQUEST,taskId:TASK,name:'report.txt',mime:'text/plain',size:bytes.length,sha256,createdAt:1}]
    await page.route('http://localhost/m/api/matter/artifact?**',route=>route.fulfill({json:{ok:true,taskId:TASK,artifactId:REQUEST,name:'report.txt',mime:'text/plain',size:bytes.length,sha256,offset:0,nextOffset:bytes.length,contentBase64:bytes.toString('base64')}}))
    await open();await page.getByRole('button',{name:'查看 report.txt',exact:true}).click()
    await expect.poll(()=>page.locator('#m-notice').textContent()).toContain('文件校验未通过')
    expect(await page.locator('#m-artifact-preview a').count()).toBe(0)
  })
  it('removes stale decision controls and disables sending when the complete detail is too large, preserving drafts',async()=>{
    detail.permissions=[permission];detail.questions=[question];await open()
    await page.locator('#m-say').fill('保留的补充')
    await page.locator('[data-answer-other="format"]').fill('保留的答案')
    await page.route('http://localhost/m/api/matter?**',route=>route.fulfill({status:413,json:{ok:false,error:'detail_too_large'}}))
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))
    await expect.poll(()=>page.locator('#m-notice').textContent()).toContain('完整内容过长，请到桌面查看')
    expect(await page.getByRole('button',{name:'允许这一次',exact:true}).count()).toBe(0)
    expect(await page.locator('#m-send').evaluate((el:any)=>el.disabled)).toBe(true)
    expect(await page.locator('#m-say').inputValue()).toBe('保留的补充')
    const saved=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('cc.phone.matter.v1:')).map(k=>localStorage.getItem(k)).join('\n'))
    expect(saved).toContain('保留的答案');expect(saved).toContain('保留的补充')
  })
})
