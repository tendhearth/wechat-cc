import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {randomUUID,createHash} from 'node:crypto'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,statSync,symlinkSync,truncateSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {makeWorkbenchStore} from './store'
import {removeLink,removeTempDir} from '../../lib/test-temp'

const quotaReads=vi.hoisted(()=>({directories:[] as string[],stats:[] as string[],beforeOpen:null as null|((path:string)=>boolean)}))
vi.mock('node:fs',async importOriginal=>{
  const fs=await importOriginal<typeof import('node:fs')>()
  return{...fs,
    readdirSync:(...args:unknown[])=>{quotaReads.directories.push(String(args[0]));return Reflect.apply(fs.readdirSync,fs,args)},
    lstatSync:(...args:unknown[])=>{quotaReads.stats.push(String(args[0]));return Reflect.apply(fs.lstatSync,fs,args)},
    openSync:(...args:unknown[])=>{if(quotaReads.beforeOpen?.(String(args[0])))quotaReads.beforeOpen=null;return Reflect.apply(fs.openSync,fs,args)},
  }
})

let root:string,project:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64')
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-attachments-')));project=join(root,'project');mkdirSync(project);db=openDb({path:join(root,'state.db')});store=makeWorkbenchStore(db)})
afterEach(()=>{vi.restoreAllMocks();db.close();removeTempDir(root)})
const task=()=>store.create({title:'task',path:project,providerId:'claude',ownerChatId:null}).id
const upload=(extra:Record<string,unknown>={})=>({id:randomUUID(),draftId:randomUUID(),name:'notes.txt',mime:'text/plain',base64:Buffer.from('original bytes').toString('base64'),...extra})
const accepted=(input:ReturnType<typeof upload>&{taskId?:string})=>{const a=store.attachments.upload(input as never,root);store.attachments.bind([a.id],input.taskId as string,input.draftId as string);return a}
const beforeNextWrite=(action:()=>void)=>{
  const original=db.transaction.bind(db);let pending=true
  vi.spyOn(db,'transaction').mockImplementation(<A extends any[],T>(body:(...args:A)=>T)=>{
    const transaction=original(body)
    return Object.assign((...args:A)=>transaction(...args),{
      deferred:transaction.deferred,exclusive:transaction.exclusive,
      immediate:(...args:A)=>{if(pending){pending=false;action()};return transaction.immediate(...args)},
    })
  })
}

it('stamps trusted ownership without exposing it or accepting an owner from the upload body',()=>{
  const input=upload(),scope={ownerKey:'owner'},a=store.attachments.upload(input as never,root,scope)
  expect(Object.keys(a).sort()).toEqual(['id','mime','name','sha256','size'])
  expect(db.query('SELECT owner_key FROM workbench_attachments WHERE id=?').get(a.id)).toEqual({owner_key:'owner'})
  expect(store.attachments.upload(input as never,root,scope)).toEqual(a)
  expect(()=>store.attachments.upload(input as never,root,{ownerKey:'other'})).toThrow('attachment_scope')
  expect(()=>store.attachments.upload(input as never,root)).toThrow('attachment_scope')
  expect(()=>store.attachments.upload(upload({ownerKey:'forged'}) as never,root,scope)).toThrow('invalid_attachment')
})

it('requires the stamped owner even on legacy calls and cannot bind or discard foreign material',()=>{
  const input=upload(),scope={ownerKey:'owner'},a=store.attachments.upload(input as never,root,scope)
  const own=store.create({title:'own',path:project,providerId:'claude',ownerChatId:'owner'}).id
  const foreign=store.create({title:'other',path:project,providerId:'claude',ownerChatId:'other'}).id
  expect(()=>store.attachments.select([a.id],undefined,input.draftId as string)).toThrow('attachment_scope')
  expect(()=>store.attachments.bind([a.id],foreign,input.draftId as string)).toThrow('attachment_scope')
  expect(()=>store.attachments.bind([a.id],foreign,input.draftId as string,scope)).toThrow('attachment_scope')
  expect(()=>store.attachments.discard(a.id,input.draftId as string,{ownerKey:'other'})).toThrow('attachment_scope')
  expect(()=>store.attachments.discard(a.id,input.draftId as string)).toThrow('attachment_scope')
  expect(store.attachments.select([a.id],undefined,input.draftId as string,scope)).toEqual([a])
  expect(store.attachments.bind([a.id],own,input.draftId as string,scope)).toEqual([a])
  expect(store.attachments.select([a.id],own)).toEqual([a])
  expect(()=>store.attachments.select([a.id],own,undefined,{ownerKey:'other'})).toThrow('attachment_scope')
})

