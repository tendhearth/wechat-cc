// Run with Bun. This assembles the production PWA in memory and mocks every request.
import {mkdir,writeFile} from 'node:fs/promises'
import {assembleMobilePage} from '../assemble.ts'
import {readMobileSource} from '../sources.ts'
import {chromium,expect} from '../../desktop/node_modules/@playwright/test/index.mjs'

const out='/tmp/tendhearth-sessions-pwa-qa'
await mkdir(out,{recursive:true})
const html=assembleMobilePage(readMobileSource).phone.replace('{{TOKEN_JSON}}','"dFixture"').replace('{{REMOTE_JSON}}','null').replaceAll('{{BRAND_ICON_VERSION}}','fixture')
await writeFile(out+'/production-fixture.html',html)
const browser=await chromium.launch({headless:true})
const evidence=[]
try{for(const width of [1000,390]){
 const context=await browser.newContext({viewport:{width,height:850},serviceWorkers:'block'}),page=await context.newPage(),calls=[],errors=[]
 let preview='ready',adopted=false,legacy=false,failList=false
 const user='\n\r\n**用户原文**\r\n\r\n- 检查阅读格式\r\n- 保留原始换行\r\n'
 const assistant='# 最近的回复\n\n保持选区文本\n\n[查看文档](https://example.test/read)\n\n```ts\nconst '+ 'wide_identifier_'.repeat(30)+' = 1\n```\n\n| 项目 | 结果 |\n| --- | --- |\n| 阅读 | 已确认 |'
 const row=provider=>({key:provider+'-key',provider,title:'改善**会话可读性**',project:'session-project',updatedAt:1760000000000,active:true})
 page.on('pageerror',error=>errors.push(error.message))
 await page.route('http://sessions-phone.test/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,body=request.postDataJSON(),provider=url.searchParams.get('provider')||((url.searchParams.get('key')||'').startsWith('codex')?'codex':'claude')
  calls.push({path,method:request.method(),query:Object.fromEntries(url.searchParams),body})
  if(path==='/m'){await route.fulfill({contentType:'text/html',body:html});return}
  const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)})
  if(path==='/m/api/sessions'){await send(failList?{ok:false,error:'unavailable'}:{ok:true,items:[row(provider)],nextCursor:null},failList?503:200);return}
  if(path==='/m/api/session'){await send({ok:true,session:row(provider),messages:[{id:'u1',role:'user',text:user,truncated:false},{id:'a1',role:'assistant',text:legacy?'最早的记录':assistant,truncated:true}],nextCursor:null,managed:adopted,...(legacy?{}:{window:url.searchParams.get('window')})});return}
  if(path==='/m/api/session/continue'){
   if(request.method()==='POST'){adopted=true;await send({ok:true,matterId:'deadbeef',created:true});return}
   await send({ok:true,state:adopted?'managed':preview,provider,project:'session-project',mode:preview==='ready'&&!adopted?'native_resume':null,matterId:adopted?'deadbeef':null});return
  }
  if(path==='/m/api/matters'){await send({ok:true,matters:adopted?[{id:'deadbeef',kind:'task',title:'接着做电脑会话',status:'open',projectPath:null}]:[]});return}
  if(path==='/m/api/matter'){await send({ok:true,matter:{id:'deadbeef',kind:'task',title:'接着做电脑会话',status:'open',projectPath:null},events:[],permissions:[],questions:[],artifacts:[],inputs:[],attachments:[]});return}
  if(path==='/m/api/home'){await send({ok:true,synced_at:new Date().toISOString(),events:[],next_cursor:null,seen_until:null,work:{focus:null,partial:false}});return}
  if(path==='/m/api/state'){await send({ok:true,todos:{active:[],settled:[]},portrait:null,stickers:[]});return}
  if(path==='/m/api/matter/options'){await send({ok:true,status:'ready',defaultProviderId:'claude',providers:[{id:'claude',displayName:'Claude',available:true}],projects:[]});return}
  await send({ok:false,error:'fixture_unavailable'},404)
 })
 await page.goto('http://sessions-phone.test/m')
 await page.locator('nav button[data-p="matters"]').click()
 await expect(page.locator('nav button')).toHaveCount(2)
 await page.locator('#memory-open').click();await expect(page.locator('#p-memory')).toHaveClass(/on/)
 await expect.poll(()=>calls.filter(c=>c.path==='/m/api/seen').length).toBeGreaterThan(0)
 await page.locator('#memory-back').click();await page.locator('#sessions-open').click()
 await expect(page.locator('.sessions-row')).toContainText('改善会话可读性')
 await page.locator('#sessions-provider').selectOption('codex')
 await expect(page.locator('[data-session-key="codex-key"]')).toBeVisible();await page.locator('[data-session-key="codex-key"]').click()
 await expect(page.locator('#sessions-meta')).toContainText('Codex');await page.locator('[data-ss-action="continue"]').click()
 await expect(page.locator('.sessions-confirm')).toContainText('Codex 的额度或费用');await page.locator('[data-ss-action="cancel"]').click()
 await page.locator('#sessions-list-back').click();await page.locator('#sessions-provider').selectOption('claude')
 await expect(page.locator('[data-session-key="claude-key"]')).toBeVisible()
 await page.locator('#sessions-query').fill('可读性');const searches=calls.filter(c=>c.path==='/m/api/sessions').length
 expect(calls.filter(c=>c.path==='/m/api/sessions').length).toBe(searches)
 await page.locator('#sessions-search-form button[type="submit"]').click()
 await expect.poll(()=>calls.some(c=>c.path==='/m/api/sessions'&&c.query.q==='可读性')).toBe(true)
 await expect(page.locator('#sessions-list-notice')).toHaveText('')
 await page.screenshot({path:out+'/list-'+width+'.png'})
 await page.locator('.sessions-row').click()
 await expect(page.locator('#sessions-source')).toContainText('最近 2 段')
 await expect(page.locator('#sessions-messages strong').first()).toHaveText('用户原文')
 await expect(page.locator('#sessions-messages .sessions-truncated')).toContainText('已截短')
 await page.locator('#sessions-messages details > summary').click()
 expect(await page.locator('#sessions-messages details pre code').textContent()).toBe(user)
 const reads=calls.filter(c=>c.path==='/m/api/session').length
 const retained=await page.evaluate(async()=>{
  const root=document.getElementById('sessions-messages'),paragraph=root.querySelector('article:nth-child(2) .m-markdown p'),link=root.querySelector('a'),pre=root.querySelector('article:nth-child(2) pre'),source=root.querySelector('details')
  link.focus({preventScroll:true});pre.scrollLeft=120
  const range=document.createRange();range.setStart(paragraph.firstChild,2);range.setEnd(paragraph.firstChild,4);document.getSelection().removeAllRanges();document.getSelection().addRange(range)
  document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('online'));await new Promise(resolve=>setTimeout(resolve,60))
  return{paragraph:root.querySelector('article:nth-child(2) .m-markdown p')===paragraph,source:root.querySelector('details')===source,open:source.open,focus:document.activeElement===link,selected:document.getSelection().toString(),left:pre.scrollLeft}
 })
 expect(retained).toEqual({paragraph:true,source:true,open:true,focus:true,selected:'选区',left:120});expect(calls.filter(c=>c.path==='/m/api/session').length).toBe(reads)
 await page.locator('#sessions-messages details').evaluate(node=>{node.open=false})
 await page.locator('#sessions-title').scrollIntoViewIfNeeded()
 await page.screenshot({path:out+'/recent-'+width+'.png'})
 await page.evaluate(()=>document.getSelection().removeAllRanges())
 await page.locator('[data-ss-action="continue"]').click()
 await expect(page.locator('.sessions-confirm')).toContainText('发送第一句才会开始')
 await page.locator('.sessions-confirm').scrollIntoViewIfNeeded()
 await page.screenshot({path:out+'/confirm-'+width+'.png'})
 preview='busy_session';await page.locator('#sessions-check').click()
 await expect(page.locator('#sessions-continue-notice')).toContainText('原工具报告正在执行')
 await expect(page.locator('[data-ss-action="confirm"]')).toHaveCount(0)
 preview='ready';await page.locator('#sessions-check').click();await page.locator('[data-ss-action="continue"]').click();await page.locator('[data-ss-action="confirm"]').click()
 await expect(page.locator('#p-matters')).toHaveClass(/on/);await expect(page.locator('#m-detail')).toBeVisible()
 const adoptedCalls=calls.filter(c=>c.path==='/m/api/session/continue'&&c.method==='POST')
 expect(adoptedCalls).toHaveLength(1);expect(adoptedCalls[0].body).toEqual({key:'claude-key'})
 expect(calls.some(c=>c.path==='/m/api/matter/say')).toBe(false)
 await page.screenshot({path:out+'/adopted-'+width+'.png',fullPage:true})
 await page.locator('#sessions-open').click();await page.locator('.sessions-row').click();await expect(page.locator('[data-ss-action="managed"]')).toBeVisible()
 legacy=true;await page.locator('#sessions-read-refresh').click();await expect(page.locator('#sessions-read-notice')).toContainText('暂不支持最近')
 await expect(page.locator('#sessions-messages')).not.toContainText('最早的记录')
 await page.locator('#sessions-start').click();await expect(page.locator('#sessions-source')).toContainText('从头读取')
 await expect(page.locator('#sessions-messages')).toContainText('最早的记录')
 await page.locator('#sessions-list-back').click();failList=true;await page.locator('#sessions-refresh').click()
 await expect(page.locator('#sessions-list-notice')).toContainText('上次看到');await expect(page.locator('#sessions-list .sessions-status.is-current')).toHaveCount(0)
 expect(errors).toEqual([])
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
 evidence.push({width,retained,bothProviders:true,searchSubmitted:true,legacyHeadNotRecent:true,cacheStatusGray:true,explicitConfirmation:true,postBody:adoptedCalls[0].body,noSayBeforeFirstInput:true,memoryReadReceipt:true,pageErrors:errors})
 await context.close()
}}
finally{await browser.close()}
await writeFile(out+'/evidence.json',JSON.stringify(evidence,null,2)+'\n')
console.log(JSON.stringify({ok:true,evidence,screenshots:out}))
