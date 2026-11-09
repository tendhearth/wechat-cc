import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { test, expect } from './fixtures'
const task={id:'aabbccdd',title:'检查备份',path:'/offline/backup',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null,pendingPermissionCount:1,pendingQuestionCount:0}
const topic=(id:string)=>({id,title:id==='backup'?'服务器':`旧话题 ${id}`,description:'家里的服务与备份',summary:'正在核对备份',bubbleState:'closed',lastRecalledAt:null,lastOpenedByOwnerAt:null,activityRevision:1,activity:id==='backup'?{waiting:1,running:2,unread:1,lastActiveAt:1793923200000}:id==='travel'?{waiting:0,running:1,unread:0,lastActiveAt:1793923100000}:id==='food'?{waiting:0,running:0,unread:1,lastActiveAt:1793923000000}:{waiting:0,running:0,unread:0,lastActiveAt:null},matterSummary:{waiting:1,running:0,total:1}})
test.beforeEach(async({page,shim})=>{
  await shim.invoke('demo.unseed');await shim.invoke('demo.seed',{})
  await page.route('**/v1/protocol/capabilities',r=>r.fulfill({json:{routes:'v1',topics:'v1'}}))
  await page.route('**/v1/matter/owner-chat/window**',r=>r.fulfill({json:{messages:[{kind:'user',text:'那台机器后来怎么样了？',createdAt:1,messageId:'source1'},{kind:'text',text:'正在核对备份。',createdAt:2,messageId:'source2'}],anchor:null,earlier:null,later:null}}))
  await page.route('**/v1/matter/owner-chat/work',r=>r.fulfill({json:{references:[],results:[]}}))
  await page.route('**/v1/matter/owner-chat/events**',r=>r.fulfill({json:{running:null,events:[],cursor:0}}))
  await page.route('**/v1/matter?id=*',r=>r.fulfill({json:{matter:{...task,kind:'task'},bindings:[],sessions:[],task,events:[],permissions:[],questions:[],artifacts:[]}}))
  await page.route('**/__dev_reload.js',r=>r.fulfill({contentType:'application/javascript',body:''}))
  await page.route('**/v1/matter/owner-chat',r=>r.fulfill({json:{events:[{kind:'user',text:'那台机器后来怎么样了？',createdAt:1,messageId:'source1'},{kind:'text',text:'正在核对备份。',createdAt:2,messageId:'source2'}]}}))
  await page.route('**/v1/workbench/attention',r=>r.fulfill({json:{tasks:[{...task,attentionKey:'["r"]',first:{kind:'permission',text:'需要读取备份文件夹'}}]}}))
  await page.route(/\/v1\/workbench(?:\?.*)?$/,r=>r.fulfill({json:{tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,projects:[{id:'p',name:'备份',path:'/offline/backup',providerId:'codex'}]}}))
  await page.route('**/v1/workbench/task?*',r=>r.fulfill({json:{task,runId:'run1',events:[{id:'1',taskId:task.id,kind:'user',text:'请检查这周备份，告诉我哪些文件已经核验。',createdAt:1},{id:'2',taskId:task.id,kind:'tool_call',text:'核对本地文件',runId:'run1',createdAt:2,activity:{id:'read1',type:'read',status:'running',label:'核对本地文件'}},{id:'3',taskId:task.id,kind:'text',text:'正在核对文件，已保存本轮检查记录。',createdAt:3}],artifacts:[],permissions:[],questions:[]}}))
  await page.route('**/v1/memory/topics?*',r=>r.fulfill({json:{topics:['backup','travel','food','books','garden','letters'].map(topic),nextCursor:null,revision:'1'}}))
  await page.route('**/v1/memory/topics/open',r=>r.fulfill({json:{id:r.request().postDataJSON().id,bubbleState:'open',revision:'2'}}))
  await page.route('**/v1/memory/topics/detail?*',r=>r.fulfill({json:{topic:topic('backup'),entries:[{id:'e1',line:'每周核验一次',body:'备份留在本地。',source:'主人',updatedTs:'2026-11-06T00:00:00Z',recalled:true,status:'live'}],matters:[{id:task.id,title:task.title,state:'waiting',session:{id:task.id,kind:'task',title:task.title,executor:'codex',displayName:'Codex',activity:'waiting',latestStep:'需要读取备份文件夹',updatedAt:1793923200000,requestId:'permission-backup'}}],messages:[{id:'source2',speaker:'cc',ts:'2026-11-06T00:00:00Z',excerpt:'正在核对备份。',source:'recall'}],pages:{entries:{total:1,nextCursor:null},matters:{total:1,nextCursor:null},messages:{total:1,nextCursor:null}},revision:'2'}}))
  await page.route('**/v1/subscribe/topics?*',r=>r.fulfill({json:{revision:'2',recentIds:['backup'],openIds:['backup'],hasMoreOpen:false}}))
})

