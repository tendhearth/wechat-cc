import {expect,it,vi} from 'vitest'
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