it('does not claim legacy unbound material through a strict new entry, but keeps legacy task reads',()=>{
  const input=upload(),a=store.attachments.upload(input as never,root),scope={ownerKey:'owner'}
  const own=store.create({title:'own',path:project,providerId:'claude',ownerChatId:'owner'}).id
  expect(()=>store.attachments.select([a.id],undefined,input.draftId as string,scope)).toThrow('attachment_scope')
  expect(()=>store.attachments.upload(input as never,root,scope)).toThrow('attachment_scope')
  expect(()=>store.attachments.bind([a.id],own,input.draftId as string,scope)).toThrow('attachment_scope')
  expect(store.attachments.bind([a.id],own,input.draftId as string,{...scope,allowLegacyUnbound:true})).toEqual([a])
  expect(store.attachments.select([a.id],own,undefined,scope)).toEqual([a])
  expect(db.query('SELECT owner_key FROM workbench_attachments WHERE id=?').get(a.id)).toEqual({owner_key:null})
  expect(()=>store.attachments.upload(input as never,root,{ownerKey:'other'})).toThrow('attachment_scope')
})

it('preserves the original owner on copies and refuses cross-owner targets',()=>{
  const input=upload(),scope={ownerKey:'owner'},a=store.attachments.upload(input as never,root,scope)
  const own=()=>store.create({title:'own',path:project,providerId:'claude',ownerChatId:'owner'}).id
  const first=own(),second=own(),foreign=store.create({title:'other',path:project,providerId:'claude',ownerChatId:'other'}).id
  store.attachments.bind([a.id],first,input.draftId as string,scope)
  expect(()=>store.attachments.copyToTask(first,[a.id],foreign)).toThrow('attachment_scope')
  const copy=store.attachments.copyToTask(first,[a.id],second,scope)[0]!
  expect(db.query('SELECT owner_key FROM workbench_attachments WHERE id=?').get(copy.id)).toEqual({owner_key:'owner'})
  expect(store.attachments.read(second,copy.id,root).base64).toBe(input.base64)
})

it('claims a staged upload once and restricts reads to its owning task',()=>{
  expect(store.attachments).toBeDefined()
  const first=task(),second=task(),input=upload(),a=store.attachments.upload(input as never,root)
  expect(Object.keys(a).sort()).toEqual(['id','mime','name','sha256','size'])
  expect(store.attachments.select([a.id],undefined,input.draftId as string)).toEqual([a])
  expect(()=>store.attachments.select([a.id],first,randomUUID())).toThrow('attachment_scope')
  expect(()=>store.attachments.select([a.id],undefined)).toThrow('attachment_scope')
  expect(store.attachments.bind([a.id],first,input.draftId as string)).toEqual([a])
  expect(store.attachments.bind([a.id],first)).toEqual([a])
  expect(()=>store.attachments.bind([a.id],second,input.draftId as string)).toThrow('attachment_scope')
  expect(()=>store.attachments.getTask(second,a.id)).toThrow('not_found')
  expect(store.attachments.read(first,a.id,root)).toEqual({attachment:a,base64:input.base64})
  expect(store.attachments.list(first)).toEqual([a])
  if(process.platform!=='win32') expect(statSync(join(root,'workbench-attachments',a.sha256)).mode&0o777).toBe(0o600)
})

it('makes upload retries exact even after claiming and keeps copies separately owned',()=>{
  const first=task(),second=task(),input=upload(),a=store.attachments.upload(input as never,root)
  store.attachments.bind([a.id],first,input.draftId as string)
  expect(store.attachments.upload(input as never,root)).toEqual(a)
  for(const change of [{draftId:randomUUID()},{taskId:first},{name:'other.txt'},{mime:'text/markdown'},{base64:Buffer.from('changed').toString('base64')}])expect(()=>store.attachments.upload({...input,...change} as never,root)).toThrow('attachment_conflict')
  const copy=store.attachments.copyToTask(first,[a.id],second)[0]!
  expect(copy).toEqual({...a,id:expect.any(String)});expect(copy.id).not.toBe(a.id)
  expect(store.attachments.read(second,copy.id,root).base64).toBe(input.base64)
  expect(()=>store.attachments.copyToTask(second,[a.id],first)).toThrow('not_found')
  expect(store.artifacts(first)).toEqual([])
})

