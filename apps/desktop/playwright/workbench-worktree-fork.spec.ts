import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
const source=fileURLToPath(new URL('../src/',import.meta.url))
// Production page, deferred transport boundary, no daemon or listening port.
const fixture=`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="workbench-root"></div><script type="module">
import {initWorkbenchPage,stopWorkbenchPolling} from '/modules/workbench.js'
const task=(id,title,providerId='codex')=>({id,title,providerId,path:'/copies/'+id,workspaceKind:'project',status:'completed',createdAt:1,updatedAt:1,error:null,worktree:{branch:'cc/'+id,projectPath:'/work/site',removed:false}})
const wt=task('aaaa1111','整理首页'),fork=task('bbbb2222','整理首页','claude'),other=task('cccc3333','另一件事')
let tasks=[wt,other]
const q={calls:[],mode:'success',receipt:false,release:null,attachments:false,workspace:false,mismatch:false,uploadDeferred:false,uploadRelease:null}
const detail=t=>({task:t,version:1,events:[{id:'1',taskId:t.id,kind:'user',text:'把首页的标题改短',createdAt:1,...(q.attachments?{attachments:[{id:'image',name:'reference.png',mime:'image/png',size:10}]}:{})}],artifacts:[],permissions:[],...(q.workspace?{workspace:{id:'ws',mode:'isolated',sourcePath:'/work/site',executionPath:t.path,branch:'codex/cc-task-fixture',baseCommit:'a'.repeat(40),removed:!!t.worktree?.removed}}:{})})
const accepted=id=>({receipt:{requestId:q.mismatch?'ffffffff-ffff-ffff-ffff-ffffffffffff':id,taskId:fork.id,matterId:fork.id,runId:'r',acceptedAt:1},task:fork})
const invoke=async(method,path,body)=>{
 q.calls.push({method,path,body:body&&structuredClone(body)})
 if(path==='/v1/workbench/attachment'){if(q.uploadDeferred)await new Promise(r=>{q.uploadRelease=r});return{attachment:{id:body.id,name:body.name,mime:body.mime,size:atob(body.base64).length,sha256:'a'.repeat(64)}}}
 if(path==='/v1/workbench/worktree'){if(body.action==='reopen'){wt.worktree.removed=false;return{worktree:{branch:wt.worktree.branch,reopened:true}}}throw Error('invalid_request')}
 if(path==='/v1/workbench/create-entry'){if(q.mode==='unknown')throw Error('network_offline');if(q.mode==='rejected')throw Error('invalid_text');if(q.mode==='deferred')await new Promise(r=>{q.release=r});tasks=[fork,wt,other];return accepted(body.requestId)}
 if(path.startsWith('/v1/workbench/entry-receipt?')){if(!q.receipt)throw Error('network_offline');tasks=[fork,wt,other];return accepted(new URL('http://x'+path).searchParams.get('requestId'))}
 if(path.startsWith('/v1/workbench/task?')){if(path.includes('since='))return new Promise(()=>{});return detail(tasks.find(t=>t.id===new URL('http://x'+path).searchParams.get('id')))}
 if(path.startsWith('/v1/workbench/review?'))return{reviews:[]}
 if(path.startsWith('/v1/matters?'))return{matters:[]}
 return{tasks,providers:[{id:'codex',displayName:'Codex'},{id:'claude',displayName:'Claude'},{id:'cursor',displayName:'Cursor'}],defaultProvider:'codex',canWechat:false,projects:[{id:'p-0123456789abcdef0123',name:'个人网站',path:'/work/site',providerId:'codex'}]}
}
q.remount=()=>{stopWorkbenchPolling();q.controller=initWorkbenchPage({invokeWorkbenchApi:invoke,pollMs:60000,onDelegate:async()=>{q.delegating=true}})};q.remount();window.qa=q
</script></body></html>`
test.beforeEach(async({page})=>{
 await page.route('http://localhost:4199/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/')return route.fulfill({contentType:'text/html',body:fixture})
  try{await route.fulfill({body:await readFile(source+path),contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'})}catch{await route.fulfill({status:404})}
 })
 await page.goto('http://localhost:4199');await page.evaluate(()=>(window as any).qa.controller.selectTask('aaaa1111'))
 await expect(page.locator('[data-action="worktree-fork"]')).toBeVisible()
})
const posts=async(page:any)=>page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.path==='/v1/workbench/create-entry').map((c:any)=>c.body))
const click=async(page:any)=>page.locator('[data-action="worktree-fork"]').click()
const opened=async(page:any)=>expect.poll(()=>page.evaluate(()=>(window as any).qa.controller.state.selectedId)).toBe('bbbb2222')
test('normal success sends the first text to the source project and opens the new isolated task',async({page})=>{
 await expect(page.locator('#wb-fork-provider option')).toHaveText(['Claude','Cursor'])
 await click(page);await opened(page)
 const bodies=await posts(page);expect(bodies).toHaveLength(1)
 expect(bodies[0]).toMatchObject({text:'把首页的标题改短',title:'整理首页',providerId:'claude',executionMode:'isolated',target:{kind:'project',projectId:'p-0123456789abcdef0123'}})
 expect(bodies[0].requestId).toMatch(/^[0-9a-f-]{36}$/)
})
test('unknown create and receipt preserve exact request through retry, remount and input drift',async({page})=>{
 await page.evaluate(()=>{(window as any).qa.mode='unknown'});await click(page);await expect(page.locator('.wb-error')).toBeVisible()
 const original=(await posts(page))[0]
 await page.evaluate(async()=>{const q=(window as any).qa;q.remount();await q.controller.selectTask('aaaa1111');q.controller.state.detail.events[0].text='后来改了要求';q.controller.state.projects[0].id='p-changed';q.controller.state.defaultProvider='cursor'})
 await click(page);await expect.poll(async()=> (await posts(page)).length).toBe(2)
 expect((await posts(page))[1]).toEqual(original)
 await page.evaluate(()=>{(window as any).qa.receipt=true});await click(page);await opened(page);expect(await posts(page)).toHaveLength(2)
})
test('explicit executor choice creates a new intent and switching back retries the original',async({page})=>{
 await page.evaluate(()=>{(window as any).qa.mode='unknown'});await click(page);await expect(page.locator('.wb-error')).toBeVisible()
 await page.locator('#wb-fork-provider').selectOption('cursor');await click(page);await expect.poll(async()=> (await posts(page)).length).toBe(2)
 await page.locator('#wb-fork-provider').selectOption('claude');await click(page);await expect.poll(async()=> (await posts(page)).length).toBe(3)
 const bodies=await posts(page);expect(bodies[1].requestId).not.toBe(bodies[0].requestId);expect(bodies[1].providerId).toBe('cursor');expect(bodies[2]).toEqual(bodies[0])
})
test('late success never steals navigation or draft and can be viewed later from the source',async({page})=>{
 await page.evaluate(()=>{(window as any).qa.mode='deferred'});await click(page)
 await expect.poll(()=>page.evaluate(()=>(window as any).qa.release!==null)).toBe(true)
 await page.locator('[data-action="worktree-fork"]').dispatchEvent('click');expect(await posts(page)).toHaveLength(1)
 await page.locator('[data-task-id="cccc3333"]').click();await page.locator('#wb-followup-text').fill('这件事的草稿')
 await page.evaluate(()=>{(window as any).qa.release()});await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))))
 await expect(page.locator('.wb-task-head h2')).toHaveText('另一件事');await expect(page.locator('#wb-followup-text')).toHaveValue('这件事的草稿')
 await page.locator('[data-task-id="aaaa1111"]').click();await click(page);await opened(page);expect(await posts(page)).toHaveLength(1)
})
test('workspace-only metadata forks using the source rather than the execution directory',async({page})=>{
 await page.evaluate(async()=>{const q=(window as any).qa;q.workspace=true;const t=q.controller.state.tasks.find((t:any)=>t.id==='aaaa1111');delete t.worktree;t.sourcePath='/work/site';await q.controller.refresh({force:true})})
 await expect(page.locator('[data-action="worktree-fork"]')).toBeVisible();await click(page);await opened(page)
 expect((await posts(page))[0].target.projectId).toBe('p-0123456789abcdef0123')
})
test('attachments are not silently omitted when another executor gets the requirement',async({page})=>{
 await page.evaluate(async()=>{const q=(window as any).qa;q.attachments=true;await q.controller.refresh({force:true})});await click(page)
 await expect(page.locator('.wb-error')).toContainText('材料');expect(await posts(page)).toHaveLength(0)
})
test('mismatched successful receipt keeps the original unknown request and never opens its task',async({page})=>{
 await page.evaluate(()=>{(window as any).qa.mismatch=true});await click(page);await expect(page.locator('.wb-error')).toBeVisible()
 expect(await page.evaluate(()=>(window as any).qa.controller.state.selectedId)).toBe('aaaa1111')
 const original=(await posts(page))[0]
 await page.evaluate(()=>{(window as any).qa.mismatch=false});await click(page);await opened(page)
 expect((await posts(page))[1]).toEqual(original)
})

