import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

// localhost:crypto.randomUUID 只在安全上下文里有(Tauri 页面是);路由拦截,不需要真的起服务。
// 「同样的要求也交给另一位，另做一份」(2026-10-08):生产模块 + 合成 API,不连 daemon。
const source=fileURLToPath(new URL('../src/',import.meta.url))
const fixture=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/styles/workbench.css"></head><body><div id="workbench-root"></div><script type="module">
import {initWorkbenchPage} from '/modules/workbench.js'
const wt={id:'aaaa1111',title:'整理首页',path:'/state/worktrees/p/aaaa1111',workspaceKind:'project',providerId:'codex',status:'completed',createdAt:1,updatedAt:1,error:null,worktree:{branch:'cc/aaaa1111',projectPath:'/work/site',removed:false,merged:false}}
const fork={...wt,id:'bbbb2222',title:'整理首页',providerId:'claude',path:'/state/worktrees/p/bbbb2222',worktree:{...wt.worktree,branch:'cc/bbbb2222'}}
let tasks=[wt]
const detailOf=t=>({task:t,version:1,events:[{id:'1',taskId:t.id,kind:'user',text:'把首页的标题改短，并补一段介绍',createdAt:1}],artifacts:[],permissions:[]})
const calls=[]
const invokeWorkbenchApi=async(method,path,body)=>{
  calls.push({method,path,body})
  if(path==='/v1/workbench/create-entry'){tasks=[fork,wt];return{receipt:{requestId:body.requestId,taskId:'bbbb2222',matterId:'bbbb2222',runId:'r',acceptedAt:1},task:fork}}
  if(path.startsWith('/v1/workbench/task?')){const id=new URL('http://x'+path).searchParams.get('id');return path.includes('since=')?new Promise(()=>{}):detailOf(tasks.find(t=>t.id===id))}
  if(path.startsWith('/v1/workbench/review?'))return{reviews:[]}
  if(path.startsWith('/v1/matters?'))return{matters:[]}
  return{tasks,providers:[{id:'codex',displayName:'Codex'},{id:'claude',displayName:'Claude'}],defaultProvider:'codex',canWechat:false,projects:[{id:'p-0123456789abcdef0123',name:'个人网站',path:'/work/site',providerId:'codex'}]}
}
const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60000})
window.qa={controller,calls}
</script></body></html>`

test('fork a worktree task to another executor: same request, same project, new isolated workspace, opens the new task',async({page})=>{
 await page.route('http://localhost:4199/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/'){await route.fulfill({contentType:'text/html',body:fixture});return}
  try{const body=await readFile(source+path);await route.fulfill({body,contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'})}
  catch{await route.fulfill({status:404,body:'missing fixture asset'})}
 })
 await page.goto('http://localhost:4199')
 await page.evaluate(()=>(window as any).qa.controller.selectTask('aaaa1111'))
 const picker=page.locator('#wb-fork-provider')
 await expect(picker).toBeVisible()
 await expect(picker.locator('option')).toHaveText(['Claude'])
 await page.locator('[data-action="worktree-fork"]').click()
 await expect.poll(()=>page.evaluate(()=>(window as any).qa.controller.state.selectedId)).toBe('bbbb2222')
 const created=await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.path==='/v1/workbench/create-entry').map((c:any)=>c.body))
 expect(created).toHaveLength(1)
 expect(created[0]).toMatchObject({text:'把首页的标题改短，并补一段介绍',title:'整理首页',providerId:'claude',target:{kind:'project',projectId:'p-0123456789abcdef0123',isolation:'worktree'}})
 expect(created[0].requestId).toMatch(/^[0-9a-f-]{36}$/)
})
