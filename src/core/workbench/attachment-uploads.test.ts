import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,statSync,symlinkSync,truncateSync,unlinkSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {makeWorkbenchStore} from './store'
import {createAttachmentUploads,type UploadChunk} from './attachment-uploads'

const CHUNK=128*1024,DAY=24*60*60*1000
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const context={ownerKey:'owner',surface:'phone' as const}
let root:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>,owner:string|null,now:number
let uploads:ReturnType<typeof createAttachmentUploads>
const meta=(bytes:Buffer,extra:Partial<UploadChunk>={})=>({id:randomUUID(),draftId:randomUUID(),name:'notes.txt',mime:'text/plain',size:bytes.length,sha256:hash(bytes),...extra})
const packet=(m:ReturnType<typeof meta>,bytes:Buffer,offset=0)=>({...m,offset,contentBase64:bytes.subarray(offset,offset+CHUNK).toString('base64')})
const query=(m:ReturnType<typeof meta>)=>({id:m.id,draftId:m.draftId})
const part=(id:string)=>join(root,'workbench-attachment-uploads',`${id}.part`)
const instance=(database=db,attachmentStore=store.attachments,extra={})=>createAttachmentUploads({db:database,stateDir:root,attachments:attachmentStore,ownerChatId:()=>owner,now:()=>now,...extra})
beforeEach(()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),'cc-chunks-')));db=openDb({path:join(root,'state.db')});store=makeWorkbenchStore(db);owner='owner';now=Date.now();uploads=instance()
})
afterEach(()=>{vi.restoreAllMocks();db.close();removeTempDir(root)})

it('replays exact chunks and produces one existing Attachment with the original ID',()=>{
  const bytes=Buffer.alloc(CHUNK+7,97),m=meta(bytes),first=uploads.chunk(packet(m,bytes),context)
  expect(first).toEqual({id:m.id,draftId:m.draftId,taskId:null,size:bytes.length,sha256:m.sha256,nextOffset:CHUNK,status:'uploading'})
  expect(uploads.chunk(packet(m,bytes),context)).toEqual(first)
  const final=uploads.chunk(packet(m,bytes,CHUNK),context)
  expect(final).toMatchObject({status:'ready',nextOffset:bytes.length,attachment:{id:m.id,name:'notes.txt',mime:'text/plain',size:bytes.length,sha256:m.sha256}})
  expect(uploads.chunk(packet(m,bytes,CHUNK),context)).toEqual(final)
  expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([{id:m.id}])
  expect(readFileSync(join(root,'workbench-attachments',m.sha256))).toEqual(bytes)
  expect(uploads.status(query(m),context)).toEqual(final)
})

it('rejects changes to bytes, fixed metadata and ordering without advancing the committed offset',()=>{
  const bytes=Buffer.alloc(CHUNK*3,97),m=meta(bytes)
  uploads.chunk(packet(m,bytes),context)
  for(const changed of [packet(m,Buffer.alloc(bytes.length,98)),{...packet(m,bytes),name:'different.txt'},packet(m,bytes,CHUNK*2)])expect(()=>uploads.chunk(changed,context)).toThrow('upload_conflict')
  expect(uploads.status(query(m),context).nextOffset).toBe(CHUNK)
  expect(statSync(part(m.id)).size).toBe(CHUNK)
})

it('rejects empty, oversized and nonfinal short chunks before reserving disk or metadata',()=>{
  const bytes=Buffer.alloc(CHUNK*2,97),m=meta(bytes)
  for(const contentBase64 of ['',Buffer.alloc(CHUNK+1,97).toString('base64'),'YQ=='])expect(()=>uploads.chunk({...packet(m,bytes),contentBase64},context)).toThrow('invalid_upload_chunk')
  expect(()=>uploads.chunk({...packet(m,bytes),size:8*1024*1024+1},context)).toThrow('invalid_attachment_size')
  expect(()=>uploads.chunk({...packet(m,bytes),mime:'image/png',size:5*1024*1024+1},context)).toThrow('invalid_attachment_size')
  expect(()=>uploads.chunk({...packet(m,bytes),mime:'image/heic'},context)).toThrow('invalid_attachment')
  expect(()=>uploads.chunk({...packet(m,bytes),path:'/outside'} as never,context)).toThrow('invalid_upload_chunk')
  expect(db.query('SELECT * FROM workbench_attachment_uploads').all()).toEqual([])
})

