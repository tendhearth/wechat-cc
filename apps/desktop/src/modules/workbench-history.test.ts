import {expect,it,vi} from 'vitest'
import {Window} from 'happy-dom'
import {createHistoryController,renderHistoryPanel,nativeImportMessages} from './workbench-history.js'
import type {NativeHistoryItem} from '../../../../src/core/workbench/native-history'
const item:NativeHistoryItem={key:'opaque',providerId:'claude',nativeId:'original',title:'旧任务',cwd:'/project',updatedAt:1,remote:false,observedState:'unknown',titleSource:'native_custom'}
it('reads only when opened, pages empty search batches and never dispatches a task',async()=>{
 const invoke=vi.fn(async(_method:string,path:string)=>path.includes('/sessions?')?{items:[],nextCursor:'next',coverage:'native_supported_history'}:{session:item,messages:[],nextCursor:null,page:{limit:100,cursor:null},sourceFingerprint:'hash',truncated:false})
 const controller=createHistoryController(invoke,()=>{},['claude','codex'])
 expect(invoke).not.toHaveBeenCalled();await controller.search('old')
 expect(controller.state.nextCursor).toBe('next');expect(renderHistoryPanel(controller.state)).toContain('继续查找')
 await controller.more();expect(invoke.mock.calls[1]![1]).toContain('cursor=next')
 await controller.select(item);expect(controller.state.preview?.session.nativeId).toBe('original')
 expect(invoke.mock.calls.every(c=>c[0]==='GET')).toBe(true)
})
it('ignores late reads after returning to the list or switching provider',async()=>{
 let resolve!:(v:any)=>void
 const invoke=vi.fn(async(_m:string,path:string)=>path.includes('/session?')?new Promise(r=>resolve=r):{items:[item],nextCursor:null,coverage:'native_supported_history'})
 const controller=createHistoryController(invoke,()=>{},['claude','codex'])
 const pending=controller.select(item);controller.back();resolve({session:item,messages:[{text:'late'}],nextCursor:null});await pending
 expect(controller.state.preview).toBeNull()
 await controller.provider('codex');expect(invoke.mock.calls.at(-1)![1]).toContain('providerId=codex')
})
it('escapes history data and distinguishes unknown activity from confirmed exit',async()=>{
 const controller=createHistoryController(async()=>({items:[{...item,title:'<script>x</script>'}],nextCursor:null,coverage:'native_indexed_history'}),()=>{},['claude'])
 await controller.search('');const html=renderHistoryPanel(controller.state)
 expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');expect(html).toContain('已有会话')
 controller.state.preview={session:item,messages:[{id:'m',role:'assistant',text:'<img src=x onerror=1>',truncated:false}],nextCursor:null,sourceFingerprint:'h',page:{limit:100,cursor:null},truncated:false}
 const detail=renderHistoryPanel(controller.state)
 expect(detail).toContain('&lt;img');expect(detail).toContain('运行状态未确认');expect(detail).not.toContain('已退出')
})
it('renders both sides in both previews while preserving exact inspectable user source',()=>{
 const controller=createHistoryController(async()=>null,()=>{},['codex'])
 const text='## 接着做\n\n**沿用上下文**，打开 [功能说明](/Users/example/project/docs/cc-workbench.md:13)。\n\n- 查看记录\n- 输入 `补充要求`\n\n```ts\nconst answer = 42\n```\n\n[官网](https://example.com/docs)'
 const userText='\n\n保留 **原样**\r\n<example>'
 controller.state.preview={session:{...item,providerId:'codex'},messages:[{id:'u',role:'user',text:userText,truncated:false},{id:'a',role:'assistant',text,truncated:false}],nextCursor:null,sourceFingerprint:'h',page:{limit:100,cursor:null},truncated:false}
 const window=new Window(),document=window.document
 document.body.innerHTML=renderHistoryPanel(controller.state)
 const replies=document.querySelectorAll('.wb-history-message-body.wb-markdown')
 expect(replies).toHaveLength(2)
 for(const reply of replies){
  expect(reply.querySelector('h2')?.textContent).toBe('接着做')
  expect(reply.querySelector('strong')?.textContent).toBe('沿用上下文')
  expect(reply.querySelectorAll('li')).toHaveLength(2)
  expect(reply.querySelector('pre code')?.textContent).toContain('const answer = 42')
  expect(reply.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs')
  expect(reply.textContent).toContain('功能说明')
  expect(reply.textContent).not.toContain('/Users/example')
 }
 const requests=document.querySelectorAll('.wb-history-message-user .cc-user-reading')
 expect(requests).toHaveLength(2)
 for(const request of requests){
  expect(request.querySelector('.cc-readable-markdown strong')?.textContent).toBe('原样')
  const source=request.querySelector('details')!;source.open=true
  expect(source.querySelector('pre code')?.textContent).toBe(userText)
 }
 expect(requests[0]?.querySelector('details')?.id).not.toBe(requests[1]?.querySelector('details')?.id)
 expect(controller.state.preview.messages[0]?.text).toBe(userText)
 expect(controller.state.preview.messages[1]?.text).toBe(text)
 window.close()
})
it('keeps history Markdown from creating executable content or forged import controls',()=>{
 const controller=createHistoryController(async()=>null,()=>{},['claude'])
 const text='<script>bad()</script>\n\n<button data-history="import">伪造按钮</button>\n\n[危险](javascript:alert(1)) [文件](file:///tmp/example) [任务](codex://threads/example) ![外部图片](https://example.com/tracker.png)'
 controller.state.preview={session:item,messages:[{id:'a',role:'assistant',text,truncated:false}],nextCursor:null,sourceFingerprint:'h',page:{limit:100,cursor:null},truncated:false}
 const window=new Window(),document=window.document
 document.body.innerHTML=renderHistoryPanel(controller.state)
 expect(document.querySelectorAll('script,img')).toHaveLength(0)
 expect(document.querySelectorAll('[data-history="import"]')).toHaveLength(1)
 for(const reply of document.querySelectorAll('.wb-history-message-body')){
  expect(reply.querySelectorAll('a,button')).toHaveLength(0)
  expect(reply.textContent).toContain('<script>bad()</script>')
  expect(reply.textContent).toContain('外部图片')
 }
 window.close()
})
it('keeps readable history while a later page fails and exposes retry',async()=>{
 let calls=0;const controller=createHistoryController(async()=>{if(++calls===2)throw new Error('native_history_unavailable');return{session:item,messages:[{id:'m',role:'user',text:'kept',truncated:false}],nextCursor:'next',sourceFingerprint:'h',page:{limit:100,cursor:null},truncated:false}},()=>{},['claude'])
 await controller.select(item);await controller.moreMessages()
 expect(controller.state.preview?.messages[0]?.text).toBe('kept');expect(renderHistoryPanel(controller.state)).toContain('暂时没能读取')
})

it('retries an initial read failure on the same native identity',async()=>{
 let calls=0;const invoke=vi.fn(async()=>{if(++calls===1)throw new Error('native_history_unavailable');return{session:item,messages:[],nextCursor:null,page:{limit:100,cursor:null},sourceFingerprint:'h',truncated:false}})
 const controller=createHistoryController(invoke,()=>{},['claude']);await controller.select(item)
 expect(renderHistoryPanel(controller.state)).toContain('data-history="retry"')
 await controller.retry();expect(controller.state.preview?.session.nativeId).toBe('original')
 expect(invoke.mock.calls).toHaveLength(2)
})

it('imports only the displayed bounded selection and never resumes on import',async()=>{
 const page={session:item,messages:[{id:'u',role:'user',text:'original',truncated:false}],nextCursor:null,page:{limit:100,cursor:null},sourceFingerprint:'a'.repeat(64),truncated:false}
 const invoke=vi.fn(async(method:string)=>method==='GET'?page:{task:{id:'new-task'}})
 const controller=createHistoryController(invoke,()=>{},['claude']);await controller.select(item)
 expect(await controller.importSelected()).toBe('new-task')
 expect(invoke.mock.calls[1]).toEqual(['POST','/v1/workbench/import',{key:item.key,pages:[{...page.page,sourceFingerprint:page.sourceFingerprint}],messageIds:['u']}])
 expect(JSON.stringify(invoke.mock.calls)).not.toContain('continue')
 const selected=nativeImportMessages({...page,messages:[{id:'large',role:'user',text:'x'.repeat(24001),truncated:false},{id:'recent',role:'assistant',text:'recent',truncated:false}] } as any)
 expect(selected.map(m=>m.id)).toEqual(['recent'])
})