// Shared capture harness: identical for the baseline and candidate product archives.
// Only captures synthetic data; new-contract assertions live in t5-conversation.spec.ts.
test('design unification captures the four owner-approved surfaces', async ({page,shimUrl}) => {
  const out=process.env.WECHAT_CC_DESIGN_SHOTS
  test.skip(!out,'Only the mini browser lab sets the output directory')
  await mkdir(out!,{recursive:true})
  const phase=process.env.CC_UI_CAPTURE_PHASE
  expect(['before','after']).toContain(phase)
  await page.setViewportSize({width:1280,height:900})
  await page.goto(shimUrl)
  await expect(page.locator('#converse-scroll')).toContainText('那台机器后来怎么样了？')
  await page.locator('#converse-input').fill('还没发出的草稿')
  await page.screenshot({path:join(out!,`desktop-conversation-${phase}.png`)})
  await page.locator('#now-waiting-title').click()
  const row=page.locator('[data-matter-id="aabbccdd"]')
  await expect(row).toContainText('等你决定')
  await row.screenshot({path:join(out!,`desktop-home-row-${phase}.png`)})
  await page.locator('.conversation-topics').getByRole('button',{name:/^服务器(?:，|$)/}).click()
  const panel=page.locator('.conversation-topic-panel')
  await expect(panel).toContainText('这次想起')
  await page.screenshot({path:join(out!,`desktop-topic-${phase}.png`)})
  await page.setViewportSize({width:2400,height:900})
  const topics=page.locator('.conversation-topics')
  await topics.evaluate(el=>{el.style.zoom='3'})
  await topics.screenshot({path:join(out!,`desktop-topic-marks-3x-${phase}.png`)})
  await topics.evaluate(el=>{el.style.removeProperty('zoom')})

  await page.setViewportSize({width:390,height:844})
  await page.screenshot({path:join(out!,`desktop-topic-narrow-${phase}.png`)})
  await page.setViewportSize({width:1280,height:900})
  await panel.getByRole('button',{name:/检查备份/}).click()
  await expect(page.locator('.wb-task-head h2')).toHaveText('检查备份')
  await expect(page.locator('.wb-dialogue')).toContainText('正在核对文件')
  await page.screenshot({path:join(out!,`desktop-matter-${phase}.png`)})
  await expect(page.locator('#converse-input')).toHaveValue('还没发出的草稿')
})

test('design fixes keep toolbar semantics, final identity dimensions and current activity',async({page,shimUrl})=>{
 test.skip(process.env.CC_UI_CAPTURE_PHASE!=='after','Candidate contract only')
 await page.goto(shimUrl)
 const summary=page.locator('.conversation-add > summary')
 await expect(summary).toBeVisible()
 expect(await summary.evaluate(el=>getComputedStyle(el).listStyleType)).toBe('none')
 const more=page.locator('.conversation-more > summary')
 expect(await more.evaluate(el=>getComputedStyle(el).listStyleType)).toBe('none')
 for(const control of [summary,more]){
  await control.focus();await page.keyboard.press('Enter')
  await expect(control.locator('..')).toHaveAttribute('open','')
  expect(await control.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('solid')
  await page.keyboard.press('Space');await expect(control.locator('..')).not.toHaveAttribute('open','')
 }
 expect(await page.locator('.now-waiting > summary').evaluate(el=>getComputedStyle(el).listStyleType)).not.toBe('none')
 await page.evaluate(()=>{document.documentElement.style.setProperty('--th-identity-header-target','53px');document.documentElement.style.setProperty('--th-identity-header-image','37px')})
 const dimensions=await page.locator('.now-figure').evaluate(el=>({width:getComputedStyle(el).width,height:getComputedStyle(el).height,image:getComputedStyle(el.querySelector('img')!).width}))
 expect(dimensions).toEqual({width:'53px',height:'53px',image:'37px'})
 await page.evaluate(()=>{document.documentElement.style.removeProperty('--th-identity-header-target');document.documentElement.style.removeProperty('--th-identity-header-image')})
 await page.locator('.conversation-topics').getByRole('button',{name:/^服务器(?:，|$)/}).click()
 await page.locator('.conversation-topic-panel').getByRole('button',{name:/检查备份/}).click()
 await expect(page.locator('.wb-dialogue')).toContainText('正在核对文件')
 await expect(page.locator('.wb-activity-now')).toHaveText('核对本地文件')
})