it.each(['another upload','exact replay'])('rejects a replaced verified blob during %s and permits a verified retry',operation=>{
  const first=upload(),a=store.attachments.upload(first as never,root),input=operation==='exact replay'?first:upload(),path=join(root,'workbench-attachments',a.sha256)
  beforeNextWrite(()=>{renameSync(path,join(root,'previous-blob'));writeFileSync(path,Buffer.from(input.base64 as string,'base64'))})
  expect(()=>store.attachments.upload(input as never,root)).toThrow('attachment_changed')
  expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([{id:a.id}])
  expect(store.attachments.upload(input as never,root)).toMatchObject({id:input.id,sha256:a.sha256})
  expect(db.query('SELECT id FROM workbench_attachments').all()).toHaveLength(operation==='exact replay'?1:2)
})

it('refuses to replay corrupted stored size even when the blob still matches the submitted bytes',()=>{
  const input=upload(),a=store.attachments.upload(input as never,root)
  db.query('UPDATE workbench_attachments SET size=size+1 WHERE id=?').run(a.id)
  expect(()=>store.attachments.upload(input as never,root)).toThrow('attachment_changed')
})

it.each(['another upload','exact replay'])('retries a concurrently created blob without changing the winning %s',operation=>{
  const input=upload(),competing=operation==='exact replay'?input:upload(),otherDb=openDb({path:join(root,'state.db')})
  const other=makeWorkbenchStore(otherDb)
  try{
    beforeNextWrite(()=>{other.attachments.upload(competing as never,root)})
    expect(()=>store.attachments.upload(input as never,root)).toThrow('attachment_changed')
    expect(db.query('SELECT id FROM workbench_attachments').all()).toEqual([{id:competing.id}])
    expect(store.attachments.upload(input as never,root)).toMatchObject({id:input.id,sha256:createHash('sha256').update(Buffer.from(input.base64 as string,'base64')).digest('hex')})
    expect(db.query('SELECT id FROM workbench_attachments').all()).toHaveLength(operation==='exact replay'?1:2)
  }finally{otherDb.close()}
})

it('discards only matching unclaimed drafts and requires existing tasks for scoped uploads',()=>{
  const input=upload(),a=store.attachments.upload(input as never,root)
  expect(()=>store.attachments.discard(a.id,randomUUID())).toThrow('attachment_scope')
  store.attachments.discard(a.id,input.draftId as string)
  expect(()=>store.attachments.select([a.id],undefined,input.draftId as string)).toThrow('not_found')
  const owner=task(),bound=accepted(upload({taskId:owner}))
  expect(()=>store.attachments.discard(bound.id,input.draftId as string)).toThrow('attachment_scope')
  expect(()=>store.attachments.upload(upload({taskId:'deadbeef'}) as never,root)).toThrow('not_found')
})

it('rejects malformed payloads, invalid file names and mismatching binary types',()=>{
  for(const name of ['../x.txt','a/b.txt','a\\b.txt','x\0.txt','.','..','x\n.txt'])expect(()=>store.attachments.upload(upload({name}) as never,root)).toThrow('invalid_attachment')
  for(const base64 of ['a===','eA','eA==\n','eA==!','eB==',''])expect(()=>store.attachments.upload(upload({base64}) as never,root)).toThrow('invalid_attachment')
  for(const [name,mime,base64] of [['x.png','image/png',Buffer.from('not png').toString('base64')],['x.pdf','application/pdf',png.toString('base64')],['x.txt','text/plain',png.toString('base64')],['x.bin','application/octet-stream','eA==']])expect(()=>store.attachments.upload(upload({name,mime,base64}) as never,root)).toThrow('invalid_attachment')
  expect(()=>store.attachments.upload(upload({id:'invalid'}) as never,root)).toThrow('invalid_attachment')
  expect(()=>store.attachments.upload(upload({draftId:'invalid'}) as never,root)).toThrow('invalid_attachment')
})

it('enforces per-file and image limits before accepting bytes',()=>{
  expect(()=>store.attachments.upload(upload({base64:Buffer.alloc(8*1024*1024+1,97).toString('base64')}) as never,root)).toThrow('invalid_attachment_size')
  const image=Buffer.alloc(5*1024*1024+1);png.copy(image)
  expect(()=>store.attachments.upload(upload({name:'x.png',mime:'image/png',base64:image.toString('base64')}) as never,root)).toThrow('invalid_attachment_size')
})

