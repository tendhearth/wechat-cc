import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
const source=fileURLToPath(new URL('../src/',import.meta.url))
// Real production dialog and browser storage; transport only, no daemon or listener.
const fixture=`<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
import {createTaskEntry} from '/modules/task-entry.js'
const projectId='p-0123456789abcdef0123'
sessionStorage.setItem('cc.task-entry.window.v1',JSON.stringify({sourceText:'分支要求',text:'分支要求',draftId:crypto.randomUUID(),target:{kind:'project',projectId,isolation:'worktree',base:'cc/retained'},providerId:'codex',executionMode:'isolated',execution:{defaults:'provider',model:null,reasoningEffort:null},excerpts:[],pending:null}))
const q={mode:'unknown',calls:[],projects:[{id:projectId,name:'Fixture',path:'/fixture/source',providerId:'codex'}],accepted:[]}
const invoke=async(method,path,body)=>{
 q.calls.push({method,path,body:body&&structuredClone(body)})
 if(path==='/v1/workbench/entry-options')return{status:'ready',defaultProviderId:'codex',providers:[{id:'codex',displayName:'Codex',available:true,capabilities:{features:{executionSettings:false,modelCatalog:false}}}],projects:q.projects}
 if(path.startsWith('/v1/workbench/entry-receipt?'))throw Error('entry_not_found')
 if(path==='/v1/workbench/create-entry'){
  if(q.mode==='unknown')throw Error('network_offline')
  if(body.target.base!==undefined)throw Error('worktree_base_unsupported')
  return{receipt:{requestId:body.requestId,taskId:'aabbccdd',matterId:'aabbccdd',runId:'fixture-run',acceptedAt:1},task:{id:'aabbccdd'}}
 }
 throw Error('Unexpected fixture request '+path)
}
q.remount=()=>{q.entry=createTaskEntry({invokeWorkbenchApi:invoke,onAccepted:r=>q.accepted.push(r)});q.result=q.entry.open({text:'分支要求'});q.result.then(r=>{if(r)q.accepted.push(r)})};q.remount();window.qa=q
</script></body></html>`
test.beforeEach(async({page})=>{
 await page.route('http://localhost:4198/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/')return route.fulfill({contentType:'text/html',body:fixture})
  try{await route.fulfill({body:await readFile(source+path),contentType:/\.m?js$/.test(path)?'text/javascript':'application/octet-stream'})}catch{await route.fulfill({status:404})}
 })
 await page.goto('http://localhost:4198');await expect(page.locator('[type="submit"]')).toBeEnabled()
})
const posts=(page:any)=>page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.path==='/v1/workbench/create-entry').map((c:any)=>c.body))
test('saved branch remains frozen through unknown retry, remount and lost source without a picker',async({page})=>{
 await expect(page.locator('[name="base"]')).toHaveCount(0)
 await page.locator('[type="submit"]').click();await expect(page.locator('[role="alert"]')).toContainText('同一请求')
 const original=(await posts(page))[0];expect(original.target.base).toBe('cc/retained')
 await page.locator('[data-entry-action="cancel"]').first().click()
 await expect(page.locator('dialog')).toHaveCount(0)
 await page.evaluate(()=>{const q=(window as any).qa;q.projects=[];q.remount()})
 await expect(page.locator('[type="submit"]')).toBeEnabled();await page.locator('[type="submit"]').click()
 await expect.poll(async()=> (await posts(page)).length).toBe(2);expect((await posts(page))[1]).toEqual(original)
 expect(await page.evaluate(()=>(window as any).qa.accepted)).toEqual([])
})
test('definite unsupported branch preserves draft and explicit project reselection creates a current-commit intent',async({page})=>{
 await page.evaluate(()=>{(window as any).qa.mode='rejected'})
 await page.locator('[type="submit"]').click();await expect(page.locator('[role="alert"]')).toContainText('分支')
 const original=(await posts(page))[0];await expect(page.locator('[name="text"]')).toHaveValue('分支要求')
 await page.locator('summary').click();await page.locator('[name="project"]').selectOption('p-0123456789abcdef0123')
 await page.locator('[type="submit"]').click();await expect.poll(async()=> (await posts(page)).length).toBe(2)
 const next=(await posts(page))[1];expect(next.requestId).not.toBe(original.requestId);expect(next.target).toEqual({kind:'project',projectId:'p-0123456789abcdef0123'})
 await expect(page.locator('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).qa.accepted)).toHaveLength(1)
})
