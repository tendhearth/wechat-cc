import {test,expect} from '@playwright/test'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

// Production modules and CSS, synthetic API data only; this never connects to a daemon.
const source=fileURLToPath(new URL('../src/',import.meta.url))
const fixture=`<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/styles/workbench.css"><style>html,body{margin:0;height:100%;overflow:hidden}#workbench-root{height:100%}</style></head><body><div id="workbench-root"></div><script type="module">
import {initWorkbenchPage,stopWorkbenchPolling} from '/modules/workbench.js'
const task={id:'A',title:'流式阅读与成果返回',path:'/synthetic-fixture',providerId:'codex',status:'running',createdAt:1,updatedAt:1,error:null}
const event=(id,text)=>({id:String(id),taskId:'A',kind:'text',text,createdAt:id})
const text='保持选区文本\\n\\n[查看网页](https://example.test/read)\\n\\n'+String.fromCharCode(96).repeat(3)+'ts\\nconst '+ 'wide_identifier_'.repeat(24)+' = 1\\n'+String.fromCharCode(96).repeat(3)
const events=[event(1,'# 工作进行中\\n\\n'+Array.from({length:12},(_,i)=>'第 '+(i+1)+' 段合成记录，确认新回复不会打断正在阅读的位置。').join('\\n\\n')),event(2,text)]
const permission=id=>({id,taskId:'A',tool:'command',description:'合成权限请求 '+id,createdAt:1})
let detail={task,version:1,events,artifacts:[{id:'file',taskId:'A',name:'fixture.md',mime:'text/plain',size:5,sha256:'a'.repeat(64),createdAt:1,approvedAt:null}],permissions:['p1','p2','p3'].map(permission)},release
const calls=[]
const invokeWorkbenchApi=async(method,path,body)=>{calls.push({method,path,body});if(path.startsWith('/v1/workbench/task?'))return path.includes('since=')?new Promise(resolve=>{release=resolve}):detail;if(path.startsWith('/v1/workbench/review?'))return{reviews:[]};if(path.startsWith('/v1/matters?'))return{matters:[]};return{tasks:[task],providers:[],defaultProvider:'codex',canWechat:false}}
const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60000})
window.qa={controller,calls,text,permission,stop:stopWorkbenchPolling,setPermissions:ids=>{detail.permissions=ids.map(permission);controller.state.detail.permissions=detail.permissions;controller.paint(true)},push:async(nextText)=>{while(!release)await new Promise(r=>setTimeout(r,1));detail={...detail,version:detail.version+1,events:[...detail.events.slice(0,-1),event(2,nextText)]};const send=release;release=null;send(detail);await new Promise(r=>setTimeout(r,20))}}
</script></body></html>`

