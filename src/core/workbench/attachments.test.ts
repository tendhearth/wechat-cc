import {afterEach,beforeEach,expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,symlinkSync,truncateSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {makeWorkbenchStore} from './store'
import {removeTempDir} from '../../lib/test-temp'

let root:string,project:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64')
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-attachments-')));project=join(root,'project');mkdirSync(project);db=openDb({path:join(root,'state.db')});store=makeWorkbenchStore(db)})
afterEach(()=>{db.close();removeTempDir(root)})
const task=()=>store.create({title:'task',path:project,providerId:'claude',ownerChatId:null}).id
const upload=(extra:Record<string,unknown>={})=>({id:randomUUID(),draftId:randomUUID(),name:'notes.txt',mime:'text/plain',base64:Buffer.from('original bytes').toString('base64'),...extra})
const accepted=(input:ReturnType<typeof upload>&{taskId?:string})=>{const a=store.attachments.upload(input as never,root);store.attachments.bind([a.id],input.taskId as string,input.draftId as string);return a}

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
  rmSync(join(project,'.cc-workbench-inputs'))
  const prepared=store.attachments.prepare(owner,[a],project,root)[0]!,secret=join(outside,'secret.txt');writeFileSync(secret,'untouched')
  rmSync(prepared.path);symlinkSync(secret,prepared.path)
  expect(()=>store.attachments.prepare(owner,[a],project,root)).toThrow('invalid_attachment_path')
  expect(readFileSync(secret,'utf8')).toBe('untouched')
})
