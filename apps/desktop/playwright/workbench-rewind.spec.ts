import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

// 回到某一轮(2026-10-21):生产模块 + 合成 API,不连 daemon。
// 点「回到这一轮结束时」⇒ 预览确认块;第一次确认后台说工作区刚变过(409 stale)⇒ 重拉预览、提示再看一眼;
// 再确认 ⇒ 第 2 轮灰掉标「已撤掉」,出现「撤销回退」;点两下撤销 ⇒ 回到原样。停住的那件事:两个选择,恢复要再确认。
const source=fileURLToPath(new URL('../src/',import.meta.url))
const fixture=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/styles/workbench.css"></head><body><div id="workbench-root"></div><script type="module">
import {initWorkbenchPage} from '/modules/workbench.js'
const T1='1'.repeat(64),T2='2'.repeat(64)
let rewound=false,stale=true,previews=0,blocked=new URLSearchParams(location.search).has('blocked')
const file=path=>({path,preexisting:false,kind:'modified',diff:'@@ -1 +1 @@\\n-a\\n+b'})
const turn=(id,sha,at,extra)=>({artifactId:id,sha256:sha.repeat(64),name:'本轮文件对比.json',createdAt:at,status:'complete',headBefore:null,headAfter:null,preexistingPaths:[],notes:[],files:[file('src/'+id+'.ts')],...extra})
const reviews=()=>rewound
  ?[turn('22222222','b',2,{discarded:true,rewindable:{start:false,end:false}}),turn('11111111','a',1,{rewindable:{start:true,end:true}})]
  :[turn('22222222','b',2,{rewindable:{start:true,end:true}}),turn('11111111','a',1,{rewindable:{start:true,end:true}})]
const task=()=>({id:'aaaa1111',title:'整理首页',path:'/state/worktrees/p/aaaa1111',workspaceKind:'project',providerId:'codex',status:blocked?'interrupted':'completed',createdAt:1,updatedAt:1,error:blocked?'rewind_needs_owner':null,worktree:{branch:'cc/aaaa1111',projectPath:'/work/site',removed:false,merged:false}})
const rewind=()=>blocked?{undo:null,blocked:{rewindId:'33333333-3333-4333-8333-333333333333',backupRef:'refs/tendhearth/rewind/aaaa1111/1',reason:'回退没做成（src/a.ts 的内容和那一刻对不上），也没能完整恢复原样。'}}:rewound?{undo:{rewindId:'44444444-4444-4444-8444-444444444444',createdAt:3},blocked:null}:null
const preview=()=>({token:previews===1?T1:T2,target:{artifactId:'11111111',to:'end',round:1},discarded:[{artifactId:'22222222',round:2}],files:{count:1,paths:[{status:'M',path:'src/22222222.ts'}]},extraChanges:{count:1,paths:[{status:'A',path:'notes.txt'}]},droppedCommits:{count:1,elsewhere:true},ignoredUntouched:true,rebuildHint:'被 ignore 的构建产物不会跟着回退，用之前先重新构建。',refsNote:'',session:'none',devServer:false,goal:null})
const calls=[]
const invokeWorkbenchApi=async(method,path,body)=>{
  calls.push({method,path,body})
  if(path.startsWith('/v1/workbench/rewind-preview')){previews++;return{preview:preview()}}
  if(path==='/v1/workbench/rewind'){
    if(body.undo){rewound=false;return{rewind:{rewindId:'u',backupRef:'b',head:'h',discarded:[]}}}
    if(stale){stale=false;throw new Error('rewind_confirmation_stale')}
    rewound=true;return{rewind:{rewindId:'44444444-4444-4444-8444-444444444444',backupRef:'b',head:'h',discarded:['22222222']}}
  }
  if(path==='/v1/workbench/rewind-resolve'){blocked=false;return{resolved:{resolution:body.choice}}}
  if(path.startsWith('/v1/workbench/task?'))return path.includes('since=')?new Promise(()=>{}):{task:task(),version:1,events:[],artifacts:[],permissions:[],...(rewind()?{rewind:rewind()}:{})}
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

test('rewind a round: preview, stale ⇒ re-preview, confirm, discarded round greyed, undo',async({page})=>{
 await serve(page)
 await page.goto('http://localhost:4199')
 await page.evaluate(()=>(window as any).qa.controller.selectTask('aaaa1111'))
 const panel=page.locator('#wb-review')
 await panel.locator('summary').first().click()
 await expect(panel.locator('[data-action="rewind-open"][data-to="start"]')).toHaveText('撤掉这一轮')
 await panel.locator('[data-action="rewind-open"][data-to="end"]').click()
 const block=panel.locator('[data-rewind-confirm]')
 await expect(block).toContainText('会撤掉第 2 轮。')
 await expect(block).toContainText('又有 1 处改动')
 await expect(block).toContainText('先重新构建')
 await expect(block).toContainText('别的分支或远端里还有一份')
 await block.locator('[data-action="rewind-confirm"]').click()
 await expect(block).toContainText('工作区刚变过，请再看一眼。')
 await block.locator('[data-action="rewind-confirm"]').click()
 await expect(block).toHaveCount(0)
 const gone=panel.locator('.wb-review-turn.is-discarded')
 await expect(gone).toContainText('已撤掉')
 await expect(gone.locator('[data-action="review-accept"]')).toHaveCount(0)
 expect(await posts(page)).toEqual([
  ['/v1/workbench/rewind',{id:'aaaa1111',artifactId:'11111111',to:'end',token:'1'.repeat(64)}],
  ['/v1/workbench/rewind',{id:'aaaa1111',artifactId:'11111111',to:'end',token:'2'.repeat(64)}],
 ])
 const undo=panel.locator('[data-action="rewind-undo"]')
 await undo.click()
 await expect(undo).toHaveText('再点一次：撤销回退')
 await undo.click()
 await expect(panel.locator('.wb-review-turn.is-discarded')).toHaveCount(0)
 await expect(panel.locator('[data-action="rewind-undo"]')).toHaveCount(0)
 expect((await posts(page)).at(-1)).toEqual(['/v1/workbench/rewind',{id:'aaaa1111',undo:'44444444-4444-4444-8444-444444444444'}])
})

test('a parked task shows one notice with the reason; restore asks once more before it is sent',async({page})=>{
 await serve(page)
 await page.goto('http://localhost:4199/?blocked=1')
 await page.evaluate(()=>(window as any).qa.controller.selectTask('aaaa1111'))
 const notice=page.locator('[data-rewind-blocked]')
 await expect(notice).toHaveCount(1)
 await expect(notice).toContainText('src/a.ts 的内容和那一刻对不上')
 await expect(notice).toContainText('refs/tendhearth/rewind/aaaa1111/1')
 await expect(page.locator('.wb-error')).toHaveCount(0)
 await notice.locator('[data-action="rewind-restore"]').click()
 await expect(notice.locator('[data-action="rewind-restore-confirm"]')).toBeVisible()
 expect(await posts(page)).toEqual([])
 await notice.locator('[data-action="rewind-restore-confirm"]').click()
 await expect(page.locator('[data-rewind-blocked]')).toHaveCount(0)
 expect(await posts(page)).toEqual([['/v1/workbench/rewind-resolve',{id:'aaaa1111',choice:'restore_backup'}]])
})
