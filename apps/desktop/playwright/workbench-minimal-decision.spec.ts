import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

// Real desktop modules/styles, intercepted synthetic data. No daemon or server is used.
const source=fileURLToPath(new URL('../src/',import.meta.url))
const fixture=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/styles/workbench.css"><style>html,body{margin:0;height:100%;overflow:hidden}#workbench-root{height:100%}</style></head><body><div id="workbench-root"></div><script type="module">
import {initWorkbenchPage,stopWorkbenchPolling} from '/modules/workbench.js'
const task={id:'A',title:'验证本地修改',path:'/synthetic/project',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null,pendingPermissionCount:2,pendingQuestionCount:1}
const other={...task,id:'B',title:'整理说明',status:'completed',pendingPermissionCount:0,pendingQuestionCount:0}
const permission=id=>({id,taskId:'A',tool:'Bash',description:'bun run test -- '+id+'\\ncwd: /synthetic/project\\n仅允许这一次请求',createdAt:1})
const artifact={id:'file',taskId:'A',name:'验证说明.md',mime:'text/plain',size:5,sha256:'a'.repeat(64),createdAt:1,approvedAt:null}
const question={id:'q1',taskId:'A',createdAt:1,questions:[{id:'q',header:'验证',question:'先验证哪个页面？',options:[]}]}
const details={A:{task,version:1,runId:'run-A',inputMode:'steer',events:[{id:'e1',taskId:'A',kind:'text',text:'本地修改已经准备好，等待验证。',createdAt:1}],artifacts:[artifact],permissions:['p1','p2'].map(permission),questions:[question]},B:{task:other,events:[],artifacts:[],continuation:{mode:'continue'}}}
const posts=[]
const invokeWorkbenchApi=async(method,path,body)=>{
 if(method==='POST'){posts.push({path,body});throw Error('synthetic request rejected')}
 if(path.startsWith('/v1/workbench/task?'))return path.includes('since=')?new Promise(()=>{}):details[new URL(path,location.origin).searchParams.get('id')]
 if(path.startsWith('/v1/workbench/review?'))return{reviews:[]}
 if(path.startsWith('/v1/matters?'))return{matters:[]}
 return{tasks:[task,other],providers:[],defaultProvider:'codex',canWechat:false}
}
const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60000})
window.qa={controller,posts,stop:stopWorkbenchPolling,removePermissions:()=>{task.pendingPermissionCount=0;details.A.permissions=[];controller.paint(true)}}
</script></body></html>`

for(const size of [{width:1400,height:850},{width:900,height:650},{width:390,height:700},{width:700,height:450}])test(`minimal decision navigation and scope at ${size.width}x${size.height}`,async({page},testInfo)=>{
 await page.setViewportSize(size)
 await page.route('http://127.0.0.1:4202/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/'){await route.fulfill({contentType:'text/html',body:fixture});return}
  try{await route.fulfill({body:await readFile(source+path),contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'})}
  catch{await route.fulfill({status:404,body:'missing fixture asset'})}
 })
 await page.goto('http://127.0.0.1:4202')
 const jump=page.getByRole('button',{name:'3 项等你处理，查看请求',exact:true})
 await expect(jump).toHaveText('3')
 const marker=page.locator('[data-task-id="A"] .wb-task-attention')
 await expect(marker).toHaveText('3')
 await expect(marker).toHaveAttribute('title',/2 项权限请求等你确认，1 项问题等你回答/)
 await expect(page.locator('.wb-permissions h3')).toHaveText('需要你的决定')
 await expect(page.locator('.wb-task-head')).not.toContainText('等你处理')
 await jump.focus();await page.keyboard.press('Enter')
 await expect(page.locator('[data-action="deny-permission"][data-request-id="p1"]')).toBeFocused()
 await expect(page.locator('.wb-permission').first()).toContainText('bun run test -- p1\ncwd: /synthetic/project\n仅允许这一次请求')
 await page.locator('[data-question-other]').fill('先看一起做的页面')
 await page.locator('[data-task-id="B"]').click()
 await expect(page.locator('.wb-task-head h2')).toHaveText('整理说明')
 await page.locator('[data-task-id="A"]').click()
 await expect(page.locator('[data-question-other]')).toHaveValue('先看一起做的页面')
 await jump.focus();await page.keyboard.press('Enter')
 await expect(page.locator('[data-action="deny-permission"][data-request-id="p1"]')).toBeFocused()
 await page.screenshot({path:testInfo.outputPath('minimal-decision.png')})
 // Authoritative failure stays visible; the compact navigation never grants a request.
 expect(await page.evaluate(()=>(window as any).qa.posts)).toEqual([])
 await page.locator('[data-action="allow-permission"][data-request-id="p1"]').click()
 await expect(page.locator('.wb-error')).toBeVisible()
 expect(await page.evaluate(()=>(window as any).qa.posts)).toEqual([{path:'/v1/workbench/permission',body:{id:'A',requestId:'p1',decision:'allow'}}])
 await expect(page.locator('[data-action="allow-permission"][data-request-id="p1"]')).toBeEnabled()
 await page.evaluate(()=>(window as any).qa.removePermissions())
 const questionJump=page.getByRole('button',{name:'1 项等你处理，查看请求',exact:true})
 await questionJump.focus();await page.keyboard.press('Enter')
 await expect(page.locator('[data-question-other]')).toBeFocused()
 // Result access remains optional and returns to the conversation.
 await page.evaluate(()=>{const qa=(window as any).qa;qa.controller.state.preview={artifactId:'file',html:'<pre>验证记录</pre>'};qa.controller.state.selectedArtifactId='file';qa.controller.state.previewOpen=false;qa.controller.paint(true)})
 await page.locator('[data-action="show-artifacts"]').click()
 await expect(page.locator('.wb-artifact-panel')).toBeVisible()
 await page.locator('[data-action="back-to-dialogue"]').click()
 await expect(page.locator('.wb-artifact-panel')).toHaveCount(0)
 await page.evaluate(()=>(window as any).qa.stop())
})
