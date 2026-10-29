import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

// Actual desktop renderer/controller/styles against isolated synthetic responses.
const source=fileURLToPath(new URL('../src/',import.meta.url))
const fixture=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/styles/workbench.css"><style>html,body{margin:0;height:100%;overflow:hidden}#workbench-root{height:100%}</style></head><body><div id="workbench-root"></div><script type="module">
import {initWorkbenchPage,stopWorkbenchPolling} from '/modules/workbench.js'
const task={id:'A',title:'整理访谈，准备交付',path:'/synthetic/project',providerId:'codex',status:'running',phase:'working',createdAt:1,updatedAt:2,error:null}
const other={...task,id:'B',title:'已保存的访谈记录',status:'completed',phase:'replied'}
const file=id=>({id,taskId:id==='saved-A'?'A':'B',name:'访谈记录.md',mime:'text/plain',size:25,sha256:'a'.repeat(64),createdAt:1,approvedAt:null})
const details={A:{task,version:1,runId:'run-A',inputMode:'steer',events:Array.from({length:18},(_,i)=>({id:'e'+i,taskId:'A',kind:'text',text:'第 '+i+' 段访谈的整理记录。保留这段正在阅读的文字。\\n\\n[查看原文](https://example.test/read)',createdAt:i})),artifacts:[file('saved-A')],permissions:[],questions:[]},B:{task:other,events:Array.from({length:18},(_,i)=>({id:'b'+i,taskId:'B',kind:'text',text:'访谈记录已整理并保存，可以继续补充。',createdAt:i})),artifacts:[file('saved-B')],continuation:{mode:'continue'}}}
const reviewsByTask={};const posts=[];let rejectPost,delayReviews=false,releaseReviews
const invokeWorkbenchApi=async(method,path,body)=>{
 if(method==='POST'){posts.push({path,body});return new Promise((_resolve,reject)=>rejectPost=reject)}
 if(path.startsWith('/v1/workbench/task?'))return path.includes('since=')?new Promise(()=>{}):details[new URL(path,location.origin).searchParams.get('id')]
 if(path.startsWith('/v1/workbench/review?')){const reviews=reviewsByTask[new URL(path,location.origin).searchParams.get('id')]??[];return delayReviews?new Promise(resolve=>releaseReviews=()=>resolve({reviews})):{reviews}}
 if(path.startsWith('/v1/workbench/artifact?'))return{name:'访谈记录.md',mime:'text/plain',size:25,sha256:'a'.repeat(64),contentBase64:btoa('saved result')}
 if(path.startsWith('/v1/matters?'))return{matters:[]}
 return{tasks:[task,other],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}
}
const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60000})
window.qa={controller,details,posts,reviewsByTask,holdReviews:()=>delayReviews=true,releaseReviews:()=>releaseReviews?.(),stop:stopWorkbenchPolling,reject:()=>rejectPost?.(Error('synthetic request rejected')),paint:()=>controller.paint(true),answer:()=>{details.A.task.phase='replied';controller.paint(true)},waiting:()=>{details.A.permissions=[{id:'p',taskId:'A',tool:'Bash',description:'bun run verify\\ncwd: /synthetic/project\\n仅允许本次请求',createdAt:1},{id:'foreign',taskId:'B',tool:'Bash',description:'foreign action',createdAt:1}];details.A.questions=[{id:'q',taskId:'A',createdAt:1,questions:[{id:'choice',header:'选择',question:'保留哪一份访谈？',options:[]}]}];controller.paint(true)},recover:()=>{details.A.permissions=[];details.A.questions=[];details.A.task.status='interrupted';details.A.task.phase='interrupted';details.A.continuation={mode:'restart_required',restart:{token:'restart-token',context:'用户原要求与已保存的访谈。',eventCount:20,includedEventCount:10,truncated:true}};controller.paint(true)}}
</script></body></html>`

for(const size of [{width:1400,height:850},{width:900,height:650},{width:390,height:700},{width:700,height:450},{width:760,height:280}])test(`task detail state and interaction at ${size.width}x${size.height}`,async({page},testInfo)=>{
 await page.setViewportSize(size)
 await page.route('http://127.0.0.1:4211/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/'){await route.fulfill({contentType:'text/html',body:fixture});return}
  try{const body=process.env.TASK_DETAIL_BASELINE&&path==='/modules/workbench.js'?execFileSync('git',['show','9c8e28172d734ee57da8439ebc363e6c53087e68:apps/desktop/src/modules/workbench.js']):await readFile(source+path);await route.fulfill({body,contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'})}
  catch{await route.fulfill({status:404,body:'missing fixture asset'})}
 })
 await page.goto('http://127.0.0.1:4211')
 const composer=page.locator('#wb-followup-text'),help=page.locator('#wb-input-help')
 await expect(composer).toBeVisible()
 await expect(help).toHaveCount(1)
 await page.locator('.wb-followup [data-action="cancel"]').focus()
 await expect(page.locator('.wb-followup [data-action="cancel"]')).toBeInViewport()
 await composer.fill('接着核对第二段引文')
 await page.screenshot({path:testInfo.outputPath('running.png')})
 await help.locator('summary').focus();await page.keyboard.press('Enter')
 await expect(help).toHaveAttribute('open','')
 await page.evaluate(()=>(window as any).qa.paint())
 await expect(help).toHaveAttribute('open','')
 await expect(help.locator('summary')).toBeFocused()
 await expect(composer).toHaveValue('接着核对第二段引文')
 // First completed-task entry exposes real saved outcomes, before the answer, without opening a preview.
 await page.locator('[data-task-id="B"]').click()
 await expect(page.locator('#wb-artifacts')).toHaveAttribute('open','')
 await expect(page.locator('#wb-artifacts .wb-artifact')).toBeInViewport()
 expect(await page.locator('#wb-artifacts').evaluate(el=>!!(el.compareDocumentPosition(document.querySelector('.wb-dialogue')!)&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
 await expect(page.locator('iframe,.wb-artifact-panel')).toHaveCount(0)
 await page.locator('#wb-artifacts>summary').focus();await page.keyboard.press('Tab')
 await expect(page.locator('#wb-artifacts .wb-artifact')).toBeFocused()
 await page.screenshot({path:testInfo.outputPath('answered.png')})
 await page.locator('#wb-artifacts>summary').click()
 await page.evaluate(()=>(window as any).qa.paint())
 await expect(page.locator('#wb-artifacts')).not.toHaveAttribute('open','')
 await page.locator('[data-task-id="A"]').click()
 await expect(composer).toHaveValue('接着核对第二段引文')
 await expect(help).toHaveAttribute('open','')
 // Selected reading nodes and visual anchor survive progress → answer while outcomes move forward.
 const before=await page.evaluate(()=>{
  const content=document.querySelector('.wb-content')!,row=document.querySelectorAll('.wb-message')[8]!,p=row.querySelector('p')!,link=row.querySelector('a')!
  content.scrollTop=(row as HTMLElement).offsetTop-120
  link.focus({preventScroll:true});const selection=getSelection()!,range=document.createRange();range.setStart(p.firstChild!,3);range.setEnd(p.firstChild!,8);selection.removeAllRanges();selection.addRange(range)
  ;(window as any).qa.reading={row,p,link,text:selection.toString()}
  return row.getBoundingClientRect().top
 })
 await page.evaluate(()=>(window as any).qa.answer())
 expect(await page.evaluate(()=>{const {row,p,link,text}=(window as any).qa.reading;return row.isConnected&&row.querySelector('p')===p&&document.activeElement===link&&getSelection()?.toString()===text})).toBe(true)
 expect(Math.abs(await page.evaluate(()=>(window as any).qa.reading.row.getBoundingClientRect().top)-before)).toBeLessThan(3)
 await expect(composer).toHaveValue('接着核对第二段引文')
 await expect(page.locator('#wb-artifacts')).toHaveAttribute('open','')
 // Explicit fold is scoped to B, not inherited by A or overwritten on a later repaint.
 await page.locator('[data-task-id="B"]').click();await expect(page.locator('#wb-artifacts')).not.toHaveAttribute('open','')
 await page.locator('[data-task-id="A"]').click();await expect(page.locator('#wb-artifacts')).toHaveAttribute('open','')
 // Preview instance and chosen artifact stay intact through a structural update.
 await page.locator('[data-action="show-artifacts"]').click();await expect(page.locator('.wb-artifact-panel')).toBeVisible()
 await expect(page.locator('#wb-preview')).toContainText('saved result')
 await page.evaluate(()=>{const qa=(window as any).qa;qa.controller.state.preview={artifactId:'saved-A',html:'<iframe id="wb-preview-frame" data-preview-key="saved-A" title="saved preview" srcdoc="Saved preview"></iframe>'};qa.paint();qa.previewNode=document.querySelector('#wb-preview-frame');qa.paint()})
 expect(await page.evaluate(()=>document.querySelector('#wb-preview-frame')===(window as any).qa.previewNode)).toBe(true)
 await page.locator('[data-action="back-to-dialogue"]').click()
 await page.evaluate(()=>(window as any).qa.waiting())
 await expect(page.locator('[data-request-id="foreign"]')).toHaveCount(0)
 await page.getByRole('button',{name:'2 项等你处理，查看请求',exact:true}).click()
 await expect(page.locator('[data-action="deny-permission"]')).toBeFocused()
 await expect(page.locator('[data-action="deny-permission"]')).toBeInViewport()
 await expect(page.locator('.wb-permission p')).toHaveText('bun run verify\ncwd: /synthetic/project\n仅允许本次请求')
 await page.locator('[data-question-other]').fill('保留第二份')
 await page.screenshot({path:testInfo.outputPath('waiting.png')})
 await page.locator('[data-task-id="B"]').click();await page.locator('[data-task-id="A"]').click()
 await expect(page.locator('[data-question-other]')).toHaveValue('保留第二份')
 // Delayed rejection preserves the submitted task/run identity and both task drafts.
 await page.locator('.wb-followup [type="submit"]').click()
 await expect(page.locator('.wb-followup [type="submit"]')).toBeDisabled()
 await page.locator('[data-task-id="B"]').click();await page.locator('[data-task-id="A"]').click()
 await expect(page.locator('.wb-followup [type="submit"]')).toBeDisabled()
 expect(await page.evaluate(()=>(window as any).qa.posts[0].body)).toMatchObject({id:'A',runId:'run-A',text:'接着核对第二段引文'})
 await page.evaluate(()=>(window as any).qa.reject())
 await expect(page.locator('.wb-followup [type="submit"]')).toBeEnabled()
 await expect(composer).toHaveValue('接着核对第二段引文')
 await expect(page.locator('.wb-followup .wb-interaction-error')).toBeVisible()
 await page.evaluate(()=>(window as any).qa.recover())
 await expect(page.locator('.wb-recovery')).toContainText('原会话无法恢复')
 await expect(page.locator('.wb-followup [type="submit"]')).toHaveText('带这些记录新开一轮')
 await expect(composer).toHaveValue('接着核对第二段引文')
 await page.locator('.wb-followup [type="submit"]').focus()
 await expect(page.locator('.wb-followup [type="submit"]')).toBeInViewport()
 await page.screenshot({path:testInfo.outputPath('recovery.png')})
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.evaluate(()=>(window as any).qa.stop())
})

test('delayed review discovery respects active reading and explicit result folds',async({page})=>{
 await page.setViewportSize({width:1400,height:850})
 await page.route('http://127.0.0.1:4211/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/'){await route.fulfill({contentType:'text/html',body:fixture});return}
  try{await route.fulfill({body:await readFile(source+path),contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'})}
  catch{await route.fulfill({status:404,body:'missing fixture asset'})}
 })
 await page.goto('http://127.0.0.1:4211')
 await expect(page.locator('#wb-followup-text')).toBeVisible()
 await page.evaluate(()=>(window as any).qa.holdReviews())
 await page.locator('[data-task-id="B"]').click()
 await expect(page.locator('.wb-task-head h2')).toHaveText('已保存的访谈记录')
 await expect(page.locator('#wb-artifacts')).not.toHaveAttribute('open','')
 const before=await page.evaluate(()=>{
  const content=document.querySelector('.wb-content')!,row=document.querySelectorAll('.wb-message')[4]!,text=row.querySelector('p')!.firstChild!
  content.scrollTop=(row as HTMLElement).offsetTop-120
  const range=document.createRange();range.setStart(text,0);range.setEnd(text,5);getSelection()!.removeAllRanges();getSelection()!.addRange(range)
  ;(window as any).qa.delayedReading={row,text:getSelection()!.toString()}
  return row.getBoundingClientRect().top
 })
 await page.evaluate(()=>(window as any).qa.releaseReviews())
 await expect(page.locator('#wb-artifacts')).toHaveAttribute('open','')
 expect(await page.evaluate(()=>getSelection()?.toString()===(window as any).qa.delayedReading.text)).toBe(true)
 expect(Math.abs(await page.evaluate(()=>(window as any).qa.delayedReading.row.getBoundingClientRect().top)-before)).toBeLessThan(3)
 await page.locator('#wb-artifacts>summary').click()
 await page.evaluate(()=>{const qa=(window as any).qa;qa.details.B.task.status='running';qa.details.B.task.phase='working';qa.paint();qa.details.B.task.phase='replied';qa.paint()})
 await expect(page.locator('#wb-artifacts')).not.toHaveAttribute('open','')
 await page.evaluate(()=>(window as any).qa.stop())
})

for(const status of ['completed','running'])for(const result of ['none','review-only','deliverable'])test(`first ${status} entry with ${result} honors result provenance`,async({page},testInfo)=>{
 await page.setViewportSize({width:1400,height:850})
 await page.route('http://127.0.0.1:4211/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/'){await route.fulfill({contentType:'text/html',body:fixture});return}
  try{await route.fulfill({body:await readFile(source+path),contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'})}
  catch{await route.fulfill({status:404,body:'missing fixture asset'})}
 })
 await page.goto('http://127.0.0.1:4211')
 await expect(page.locator('#wb-followup-text')).toBeVisible()
 await page.evaluate(({status,result})=>{
  const qa=(window as any).qa;qa.holdReviews();qa.details.B.task.status=status
  if(result==='none')qa.details.B.artifacts=[]
  if(result==='review-only')qa.reviewsByTask.B=[{artifactId:'saved-B',sha256:'a'.repeat(64),name:'changes.json',createdAt:1,status:'complete',headBefore:null,headAfter:null,preexistingPaths:[],notes:[],files:[]}]
 },{status,result})
 await page.locator('[data-task-id="B"]').click()
 await expect(page.locator('.wb-task-head h2')).toHaveText('已保存的访谈记录')
 // Unclassified saved files are not a reason to jump back to the oldest message.
 await expect(page.locator('.wb-message').last()).toBeInViewport()
 expect(await page.locator('.wb-content').evaluate(el=>el.scrollTop)).toBeGreaterThan(500)
 await page.evaluate(()=>(window as any).qa.releaseReviews())
 await expect.poll(()=>page.evaluate(()=>(window as any).qa.controller.state.reviewsLoaded)).toBe(true)
 if(result==='deliverable'){
  await expect(page.locator('#wb-artifacts .wb-artifact')).toBeInViewport()
  expect(await page.locator('.wb-content').evaluate(el=>el.scrollTop)).toBe(0)
 }else{
  await expect(page.locator('.wb-message').last()).toBeInViewport()
  expect(await page.locator('.wb-content').evaluate(el=>el.scrollTop)).toBeGreaterThan(500)
  await expect(page.locator('#wb-artifacts.is-outcome')).toHaveCount(0)
  if(result==='review-only')await expect(page.locator('#wb-review>summary')).toBeInViewport()
 }
 await page.screenshot({path:testInfo.outputPath('first-entry.png')})
 await page.evaluate(()=>(window as any).qa.stop())
})

for(const result of ['deliverable','none'])test(`cold restored answered task with ${result} distinguishes loading from saved reading`,async({page},testInfo)=>{
 await page.setViewportSize({width:1400,height:850})
 await page.addInitScript(()=>{
  sessionStorage.setItem('cc.workbench.window.v1:view',JSON.stringify({scope:'task:bbbb2222',query:{q:'',archived:'exclude'},search:''}))
  sessionStorage.setItem('cc.workbench.window.v1:draft:task:bbbb2222',JSON.stringify({path:'/synthetic/project',text:'',title:'',providerId:'codex',followup:'恢复后保留的补充草稿'}))
 })
 // Valid persisted task IDs exercise the real loadWorkbenchView path before module import.
 const setup=`task.id='aaaa1111';other.id='bbbb2222';details.aaaa1111=details.A;details.bbbb2222=details.B;
 for(const detail of [details.A,details.B]){for(const event of detail.events)event.taskId=detail.task.id;for(const artifact of detail.artifacts)artifact.taskId=detail.task.id}
 ${result==='none'?'details.B.artifacts=[];':''}`
 const restoredFixture=fixture.replace('const controller=initWorkbenchPage',setup+'\nconst controller=initWorkbenchPage')
 await page.route('http://127.0.0.1:4211/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/'){await route.fulfill({contentType:'text/html',body:restoredFixture});return}
  try{await route.fulfill({body:await readFile(source+path),contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'})}
  catch{await route.fulfill({status:404,body:'missing fixture asset'})}
 })
 await page.goto('http://127.0.0.1:4211')
 await expect(page.locator('.wb-task-head h2')).toHaveText('已保存的访谈记录')
 await expect.poll(()=>page.evaluate(()=>(window as any).qa.controller.state.reviewsLoaded)).toBe(true)
 await expect(page.locator('#wb-followup-text')).toHaveValue('恢复后保留的补充草稿')
 if(result==='deliverable'){
  await expect(page.locator('#wb-artifacts')).toHaveAttribute('open','')
  await expect(page.locator('#wb-artifacts .wb-artifact')).toBeInViewport()
  expect(await page.locator('.wb-content').evaluate(el=>el.scrollTop)).toBe(0)
 }else{
  await expect(page.locator('.wb-message').last()).toBeInViewport()
  expect(await page.locator('.wb-content').evaluate(el=>el.scrollTop)).toBeGreaterThan(500)
 }
 await page.screenshot({path:testInfo.outputPath('cold-restored.png')})
 if(result==='deliverable')await page.locator('#wb-artifacts>summary').click()
 // A position actually read after loading must still survive leaving and returning.
 await page.locator('.wb-content').evaluate(el=>{el.scrollTop=420})
 await page.evaluate(()=>(window as any).qa.paint())
 await page.locator('[data-task-id="aaaa1111"]').click()
 await page.locator('[data-task-id="bbbb2222"]').click()
 expect(await page.locator('.wb-content').evaluate(el=>el.scrollTop)).toBe(420)
 if(result==='deliverable')await expect(page.locator('#wb-artifacts')).not.toHaveAttribute('open','')
 await expect(page.locator('#wb-followup-text')).toHaveValue('恢复后保留的补充草稿')
 await page.evaluate(()=>(window as any).qa.stop())
})