test('late accepted result preserves a newly edited draft on the source task',async({page})=>{
 await page.evaluate(()=>{(window as any).qa.mode='deferred'});await click(page)
 await expect.poll(()=>page.evaluate(()=>(window as any).qa.release!==null)).toBe(true)
 await page.locator('#wb-followup-text').fill('刚写的新草稿')
 await page.evaluate(()=>{(window as any).qa.release()});await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))))
 await expect(page.locator('.wb-task-head h2')).toHaveText('整理首页');await expect(page.locator('#wb-followup-text')).toHaveValue('刚写的新草稿')
 await click(page);await opened(page);expect(await posts(page)).toHaveLength(1)
})

test('pending original provider remains retryable when provider and source project disappear',async({page})=>{
 await page.evaluate(()=>{(window as any).qa.mode='unknown'});await click(page);await expect(page.locator('.wb-error')).toBeVisible()
 const original=(await posts(page))[0]
 await page.evaluate(()=>{const q=(window as any).qa;q.controller.state.providers=[{id:'codex',displayName:'Codex'}];q.controller.state.projects=[];q.controller.paint(true)})
 await expect(page.locator('[data-action="worktree-fork"]')).toBeVisible();await click(page)
 await expect.poll(async()=> (await posts(page)).length).toBe(2);expect((await posts(page))[1]).toEqual(original)
})
test('opening another delegation while a fork is pending prevents its late navigation',async({page})=>{
 await page.evaluate(()=>{(window as any).qa.mode='deferred'});await click(page)
 await expect.poll(()=>page.evaluate(()=>(window as any).qa.release!==null)).toBe(true)
 await page.locator('[data-action="task-entry"]').first().click()
 await page.evaluate(()=>{(window as any).qa.release()});await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))))
 expect(await page.evaluate(()=>(window as any).qa.delegating)).toBe(true)
 expect(await page.evaluate(()=>(window as any).qa.controller.state.selectedId)).toBe('aaaa1111')
})