it('validates batch ownership atomically and preserves order within count and total-byte limits',()=>{
  const owner=task(),draftId=randomUUID(),a=store.attachments.upload(upload({draftId,name:'a.txt'}) as never,root),b=store.attachments.upload(upload({draftId,name:'b.txt'}) as never,root)
  expect(()=>store.attachments.bind([a.id,randomUUID()],owner,draftId)).toThrow('not_found')
  expect(store.attachments.select([a.id],undefined,draftId)).toEqual([a])
  expect(store.attachments.select([b.id,a.id],undefined,draftId)).toEqual([b,a])
  for(const ids of [[a.id,a.id],Array.from({length:9},()=>randomUUID()),null,'x',[42]])expect(()=>store.attachments.select(ids,owner,draftId)).toThrow('invalid_attachment')
  const large=Buffer.alloc(8*1024*1024,97).toString('base64')
  const refs=Array.from({length:4},(_,i)=>accepted(upload({taskId:owner,name:`large-${i}.txt`,base64:large})))
  expect(store.attachments.select(refs.slice(0,3).map(a=>a.id),owner)).toHaveLength(3)
  expect(()=>store.attachments.select(refs.map(a=>a.id),owner)).toThrow('invalid_attachment_size')
})

it('materializes pinned bytes, supplies native image/PDF data and rejects changed refs or files',()=>{
  const owner=task(),input=upload({taskId:owner}),a=accepted(input)
  const image=accepted(upload({taskId:owner,name:'sample.png',mime:'image/png',base64:png.toString('base64')}))
  const pdf=accepted(upload({taskId:owner,name:'sample.pdf',mime:'application/pdf',base64:Buffer.from('%PDF-1.7\n%%EOF\n').toString('base64')}))
  const prepared=store.attachments.prepare(owner,[a,image,pdf],project,root)
  expect(prepared[0]).toEqual({name:a.name,mime:a.mime,sha256:a.sha256,path:join(project,'.cc-workbench-inputs',owner,a.id,a.name)})
  expect(readFileSync(prepared[0]!.path,'utf8')).toBe('original bytes')
  if(process.platform!=='win32') expect(statSync(prepared[0]!.path).mode&0o777).toBe(0o600)
  expect(prepared[1]!.data).toBe(png.toString('base64'));expect(prepared[2]!.data).toBeDefined()
  expect(store.attachments.prepare(owner,[a],project,root)).toEqual([prepared[0]])
  expect(()=>store.attachments.prepare(owner,[{...a,sha256:'a'.repeat(64)}],project,root)).toThrow('attachment_changed')
  writeFileSync(prepared[0]!.path,'tampered')
  expect(()=>store.attachments.prepare(owner,[a],project,root)).toThrow('attachment_changed')
})

it('infers missing browser MIME from supported filenames while still checking bytes',()=>{
  expect(store.attachments.upload(upload({mime:'application/octet-stream'}) as never,root).mime).toBe('text/plain')
  expect(store.attachments.upload(upload({name:'sample.png',mime:'',base64:png.toString('base64')}) as never,root).mime).toBe('image/png')
  expect(()=>store.attachments.upload(upload({name:'sample.png',mime:''}) as never,root)).toThrow('invalid_attachment')
  expect(()=>store.attachments.upload(upload({name:'unknown.bin',mime:''}) as never,root)).toThrow('invalid_attachment')
  expect(store.attachments.upload(upload({name:'source.js',mime:'text/javascript'}) as never,root).mime).toBe('text/plain')
})

it('limits total bytes per draft and total staged rows even when blobs are deduplicated',()=>{
  const draftId=randomUUID(),large=Buffer.alloc(8*1024*1024,97).toString('base64')
  for(let i=0;i<3;i++)store.attachments.upload(upload({draftId,name:`large-${i}.txt`,base64:large}) as never,root)
  expect(()=>store.attachments.upload(upload({draftId}) as never,root)).toThrow('invalid_attachment_size')
  const small=store.attachments.upload(upload() as never,root)
  db.transaction(()=>{
    for(let i=0;i<508;i++)db.query('INSERT INTO workbench_attachments(id,draft_id,task_id,upload_task_id,name,mime,size,sha256,storage_path,created_at) SELECT ?,?,NULL,NULL,name,mime,size,sha256,storage_path,created_at FROM workbench_attachments WHERE id=?').run(randomUUID(),randomUUID(),small.id)
  })()
  expect(()=>store.attachments.upload(upload() as never,root)).toThrow('attachment_storage_limit')
})

