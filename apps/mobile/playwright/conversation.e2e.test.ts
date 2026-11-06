// @ts-nocheck — offline browser fixture, original daemon-generated document.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { mobilePhoneHtml, MOBILE_BOOTSTRAP_HTML } from '../../../src/features/phone/mobile-page'
const { test, expect } = createRequire(new URL('../../desktop/package.json', import.meta.url))('@playwright/test')
const art=JSON.parse(readFileSync(new URL('../../../src/features/phone/mobile-presence-art.json',import.meta.url),'utf8'))
const HOST='http://127.0.0.1:4274',id='deadbeef',run='11111111-1111-4111-8111-111111111111'
const matter={id,kind:'task',title:'检查备份',createdAt:2,updatedAt:3,status:'open',state:'waiting',originMessageId:'cc1',agents:['codex'],agentNames:{codex:'Codex'},taskState:{status:'running',phase:'working',pending:1}}
const topic={id:'server',title:'服务器',description:'家里的服务与备份',summary:'正在检查备份',bubbleState:'open',lastRecalledAt:null,lastOpenedByOwnerAt:null,matterSummary:{waiting:1,running:0,total:1}}
async function fixture(page,{link=false,old=false}={}){
 const requests=[],posts=[],errors=[],messages=[{id:'me1',role:'me',text:'查一下备份。',at:1},{id:'cc1',role:'cc',text:'交给 Codex 检查备份了。',at:2}];let revoked=false,down=false,allow=true
 page.on('pageerror',e=>errors.push(e.message))
 const detail={matter,runId:run,task:{status:'running',phase:'working',providerId:'codex'},events:[{kind:'assistant',text:'已核对一份备份',createdAt:3}],permissions:[{id:run,taskId:id,tool:'读取文件夹',description:'只读检查备份目录',createdAt:3}],questions:[],artifacts:[]}
 await page.route(HOST+'/**',async route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname;requests.push(p)
  if(p==='/m')return route.fulfill({contentType:'text/html',body:revoked?MOBILE_BOOTSTRAP_HTML:mobilePhoneHtml(link?'tLINK':'dDEVICE',null)})
  if(p==='/m/sw.js')return route.fulfill({body:''})
  if(revoked)return route.fulfill({status:401,json:{error:'unauthorized'}})
  if(down)return route.abort('connectionfailed')
  if(req.method()==='POST'){const body=req.postDataJSON();posts.push({path:p,body});if(p==='/v1/matter/permission'){detail.permissions=[];matter.taskState.pending=0}return route.fulfill({json:{ok:true,job:{requestId:body.requestId,status:'pending'}}})}
  if(p==='/v1/home')return route.fulfill({json:{ok:true,synced_at:new Date().toISOString(),presence:{presence:'ok',activity:{label:'在家待着'}},work:{focus:null,partial:false}}})
  if(p==='/v1/phone/art/presence')return route.fulfill({json:{ok:true,mime:'image/png',unlit:art.unlit.base64,lit:art.lit.base64}})
  if(p==='/v1/matters')return route.fulfill({json:{matters:[matter]}})
  if(p==='/v1/matter')return route.fulfill({json:detail})
  if(p==='/v1/matter/owner-chat/page')return route.fulfill({json:{ok:true,...(!old?{conversation:'v1',topics:'v1'}:{}),matterId:'chat',messages,hasMore:false,pending:null,failed:null}})
  if(p==='/v1/matter/owner-chat/search')return route.fulfill({json:{hits:[{id:'cc1',kind:'assistant',text:'交给 Codex 检查备份了。',createdAt:2}]}})
  if(p==='/v1/memory/topics')return route.fulfill({json:{topics:[topic],nextCursor:null,revision:'1'}})
  if(p==='/v1/memory/topics/detail')return route.fulfill({json:{topic,entries:[{id:'e1',line:'每周核验一次',body:'保留本地备份',recalled:true,source:'主人',createdTs:'2026-11-06T00:00:00Z'}],matters:[{id,title:'检查备份',state:'waiting'}],messages:[{id:'me1',speaker:'owner',ts:'1970-01-01T00:00:00.001Z',excerpt:'查一下备份。',source:'recall'}],pages:{entries:{total:1,nextCursor:null},matters:{total:1,nextCursor:null},messages:{total:1,nextCursor:null}},revision:'1'}})
  if(p==='/v1/subscribe/topics')return route.fulfill({json:{revision:'1',recentIds:['server'],openIds:['server'],hasMoreOpen:false}})
  return route.fulfill({status:404,json:{ok:false,error:'not_found'}})
 })
 return {requests,posts,errors,detail,messages,revoke(){revoked=true},down(){down=true}}
}
test('device enters the one conversation, drafts survive topic and matter layers; narrow/wide screenshots',async({page},info)=>{
 const h=await fixture(page);await page.goto(HOST+'/m');await expect(page.locator('#chat-messages')).toContainText('交给 Codex');await expect(page.locator('#m-list')).toBeHidden()
 await page.locator('#chat-input').fill('保留这句草稿');await page.getByRole('button',{name:'服务器',exact:true}).click();await expect(page.locator('#topic-body')).toContainText('这次想起');await page.screenshot({path:info.outputPath('topic-390.png'),fullPage:true})
 await page.locator('#topic-body [data-mid]').click();await expect(page.locator('#m-title')).toHaveText('检查备份');await page.locator('#m-back').click();await expect(page.locator('#topic-body')).toContainText('每周核验一次');await page.locator('#topic-close').click();await expect(page.locator('#topic-panel')).toBeHidden();await expect(page.locator('#chat-input')).toHaveValue('保留这句草稿')
 await page.screenshot({path:info.outputPath('conversation-390.png'),fullPage:true});await page.setViewportSize({width:1280,height:900});await page.getByRole('button',{name:'服务器',exact:true}).click();await expect(page.locator('#topic-body')).toContainText('这次想起');await page.screenshot({path:info.outputPath('topic-1280.png'),fullPage:true});expect(h.errors).toEqual([])
})
test('sending uses one owner-chat request, approval binds exact current run, browser Back returns to conversation',async({page})=>{
 const h=await fixture(page);await page.goto(HOST+'/m');await expect(page.locator('#chat-messages')).toContainText('交给 Codex');await page.locator('#chat-input').fill('看看结果');await page.locator('#chat-send').click();await expect.poll(()=>h.posts.filter(p=>p.path.endsWith('/say')).length).toBe(1)
 await page.locator('#chat-waiting').click();await page.locator('#reference-deadbeef summary').click();await page.locator('#chat-messages [data-mid]').click();await page.getByRole('button',{name:'允许这一步',exact:true}).click();await expect.poll(()=>h.posts.filter(p=>p.path.endsWith('/permission')).length).toBe(1);expect(h.posts.find(p=>p.path.endsWith('/permission')).body).toEqual({id,runId:run,requestId:run,decision:'allow'});await page.goBack();await expect(page.locator('#conversation')).toBeVisible();expect(h.errors).toEqual([])
})
test('link identity never requests private conversation, topics or approval',async({page})=>{
 const h=await fixture(page,{link:true});await page.goto(HOST+'/m');await expect(page.locator('#pairbar')).toBeVisible();await expect(page.locator('#conversation')).toBeHidden();expect(h.requests.filter(p=>/owner-chat|topics|permission|answer/.test(p))).toEqual([])
})
test('revocation clears transcript, topics and draft before returning to pairing',async({page})=>{
 const h=await fixture(page);await page.goto(HOST+'/m');await expect(page.locator('#chat-messages')).toContainText('交给 Codex');await page.locator('#chat-input').fill('private draft');h.revoke();await page.locator('#chat-refresh').click();await expect(page.locator('body')).toContainText('还没配对过');await expect(page.locator('#chat-messages')).toHaveCount(0);expect(await page.evaluate(()=>localStorage.getItem('deviceToken'))).toBeNull();expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('cc.conversation.draft:')))).toEqual([]);expect(h.errors).toEqual([])
})