for(const gesture of ['drop','paste'])test('late fork preserves an attachment draft added by '+gesture,async({page})=>{
 await page.evaluate(()=>{(window as any).qa.mode='deferred'});await click(page)
 await expect.poll(()=>page.evaluate(()=>(window as any).qa.release!==null)).toBe(true)
 await page.locator('#wb-followup-text').evaluate((el,gesture)=>{
  const data=new DataTransfer();data.items.add(new File(['new draft material'],'new-draft.txt',{type:'text/plain'}))
  el.dispatchEvent(gesture==='drop'?new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}):new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))
 },gesture)
 await expect(page.locator('.wb-attachment-chip[data-upload-status="ready"]')).toContainText('new-draft.txt')
 await page.evaluate(()=>{(window as any).qa.release()})
 await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))))
 expect(await page.evaluate(()=>(window as any).qa.controller.state.selectedId)).toBe('aaaa1111')
 await expect(page.locator('.wb-attachment-chip[data-upload-status="ready"]')).toContainText('new-draft.txt')
})
test('late fork preserves a draft changed by removing an attachment',async({page})=>{
 await page.locator('#wb-attachment-files').setInputFiles({name:'remove-me.txt',mimeType:'text/plain',buffer:Buffer.from('old draft')})
 await expect(page.locator('.wb-attachment-chip[data-upload-status="ready"]')).toContainText('remove-me.txt')
 await page.evaluate(()=>{(window as any).qa.mode='deferred'});await click(page)
 await expect.poll(()=>page.evaluate(()=>(window as any).qa.release!==null)).toBe(true)
 await page.locator('[data-action="remove-attachment"]').click()
 await page.evaluate(()=>{(window as any).qa.release()})
 await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))))
 expect(await page.evaluate(()=>(window as any).qa.controller.state.selectedId)).toBe('aaaa1111')
})