it('checks the current trusted owner and task ownership for every upload operation',()=>{
  const project=join(root,'project');mkdirSync(project)
  const own=store.create({path:project,title:'own',providerId:'claude',ownerChatId:'owner'}),foreign=store.create({path:project,title:'foreign',providerId:'claude',ownerChatId:'someone-else'})
  const bytes=Buffer.alloc(CHUNK+1,97),m=meta(bytes,{taskId:own.id})
  expect(()=>uploads.chunk(packet(meta(bytes,{taskId:foreign.id}),bytes),context)).toThrow('attachment_scope')
  uploads.chunk(packet(m,bytes),context)
  expect(()=>uploads.chunk({...packet(m,bytes,CHUNK),taskId:foreign.id},context)).toThrow('upload_conflict')
  expect(()=>uploads.status({...query(m),draftId:randomUUID()},context)).toThrow('attachment_scope')
  owner='changed-owner'
  for(const operation of [()=>uploads.chunk(packet(m,bytes,CHUNK),context),()=>uploads.status(query(m),context),()=>uploads.discard(query(m),context)])expect(operation).toThrow('attachment_scope')
  expect(()=>uploads.status(query(m),{ownerKey:'changed-owner',surface:'phone'})).toThrow('attachment_scope')
})

it('does not finalize bytes whose complete hash or MIME signature is invalid',()=>{
  const bytes=Buffer.from('not an image'),m=meta(bytes,{name:'picture.png',mime:'image/png'})
  expect(()=>uploads.chunk(packet(m,bytes),context)).toThrow('invalid_attachment')
  const wrong=meta(bytes,{sha256:'a'.repeat(64)})
  expect(()=>uploads.chunk(packet(wrong,bytes),context)).toThrow('upload_changed')
  expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([])
})

it('truncates bytes written before a failed offset commit and resumes from the committed boundary',()=>{
  const bytes=Buffer.alloc(CHUNK*2+1,97),m=meta(bytes)
  uploads.chunk(packet(m,bytes),context)
  db.exec("CREATE TRIGGER fault BEFORE UPDATE OF next_offset ON workbench_attachment_uploads BEGIN SELECT RAISE(ABORT,'offset_fault'); END")
  expect(()=>uploads.chunk(packet(m,bytes,CHUNK),context)).toThrow('offset_fault')
  expect(statSync(part(m.id)).size).toBe(CHUNK*2)
  db.exec('DROP TRIGGER fault');uploads=instance()
  expect(uploads.status(query(m),context).nextOffset).toBe(CHUNK)
  expect(statSync(part(m.id)).size).toBe(CHUNK)
  uploads.chunk(packet(m,bytes,CHUNK),context)
  expect(uploads.chunk(packet(m,bytes,CHUNK*2),context).status).toBe('ready')
})

it.each(['short','changed'] as const)('refuses a %s committed part after restart',damage=>{
  const bytes=Buffer.alloc(CHUNK+1,97),m=meta(bytes)
  uploads.chunk(packet(m,bytes),context)
  if(damage==='short')truncateSync(part(m.id),CHUNK-1)
  else writeFileSync(part(m.id),Buffer.alloc(CHUNK,98))
  uploads=instance()
  expect(()=>uploads.status(query(m),context)).toThrow('upload_changed')
  expect(()=>uploads.chunk(packet(m,bytes),context)).toThrow('upload_changed')
  expect(()=>uploads.chunk(packet(m,bytes,CHUNK),context)).toThrow('upload_changed')
  expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([])
})

