import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

// 行评论 + 按块撤回(2026-10-21,切片 3):生产模块 + 合成 API,不连 daemon。
// 点一行、Shift 点扩到同一块 ⇒「评论」⇒ 存草稿 ⇒ 行下出现草稿、底部「1 条评论待发出」;
// 「撤回这一块」点两下 ⇒ 小签「已撤回」+「恢复这一块」;发出遇上原会话不可恢复 ⇒ 换成「带记录重新开始并发回」再发。
const source=fileURLToPath(new URL('../src/',import.meta.url))
const fixture=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/styles/workbench.css"></head><body><div id="workbench-root"></div><script type="module">
import {initWorkbenchPage} from '/modules/workbench.js'
const H0='1'.repeat(64),H1='2'.repeat(64),TOKEN='c'.repeat(64)
const busy=new URLSearchParams(location.search).has('busy')
let reverted=false,restartAsked=false
const comments=[]
const hunks=()=>[
  {index:0,sha256:H0,header:'@@ -1,3 +1,3 @@',oldStart:1,oldCount:3,newStart:1,newCount:3,rows:4},
  {index:1,sha256:H1,header:'@@ -10 +10 @@',oldStart:10,oldCount:1,newStart:10,newCount:1,rows:2,...(reverted?{reverted:{at:5}}:{})},
]
const reviews=()=>[{artifactId:'11111111',sha256:'a'.repeat(64),name:'本轮文件对比.json',createdAt:1,status:'complete',headBefore:null,headAfter:null,preexistingPaths:[],notes:[],
  files:[{path:'src/app.ts',preexisting:false,kind:'modified',diff:'@@ -1,3 +1,3 @@\\n a\\n-b\\n+c\\n d\\n@@ -10 +10 @@\\n-x\\n+y',hunks:hunks(),...(comments.length?{comments:comments.map(c=>({...c}))}:{})}]}]