it('bounds each draft and expires only old unclaimed uploads without breaking shared snapshots',()=>{
  const draftId=randomUUID(),inputs=Array.from({length:8},(_,i)=>upload({draftId,name:`item-${i}.txt`}))
  const refs=inputs.map(input=>store.attachments.upload(input as never,root))
  expect(()=>store.attachments.upload(upload({draftId}) as never,root)).toThrow('attachment_limit')
  const owner=task();store.attachments.bind([refs[0]!.id],owner,draftId)
  db.query('UPDATE workbench_attachments SET created_at=1').run()
  store.attachments.upload(upload({draftId}) as never,root)
  expect(()=>store.attachments.select([refs[1]!.id],undefined,draftId)).toThrow('not_found')
  expect(store.attachments.read(owner,refs[0]!.id,root).base64).toBe(inputs[0]!.base64)
})

it('allows an expired unsent upload to be explicitly uploaded again instead of returning an unusable receipt',()=>{
  const input=upload(),a=store.attachments.upload(input as never,root)
  db.query('UPDATE workbench_attachments SET created_at=1 WHERE id=?').run(a.id)
  expect(()=>store.attachments.select([a.id],undefined,input.draftId as string)).toThrow('not_found')
  expect(store.attachments.upload(input as never,root)).toEqual(a)
  expect(store.attachments.select([a.id],undefined,input.draftId as string)).toEqual([a])
})

it('reclaims unreferenced blobs before enforcing disk quota without touching shared snapshots',()=>{
  const dir=join(root,'workbench-attachments');mkdirSync(dir)
  // Sparse bytes represent an orphan from an interrupted write without filling disk.
  const path=join(dir,'a'.repeat(64));writeFileSync(path,'x');truncateSync(path,256*1024*1024)
  const input=upload(),a=store.attachments.upload(input as never,root)
  expect(existsSync(path)).toBe(false)
  const owner=task();store.attachments.bind([a.id],owner,input.draftId as string)
  const duplicate=upload(),b=store.attachments.upload(duplicate as never,root)
  store.attachments.discard(b.id,duplicate.draftId as string)
  expect(store.attachments.read(owner,a.id,root).base64).toBe(input.base64)
  const unique=upload({base64:Buffer.from('unique orphan').toString('base64')}),c=store.attachments.upload(unique as never,root)
  store.attachments.discard(c.id,unique.draftId as string)
  expect(existsSync(join(dir,c.sha256))).toBe(false)
})

it('keeps task-scoped uploads unsent and permits only the intended task to claim them',()=>{
  const first=task(),second=task(),input=upload({taskId:first}),a=store.attachments.upload(input as never,root)
  expect(store.attachments.list(first)).toEqual([])
  expect(()=>store.attachments.getTask(first,a.id)).toThrow('not_found')
  expect(()=>store.attachments.bind([a.id],second,input.draftId as string)).toThrow('attachment_scope')
  store.attachments.discard(a.id,input.draftId as string)
  expect(()=>store.attachments.select([a.id],first,input.draftId as string)).toThrow('not_found')
})

it('keeps snapshots across database reopen and fails closed after snapshot corruption',()=>{
  const owner=task(),a=accepted(upload({taskId:owner}))
  db.close();db=openDb({path:join(root,'state.db')});store=makeWorkbenchStore(db)
  expect(store.attachments.getTask(owner,a.id)).toEqual(a)
  writeFileSync(join(root,'workbench-attachments',a.sha256),'tampered')
  expect(()=>store.attachments.read(owner,a.id,root)).toThrow('attachment_changed')
  expect(()=>store.attachments.prepare(owner,[a],project,root)).toThrow('attachment_changed')
})

it('does not follow input-directory or materialized-file symlinks',()=>{
  const owner=task(),a=accepted(upload({taskId:owner})),outside=join(root,'outside');mkdirSync(outside)
  symlinkSync(outside,join(project,'.cc-workbench-inputs'))
  expect(()=>store.attachments.prepare(owner,[a],project,root)).toThrow('invalid_attachment_path')
  expect(()=>readFileSync(join(outside,owner,a.id,a.name))).toThrow()
  removeLink(join(project,'.cc-workbench-inputs'))
  const prepared=store.attachments.prepare(owner,[a],project,root)[0]!,secret=join(outside,'secret.txt');writeFileSync(secret,'untouched')
  rmSync(prepared.path);symlinkSync(secret,prepared.path)
  expect(()=>store.attachments.prepare(owner,[a],project,root)).toThrow('invalid_attachment_path')
  expect(readFileSync(secret,'utf8')).toBe('untouched')
})