it.each(['symlink','hardlink','replacement'] as const)('refuses a %s substituted for a committed part',kind=>{
  const bytes=Buffer.alloc(CHUNK+1,97),m=meta(bytes),outside=join(root,'untouched.txt')
  uploads.chunk(packet(m,bytes),context);writeFileSync(outside,bytes.subarray(0,CHUNK))
  renameSync(part(m.id),join(root,'original.part'))
  if(kind==='symlink')symlinkSync(outside,part(m.id))
  else if(kind==='hardlink')linkSync(outside,part(m.id))
  else writeFileSync(part(m.id),bytes.subarray(0,CHUNK))
  expect(()=>uploads.chunk(packet(m,bytes,CHUNK),context)).toThrow(kind==='replacement'?'upload_changed':'invalid_attachment_path')
  expect(readFileSync(outside)).toEqual(bytes.subarray(0,CHUNK))
  expect(db.query('SELECT next_offset FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({next_offset:CHUNK})
})

it('recovers the same finalized attachment after ready commit fails, even without its part',()=>{
  const bytes=Buffer.from('one attachment'),m=meta(bytes)
  db.exec("CREATE TRIGGER fault BEFORE UPDATE OF status ON workbench_attachment_uploads WHEN NEW.status='ready' BEGIN SELECT RAISE(ABORT,'ready_fault'); END")
  expect(()=>uploads.chunk(packet(m,bytes),context)).toThrow('ready_fault')
  expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([{id:m.id}])
  expect(db.query('SELECT status FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({status:'finalizing'})
  db.exec('DROP TRIGGER fault');unlinkSync(part(m.id));uploads=instance()
  const ready=uploads.status(query(m),context)
  expect(ready.status).toBe('ready');expect(ready.attachment?.id).toBe(m.id)
  expect(uploads.chunk(packet(m,bytes),context)).toEqual(ready)
  expect(db.query('SELECT id FROM workbench_attachments').all()).toHaveLength(1)
})

it('keeps a cancellation tombstone and never revives a late final chunk',()=>{
  const bytes=Buffer.alloc(CHUNK+1,97),m=meta(bytes)
  uploads.chunk(packet(m,bytes),context);uploads.discard(query(m),context);uploads=instance()
  expect(()=>uploads.discard(query(m),context)).not.toThrow()
  expect(()=>uploads.chunk(packet(m,bytes,CHUNK),context)).toThrow('upload_discarded')
  expect(()=>uploads.status(query(m),context)).toThrow('upload_discarded')
  expect(existsSync(part(m.id))).toBe(false)
  expect(db.query('SELECT status FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({status:'discarded'})
})

it('cancels an unseen first chunk before it can create an upload',()=>{
  const bytes=Buffer.from('late first block'),m=meta(bytes)
  uploads.discard(query(m),context);uploads=instance()
  expect(()=>uploads.discard(query(m),context)).not.toThrow()
  expect(()=>uploads.chunk(packet(m,bytes),context)).toThrow('upload_discarded')
  expect(db.query('SELECT status FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({status:'discarded'})
  expect(existsSync(part(m.id))).toBe(false)
})

it('serializes cancellation between final upload and ready across two connections',()=>{
  const otherDb=openDb({path:join(root,'state.db')}),other=instance(otherDb,makeWorkbenchStore(otherDb).attachments)
  const bytes=Buffer.from('material'),m=meta(bytes);let canceled=false
  uploads=instance(db,store.attachments,{onTransaction:(event:{operation:string})=>{if(event.operation==='finalize'&&!canceled){canceled=true;other.discard(query(m),context)}}})
  try{
    expect(()=>uploads.chunk(packet(m,bytes),context)).toThrow('upload_discarded')
    expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([])
    expect(()=>other.status(query(m),context)).toThrow('upload_discarded')
  }finally{otherDb.close()}
})

it('expires only unbound unreferenced bytes and retains a terminal upload identity',()=>{
  const bytes=Buffer.alloc(CHUNK+1,97),m=meta(bytes)
  uploads.chunk(packet(m,bytes),context);now+=7*DAY+1
  expect(()=>uploads.status(query(m),context)).toThrow('upload_expired')
  expect(existsSync(part(m.id))).toBe(false)
  expect(()=>uploads.chunk(packet(m,bytes,CHUNK),context)).toThrow('upload_expired')
  expect(db.query('SELECT status FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({status:'expired'})
})

it('does not cancel or expire ready material protected by a task or a valid entry reservation',()=>{
  const bytes=Buffer.from('protected'),first=meta(bytes),second=meta(bytes),a=uploads.chunk(packet(first,bytes),context),b=uploads.chunk(packet(second,bytes),context)
  const project=join(root,'project');mkdirSync(project)
  const task=store.create({path:project,title:'task',providerId:'claude',ownerChatId:'owner'})
  store.attachments.bind([a.id],task.id,first.draftId,{ownerKey:'owner'})
  store.entryRequests.reserve({ownerKey:'owner',requestId:randomUUID(),canonicalRequestHash:'a'.repeat(64),target:{kind:'managed'},workspaceId:randomUUID(),resolvedPath:null,directoryIdentity:null,providerId:'claude',execution:{defaults:'provider',model:null,reasoningEffort:null},materialSnapshot:[b.attachment!]})
  now+=7*DAY+1
  expect(uploads.expire()).toBe(0)
  for(const m of [first,second]){
    expect(()=>uploads.discard(query(m),context)).toThrow('attachment_in_use')
    expect(uploads.status(query(m),context).status).toBe('ready')
  }
  expect(db.query('SELECT id FROM workbench_attachments').all()).toHaveLength(2)
})

it('enforces batch count and bytes independently of the global disk limit',()=>{
  const bytes=Buffer.alloc(CHUNK+1,97),draftId=randomUUID()
  for(let n=0;n<8;n++)uploads.chunk(packet(meta(bytes,{draftId}),bytes),context)
  expect(()=>uploads.chunk(packet(meta(bytes,{draftId}),bytes),context)).toThrow('attachment_limit')
  const large=Buffer.alloc(8*1024*1024,97),largeDraft=randomUUID()
  for(let n=0;n<3;n++)uploads.chunk(packet(meta(large,{draftId:largeDraft}),large),context)
  expect(()=>uploads.chunk(packet(meta(large,{draftId:largeDraft}),large),context)).toThrow('invalid_attachment_size')
})

it('shares the batch reservation with existing desktop whole-file uploads in both directions',()=>{
  const bytes=Buffer.alloc(CHUNK+1,97),draftId=randomUUID()
  for(let n=0;n<8;n++)uploads.chunk(packet(meta(bytes,{draftId}),bytes),context)
  expect(()=>store.attachments.upload({id:randomUUID(),draftId,name:'whole.txt',mime:'text/plain',base64:'eA=='},root,{ownerKey:'owner'})).toThrow('attachment_limit')
  const anotherDraft=randomUUID()
  store.attachments.upload({id:randomUUID(),draftId:anotherDraft,name:'whole.txt',mime:'text/plain',base64:'eA=='},root,{ownerKey:'owner'})
  for(let n=0;n<7;n++)uploads.chunk(packet(meta(bytes,{draftId:anotherDraft}),bytes),context)
  expect(()=>uploads.chunk(packet(meta(bytes,{draftId:anotherDraft}),bytes),context)).toThrow('attachment_limit')
})

it('admits only one of two first chunks competing for the last unfinished slot',()=>{
  const bytes=Buffer.alloc(CHUNK+1,97)
  for(let n=0;n<31;n++)uploads.chunk(packet(meta(bytes),bytes),context)
  const otherDb=openDb({path:join(root,'state.db')}),other=instance(otherDb,makeWorkbenchStore(otherDb).attachments),last=meta(bytes),loser=meta(bytes)
  let attempted=false,rejection=''
  uploads=instance(db,store.attachments,{onTransaction:(event:{operation:string})=>{if(event.operation==='reserve'&&!attempted){attempted=true;try{other.chunk(packet(loser,bytes),context)}catch(error){rejection=(error as Error).message}}}})
  try{
    expect(uploads.chunk(packet(last,bytes),context).status).toBe('uploading')
    expect(rejection).toBe('upload_unfinished_limit')
    expect(db.query('SELECT id FROM workbench_attachment_uploads').all()).toHaveLength(32)
  }finally{otherDb.close()}
})

it('charges a crashed orphan part against the peak storage reservation',()=>{
  mkdirSync(join(root,'workbench-attachment-uploads'))
  const orphan=part(randomUUID());writeFileSync(orphan,'');truncateSync(orphan,256*1024*1024-128*1024)
  const bytes=Buffer.alloc(CHUNK+1,97),m=meta(bytes)
  expect(()=>uploads.chunk(packet(m,bytes),context)).toThrow('attachment_storage_limit')
  expect(db.query('SELECT id FROM workbench_attachment_uploads').all()).toEqual([])
})

it('admits only one connection when two first chunks compete for the remaining peak bytes',()=>{
  const bytes=Buffer.alloc(CHUNK+1,97),first=meta(bytes),second=meta(bytes)
  mkdirSync(join(root,'workbench-attachment-uploads'))
  const orphan=part(randomUUID());writeFileSync(orphan,'');truncateSync(orphan,256*1024*1024-(bytes.length*2+16*1024))
  const otherDb=openDb({path:join(root,'state.db')}),other=instance(otherDb,makeWorkbenchStore(otherDb).attachments)
  let attempted=false,rejection=''
  uploads=instance(db,store.attachments,{onTransaction:(event:{operation:string})=>{if(event.operation==='reserve'&&!attempted){attempted=true;try{other.chunk(packet(second,bytes),context)}catch(error){rejection=(error as Error).message}}}})
  try{
    expect(uploads.chunk(packet(first,bytes),context).status).toBe('uploading')
    expect(rejection).toBe('attachment_storage_limit')
    expect(db.query('SELECT id FROM workbench_attachment_uploads').all()).toEqual([{id:first.id}])
  }finally{otherDb.close()}
})
it('sweeps abandoned uploads after more than one page of completed bound material',()=>{
  const task=store.create({title:'bound',path:root,providerId:'claude',ownerChatId:'owner'}).id,small=Buffer.from('x')
  for(let i=0;i<64;i++){
    const m=meta(small);uploads.chunk(packet(m,small),context);store.attachments.bind([m.id],task,m.draftId,{ownerKey:'owner'})
  }
  now++
  const bytes=Buffer.alloc(CHUNK+1,65),m=meta(bytes);uploads.chunk(packet(m,bytes),context);now+=8*DAY
  expect(uploads.expire()).toBe(1)
  expect(db.query('SELECT status FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({status:'expired'})
  expect(store.attachments.list(task)).toHaveLength(64)
})
