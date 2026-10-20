import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

// 工作区脚本「运行」(2026-10-20):生产模块 + 合成 API,不连 daemon。
// 没批过 ⇒ 后台回 script_approval_required(428),确认框逐字给出三条脚本,批了再原样重发;之后状态行变成「运行中 · 端口」+「停下」。
const source=fileURLToPath(new URL('../src/',import.meta.url))
const fixture=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/styles/workbench.css"></head><body><div id="workbench-root"></div><script type="module">
import {initWorkbenchPage} from '/modules/workbench.js'
const HASH='ab'.repeat(32)
const config={setup:'bun install',run:'bun run dev --port "$TENDHEARTH_PORT"',archive:null}
let approved=false,running=false
const scripts=()=>({configured:true,approved,hash:HASH,config,setup:approved?'done':'pending',run:running?'running':'idle',archiving:false})
const task=()=>({id:'aaaa1111',title:'整理首页',path:'/state/worktrees/p/aaaa1111',workspaceKind:'project',providerId:'codex',status:'completed',createdAt:1,updatedAt:1,error:null,worktree:{branch:'cc/aaaa1111',projectPath:'/work/site',removed:false,merged:false,...(running?{port:47100}:{}),scripts:scripts()}})
const listTask=()=>{const {scripts:_s,...worktree}=task().worktree;return{...task(),worktree}}
const calls=[]
const invokeWorkbenchApi=async(method,path,body)=>{
  calls.push({method,path,body})
  if(path==='/v1/workbench/worktree'){
    if(body.action==='run'){if(!approved)throw new Error('script_approval_required');running=true}
    if(body.action==='stop')running=false
    return{worktree:{branch:'cc/aaaa1111',scripts:scripts(),port:running?47100:null}}
  }
  if(path==='/v1/workbench/script-approve'){if(body.hash!==HASH)throw new Error('script_config_changed');approved=true;return{scripts:scripts()}}
  if(path.startsWith('/v1/workbench/task?'))return path.includes('since=')?new Promise(()=>{}):{task:task(),version:1,events:[],artifacts:[],permissions:[]}
  if(path.startsWith('/v1/workbench/review?'))return{reviews:[]}
  if(path.startsWith('/v1/matters?'))return{matters:[]}
  return{tasks:[listTask()],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,projects:[{id:'p-0123456789abcdef0123',name:'个人网站',path:'/work/site',providerId:'codex'}]}
}
const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60000})
window.qa={controller,calls}
</script></body></html>`

test('run a worktree script: unapproved ⇒ the dialog shows the scripts verbatim, approve by hash, retry, then stop',async({page})=>{
 await page.route('http://localhost:4199/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/'){await route.fulfill({contentType:'text/html',body:fixture});return}
  try{const body=await readFile(source+path);await route.fulfill({body,contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'})}
  catch{await route.fulfill({status:404,body:'missing fixture asset'})}
 })
 await page.goto('http://localhost:4199')
 await page.evaluate(()=>(window as any).qa.controller.selectTask('aaaa1111'))
 const status=page.locator('[data-scripts-status]')
 await expect(status).toContainText('工作区脚本：待确认')
 await status.locator('[data-action="worktree-run"]').click()
 const dialog=page.locator('dialog.wb-scripts-dialog')
 await expect(dialog).toBeVisible()
 await expect(dialog.locator('pre')).toHaveText(['bun install','bun run dev --port "$TENDHEARTH_PORT"'])
 await dialog.locator('[data-scripts="approve"]').click()
 await expect(dialog).toHaveCount(0)
 await expect(status).toContainText('运行中 · 端口 47100')
 const calls=await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.method==='POST').map((c:any)=>[c.path,c.body]))
 expect(calls).toEqual([
  ['/v1/workbench/worktree',{id:'aaaa1111',action:'run'}],
  ['/v1/workbench/script-approve',{id:'aaaa1111',hash:'ab'.repeat(32)}],
  ['/v1/workbench/worktree',{id:'aaaa1111',action:'run'}],
 ])
 await status.locator('[data-action="worktree-stop"]').click()
 await expect(status.locator('[data-action="worktree-run"]')).toBeVisible()
 await expect(status).not.toContainText('运行中')
})

test('cancelling the dialog runs nothing and sends no approval',async({page})=>{
 await page.route('http://localhost:4199/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/'){await route.fulfill({contentType:'text/html',body:fixture});return}
  try{const body=await readFile(source+path);await route.fulfill({body,contentType:/\.m?js$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'})}
  catch{await route.fulfill({status:404,body:'missing fixture asset'})}
 })
 await page.goto('http://localhost:4199')
 await page.evaluate(()=>(window as any).qa.controller.selectTask('aaaa1111'))
 await page.locator('[data-action="worktree-run"]').click()
 await page.locator('dialog.wb-scripts-dialog [data-scripts="cancel"]').click()
 await expect(page.locator('dialog.wb-scripts-dialog')).toHaveCount(0)
 const posts=await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.method==='POST').map((c:any)=>c.path))
 expect(posts).toEqual(['/v1/workbench/worktree'])
 await expect(page.locator('[data-scripts-status]')).toContainText('待确认')
})
