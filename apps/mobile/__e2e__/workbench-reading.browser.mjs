// Run with Bun. The assembled production PWA uses synthetic data and mocked requests only.
import {mkdir,writeFile} from 'node:fs/promises'
import {assembleMobilePage} from '../assemble.ts'
import {readMobileSource} from '../sources.ts'
import {chromium,expect} from '../../desktop/node_modules/@playwright/test/index.mjs'

const out='/tmp/tendhearth-workbench-pwa-reading-qa'
await mkdir(out,{recursive:true})
// An integrator can verify its current shared style tokens without replacing this workbench implementation.
const styleRoot=process.env.MOBILE_QA_STYLE_ROOT,styleSource=styleRoot?(await import(styleRoot+'/apps/mobile/sources.ts')).readMobileSource:null
const html=assembleMobilePage(name=>styleSource&&name.endsWith('.css')?styleSource(name):readMobileSource(name)).phone.replace('{{TOKEN_JSON}}','"dFixture"').replace('{{REMOTE_JSON}}','null').replaceAll('{{BRAND_ICON_VERSION}}','fixture')
await writeFile(out+'/production-fixture.html',html)
const browser=await chromium.launch({headless:true}),evidence=[]
try{for(const width of [1000,390]){
 const context=await browser.newContext({viewport:{width,height:850},serviceWorkers:'block'}),page=await context.newPage(),errors=[],calls=[]
 const user='\n\r\n**用户原文**\r\n\r\n- 阅读与原文都保留\r\n'
 const assistant='# 阅读中的答复\n\n保持选区文本\n\n[查看文档](https://example.test/read)\n\n```ts\nconst '+ 'wide_identifier_'.repeat(30)+' = 1\n```\n\n| 一 | 二 |\n| --- | --- |\n| '+ 'table_identifier_'.repeat(30)+' | 结果 |'
 const clock=Date.now()-60000
 let events=[{kind:'text',text:'前一条回复',createdAt:clock+1000},{kind:'user',text:user,createdAt:clock+2000},{kind:'text',text:assistant,createdAt:clock+3000},{kind:'tool_call',text:'**原始命令**',createdAt:clock+4000}]
 page.on('pageerror',error=>errors.push(error.message))
 await page.route('http://workbench-reading.test/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname
  calls.push({path,method:request.method()})
  if(path==='/m'){await route.fulfill({contentType:'text/html',body:html});return}
  const send=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)})
  if(path==='/m/api/matter'){await send({ok:true,matter:{id:'deadbeef',kind:'task',title:'合成阅读验证',status:'open'},events,permissions:[],questions:[],artifacts:[],inputs:[],attachments:[]});return}
  if(path==='/m/api/matters'){await send({ok:true,matters:[{id:'deadbeef',kind:'task',title:'合成阅读验证',status:'open'}]});return}
  if(path==='/m/api/home'){await send({ok:true,synced_at:new Date().toISOString(),events:[],next_cursor:null,seen_until:null,work:{focus:null,partial:false}});return}
  if(path==='/m/api/state'){await send({ok:true,todos:{active:[],settled:[]},portrait:null,stickers:[]});return}
  if(path==='/m/api/matter/options'){await send({ok:true,status:'ready',defaultProviderId:'claude',providers:[{id:'claude',displayName:'Claude',available:true}],projects:[]});return}
  await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({ok:false,error:'fixture_unavailable'})})
 })
 await page.goto('http://workbench-reading.test/m')
 await page.locator('nav button[data-p="matters"]').click()
 await page.locator('[data-mid="deadbeef"]').click()
 await expect(page.locator('#m-events strong')).toHaveText('用户原文')
 const positioned=await page.evaluate(()=>{
  const root=document.getElementById('m-events'),source=root.querySelector('details.m-message-source'),link=root.querySelector('a'),reading=link.closest('.m-markdown'),paragraph=reading.querySelector('p'),pre=reading.querySelector('pre'),table=reading.querySelector('table')
  source.open=true;link.focus({preventScroll:true});pre.scrollLeft=120;table.scrollLeft=70
  const range=document.createRange();range.setStart(paragraph.firstChild,2);range.setEnd(paragraph.firstChild,4);document.getSelection().removeAllRanges();document.getSelection().addRange(range)
  window.fixtureReading={source,link,paragraph,pre,table}
  return{code:pre.scrollLeft,table:table.scrollLeft}
 })
 expect(positioned).toEqual({code:120,table:70})
 events=[{...events[0],text:'修正前一条回复'},...events.slice(1),{kind:'text',text:'新回复仍然到达',createdAt:clock+5000}]
 await page.evaluate(()=>mRefresh())
 const retained=await page.evaluate(()=>{
  const root=document.getElementById('m-events'),f=window.fixtureReading
  return{source:root.querySelector('details.m-message-source')===f.source,sourceOpen:f.source.open,exactSource:f.source.querySelector('pre code').textContent,link:root.querySelector('a')===f.link,focus:document.activeElement===f.link,paragraph:f.paragraph.isConnected,selected:document.getSelection().toString(),code:f.pre.scrollLeft,table:f.table.scrollLeft}
 })
 expect(retained).toEqual({source:true,sourceOpen:true,exactSource:user,link:true,focus:true,paragraph:true,selected:'选区',code:120,table:70})
 await expect(page.locator('#m-events')).toContainText('修正前一条回复')
 await expect(page.locator('#m-events')).toContainText('新回复仍然到达')
 await page.locator('#m-events .m-markdown h1').scrollIntoViewIfNeeded()
 await page.screenshot({path:out+'/retained-'+width+'.png'})
 await page.evaluate(()=>{
  const f=window.fixtureReading;f.source.open=false;f.link.blur();f.pre.scrollLeft=0;f.table.scrollLeft=0
 })
 events=events.map(event=>event.createdAt===clock+3000?{...event,text:'# 最新答复\n\n**阅读完成** <script>bad()</script>'}:event).concat({kind:'text',text:'下一条完整回复',createdAt:clock+6000})
 await page.evaluate(()=>mRefresh())
 await expect(page.locator('#m-events')).toContainText('保持选区文本')
 await expect(page.locator('#m-events')).toContainText('下一条完整回复')
 expect(await page.evaluate(()=>document.getSelection().toString())).toBe('选区')
 await page.evaluate(()=>{document.getSelection().removeAllRanges()})
 await page.evaluate(()=>mRefresh())
 await expect(page.locator('#m-events')).toContainText('最新答复')
 await expect(page.locator('#m-events')).not.toContainText('保持选区文本')
 await expect(page.locator('#m-events script,[onclick],[data-control]')).toHaveCount(0)
 await page.locator('#m-events .m-markdown h1').scrollIntoViewIfNeeded()
 await page.screenshot({path:out+'/released-'+width+'.png'})
 expect(errors).toEqual([])
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
 const ground=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--th-ground').trim())
 if(styleRoot)expect(ground).not.toBe('')
 expect(calls.every(call=>call.method==='GET')).toBe(true)
 evidence.push({width,ground,retained,changedEarlierReply:true,newRepliesVisible:true,latestReplyAfterRelease:true,safeRendering:true,noWriteCalls:true,pageErrors:errors})
 await context.close()
}}
finally{await browser.close()}
await writeFile(out+'/evidence.json',JSON.stringify(evidence,null,2)+'\n')
console.log(JSON.stringify({ok:true,evidence,screenshots:out}))