for(const width of [1000,390])test(`keeps core workbench interactions at ${width}px`,async({page},testInfo)=>{
 await page.setViewportSize({width,height:850})
 await page.route('http://workbench-core.test/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/'){await route.fulfill({contentType:'text/html',body:fixture});return}
  try{const body=await readFile(source+path);await route.fulfill({body,contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'})}
  catch{await route.fulfill({status:404,body:'missing fixture asset'})}
 })
 await page.goto('http://workbench-core.test')
 await expect(page.locator('.wb-dialogue > .wb-message:last-child a')).toBeVisible()
 await page.evaluate(()=>{
  const row=document.querySelector('.wb-dialogue > .wb-message:last-child')!,link=row.querySelector('a')!,pre=row.querySelector('pre')!,paragraph=row.querySelector('p')!
  link.focus({preventScroll:true});const range=document.createRange();range.setStart(paragraph.firstChild!,2);range.setEnd(paragraph.firstChild!,4)
  document.getSelection()!.removeAllRanges();document.getSelection()!.addRange(range);pre.scrollLeft=120
  Object.assign((window as any).qa,{nodes:{row,link,pre,paragraph},selected:document.getSelection()!.toString(),left:pre.scrollLeft})
 })
 await page.evaluate(async()=>{const qa=(window as any).qa;await qa.push(qa.text+'\n\n新回复仍正常到达')})
 const retained=await page.evaluate(()=>{
  const qa=(window as any).qa,n=qa.nodes
  return{row:document.querySelector('.wb-dialogue > .wb-message:last-child')===n.row,paragraph:n.row.querySelector('p')===n.paragraph,link:n.row.querySelector('a')===n.link,focus:document.activeElement===n.link,pre:n.row.querySelector('pre')===n.pre,left:n.pre.scrollLeft,expectedLeft:qa.left,selection:document.getSelection()!.toString(),start:document.getSelection()!.anchorOffset,end:document.getSelection()!.focusOffset,newReply:n.row.textContent.includes('新回复仍正常到达')}
 })
 expect(retained).toEqual({row:true,paragraph:true,link:true,focus:true,pre:true,left:120,expectedLeft:120,selection:'选区',start:2,end:4,newReply:true})
 await page.screenshot({path:testInfo.outputPath(`stream-reading-${width}.png`)})

 // A structural inline-format change waits until selection releases, using the latest receipt.
 await page.evaluate(async()=>{
  const qa=(window as any).qa;document.getSelection()!.removeAllRanges();qa.nodes.link.blur();qa.nodes.pre.scrollLeft=0
  await qa.push('开头 **选中文字');const node=document.querySelector('.wb-dialogue > .wb-message:last-child p')!.firstChild!,range=document.createRange();range.setStart(node,5);range.setEnd(node,9);document.getSelection()!.addRange(range)
  await qa.push('开头 **选中文字** 第一版');await qa.push('开头 **选中文字** 最新版')
 })
 expect(await page.locator('.wb-dialogue > .wb-message:last-child strong').count()).toBe(0)
 expect(await page.evaluate(()=>document.getSelection()!.toString())).toBe('选中文字')
 await page.evaluate(()=>document.getSelection()!.removeAllRanges())
 await expect(page.locator('.wb-dialogue > .wb-message:last-child strong')).toHaveText('选中文字')
 await expect(page.locator('.wb-dialogue > .wb-message:last-child')).toContainText('最新版')

 await page.evaluate(()=>{
  const qa=(window as any).qa;document.querySelector<HTMLButtonElement>('[data-action="allow-permission"][data-request-id="p2"]')!.focus({preventScroll:true});qa.focusId=document.activeElement!.id;qa.controller.paint(true)
 })
 expect(await page.evaluate(()=>document.activeElement!.id===(window as any).qa.focusId)).toBe(true)
 await page.evaluate(()=>(window as any).qa.setPermissions(['p3']))
 expect(await page.evaluate(()=>(document.activeElement as HTMLElement).dataset.requestId)).toBe('p3')
 await page.evaluate(()=>(window as any).qa.setPermissions([]))
 await expect(page.locator('#wb-followup-text')).toBeFocused()
 expect(await page.evaluate(()=>(window as any).qa.calls.filter((c:any)=>c.method==='POST').length)).toBe(0)

 // Returning closes the disclosure, restores reading, and retains the existing preview cache.
 await page.evaluate(()=>{
  const qa=(window as any).qa;qa.preview={artifactId:'file',html:'<pre>合成成果预览缓存</pre>'};qa.controller.state.preview=qa.preview;qa.controller.state.selectedArtifactId='file';qa.controller.paint(true)
  const pane=document.querySelector('.wb-content')!;pane.scrollTop=180;qa.returnPosition=pane.scrollTop
  document.querySelector<HTMLButtonElement>('[data-action="show-artifacts"]')!.click()
 })
 await expect(page.locator('#wb-artifacts')).toHaveAttribute('open','')
 await page.locator('[data-action="back-to-dialogue"]').click()
 expect(await page.locator('#wb-artifacts').getAttribute('open')).toBeNull()
 const returned=await page.evaluate(()=>{const qa=(window as any).qa;return{position:document.querySelector('.wb-content')!.scrollTop,expected:qa.returnPosition,selected:qa.controller.state.selectedArtifactId,cached:qa.controller.state.preview===qa.preview}})
 expect(returned.position).toBe(returned.expected);expect(returned.selected).toBe('file');expect(returned.cached).toBe(true)
 await page.evaluate(()=>document.querySelector<HTMLElement>('#wb-artifacts > summary')!.click())
 await expect(page.locator('#wb-artifacts')).toHaveAttribute('open','')
 await page.locator('[data-action="back-to-dialogue"]').click()
 expect(await page.evaluate(()=>document.querySelector('.wb-content')!.scrollTop)).toBe(returned.expected)
 // Closing the summary manually must also release result browsing.
 await page.evaluate(()=>document.querySelector<HTMLButtonElement>('[data-action="show-artifacts"]')!.click())
 await page.evaluate(()=>document.querySelector<HTMLElement>('#wb-artifacts > summary')!.click())
 await expect(page.locator('#wb-artifacts')).not.toHaveAttribute('open','')
 await page.evaluate(()=>{const pane=document.querySelector('.wb-content')!;(window as any).qa.returnedPane=pane;pane.scrollTop=pane.scrollHeight;pane.dispatchEvent(new Event('scroll'))})
 await page.evaluate(async()=>{const qa=(window as any).qa;await qa.push('开头 **选中文字** 最新版\n\n'+Array.from({length:8},(_,i)=>'成果返回后的新回复 '+i).join('\n\n'))})
 expect(await page.evaluate(()=>{const p=document.querySelector('.wb-content')!;return p.scrollHeight-p.clientHeight-p.scrollTop})).toBeLessThanOrEqual(1)
 expect(await page.evaluate(()=>document.querySelector('.wb-content')===(window as any).qa.returnedPane)).toBe(true)
 await expect(page.locator('.wb-reading-bar')).toBeHidden()
 await page.screenshot({path:testInfo.outputPath(`returned-following-${width}.png`)})
 await page.evaluate(()=>(window as any).qa.stop())
})
