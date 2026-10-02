import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {existsSync,fstatSync,linkSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,statSync,symlinkSync,truncateSync,unlinkSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {makeWorkbenchStore} from './store'
import {createAttachmentUploads,type UploadChunk} from './attachment-uploads'

const reads=vi.hoisted(()=>({bytes:0,fsyncs:0,observe:null as null|((fd:number,count:number,requested:number)=>void)}))
vi.mock('node:fs',async importOriginal=>{
  const fs=await importOriginal<typeof import('node:fs')>()
  // fsync 换成只计数:这个文件测的是读放大、锁外校验、偏移/终态的提交顺序,没有一条测掉电持久性
  // (进程内也测不了)。而它是这里最贵的东西 —— 每个 128 KiB 块落盘一次,8 MiB 就是 64 次;
  // windows-latest runner 的盘上一次几十到上百毫秒,三条 8 MiB 用例一条就 11~16s,
  // 再赶上 runner 抖一下就撞 20s(2026-10-01 「exact replay」那次)。本机给 fsync 注入 200ms
  // 即复现:一份上传 13s、两份上传的「another upload」25.8s 超时。每块都 fsync 这件事本身由
  // 「reads linear bytes」那条按次数断言,不会因为这里不真落盘就悄悄丢掉。同理 beforeEach 里
  // 把这个连接的 SQLite synchronous 关掉:WAL 每次提交的那一次 fsync 也不在任何断言里。
  return{...fs,fsyncSync:(fd:number)=>{fs.fstatSync(fd);reads.fsyncs++},readSync:(...args:unknown[])=>{
    const count=Reflect.apply(fs.readSync,fs,args) as number
    reads.bytes+=count;reads.observe?.(args[0] as number,count,args[3] as number)
    return count
  }}
})

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
  root=realpathSync(mkdtempSync(join(tmpdir(),'cc-chunks-')));db=openDb({path:join(root,'state.db')});db.exec('PRAGMA synchronous=OFF');store=makeWorkbenchStore(db);owner='owner';now=Date.now();uploads=instance()
})
afterEach(()=>{reads.observe=null;vi.restoreAllMocks();db.close();removeTempDir(root)})

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

