import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
// In-process DRY_RUN transport; production DOM/modules/CSS. No daemon discovery,
// token, project directory, shared port or external network is involved.
const source=fileURLToPath(new URL('../src/',import.meta.url))
const fixture=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/styles/workbench.css"><style>html,body{margin:0;height:100%;overflow:hidden}#workbench-root{height:100%}</style></head><body><div id="workbench-root"></div><script type="module">
import {initWorkbenchPage,stopWorkbenchPolling} from '/modules/workbench.js'
const task=(id,title,updatedAt)=>({id,title,updatedAt,path:'/copies/'+id,sourcePath:'/fixture/project',providerId:'codex',status:'completed',createdAt:1,error:null,canArchive:true})
const tasks=[task('aabbccdd','任务 A',10),task('11223344','任务 B',1)]
const workspace=t=>({id:'ws-'+t.id,mode:'isolated',sourcePath:t.sourcePath,executionPath:t.path,branch:'codex/cc-task-'+t.id,baseCommit:'a'.repeat(40)})
const artifact={id:'restore',taskId:'aabbccdd',name:'restore.json',mime:'application/json',size:1,sha256:'a'.repeat(64),createdAt:1,approvedAt:null}
let reviews=[{artifactId:'restore',sha256:'a'.repeat(64),name:'restore.json',createdAt:90,status:'complete',headBefore:null,headAfter:null,preexistingPaths:[],notes:[],restore:{runId:'run',scope:'closed_session',startedAt:10,finishedAt:90},files:[{path:'a.txt',kind:'modified',preexisting:false,diff:'@@ -1 +1 @@\\n-old\\n+new',revert:{changeId:'change',state:'available'}}]}]
const qa={tasks,calls:[],outcome:'reverted',stale:false,late:false,release:null}
const invoke=async(method,path,body)=>{
 qa.calls.push({method,path,body})
 if(path==='/v1/workbench')return{tasks,providers:[{id:'codex',displayName:'Codex'}],projects:[{id:'p',name:'来源项目',path:'/fixture/project',providerId:'codex'}],defaultProvider:'codex',canWechat:false}
 if(path.startsWith('/v1/workbench/task?')){const id=new URL('http://fixture'+path).searchParams.get('id'),t=tasks.find(t=>t.id===id);return{task:t,events:[{id:'1',taskId:id,kind:'text',text:'可继续阅读的 **内容**',createdAt:1}],artifacts:id==='aabbccdd'?[artifact]:[],workspace:workspace(t)}}
 if(path.startsWith('/v1/workbench/review?'))return{reviews:path.includes('aabbccdd')?structuredClone(reviews):[]}
 if(path==='/v1/workbench/review-revert'){
  if(qa.outcome==='conflict')throw Error('restore_version_changed')
  const o={...body,taskId:body.id,workspaceId:'ws-aabbccdd',operationId:'op',state:qa.outcome,...(qa.outcome==='needs_recovery'?{observedFingerprint:'fp'}:{})}
  if(qa.late)await new Promise(r=>{qa.release=r})
  reviews[0].files[0].revert={changeId:'change',state:o.state,operationId:'op',...(o.observedFingerprint?{observedFingerprint:o.observedFingerprint}:{})}
  qa.operation=o;return{operation:o}
 }
 if(path==='/v1/workbench/review-revert-resolve'){
  if(qa.stale)throw Error('restore_observation_stale')
  reviews[0].files[0].revert={changeId:'change',state:'resolved_keep_current'}
  return{operation:{...qa.operation,taskId:body.id,state:'resolved_keep_current'}}
 }
 if(path==='/v1/workbench/workspace-export')return{artifact:{...artifact,id:'patch',name:'project.patch',mime:'text/plain'}}
 if(path.startsWith('/v1/workbench/artifact?'))return{name:'project.patch',mime:'text/plain',contentBase64:btoa('complete patch'),size:14,sha256:'b'.repeat(64)}
 return{}
}
qa.controller=initWorkbenchPage({invokeWorkbenchApi:invoke,pollMs:60000,invoke:async(command,args)=>qa.calls.push({command,args})});qa.stop=stopWorkbenchPolling;window.qa=qa
</script></body></html>`
test.beforeEach(async({page})=>{
 await page.route('https://workbench-isolation.test/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/')return route.fulfill({contentType:'text/html',body:fixture})
  try{await route.fulfill({body:await readFile(source+path),contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'})}catch{process.stderr.write('MISSING ASSET '+path+'\n');await route.fulfill({status:404})}
 })
 page.on('console',message=>process.stderr.write('CONSOLE '+message.text()+'\n'))
 page.on('pageerror',error=>process.stderr.write('FIXTURE ERROR '+error.message+'\n'))
 page.on('dialog',dialog=>dialog.accept())
 await page.goto('https://workbench-isolation.test');await expect(page.locator('.wb-task-head h2')).toHaveText('任务 A')
 await page.locator('#wb-review').evaluate(el=>el.setAttribute('open',''))
})
test('version conflict keeps draft and original request id, then exact success updates restored state',async({page})=>{
 await page.locator('#wb-followup-text').fill('未发送的补充')
 await page.locator('[data-review-file-path="a.txt"]').evaluate(el=>el.setAttribute('open',''))
 await page.evaluate(()=>{(window as any).qa.readingNode=document.querySelector('.wb-dialogue .wb-message')})
 await page.evaluate(()=>{(window as any).qa.outcome='conflict'})
 await page.locator('[data-action="review-revert"]').click();await page.locator('[data-restore-confirm="accept"]').click()
 await expect(page.locator('.wb-error')).toContainText('restore_version_changed')
 await expect(page.locator('#wb-followup-text')).toHaveValue('未发送的补充')
 await page.evaluate(()=>{(window as any).qa.outcome='reverted'})
 await page.locator('[data-action="review-revert"]').click();await page.locator('[data-restore-confirm="accept"]').click()
 await expect(page.locator('#wb-review')).toContainText('已撤回')
 expect(await page.evaluate(()=>{const posts=(window as any).qa.calls.filter((c:any)=>c.path==='/v1/workbench/review-revert');return posts[0].body.requestId===posts[1].body.requestId})).toBe(true)
 await expect(page.locator('#wb-followup-text')).toHaveValue('未发送的补充')
 await expect(page.locator('[data-review-file-path="a.txt"]')).toHaveAttribute('open','')
 expect(await page.evaluate(()=>document.querySelector('.wb-dialogue .wb-message')===(window as any).qa.readingNode)).toBe(true)
})
test('needs recovery and stale observations never display reverted; keep current is a separate receipt',async({page})=>{
 await page.evaluate(()=>{(window as any).qa.outcome='needs_recovery'})
 await page.locator('[data-action="review-revert"]').click();await page.locator('[data-restore-confirm="accept"]').click()
 await expect(page.locator('[data-action="review-revert-resolve"]')).toBeVisible()
 await expect(page.locator('#wb-review')).not.toContainText('已撤回')
 await page.evaluate(()=>{(window as any).qa.stale=true})
 await page.locator('[data-action="review-revert-resolve"]').click();await page.locator('[data-restore-confirm="accept"]').click()
 await expect(page.locator('.wb-error')).toContainText('restore_observation_stale')
 await page.evaluate(()=>{(window as any).qa.stale=false})
 await page.locator('[data-action="review-revert-resolve"]').click();await page.locator('[data-restore-confirm="accept"]').click()
 await expect(page.locator('#wb-review')).toContainText('已保留当前现场')
 await expect(page.locator('#wb-review')).not.toContainText('已撤回')
})
test('a late revert receipt does not switch another task or consume its draft',async({page})=>{
 await page.evaluate(()=>{(window as any).qa.late=true})
 await page.locator('[data-action="review-revert"]').click();await page.locator('[data-restore-confirm="accept"]').click()
 await page.locator('[data-task-id="11223344"]').click()
 await expect(page.locator('.wb-task-head h2')).toHaveText('任务 B')
 await page.locator('#wb-followup-text').fill('任务 B 的草稿')
 await page.evaluate(()=>{(window as any).qa.release()})
 await expect(page.locator('.wb-task-head h2')).toHaveText('任务 B')
 await expect(page.locator('#wb-followup-text')).toHaveValue('任务 B 的草稿')
 await expect(page.locator('.wb-error')).toHaveCount(0)
})
test('source project groups copies and full export reuses actual artifact download',async({page})=>{
 await page.locator('#wb-task-info').evaluate(el=>el.setAttribute('open',''))
 await expect(page.locator('.wb-task-context')).toContainText('来源项目')
 await page.locator('[data-action="open-task-folder"]').click()
 expect(await page.evaluate(()=>(window as any).qa.calls.find((c:any)=>c.command==='open_workbench_folder').args)).toEqual({taskId:'aabbccdd'})
 const download=page.waitForEvent('download');await page.locator('[data-action="workspace-export"]').click()
 expect((await download).suggestedFilename()).toBe('project.patch')
 expect(await page.evaluate(()=>(window as any).qa.calls.find((c:any)=>c.path==='/v1/workbench/workspace-export').body)).toEqual({id:'aabbccdd'})
})
test('file impact confirmation can be cancelled without creating a mutation',async({page})=>{
 await page.setViewportSize({width:390,height:844})
 await page.locator('[data-action="review-revert"]').click()
 const dialog=page.getByRole('dialog',{name:'撤回这个文件'})
 await expect(dialog).toBeVisible();expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await expect(dialog).toContainText('a.txt');await expect(dialog).toContainText('整段已关闭会话')
 await dialog.locator('[data-restore-confirm="cancel"]').click()
 expect(await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.path==='/v1/workbench/review-revert').length)).toBe(0)
 await expect(page.locator('[data-action="review-revert"]')).toBeVisible()
})

// An interrupted terminal task can still own an unclosed writer.
for(const writerExit of ['alive','unconfirmed'] as const) {
 for(const action of ['review-revert','review-revert-resolve'] as const) {
  const prepare = async(page:any) => {
   if(action==='review-revert-resolve') {
    await page.evaluate(()=>{(window as any).qa.outcome='needs_recovery'})
    await page.locator('[data-action="review-revert"]').click()
    await page.locator('[data-restore-confirm="accept"]').click()
    await expect(page.locator('[data-action="review-revert-resolve"]')).toBeVisible()
   }
  }
  test(`writer ${writerExit} suppresses ${action} and preserves exit guidance`,async({page})=>{
   await prepare(page)
   await page.evaluate(async state=>{const q=(window as any).qa;Object.assign(q.tasks[0],{status:'interrupted',error:'writer_not_closed',writerExit:state});await q.controller.refresh({force:true})},writerExit)
   await expect(page.locator(`[data-action="${action}"]`)).toHaveCount(0)
   if(writerExit==='unconfirmed')await expect(page.locator('[data-action="confirm-writer-exited"]')).toBeVisible()
   else await expect(page.locator('.wb-error-note')).toContainText('执行程序还在运行')
  })
  test(`stale ${action} cannot open confirmation while writer is ${writerExit}`,async({page})=>{
   await prepare(page)
   // New detail has arrived; the earlier review controls are still painted.
   await page.evaluate(state=>{Object.assign((window as any).qa.controller.state.detail.task,{status:'interrupted',error:'writer_not_closed',writerExit:state})},writerExit)
   await page.locator(`[data-action="${action}"]`).click()
   await expect(page.getByRole('dialog')).toHaveCount(0)
   // Native dialog close dispatches on a later animation frame; drain it before checking writes.
   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
   expect(await page.evaluate(a=>(window as any).qa.calls.filter((c:any)=>c.path==='/v1/workbench/'+a).length,action)).toBe(0)
  })
  test(`confirmation cannot submit ${action} after writer becomes ${writerExit}`,async({page})=>{
   await prepare(page)
   await page.locator(`[data-action="${action}"]`).click()
   await expect(page.getByRole('dialog')).toBeVisible()
   await page.evaluate(state=>{Object.assign((window as any).qa.controller.state.detail.task,{status:'interrupted',error:'writer_not_closed',writerExit:state})},writerExit)
   await page.locator('[data-restore-confirm="accept"]').click()
   await expect(page.getByRole('dialog')).toHaveCount(0)
   // Native dialog close dispatches on a later animation frame; drain it before checking writes.
   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
   expect(await page.evaluate(a=>(window as any).qa.calls.filter((c:any)=>c.path==='/v1/workbench/'+a).length,action)).toBe(0)
  })
 }
}