test('wide matter uses a side panel; new replies preserve an older reading anchor and keyboard focus',async({page},info)=>{
 const h=await fixture(page);for(let n=0;n<45;n++)h.messages.push({id:'long-'+n,role:n%2?'cc':'me',text:('保留原来阅读的位置。').repeat(30),at:10+n})
 await page.setViewportSize({width:1280,height:900});await page.goto(HOST+'/m');await expect(page.locator('#message-long-44')).toBeVisible();await page.locator('#message-long-5').scrollIntoViewIfNeeded();const top=await page.locator('#message-long-5').evaluate(el=>el.getBoundingClientRect().top)
 h.messages.push({id:'new-reply',role:'cc',text:'这是一条新回复。',at:100});await page.evaluate(()=>cRead(false));await expect(page.locator('#message-new-reply')).toHaveCount(1);expect(Math.abs(await page.locator('#message-long-5').evaluate(el=>el.getBoundingClientRect().top)-top)).toBeLessThan(2)
 await page.evaluate(()=>{cRevealMatter('deadbeef');openMatter('deadbeef')});await expect(page.locator('#m-detail')).toBeVisible();await expect(page.locator('#conversation')).toBeVisible();await expect(page.getByRole('button',{name:'允许这一步',exact:true})).toBeVisible();await page.screenshot({path:info.outputPath('matter-1280.png'),fullPage:true});expect(h.errors).toEqual([])
})

test('a cold matter target waits for device conversation readiness, opens the stable reference and returns to chat',async({page})=>{
 const h=await fixture(page);await page.goto(HOST+'/m?matter=deadbeef');await expect(page.locator('#m-title')).toHaveText('检查备份');await page.locator('#m-back').click();await expect(page.locator('#conversation')).toBeVisible();await expect(page.locator('#reference-deadbeef')).toHaveCount(1);expect(new URL(page.url()).searchParams.has('matter')).toBe(false);expect(h.errors).toEqual([])
})

test('an older daemon keeps its limited status detail and hides unsupported conversation controls even on a wide screen',async({page},info)=>{
 const h=await fixture(page,{old:true});await page.setViewportSize({width:1280,height:900});await page.goto(HOST+'/m');await expect(page.locator('#chat-notice')).toContainText('电脑版本暂不支持');await expect(page.locator('#chat-form')).toBeHidden();await expect(page.locator('#topic-row')).toBeHidden();await page.locator('#m-list [data-mid]').click();await expect(page.locator('#m-home')).toBeHidden();await expect(page.locator('#m-detail')).toBeVisible();expect(h.requests.filter(p=>p.includes('/memory/topics'))).toEqual([]);await page.screenshot({path:info.outputPath('legacy-device-1280.png'),fullPage:true});expect(h.errors).toEqual([])
})