// 威胁模型(docs/reference/workbench-file-guard.md):锚定的是项目目录,不是 mkdirAnchored 交回来的深层路径。
// 目录建好之后、文件打开之前,中间一级被换成指出去的链接,打开后的复核必须从项目目录核到叶子才看得见。
it.skipIf(process.platform==='win32')('re-verifies the whole chain from the project when an input directory is swapped for a link before the write',()=>{
  const owner=task(),a=accepted(upload({taskId:owner})),outside=join(root,'outside')
  mkdirSync(join(outside,owner,a.id),{recursive:true})
  const inputs=join(project,'.cc-workbench-inputs')
  quotaReads.beforeOpen=path=>{
    if(!path.startsWith(inputs))return false
    renameSync(inputs,`${inputs}-real`);symlinkSync(outside,inputs);return true
  }
  try{expect(()=>store.attachments.prepare(owner,[a],project,root)).toThrow('invalid_attachment_path')}
  finally{quotaReads.beforeOpen=null}
  // 内核已经穿过链接建出一个空文件(接受的残留),但我们拒绝往里写内容。
  expect(existsSync(join(outside,owner,a.id,a.name))?readFileSync(join(outside,owner,a.id,a.name),'utf8'):'').toBe('')
})

const uploadReservation=(input:{id:string;draftId:string;size:number;sha256:string},status='uploading')=>{
  const now=Date.now()
  db.query('INSERT INTO workbench_attachment_uploads(id,owner_key,draft_id,name,mime,size,sha256,status,reserved_bytes,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(input.id,'owner',input.draftId,'notes.txt','text/plain',input.size,input.sha256,status,2*input.size+16384,now,now,now+7*86400_000)
}
it('shares draft count and byte reservations with full uploads and counts orphan parts',()=>{
  const draftId=randomUUID(),scope={ownerKey:'owner'}
  for(let i=0;i<8;i++)uploadReservation({id:randomUUID(),draftId,size:1,sha256:'a'.repeat(64)})
  expect(()=>store.attachments.upload(upload({draftId}) as never,root,scope)).toThrow('attachment_limit')
  const parts=join(root,'workbench-attachment-uploads');mkdirSync(parts,{recursive:true})
  const orphan=join(parts,'orphan');writeFileSync(orphan,'');truncateSync(orphan,256*1024*1024)
  expect(()=>store.attachments.upload(upload() as never,root,scope)).toThrow('attachment_storage_limit')
})
it('reserves future part and blob bytes and reuses its reservation during finalize',()=>{
  const scope={ownerKey:'owner'},input=upload(),bytes=Buffer.from(input.base64 as string,'base64')
  const sha256='f'.repeat(64),parts=join(root,'workbench-attachment-uploads');mkdirSync(parts,{recursive:true})
  const orphan=join(parts,'orphan');writeFileSync(orphan,'');truncateSync(orphan,256*1024*1024-16384-bytes.length*2)
  const reservation={id:input.id as string,draftId:input.draftId as string,size:bytes.length,sha256}
  expect(()=>store.attachments.checkUploadQuota({...reservation,kind:'resumable'},root,scope)).not.toThrow()
  expect(()=>store.attachments.checkUploadQuota({...reservation,size:bytes.length+1,kind:'resumable'},root,scope)).toThrow('attachment_storage_limit')
  // An actual reservation covers both files, including the final full-upload metadata.
  const actualSha=(bytesHash(bytes))
  uploadReservation({...reservation,sha256:actualSha},'finalizing')
  writeFileSync(join(parts,reservation.id+'.part'),bytes)
  expect(store.attachments.upload(input as never,root,scope).sha256).toBe(actualSha)
})
function bytesHash(bytes:Buffer){return createHash('sha256').update(bytes).digest('hex')}
it('protects a reserved creation material from discard and collection until the reservation expires',()=>{
  const scope={ownerKey:'owner'},input=upload(),a=store.attachments.upload(input as never,root,scope)
  const requestId=randomUUID()
  store.entryRequests.reserve({ownerKey:'owner',requestId,canonicalRequestHash:'f'.repeat(64),target:{kind:'managed'},workspaceId:randomUUID(),resolvedPath:null,directoryIdentity:null,providerId:'claude',execution:{defaults:'provider',model:null,reasoningEffort:null},materialSnapshot:[a]})
  expect(()=>store.attachments.discard(a.id,input.draftId as string,scope)).toThrow('attachment_in_use')
  db.query('UPDATE workbench_attachments SET created_at=? WHERE id=?').run(Date.now()-8*86400_000,a.id)
  store.attachments.upload(upload() as never,root,scope)
  expect(store.attachments.select([a.id],undefined,input.draftId as string,scope)).toEqual([a])
  db.query('UPDATE workbench_entry_requests SET created_at=? WHERE request_id=?').run(Date.now()-8*86400_000,requestId)
  expect(()=>store.attachments.discard(a.id,input.draftId as string,scope)).not.toThrow()
})
it.each(['discarded','expired'])('rejects consumption after an upload %s tombstone',status=>{
  const scope={ownerKey:'owner'},input=upload(),a=store.attachments.upload(input as never,root,scope)
  uploadReservation({id:a.id,draftId:input.draftId as string,size:a.size,sha256:a.sha256},status)
  const ownerTask=store.create({title:'own',path:project,providerId:'claude',ownerChatId:'owner'}).id
  for(const operation of [()=>store.attachments.select([a.id],undefined,input.draftId as string,scope),()=>store.attachments.bind([a.id],ownerTask,input.draftId as string,scope),()=>store.attachments.upload(input as never,root,scope)])expect(operation).toThrow('upload_'+status)
  expect(()=>store.attachments.discard(a.id,input.draftId as string,scope)).not.toThrow()
})
it('does not let a whole upload borrow another owner or payload reservation',()=>{
  const input=upload(),bytes=Buffer.from(input.base64 as string,'base64'),sha256=bytesHash(bytes)
  uploadReservation({id:input.id as string,draftId:input.draftId as string,size:bytes.length,sha256},'finalizing')
  expect(()=>store.attachments.upload(input as never,root,{ownerKey:'other'})).toThrow('attachment_scope')
  for(const extra of [{draftId:randomUUID()},{base64:Buffer.alloc(8*1024*1024,65).toString('base64')},{name:'changed.txt'}])expect(()=>store.attachments.upload({...input,...extra} as never,root,{ownerKey:'owner'})).toThrow('attachment_conflict')
  db.query("UPDATE workbench_attachment_uploads SET status='uploading'").run()
  expect(()=>store.attachments.upload(input as never,root,{ownerKey:'owner'})).toThrow('attachment_conflict')
  expect(db.query('SELECT * FROM workbench_attachments').all()).toEqual([])
})
it('charges copied handoff metadata to the same global storage budget',()=>{
  const scope={ownerKey:'owner'},input=upload(),a=store.attachments.upload(input as never,root,scope)
  const own=()=>store.create({title:'own',path:project,providerId:'claude',ownerChatId:'owner'}).id,source=own(),target=own()
  store.attachments.bind([a.id],source,input.draftId as string,scope)
  const orphan=join(root,'workbench-attachment-uploads','orphan');writeFileSync(orphan,'');truncateSync(orphan,256*1024*1024-a.size-1024)
  expect(()=>store.attachments.copyToTask(source,[a.id],target,scope)).toThrow('attachment_storage_limit')
  expect(store.attachments.list(target)).toEqual([])
})

it('uses an explicit budget kind: staged and resumable obey draft limits while tombstones remain possible',()=>{
  const draftId=randomUUID(),scope={ownerKey:'owner'}
  for(let i=0;i<8;i++)uploadReservation({id:randomUUID(),draftId,size:1024,sha256:'a'.repeat(64)})
  const candidate={id:randomUUID(),draftId,size:1024,sha256:'b'.repeat(64)}
  for(const kind of ['staged','resumable'] as const)expect(()=>store.attachments.checkUploadQuota({...candidate,kind},root,scope)).toThrow('attachment_limit')
  expect(()=>store.attachments.checkUploadQuota({...candidate,kind:'tombstone'},root,scope)).not.toThrow()
  expect(()=>store.attachments.checkUploadQuota({...candidate,kind:'unknown'} as never,root,scope)).toThrow('invalid_attachment')
})

it('collects and charges each existing blob with one directory inventory per whole upload',()=>{
  const input=upload(),first=store.attachments.upload(input as never,root),blob=join(root,'workbench-attachments',first.sha256)
  quotaReads.directories=[];quotaReads.stats=[]
  store.attachments.upload(upload({base64:Buffer.from('different bytes').toString('base64')}) as never,root)
  expect(quotaReads.directories.filter(path=>path===join(root,'workbench-attachments'))).toHaveLength(1)
  expect(quotaReads.directories.filter(path=>path===join(root,'workbench-attachment-uploads'))).toHaveLength(1)
  expect(quotaReads.stats.filter(path=>path===blob)).toHaveLength(1)
})

it('does not materialize unrelated terminal uploads or handoff history while checking a fresh reservation',()=>{
  const input=upload(),first=store.attachments.upload(input as never,root),owner=task()
  store.attachments.bind([first.id],owner,input.draftId as string)
  const insert=db.query("INSERT INTO workbench_attachment_uploads(id,owner_key,draft_id,name,mime,size,sha256,status,reserved_bytes,created_at,updated_at,expires_at) VALUES(?,'owner',?,'','',1,?,'discarded',1024,1,1,1)")
  const copy=db.query('INSERT INTO workbench_attachments(id,draft_id,task_id,upload_task_id,name,mime,size,sha256,storage_path,created_at) SELECT ?,?,task_id,task_id,name,mime,size,sha256,storage_path,created_at FROM workbench_attachments WHERE id=?')
  db.transaction(()=>{for(let i=0;i<1200;i++){insert.run(randomUUID(),randomUUID(),'a'.repeat(64));copy.run(randomUUID(),randomUUID(),first.id)}})()
  let returnedRows=0
  const query=db.query.bind(db)
  vi.spyOn(db,'query').mockImplementation(((sql:string)=>{
    const statement=query(sql)
    return new Proxy(statement,{get(target,key,receiver){
      const value=Reflect.get(target,key,receiver)
      if(typeof value!=='function')return value
      return (...args:unknown[])=>{const result=Reflect.apply(value,target,args);if(key==='all'&&Array.isArray(result))returnedRows+=result.length;return result}
    }})
  }) as typeof db.query)
  expect(()=>store.attachments.checkUploadQuota({id:randomUUID(),draftId:randomUUID(),size:1024,sha256:'b'.repeat(64),kind:'resumable'},root,{ownerKey:'owner'})).not.toThrow()
  expect(returnedRows).toBeLessThanOrEqual(8)
})

it('sees another connection’s reserved future bytes without a process-local quota cache',()=>{
  const size=1024,parts=join(root,'workbench-attachment-uploads');mkdirSync(parts)
  const orphan=join(parts,'orphan');writeFileSync(orphan,'');truncateSync(orphan,256*1024*1024-(2*size+16384))
  const second=openDb({path:join(root,'state.db')})
  try{
    const other=makeWorkbenchStore(second),candidate={id:randomUUID(),draftId:randomUUID(),size,sha256:'a'.repeat(64)}
    db.transaction(()=>{store.attachments.checkUploadQuota({...candidate,kind:'resumable'},root,{ownerKey:'owner'});uploadReservation(candidate) }).immediate()
    expect(()=>second.transaction(()=>other.attachments.checkUploadQuota({...candidate,id:randomUUID(),draftId:randomUUID(),kind:'resumable'},root,{ownerKey:'owner'})).immediate()).toThrow('attachment_storage_limit')
  }finally{second.close()}
})

it.each(['workbench-attachments','workbench-attachment-uploads'])('recounts externally resized orphan bytes in %s without relying on directory timestamps',leaf=>{
  const dir=join(root,leaf);mkdirSync(dir)
  const orphan=join(dir,'orphan');writeFileSync(orphan,'small')
  const candidate={id:randomUUID(),draftId:randomUUID(),size:1024,sha256:'b'.repeat(64),kind:'staged' as const}
  expect(()=>store.attachments.checkUploadQuota(candidate,root)).not.toThrow()
  truncateSync(orphan,256*1024*1024)
  expect(()=>store.attachments.checkUploadQuota(candidate,root)).toThrow('attachment_storage_limit')
  truncateSync(orphan,5)
  expect(()=>store.attachments.checkUploadQuota(candidate,root)).not.toThrow()
})

it('counts every active reservation’s future bytes even when several reserve the same missing blob',()=>{
  const size=1024,parts=join(root,'workbench-attachment-uploads');mkdirSync(parts)
  const orphan=join(parts,'orphan');writeFileSync(orphan,'');truncateSync(orphan,256*1024*1024-(2*16384+3*size+1024+1))
  for(let i=0;i<2;i++)uploadReservation({id:randomUUID(),draftId:randomUUID(),size,sha256:'a'.repeat(64)})
  expect(()=>store.attachments.checkUploadQuota({id:randomUUID(),draftId:randomUUID(),size:1,sha256:'b'.repeat(64),kind:'staged'},root)).toThrow('attachment_storage_limit')
})
