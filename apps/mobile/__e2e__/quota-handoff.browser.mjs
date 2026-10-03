// Assembled production PWA, isolated synthetic data and intercepted requests only.
// Run with: bun apps/mobile/__e2e__/quota-handoff.browser.mjs
import {mkdir,writeFile} from 'node:fs/promises'
import {assembleMobilePage} from '../assemble.ts'
import {readMobileSource} from '../sources.ts'
import {chromium,expect} from '../../desktop/node_modules/@playwright/test/index.mjs'

const out='/tmp/tendhearth-pwa-quota-handoff-qa',source='deadbeef',next='feedface',other='1234abcd'
await mkdir(out,{recursive:true})
const html=assembleMobilePage(readMobileSource).phone.replace('{{TOKEN_JSON}}','"dFixture"').replace('{{REMOTE_JSON}}','null').replaceAll('{{BRAND_ICON_VERSION}}','fixture')
const browser=await chromium.launch({headless:true}),evidence=[]
try{for(const width of [390,1000]){
  const context=await browser.newContext({viewport:{width,height:850},serviceWorkers:'block'}),page=await context.newPage(),errors=[],calls=[]
  const offer=(to='codex')=>({state:'offer',from:'claude',to,kind:'quota',resetAt:Date.now()+600000})
  let handoff=offer(),postMode='success',releasePost=null,taskError=null
  let events=[{kind:'text',text:'# 正在阅读\n\n保留我的阅读位置\n\n```ts\nconst '+ 'wide_identifier_'.repeat(30)+' = 1\n```',createdAt:123}]
  const detail=id=>({ok:true,matter:{id,kind:'task',title:id===source?'额度用完后的任务':id===next?'接手任务':'另一件事',status:'open'},
    task:{id,path:'/fixture/work',providerId:'claude',error:id===source?taskError:null,status:'failed'},events,permissions:[],questions:[],artifacts:[],inputs:[],attachments:[],...(id===source?{quotaHandoff:handoff}:{})})
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('http://quota-handoff.test/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname
    calls.push({path,method:request.method(),body:request.postDataJSON()})
    if(path==='/m'){await route.fulfill({contentType:'text/html',body:html});return}
    const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)})
    if(path==='/m/api/matter'){await send(detail(url.searchParams.get('id')));return}
    if(path==='/m/api/matter/handoff'){
      if(postMode==='lost'){await route.abort('connectionfailed');return}
      if(postMode==='held'){await new Promise(resolve=>{releasePost=resolve})}
      handoff={state:'handed',from:'claude',to:request.postDataJSON().providerId,matterId:next}
      await send({ok:true,matterId:next,created:true});return
    }
    if(path==='/m/api/matters'){await send({ok:true,matters:[detail(source).matter]});return}
    if(path==='/m/api/home'){await send({ok:true,synced_at:new Date().toISOString(),events:[],next_cursor:null,seen_until:null,work:{focus:null,partial:false}});return}
    if(path==='/m/api/state'){await send({ok:true,todos:{active:[],settled:[]},portrait:null,stickers:[]});return}
    if(path==='/m/api/entry/options'){await send({ok:true,status:'ready',defaultProviderId:'codex',providers:[{id:'codex',displayName:'Codex',available:true}],projects:[]});return}
    await send({ok:false,error:'fixture_unavailable'},404)
  })
  const posts=()=>calls.filter(c=>c.path==='/m/api/matter/handoff')
  const clickConfirm=async()=>{
    const dialog=page.waitForEvent('dialog');await page.locator('[data-handoff="confirm"]').click()
    const shown=await dialog;const message=shown.message();await shown.accept();return message
  }
  await page.goto('http://quota-handoff.test/m');await page.locator('nav button[data-p="matters"]').click();await page.locator('[data-mid="'+source+'"]').click()
  await expect(page.locator('#m-task-status')).toContainText('Claude Code 的额度已用完')
  await page.locator('#m-say').fill('原任务的草稿')
  await page.screenshot({path:out+'/offer-'+width+'.png',fullPage:true})
  handoff=offer('cursor');await page.locator('[data-handoff="confirm"]').click()
  await expect(page.locator('#m-notice')).toContainText('重新确认');expect(posts()).toHaveLength(0)
  const cancelled=page.waitForEvent('dialog');await page.locator('[data-handoff="confirm"]').click();await(await cancelled).dismiss()
  expect(posts()).toHaveLength(0)
  const confirmation=await clickConfirm()
  for(const text of ['同一个文件夹','原来这件留着','看不到 Claude Code 之前的对话','只拿到这件事的标题','会用掉 Cursor 的额度'])expect(confirmation).toContain(text)
  await expect(page.locator('#m-title')).toContainText('接手任务')
  expect(posts()).toHaveLength(1);expect(Object.keys(posts()[0].body).sort()).toEqual(['id','providerId','requestId'])
  expect(posts()[0].body.providerId).toBe('cursor')
  expect(await page.evaluate(id=>JSON.parse(localStorage.getItem('cc.phone.matter.v1:'+location.host+':'+id+':say')).text,source)).toBe('原任务的草稿')

  handoff=offer();postMode='lost';await page.evaluate(id=>openMatter(id),source)
  await clickConfirm();await expect(page.locator('#m-notice')).toContainText('还未确认')
  const unknown=posts()[1].body
  expect(posts()).toHaveLength(2)
  await page.evaluate(()=>{window.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('online'))})
  await expect(page.locator('[data-handoff="confirm"]')).toBeEnabled();expect(posts()).toHaveLength(2)
  await page.reload();await page.locator('nav button[data-p="matters"]').click();await page.locator('[data-mid="'+source+'"]').click()
  await expect(page.locator('[data-handoff="confirm"]')).toContainText('核对并重试');expect(posts()).toHaveLength(2)
  postMode='success';await clickConfirm();await expect(page.locator('#m-title')).toContainText('接手任务')
  expect(posts()).toHaveLength(3);expect(posts()[2].body).toEqual(unknown)

  handoff=offer();postMode='held';await page.evaluate(id=>openMatter(id),source);await clickConfirm()
  await expect.poll(()=>posts().length).toBe(4)
  await page.evaluate(id=>openMatter(id),other);await page.locator('#m-say').fill('另一页的新草稿')
  await page.evaluate(()=>{
    mNotice('另一页的提示')
    const pre=document.querySelector('#m-events pre');pre.scrollLeft=90
    const paragraph=document.querySelector('#m-events .m-markdown p'),range=document.createRange();range.setStart(paragraph.firstChild,0);range.setEnd(paragraph.firstChild,2)
    document.getSelection().removeAllRanges();document.getSelection().addRange(range)
    window.fixtureReader={pre,paragraph}
  })
  releasePost();await expect.poll(()=>page.evaluate(()=>Boolean(mBusy['deadbeef:handoff']))).toBe(false)
  await expect(page.locator('#m-title')).toContainText('另一件事');await expect(page.locator('#m-say')).toHaveValue('另一页的新草稿');await expect(page.locator('#m-notice')).toHaveText('另一页的提示')
  expect(await page.evaluate(()=>({same:document.querySelector('#m-events pre')===window.fixtureReader.pre,scroll:window.fixtureReader.pre.scrollLeft,selected:document.getSelection().toString()}))).toEqual({same:true,scroll:90,selected:'保留'})
  await page.evaluate(()=>document.getSelection().removeAllRanges())

  handoff={state:'none',from:'claude',kind:'quota',resetAt:Date.now()+300000};await page.evaluate(id=>openMatter(id),source)
  await expect(page.locator('#m-task-status')).toContainText('目前没有可用的接手者');await expect(page.locator('[data-handoff="confirm"]')).toHaveCount(0)
  handoff={state:'handed',from:'claude',to:'codex',matterId:next};await page.evaluate(()=>mRefresh());await page.locator('[data-handoff="open"]').click()
  await expect(page.locator('#m-title')).toContainText('接手任务');expect(posts()).toHaveLength(4)

  handoff=null;taskError='execution_model_unsupported'
  const raw='\n<unsafe onclick="evil()">\r\n**model raw**'
  events=[{kind:'error',text:'这个账号不能使用当前模型。',errorCode:taskError,diagnostic:raw,createdAt:123}]
  await page.evaluate(id=>openMatter(id),source)
  await expect(page.locator('#m-task-status')).toContainText('请在桌面为这件事选择账号可用的模型后继续')
  await expect(page.locator('.m-error-diagnostic')).not.toHaveAttribute('open')
  await page.locator('.m-error-diagnostic summary').click()
  expect(await page.locator('.m-error-diagnostic code').textContent()).toBe(raw)
  await page.evaluate(()=>{window.fixtureDiagnostic=document.querySelector('.m-error-diagnostic')})
  events=events.concat({kind:'text',text:'后续仍能查看',createdAt:124});await page.evaluate(()=>mRefresh())
  expect(await page.evaluate(()=>document.querySelector('.m-error-diagnostic')===window.fixtureDiagnostic&&window.fixtureDiagnostic.open)).toBe(true)
  await expect(page.locator('#m-events unsafe,#m-events [onclick]')).toHaveCount(0)
  await page.screenshot({path:out+'/model-diagnostic-'+width+'.png',fullPage:true})
  expect(calls.some(c=>c.path==='/m/api/matter/create')).toBe(false)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(errors).toEqual([])
  evidence.push({width,explicitConfirmation:true,candidateReconfirmation:true,manualUnknownRetrySameIdentity:true,postCount:posts().length,lateResultPreservesOtherPageAndReading:true,diagnosticExactAndFolded:true,noOrdinaryCreate:true,pageErrors:errors})
  await context.close()
}}
finally{await browser.close()}
await writeFile(out+'/evidence.json',JSON.stringify(evidence,null,2)+'\n')
console.log(JSON.stringify({ok:true,evidence,screenshots:out}))