const task=()=>({id:'aaaa1111',title:'整理首页',path:'/work/site',workspaceKind:'project',providerId:'codex',status:'completed',createdAt:1,updatedAt:1,error:null})
const calls=[]
const invokeWorkbenchApi=async(method,path,body)=>{
  calls.push({method,path,body})
  if(path==='/v1/workbench/review-comment'){
    if(body.delete){comments.splice(comments.findIndex(c=>c.id===body.commentId),1);return{deleted:body.commentId}}
    const c={id:body.commentId,hunk:body.hunk,rowStart:body.rowStart,rowEnd:body.rowEnd,side:'new',lineStart:body.rowStart+1,lineEnd:body.rowEnd,body:body.body,state:'draft'}
    comments.push(c);return{comment:c}
  }
  if(path==='/v1/workbench/review-hunk'){
    if(busy)throw new Error('HTTP 409: {"error":"workbench_busy"}')
    reverted=body.action==='revert';return{hunk:{path:body.path,hunk:body.hunk,state:reverted?'reverted':'restored'}}
  }
  if(path==='/v1/workbench/review-comments-send'){
    if(!body.restartToken){restartAsked=true;throw new Error('HTTP 409: {"error":"restart_confirmation_required"}')}
    for(const c of comments){c.state='sent';c.sentAt=9}
    return{task:task(),sent:comments.length,remaining:0,skippedDiscarded:0}
  }
  if(path.startsWith('/v1/workbench/task?'))return path.includes('since=')?new Promise(()=>{}):{task:task(),version:1,events:[],artifacts:[],permissions:[],...(restartAsked?{continuation:{mode:'restart_required',restart:{token:TOKEN,context:'记录',eventCount:1,includedEventCount:1,truncated:false}}}:{})}
  if(path.startsWith('/v1/workbench/review?'))return{reviews:reviews()}
  if(path.startsWith('/v1/matters?'))return{matters:[]}
  return{tasks:[task()],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,projects:[{id:'p-0123456789abcdef0123',name:'个人网站',path:'/work/site',providerId:'codex'}]}
}
const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60000})
window.qa={controller,calls}
</script></body></html>`

const serve=async(page:import('@playwright/test').Page)=>{
 await page.route('http://localhost:4199/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/'){await route.fulfill({contentType:'text/html',body:fixture});return}
  try{const body=await readFile(source+path);await route.fulfill({body,contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'})}
  catch{await route.fulfill({status:404,body:'missing fixture asset'})}
 })
}
const posts=(page:import('@playwright/test').Page)=>page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.method==='POST').map((c:any)=>[c.path,c.body]))
const openFile=async(page:import('@playwright/test').Page)=>{
 await page.evaluate(()=>(window as any).qa.controller.selectTask('aaaa1111'))
 const panel=page.locator('#wb-review')
 await panel.locator('summary').first().click()
 await panel.locator('.wb-review-file > summary').click()
 await expect(panel.locator('.wb-review-hunk')).toHaveCount(2)
 return panel
}

test('line comments: select rows, save a draft, revert a hunk, send with restart confirmation',async({page})=>{
 await serve(page)
 await page.goto('http://localhost:4199')
 const panel=await openFile(page)
 await panel.locator('[data-hunk="0"][data-row="1"]').click()
 await panel.locator('[data-hunk="0"][data-row="2"]').click({modifiers:['Shift']})
 await expect(panel.locator('.is-selected')).toHaveCount(2)
 await expect(panel.locator('[data-line-select]')).toContainText('已选 2 行')
 await panel.locator('[data-action="line-comment-open"]').click()
 const box=panel.locator('.wb-line-compose textarea')
 await expect(box).toHaveAttribute('placeholder','这几行要怎么改…')
 await box.fill('这里改成常量')
 await panel.locator('.wb-line-compose button[type="submit"]').click()
 const draft=panel.locator('.wb-line-comment[data-state="draft"]')
 await expect(draft).toContainText('这里改成常量')
 await expect(draft).toContainText('草稿')
 await expect(panel.locator('.wb-review-send-count')).toHaveText('1 条评论待发出')
 const [[createPath,created]]=await posts(page)
 expect(createPath).toBe('/v1/workbench/review-comment')
 expect(created).toMatchObject({id:'aaaa1111',artifactId:'11111111',path:'src/app.ts',hunk:0,hunkSha256:'1'.repeat(64),rowStart:1,rowEnd:2,body:'这里改成常量'})
 expect(created.commentId).toMatch(/^[0-9a-f-]{36}$/)

 const revert=panel.locator('[data-action="review-hunk"][data-hunk="1"]')
 await expect(revert).toHaveText('撤回这一块')
 await revert.click()
 await expect(revert).toHaveText('再点一次：撤回这一块')
 await revert.click()
 await expect(panel.locator('[data-review-hunk="1"] [data-mark="reverted"]')).toHaveText('已撤回')
 await expect(panel.locator('[data-action="review-hunk"][data-hunk="1"]')).toHaveText('恢复这一块')
 expect((await posts(page)).at(-1)).toEqual(['/v1/workbench/review-hunk',{id:'aaaa1111',artifactId:'11111111',path:'src/app.ts',hunk:1,hunkSha256:'2'.repeat(64),action:'revert'}])

 await panel.locator('.wb-review-send textarea').fill('整体再收一收')
 await panel.locator('.wb-review-send button[type="submit"]').click()
 const again=panel.locator('.wb-review-send button[type="submit"]')
 await expect(again).toHaveText('带记录重新开始并发回')
 await expect(panel.locator('.wb-review-send')).toContainText('原会话无法恢复')
 await again.click()
 await expect(panel.locator('.wb-review-send [role="status"]')).toHaveText('已发出 1 条评论。')
 await expect(panel.locator('.wb-line-comment[data-state="sent"]')).toContainText('之后没再动过这个文件')
 const sends=(await posts(page)).filter(([path]:[string])=>path==='/v1/workbench/review-comments-send')
 expect(sends).toEqual([
  ['/v1/workbench/review-comments-send',{id:'aaaa1111',summary:'整体再收一收'}],
  ['/v1/workbench/review-comments-send',{id:'aaaa1111',summary:'整体再收一收',restartToken:'c'.repeat(64)}],
 ])
})

test('a busy folder refuses the hunk revert in plain words',async({page})=>{
 await serve(page)
 await page.goto('http://localhost:4199/?busy=1')
 const panel=await openFile(page)
 const revert=panel.locator('[data-action="review-hunk"][data-hunk="0"]')
 await revert.click();await revert.click()
 await expect(page.locator('.wb-error')).toContainText('这个文件夹还有会话或检查在跑，等它停下再撤回。')
 await expect(panel.locator('[data-mark="reverted"]')).toHaveCount(0)
})
