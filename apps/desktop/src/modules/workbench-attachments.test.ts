import {expect,it,vi} from 'vitest'
import {createWorkbenchDraftStore} from './workbench-window-state.js'
import {createWorkbenchAttachments,attachmentSignature,renderAttachmentComposer,renderMessageAttachments} from './workbench-attachments.js'
const metadata={id:'123e4567-e89b-42d3-a456-426614174000',name:'notes.txt',mime:'text/plain',size:5,sha256:'a'.repeat(64)}
const memory=()=>{const values=new Map<string,string>();return{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}}
it('finishes an upload in its original task draft while another task is edited',async()=>{
 const store=createWorkbenchDraftStore(),changed=vi.fn();let finish!:(value:unknown)=>void
 const invoke=vi.fn(async(_method:string,_path:string,body:any)=>new Promise(resolve=>{finish=value=>resolve(value);metadata.id=body.id}))
 const manager=createWorkbenchAttachments({drafts:store,invokeWorkbenchApi:invoke,changed,encode:async()=> 'aGVsbG8='})
 const pending=manager.add('task:deadbeef',[new File(['hello'],'notes.txt',{type:'text/plain'})])
 await vi.waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1))
 expect(manager.ready('task:deadbeef')).toBe(false)
 store.set('task:cafefeed',{...store.get('task:cafefeed'),followup:'keep B'})
 finish({attachment:{...metadata}});await pending
 expect(store.get('task:deadbeef').attachments?.[0]).toMatchObject({...metadata,status:'ready'})
 expect(store.get('task:cafefeed').followup).toBe('keep B');expect(store.get('task:cafefeed').attachments??[]).toEqual([])
 expect(invoke.mock.calls[0]?.[2]).toMatchObject({taskId:'deadbeef',name:'notes.txt',base64:'aGVsbG8='})
 expect(manager.ready('task:deadbeef')).toBe(true)
})
it('does not resurrect a removed chip after upload finishes and blocks failed uploads',async()=>{
 const store=createWorkbenchDraftStore();let finish!:(value:unknown)=>void
 const manager=createWorkbenchAttachments({drafts:store,invokeWorkbenchApi:async()=>new Promise(resolve=>{finish=resolve}),encode:async()=> 'aGVsbG8='})
 const pending=manager.add('new',[new File(['hello'],'notes.txt')]);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
 const id=store.get('new').attachments![0]!.id;manager.remove('new',id);finish({attachment:{...metadata,id}});await pending
 expect(store.get('new').attachments).toEqual([])
 const broken=createWorkbenchAttachments({drafts:store,invokeWorkbenchApi:async()=>{throw Error('invalid_attachment')},encode:async()=> 'aGVsbG8='})
 await broken.add('new',[new File(['hello'],'notes.txt')]);expect(broken.ready('new')).toBe(false)
 expect(store.get('new').attachments![0]!.status).toBe('failed')
 expect(store.get('new').attachments![0]!.error).toContain('格式')
})
it('preserves completed metadata across reload with deep copies and marks interrupted uploads',()=>{
 const storage=memory(),store=createWorkbenchDraftStore(storage)
 store.set('new',{...store.get('new'),draftId:crypto.randomUUID(),attachments:[{...metadata,status:'ready'}]})
 const copy=store.get('new');copy.attachments![0]!.name='changed'
 expect(store.get('new').attachments![0]!.name).toBe('notes.txt')
 expect(createWorkbenchDraftStore(storage).get('new').attachments![0]!.status).toBe('ready')
 store.set('new',{...store.get('new'),attachments:[{...metadata,status:'uploading'}]})
 expect(createWorkbenchDraftStore(storage).get('new').attachments![0]!.status).toBe('failed')
})
it('checks file count and image limits before encoding or uploading',async()=>{
 const store=createWorkbenchDraftStore(),encode=vi.fn(),invokeWorkbenchApi=vi.fn(),manager=createWorkbenchAttachments({drafts:store,encode,invokeWorkbenchApi})
 await manager.add('new',[{name:'large.png',type:'image/png',size:5*1024*1024+1} as File])
 expect(encode).not.toHaveBeenCalled();expect(invokeWorkbenchApi).not.toHaveBeenCalled();expect(manager.error('new')).toContain('5 MiB')
 await manager.add('new',Array.from({length:9},()=>new File(['a'],'a.txt')))
 expect(invokeWorkbenchApi).not.toHaveBeenCalled();expect(manager.error('new')).toContain('8')
})
it('discards removed staging after a late upload and treats bound-file refusal as harmless',async()=>{
 const store=createWorkbenchDraftStore();let complete!:(value:any)=>void;let uploadedId=''
 const invoke=vi.fn(async(_method:string,path:string,body:any)=>{if(path.endsWith('/attachment')){uploadedId=body.id;return await new Promise(resolve=>{complete=resolve})}throw Error('already_claimed')})
 const manager=createWorkbenchAttachments({drafts:store,invokeWorkbenchApi:invoke,encode:async()=> 'aGVsbG8='})
 const pending=manager.add('new',[new File(['hello'],'notes.txt')]);await vi.waitFor(()=>expect(complete).toBeTypeOf('function'))
 const draftId=store.get('new').draftId;manager.remove('new',uploadedId)
 complete({attachment:{...metadata,id:uploadedId}});await pending
 expect(invoke).toHaveBeenCalledWith('POST','/v1/workbench/discard-attachment',{id:uploadedId,draftId})
 expect(store.get('new').attachments).toEqual([])
})
it('defers discard while a submitted snapshot is awaiting acknowledgement',()=>{
 const store=createWorkbenchDraftStore(),draftId=crypto.randomUUID(),invokeWorkbenchApi=vi.fn(async()=>({ok:true}))
 store.set('new',{...store.get('new'),draftId,attachments:[{...metadata,status:'ready'}]})
 const manager=createWorkbenchAttachments({drafts:store,invokeWorkbenchApi}),release=manager.reserve('new',store.get('new'))
 manager.remove('new',metadata.id);expect(invokeWorkbenchApi).not.toHaveBeenCalled()
 release();expect(invokeWorkbenchApi).toHaveBeenCalledWith('POST','/v1/workbench/discard-attachment',{id:metadata.id,draftId})
})
it('keeps a snapshot reserved until every overlapping submission releases it',()=>{
 const store=createWorkbenchDraftStore(),draftId=crypto.randomUUID(),invokeWorkbenchApi=vi.fn(async()=>({ok:true}))
 store.set('new',{...store.get('new'),draftId,attachments:[{...metadata,status:'ready'}]})
 const manager=createWorkbenchAttachments({drafts:store,invokeWorkbenchApi})
 const first=manager.reserve('new',store.get('new')),second=manager.reserve('new',store.get('new'))
 second();manager.remove('new',metadata.id);expect(invokeWorkbenchApi).not.toHaveBeenCalled()
 first();expect(invokeWorkbenchApi).toHaveBeenCalledTimes(1)
 first();expect(invokeWorkbenchApi).toHaveBeenCalledTimes(1)
})
it('renders escaped removable draft chips and task-bound message downloads',()=>{
 const attachment={...metadata,name:'<img onerror=bad>.txt',status:'ready' as const}
 expect(renderAttachmentComposer({attachments:[attachment]})).toContain('&lt;img onerror=bad&gt;.txt')
 expect(renderAttachmentComposer({attachments:[attachment]})).toContain('remove-attachment')
 expect(renderMessageAttachments('deadbeef',[attachment])).toContain('data-owner-task="deadbeef"')
 expect(attachmentSignature([attachment])).not.toBe(attachmentSignature([{...attachment,id:crypto.randomUUID()}]))
})
it('keeps a failed file visible and prevents the incomplete composer from sending',async()=>{
 const {renderTaskControls}=await import('./workbench.js')
 const draft={path:'',text:'',title:'',providerId:'',followup:'request',attachments:[{...metadata,status:'failed' as const}]}
 const html=renderTaskControls('completed',undefined,undefined,undefined,undefined,draft)
 expect(html).toMatch(/type="submit"[^>]*disabled/)
 expect(html).toContain('上传失败');expect(html).toContain('remove-attachment')
})
