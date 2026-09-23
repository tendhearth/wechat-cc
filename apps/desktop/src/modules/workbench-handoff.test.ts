import {expect,it,vi} from 'vitest'
import {createHandoffController,renderHandoffPanel,defaultReviewArtifacts} from './workbench-handoff.js'
const initial={sourceTaskId:'deadbeef',targetProviderId:'claude',purpose:'review' as const,request:'检查',artifacts:[]}
it('offers original inputs separately, unchecked by default, and shows selected file coverage',()=>{
 const a={id:crypto.randomUUID(),taskId:'deadbeef',name:'<photo>.png',mime:'image/png',size:12,sha256:'a'.repeat(64)}
 const html=renderHandoffPanel({input:initial,preview:null,busy:false,error:''},[],'Task',[a])
 expect(html).toContain('原始附件');expect(html).toContain('data-handoff-attachment=');expect(html).not.toContain(' checked');expect(html).toContain('&lt;photo&gt;.png')
 const attachments=[{taskId:a.taskId,attachmentId:a.id,sha256:a.sha256}]
 const selected=renderHandoffPanel({input:{...initial,attachments},preview:{...initial,attachments,context:'检查范围',token:'token',truncated:false} as any,busy:false,error:''},[],'Task',[a])
 expect(selected).toContain('已选 1 个原始附件');expect(selected).toContain(' checked')
})
it('shows pinned originals read-only when returning a revision',()=>{
 const a={id:crypto.randomUUID(),taskId:'deadbeef',name:'original.png',mime:'image/png',size:12,sha256:'a'.repeat(64)}
 const input={...initial,purpose:'revision' as const,targetTaskId:'cafefeed',quote:{taskId:'deadbeef',eventId:1,text:'change this'}}
 const preview={...input,attachments:[{taskId:'cafefeed',attachmentId:a.id,sha256:a.sha256}],context:'固定附件 original.png',token:'token',truncated:false} as any
 const html=renderHandoffPanel({input,preview,busy:false,error:''},[],'Task',[a])
 expect(html).not.toContain('data-handoff-attachment=');expect(html).toContain('固定沿用 1 个原始附件');expect(html).toContain('original.png')
})
it('explains an unavailable project without suggesting that retry alone can restore it',async()=>{
 const invoke=vi.fn(async()=>{throw new Error('invalid_path')}),opened=vi.fn()
 const c=createHandoffController(invoke,()=>{},initial,opened)
 await c.prepare();await c.submit()
 expect(c.state.error).toBe('原项目文件夹已不存在或位置发生变化。请先恢复到原位置，再发起检查。')
 expect(c.state.preview).toBeNull();expect(invoke).toHaveBeenCalledTimes(1);expect(opened).not.toHaveBeenCalled()
})
it('never dispatches when opening or editing; sends only the exact prepared token once',async()=>{
 const invoke=vi.fn(async(_method:string,path:string)=>path.endsWith('handoff-preview')?{...initial,token:'a'.repeat(64),context:'v1',targetTaskId:null,quote:null,truncated:false}:{task:{id:'cafefeed'}}),opened=vi.fn()
 const c=createHandoffController(invoke,()=>{},initial,opened)
 await c.prepare();expect(invoke).toHaveBeenCalledTimes(1)
 c.edit({...initial,request:'只查测试'});expect(c.state.preview).toBeNull();await c.submit();expect(invoke).toHaveBeenCalledTimes(1)
 await c.prepare();await Promise.all([c.submit(),c.submit()]);expect(invoke).toHaveBeenCalledTimes(3)
 expect(invoke.mock.calls[2]).toEqual(['POST','/v1/workbench/handoff',{token:'a'.repeat(64)}]);expect(opened).toHaveBeenCalledWith('cafefeed')
})
it('ignores stale previews and cannot dispatch after a dialog is closed',async()=>{
 let resolve!:(value:unknown)=>void
 const invoke=vi.fn(()=>new Promise(r=>{resolve=r})),c=createHandoffController(invoke,()=>{},initial,()=>{})
 const pending=c.prepare();c.edit({...initial,request:'changed'});resolve({token:'old'});await pending
 expect(c.state.preview).toBeNull();c.destroy();await c.submit();expect(invoke).toHaveBeenCalledTimes(1)
})
it('defaults to one latest code snapshot and escapes quoted content without adding a workflow panel',()=>{
 const assets=[{id:'old',taskId:'deadbeef',name:'x',mime:'text/markdown',sha256:'1',createdAt:1},{id:'new',taskId:'deadbeef',name:'diff',mime:'application/vnd.cc.workbench-review+json',sha256:'2',createdAt:2}]
 expect(defaultReviewArtifacts(assets)).toEqual([{taskId:'deadbeef',artifactId:'new',sha256:'2'}])
 const html=renderHandoffPanel({input:{...initial,request:'<script>bad</script>'},preview:null,busy:false,error:''},assets,'任务')
 expect(html).not.toContain('<script>');expect(html).toContain('&lt;script&gt;');expect(html).toContain('成果版本');expect(html).not.toContain('流程')
})