test('late fork preserves attachment editing while upload is still pending',async({page})=>{
 await page.evaluate(()=>{const q=(window as any).qa;q.mode='deferred';q.uploadDeferred=true});await click(page)
 await expect.poll(()=>page.evaluate(()=>(window as any).qa.release!==null)).toBe(true)
 await page.locator('#wb-followup-text').evaluate(el=>{const data=new DataTransfer();data.items.add(new File(['material'],'pending.txt',{type:'text/plain'}));el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}))})
 await expect(page.locator('.wb-attachment-chip[data-upload-status="uploading"]')).toContainText('pending.txt')
 await expect.poll(()=>page.evaluate(()=>(window as any).qa.uploadRelease!==null)).toBe(true)
 await page.evaluate(()=>{(window as any).qa.release()});await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))))
 expect(await page.evaluate(()=>(window as any).qa.controller.state.selectedId)).toBe('aaaa1111')
 await page.evaluate(()=>{(window as any).qa.uploadRelease()})
 await expect(page.locator('.wb-attachment-chip[data-upload-status="ready"]')).toContainText('pending.txt')
})
test('upload completing after fork starts invalidates its late navigation',async({page})=>{
 await page.evaluate(()=>{(window as any).qa.uploadDeferred=true})
 await page.locator('#wb-attachment-files').setInputFiles({name:'finishing.txt',mimeType:'text/plain',buffer:Buffer.from('material')})
 await expect.poll(()=>page.evaluate(()=>(window as any).qa.uploadRelease!==null)).toBe(true)
 await page.evaluate(()=>{(window as any).qa.mode='deferred'});await click(page)
 await expect.poll(()=>page.evaluate(()=>(window as any).qa.release!==null)).toBe(true)
 await page.evaluate(()=>{(window as any).qa.uploadRelease()});await expect(page.locator('.wb-attachment-chip[data-upload-status="ready"]')).toContainText('finishing.txt')
 await page.evaluate(()=>{(window as any).qa.release()});await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))))
 expect(await page.evaluate(()=>(window as any).qa.controller.state.selectedId)).toBe('aaaa1111')
})

test('archive hint distinguishes historical worktrees from UUID copies and keeps the live-writer guard',async({page})=>{
 await page.evaluate(async()=>{const q=(window as any).qa;q.controller.state.tasks[0].canArchive=true;await q.controller.refresh({force:true})})
 await page.locator('#wb-task-info summary').click()
 await expect(page.locator('[data-action="archive-task"]')).toBeVisible()
 await expect(page.locator('.wb-task-organization small')).toHaveText('独立工作区没有没提交的改动时会一起删掉（分支保留）。')
 await page.evaluate(async()=>{const q=(window as any).qa;q.workspace=true;await q.controller.refresh({force:true})})
 await expect(page.locator('[data-action="archive-task"]')).toBeVisible()
 await expect(page.locator('.wb-task-organization small')).toHaveCount(0)
 await expect(page.locator('.wb-task-head')).toContainText('归档会保留副本')
 await page.evaluate(async()=>{const q=(window as any).qa;Object.assign(q.controller.state.tasks[0],{error:'writer_not_closed',writerExit:'unconfirmed'});await q.controller.refresh({force:true})})
 await expect(page.locator('[data-action="archive-task"]')).toHaveCount(0)
})

test('reopens a historical removed worktree through production transport but never exposes or posts UUID reopen',async({page})=>{
 await page.evaluate(async()=>{const q=(window as any).qa;q.controller.state.tasks[0].worktree.removed=true;await q.controller.refresh({force:true})})
 await expect(page.locator('[data-action="worktree-reopen"]')).toBeVisible()
 await page.locator('[data-action="worktree-reopen"]').click()
 await expect(page.locator('[data-action="worktree-commit"]')).toBeVisible()
 expect(await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.path==='/v1/workbench/worktree').map((c:any)=>c.body))).toEqual([{id:'aaaa1111',action:'reopen'}])
 await page.evaluate(async()=>{const q=(window as any).qa;q.workspace=true;q.controller.state.tasks[0].worktree.removed=true;await q.controller.refresh({force:true})})
 await expect(page.locator('.wb-task-head')).toContainText('工作区已删除')
 await expect(page.locator('[data-action="worktree-reopen"]')).toHaveCount(0)
 await page.evaluate(()=>{const button=document.createElement('button');button.dataset.action='worktree-reopen';document.getElementById('workbench-root')!.append(button);button.click();button.remove()})
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
 expect(await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.path==='/v1/workbench/worktree'))).toHaveLength(1)
})