it.each([
  ['picture.png','image/png',Buffer.from('actually HEIC')],
  ['document.pdf','application/pdf',Buffer.from('not a PDF')],
  ['notes.txt','text/plain',Buffer.from([0xff,0xfe])],
  ['notes.txt','text/plain',Buffer.from('text\0binary')],
])('terminates deterministic content rejection for %s', (name,mime,bytes)=>{
  const m=meta(bytes as Buffer,{name:name as string,mime:mime as string})
  expect(()=>uploads.chunk(packet(m,bytes as Buffer),context)).toThrow('upload_invalid_content')
  expect(db.query('SELECT status,reserved_bytes,chunks_json FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({status:'discarded',reserved_bytes:1024,chunks_json:'[]'})
  expect(existsSync(part(m.id))).toBe(false)
  uploads=instance()
  expect(()=>uploads.chunk(packet(m,bytes as Buffer),context)).toThrow('upload_discarded')
  expect(()=>uploads.status(query(m),context)).toThrow('upload_discarded')
  expect(db.query("SELECT id FROM workbench_attachment_uploads WHERE status IN ('uploading','finalizing')").all()).toEqual([])
  expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([])
})

it.each(['EIO','attachment_storage_limit'])('preserves a resumable finalization after temporary %s failure',failure=>{
  const bytes=Buffer.from('valid text'),m=meta(bytes);let fail=true
  uploads=instance(db,{...store.attachments,upload:(...args:Parameters<typeof store.attachments.upload>)=>{if(fail)throw Error(failure);return store.attachments.upload(...args)}})
  expect(()=>uploads.chunk(packet(m,bytes),context)).toThrow(failure)
  expect(db.query('SELECT status FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({status:'finalizing'})
  expect(existsSync(part(m.id))).toBe(true)
  fail=false
  expect(uploads.status(query(m),context).attachment?.id).toBe(m.id)
  expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([{id:m.id}])
})

it('terminates a complete-file digest mismatch instead of retrying the same last block',()=>{
  const bytes=Buffer.alloc(CHUNK+9,97),m=meta(bytes,{sha256:'a'.repeat(64)})
  uploads.chunk(packet(m,bytes),context)
  expect(()=>uploads.chunk(packet(m,bytes,CHUNK),context)).toThrow('upload_invalid_content')
  expect(db.query('SELECT status,reserved_bytes FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({status:'discarded',reserved_bytes:1024})
  expect(existsSync(part(m.id))).toBe(false)
  uploads=instance()
  expect(()=>uploads.chunk(packet(m,bytes,CHUNK),context)).toThrow('upload_discarded')
  expect(()=>uploads.status(query(m),context)).toThrow('upload_discarded')
  expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([])
})

it('does not delete rejected bytes before the terminal record commits',()=>{
  const bytes=Buffer.from('not a PNG'),m=meta(bytes,{name:'photo.png',mime:'image/png'})
  db.exec("CREATE TRIGGER fault BEFORE UPDATE OF status ON workbench_attachment_uploads WHEN NEW.status='discarded' BEGIN SELECT RAISE(ABORT,'terminal_fault'); END")
  expect(()=>uploads.chunk(packet(m,bytes),context)).toThrow('terminal_fault')
  expect(existsSync(part(m.id))).toBe(true)
  expect(db.query('SELECT status FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({status:'finalizing'})
  db.exec('DROP TRIGGER fault')
  expect(()=>uploads.status(query(m),context)).toThrow('upload_invalid_content')
  expect(existsSync(part(m.id))).toBe(false)
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

it('reads linear bytes for an 8 MiB upload and keeps full-file reads outside the SQLite writer lock',()=>{
  const bytes=Buffer.alloc(8*1024*1024,97),m=meta(bytes),otherDb=openDb({path:join(root,'state.db')})
  otherDb.exec('PRAGMA busy_timeout=0')
  const events:{operation:string;durationMs:number}[]=[],lockedFullReads:number[]=[],lockedCallbacks:string[]=[]
  const writable=()=>{try{otherDb.transaction(()=>{}).immediate();return true}catch{return false}}
  uploads=instance(db,store.attachments,{onTransaction:(event:{operation:string;durationMs:number})=>{events.push(event);if(!writable())lockedCallbacks.push(event.operation)}})
  reads.bytes=0;reads.fsyncs=0
  reads.observe=(_fd,count,requested)=>{if(count>CHUNK&&requested>CHUNK&&!writable())lockedFullReads.push(count)}
  try{
    for(let offset=0;offset<bytes.length;offset+=CHUNK)uploads.chunk(packet(m,bytes,offset),context)
    expect(uploads.status(query(m),context).status).toBe('ready')
    expect(reads.bytes).toBeGreaterThanOrEqual(bytes.length)
    expect(reads.bytes).toBeLessThanOrEqual(bytes.length*4)
    expect(lockedFullReads).toEqual([])
    expect(lockedCallbacks).toEqual([])
    expect(events.filter(e=>e.operation==='write')).toHaveLength(64)
    expect(reads.fsyncs).toBeGreaterThanOrEqual(64)   // 每块落盘后都 fsync(断点续传的持久性契约)
    expect(events.every(e=>Number.isFinite(e.durationMs)&&e.durationMs>=0)).toBe(true)
    if(process.env.CC_UPLOAD_BENCHMARK==='1')process.stdout.write(JSON.stringify({readBytes:reads.bytes,transactions:events.length,maxTransactionMs:Math.max(...events.map(e=>e.durationMs))})+'\n')
  }finally{reads.observe=null;otherDb.close()}
})

it.each(['another upload','exact replay'])('verifies a shared 8 MiB blob outside the writer lock for %s',operation=>{
  const bytes=Buffer.alloc(8*1024*1024,97),first=meta(bytes)
  for(let offset=0;offset<bytes.length;offset+=CHUNK)uploads.chunk(packet(first,bytes,offset),context)
  const otherDb=openDb({path:join(root,'state.db')}),lockedFullReads:number[]=[],events:{operation:string;durationMs:number}[]=[]
  otherDb.exec('PRAGMA busy_timeout=0')
  const durations:number[]=[],original=db.transaction.bind(db)
  vi.spyOn(db,'transaction').mockImplementation(<A extends any[],T>(body:(...args:A)=>T)=>{
    const transaction=original(body)
    return Object.assign((...args:A)=>transaction(...args),{
      deferred:transaction.deferred,exclusive:transaction.exclusive,
      immediate:(...args:A)=>{const start=performance.now();try{return transaction.immediate(...args)}finally{durations.push(performance.now()-start)}},
    })
  })
  uploads=instance(db,store.attachments,{onTransaction:(event:{operation:string;durationMs:number})=>events.push(event)})
  reads.bytes=0
  reads.observe=(_fd,count,requested)=>{
    if(count<=CHUNK||requested<=CHUNK)return
    try{otherDb.transaction(()=>{}).immediate()}catch{lockedFullReads.push(count)}
  }
  try{
    if(operation==='another upload'){
      const second=meta(bytes)
      for(let offset=0;offset<bytes.length;offset+=CHUNK)uploads.chunk(packet(second,bytes,offset),context)
      expect(uploads.status(query(second),context)).toMatchObject({status:'ready',attachment:{id:second.id,sha256:first.sha256}})
      expect(db.query('SELECT id FROM workbench_attachments').all()).toHaveLength(2)
    }else{
      expect(store.attachments.upload({...first,base64:bytes.toString('base64')},root,context)).toMatchObject({id:first.id,sha256:first.sha256})
      expect(db.query('SELECT id FROM workbench_attachments').all()).toHaveLength(1)
    }
    expect(reads.bytes).toBeGreaterThanOrEqual(bytes.length)
    expect(reads.bytes).toBeLessThanOrEqual(bytes.length*5)
    expect(lockedFullReads).toEqual([])
    expect(durations.every(duration=>Number.isFinite(duration)&&duration>=0)).toBe(true)
    if(process.env.CC_UPLOAD_BENCHMARK==='1')process.stdout.write(JSON.stringify({operation,readBytes:reads.bytes,transactions:durations.length,maxTransactionMs:Math.max(...durations),moduleTransactions:events.length})+'\n')
  }finally{reads.observe=null;otherDb.close()}
})

it('checks an earlier committed block after restart or unexpected file modification',()=>{
  const bytes=Buffer.alloc(CHUNK*4,97),m=meta(bytes)
  for(let offset=0;offset<CHUNK*3;offset+=CHUNK)uploads.chunk(packet(m,bytes,offset),context)
  const damaged=Buffer.alloc(CHUNK*3,97);damaged[0]=98;writeFileSync(part(m.id),damaged)
  expect(()=>uploads.chunk(packet(m,bytes,CHUNK*3),context)).toThrow('upload_changed')
  uploads=instance()
  expect(()=>uploads.chunk(packet(m,bytes,CHUNK),context)).toThrow('upload_changed')
  expect(()=>uploads.status(query(m),context)).toThrow('upload_changed')
  expect(db.query('SELECT next_offset FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({next_offset:CHUNK*3})
  expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([])
})

it('lets a second connection cancel during unlocked full-file verification without reviving the upload',()=>{
  const bytes=Buffer.alloc(CHUNK+7,97),m=meta(bytes),otherDb=openDb({path:join(root,'state.db')}),other=instance(otherDb,makeWorkbenchStore(otherDb).attachments)
  otherDb.exec('PRAGMA busy_timeout=0');let cancelled=false
  uploads.chunk(packet(m,bytes),context)
  reads.observe=(_fd,count)=>{if(count>CHUNK&&!cancelled){cancelled=true;other.discard(query(m),context)}}
  try{
    expect(()=>uploads.chunk(packet(m,bytes,CHUNK),context)).toThrow('upload_discarded')
    expect(cancelled).toBe(true)
    expect(db.query('SELECT status FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({status:'discarded'})
    expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([])
  }finally{reads.observe=null;otherDb.close()}
})

it('rechecks cancellation after verifying an existing shared blob outside the write transaction',()=>{
  const bytes=Buffer.alloc(CHUNK+7,97),first=meta(bytes),m=meta(bytes)
  uploads.chunk(packet(first,bytes),context);uploads.chunk(packet(first,bytes,CHUNK),context)
  uploads.chunk(packet(m,bytes),context)
  const otherDb=openDb({path:join(root,'state.db')}),other=instance(otherDb,makeWorkbenchStore(otherDb).attachments)
  const blob=statSync(join(root,'workbench-attachments',first.sha256));let cancelled=false
  otherDb.exec('PRAGMA busy_timeout=0')
  reads.observe=(fd,count)=>{if(count>CHUNK&&fstatSync(fd).ino===blob.ino&&!cancelled){cancelled=true;other.discard(query(m),context)}}
  try{
    expect(()=>uploads.chunk(packet(m,bytes,CHUNK),context)).toThrow('upload_discarded')
    expect(cancelled).toBe(true)
    expect(db.query('SELECT status FROM workbench_attachment_uploads WHERE id=?').get(m.id)).toEqual({status:'discarded'})
    expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([{id:first.id}])
  }finally{reads.observe=null;otherDb.close()}
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
