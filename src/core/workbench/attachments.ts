import {createHash,randomUUID} from 'node:crypto'
import {closeSync,constants,fstatSync,lstatSync,readdirSync,readSync,unlinkSync,writeFileSync} from 'node:fs'
import {basename,dirname,extname,isAbsolute,join,resolve} from 'node:path'
import type {Db} from '../../lib/db'
import type {AgentAttachment} from '../agent-provider'
import {readAnchoredRegular} from './artifacts'
import {O_NONBLOCK,lstatNoLink,mkdirAnchored,openAnchored} from './anchored-fs'

export interface Attachment {id:string;name:string;mime:string;size:number;sha256:string}
export interface AttachmentUpload {id:string;draftId:string;taskId?:string;name:string;mime:string;base64:string}
interface StoredAttachment extends Attachment {draftId:string;taskId:string|null;uploadTaskId:string|null;storagePath:string;createdAt:number}
export const MAX_ATTACHMENT_BYTES=8*1024*1024
export const MAX_IMAGE_ATTACHMENT_BYTES=5*1024*1024
export const MAX_ATTACHMENT_BATCH_BYTES=24*1024*1024
export const MAX_ATTACHMENTS=8
const MAX_STORAGE_BYTES=256*1024*1024
const STAGED_RETENTION_MS=7*24*60*60*1000
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const TEXT_MIMES=new Set(['text/plain','text/markdown','text/csv','application/json'])
const IMAGE_MIMES=new Set(['image/png','image/jpeg','image/gif','image/webp'])
const OFFICE_MIMES=new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation'])
const EXTENSION_MIMES:Record<string,string>={txt:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation'}
for(const extension of ['ts','tsx','js','jsx','mjs','cjs','py','go','rs','java','c','h','cpp','hpp','css','html','sql','sh','yaml','yml','toml','xml','diff','patch'])EXTENSION_MIMES[extension]='text/plain'
const SELECT='SELECT id,draft_id AS draftId,task_id AS taskId,upload_task_id AS uploadTaskId,name,mime,size,sha256,storage_path AS storagePath,created_at AS createdAt FROM workbench_attachments'
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const publicAttachment=({id,name,mime,size,sha256}:Attachment):Attachment=>({id,name,mime,size,sha256})
function uuid(value:unknown):string {if(typeof value!=='string'||!UUID.test(value))throw Error('invalid_attachment');return value.toLowerCase()}
function taskIdentity(value:unknown):string {if(typeof value!=='string'||! /^[a-f0-9]{8}$/.test(value))throw Error('invalid_attachment');return value}
function fileName(value:unknown):string {
  if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>240||value==='.'||value==='..'||/[\\/\u0000-\u001f\u007f]/.test(value)||value.endsWith('.')||value.endsWith(' '))throw Error('invalid_attachment')
  return value
}
function attachmentIds(value:unknown):string[] {
  if(value===undefined)return[]
  if(!Array.isArray(value)||value.length>MAX_ATTACHMENTS)throw Error('invalid_attachment')
  const ids=value.map(uuid)
  if(new Set(ids).size!==ids.length)throw Error('invalid_attachment')
  return ids
}
function decodeUpload(mime:unknown,base64:unknown):Buffer {
  if(typeof mime!=='string'||(!TEXT_MIMES.has(mime)&&!IMAGE_MIMES.has(mime)&&!OFFICE_MIMES.has(mime)&&mime!=='application/pdf')||typeof base64!=='string')throw Error('invalid_attachment')
  const max=IMAGE_MIMES.has(mime)?MAX_IMAGE_ATTACHMENT_BYTES:MAX_ATTACHMENT_BYTES
  if(base64.length>4*Math.ceil(max/3))throw Error('invalid_attachment_size')
  if(!base64.length||base64.length%4||/[^A-Za-z0-9+/=]/.test(base64))throw Error('invalid_attachment')
  const bytes=Buffer.from(base64,'base64')
  if(bytes.length>max)throw Error('invalid_attachment_size')
  if(!bytes.length||bytes.toString('base64')!==base64)throw Error('invalid_attachment')
  const starts=(signature:number[])=>bytes.subarray(0,signature.length).equals(Buffer.from(signature))
  let valid=false
  if(TEXT_MIMES.has(mime)) {
    try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);valid=!bytes.includes(0)}catch{/* Invalid UTF-8 remains binary. */}
  } else if(mime==='image/png')valid=bytes.length>=24&&starts([137,80,78,71,13,10,26,10])&&bytes.toString('ascii',12,16)==='IHDR'
  else if(mime==='image/jpeg')valid=bytes.length>=4&&starts([255,216,255])
  else if(mime==='image/gif')valid=bytes.length>=10&&/^GIF8[79]a$/.test(bytes.toString('ascii',0,6))
  else if(mime==='image/webp')valid=bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'
  else if(mime==='application/pdf')valid=bytes.length>=8&&/^%PDF-[12]\.[0-9]/.test(bytes.toString('ascii',0,8))
  else if(OFFICE_MIMES.has(mime))valid=bytes.length>=22&&starts([80,75,3,4])
  if(!valid)throw Error('invalid_attachment')
  return bytes
}
function inferredMime(name:string,mime:unknown):string {
  if(typeof mime!=='string')throw Error('invalid_attachment')
  const inferred=EXTENSION_MIMES[extname(name).slice(1).toLowerCase()]
  if(mime===''||mime==='application/octet-stream')return inferred??''
  if(TEXT_MIMES.has(mime))return mime
  if(inferred==='text/plain'&&(/^(?:text\/|application\/(?:javascript|x-javascript|xml|sql|yaml|x-yaml)$)/.test(mime)))return 'text/plain'
  if(inferred==='text/markdown'&&mime==='text/x-markdown')return inferred
  if(inferred==='text/csv'&&mime==='application/vnd.ms-excel')return inferred
  return mime
}

/** Every created directory stays a real directory under its parent — a link at any level fails closed (anchored-fs.ts). */
function withDirectory<T>(root:string,parts:string[],action:(dir:string)=>T):T {
  if(!isAbsolute(root))throw Error('invalid_attachment_path')
  parts.forEach(part=>fileName(part))
  return action(mkdirAnchored(root,parts,'invalid_attachment_path'))
}
function readFileDescriptor(fd:number):Buffer {
  const before=fstatSync(fd)
  if(!before.isFile()||before.size>MAX_ATTACHMENT_BYTES)throw Error('invalid_attachment_path')
  const bytes=Buffer.allocUnsafe(MAX_ATTACHMENT_BYTES+1)
  let length=0
  while(length<bytes.length){const n=readSync(fd,bytes,length,bytes.length-length,null);if(!n)break;length+=n}
  const after=fstatSync(fd)
  if(length>MAX_ATTACHMENT_BYTES||length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('attachment_changed')
  return bytes.subarray(0,length)
}
function writeImmutable(dir:string,name:string,bytes:Buffer,sha256:string):void {
  const leaf=fileName(name)
  let created:number|undefined
  try{created=openAnchored(dir,[leaf],constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600,'invalid_attachment_path')}catch{/* exists (or a link): compare below */}
  if(created!==undefined){try{writeFileSync(created,bytes)}finally{closeSync(created)};return}
  const existing=openAnchored(dir,[leaf],constants.O_RDONLY|O_NONBLOCK,0,'invalid_attachment_path')
  try{if(hash(readFileDescriptor(existing))!==sha256)throw Error('attachment_changed')}finally{closeSync(existing)}
}
function snapshot(row:StoredAttachment,stateDir:string):Buffer {
  const root=resolve(stateDir,'workbench-attachments')
  if(row.storagePath!==join(root,row.sha256))throw Error('invalid_attachment_path')
  let bytes:Buffer
  try{bytes=readAnchoredRegular(root,row.sha256)}catch(error){
    if(error instanceof Error&&error.message==='artifact_changed')throw Error('attachment_changed')
    throw Error('invalid_attachment_path')
  }
  if(hash(bytes)!==row.sha256||bytes.length!==row.size)throw Error('attachment_changed')
  return bytes
}
/** Called with the SQLite write transaction held, so another process cannot claim a collected blob. */
function collectUnusedBlobs(db:Db,root:string,dir:string):void {
  const referenced=new Set(db.query<{storagePath:string},[]>('SELECT DISTINCT storage_path AS storagePath FROM workbench_attachments').all().map(row=>row.storagePath))
  for(const entry of readdirSync(root)){
    if(!/^[a-f0-9]{64}$/.test(entry)||referenced.has(join(root,entry)))continue
    // 只删真文件;unlink 本身也从不跟链接走。
    if(!lstatNoLink(join(dir,entry),'invalid_attachment_path').isFile())throw Error('invalid_attachment_path')
    try{unlinkSync(join(dir,entry))}catch{throw Error('invalid_attachment_path')}
  }
}
/** Count any remaining orphan/unknown files too; failed cleanup cannot bypass disk limits. */
function checkDiskQuota(root:string,sha256:string,additionalBytes:number):void {
  const entries=readdirSync(root,{withFileTypes:true})
  if(entries.length>=4096&&!entries.some(entry=>entry.name===sha256))throw Error('attachment_storage_limit')
  let total=0,alreadyExists=false
  for(const entry of entries){
    const stat=lstatSync(join(root,entry.name))
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('invalid_attachment_path')
    total+=stat.size;alreadyExists ||= entry.name===sha256
  }
  if(total+(alreadyExists?0:additionalBytes)>MAX_STORAGE_BYTES)throw Error('attachment_storage_limit')
}

export function makeTaskAttachmentStore(db:Db) {
  const get=(id:string)=>db.query<StoredAttachment,[string]>(SELECT+' WHERE id=?').get(id)
  const requireTask=(id:string)=>{taskIdentity(id);if(!db.query('SELECT 1 FROM workbench_tasks WHERE id=?').get(id))throw Error('not_found')}
  const getTaskRow=(taskId:string,id:string):StoredAttachment=>{
    taskIdentity(taskId);const row=get(uuid(id));if(!row||row.taskId!==taskId)throw Error('not_found');return row
  }
  const selected=(ids:unknown,taskId?:string,draftId?:string):StoredAttachment[]=>{
    if(taskId!==undefined)requireTask(taskId)
    const draft=draftId===undefined?undefined:uuid(draftId)
    const rows=attachmentIds(ids).map(id=>{
      const row=get(id);if(!row)throw Error('not_found')
      if(row.taskId===null&&row.createdAt<Date.now()-STAGED_RETENTION_MS)throw Error('not_found')
      if(row.taskId!==null?row.taskId!==taskId:!draft||row.draftId!==draft||(row.uploadTaskId!==null&&row.uploadTaskId!==taskId))throw Error('attachment_scope')
      return row
    })
    if(rows.reduce((sum,row)=>sum+row.size,0)>MAX_ATTACHMENT_BATCH_BYTES)throw Error('invalid_attachment_size')
    return rows
  }
  return {
    upload(input:AttachmentUpload,stateDir:string):Attachment {
      if(!input||typeof input!=='object')throw Error('invalid_attachment')
      const id=uuid(input.id),draftId=uuid(input.draftId),taskId=input.taskId===undefined?null:taskIdentity(input.taskId),name=fileName(input.name)
      const mime=inferredMime(name,input.mime),bytes=decodeUpload(mime,input.base64),sha256=hash(bytes),storageRoot=resolve(stateDir,'workbench-attachments'),storagePath=join(storageRoot,sha256)
      return db.transaction(()=>{
        // Expired unsent uploads can be explicitly selected and uploaded afresh.
        db.query('DELETE FROM workbench_attachments WHERE task_id IS NULL AND created_at<?').run(Date.now()-STAGED_RETENTION_MS)
        const prior=get(id)
        if(prior){
          if(prior.draftId!==draftId||prior.uploadTaskId!==taskId||prior.name!==name||prior.mime!==mime||prior.sha256!==sha256)throw Error('attachment_conflict')
          snapshot(prior,stateDir);return publicAttachment(prior)
        }
        if(taskId)requireTask(taskId)
        // Only unclaimed metadata expires. Collection below retains every blob
        // referenced by any remaining draft, submitted task, or handoff copy.
        const draft=db.query<{count:number;bytes:number},[string]>('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM workbench_attachments WHERE draft_id=? AND task_id IS NULL').get(draftId)!
        if(draft.count>=MAX_ATTACHMENTS)throw Error('attachment_limit')
        if(draft.bytes+bytes.length>MAX_ATTACHMENT_BATCH_BYTES)throw Error('invalid_attachment_size')
        const staged=db.query<{count:number;bytes:number},[]>('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM workbench_attachments WHERE task_id IS NULL').get()!
        if(staged.count>=512||staged.bytes+bytes.length>MAX_STORAGE_BYTES)throw Error('attachment_storage_limit')
        withDirectory(resolve(stateDir),['workbench-attachments'],fd=>{collectUnusedBlobs(db,storageRoot,fd);checkDiskQuota(storageRoot,sha256,bytes.length);writeImmutable(fd,sha256,bytes,sha256)})
        db.query('INSERT INTO workbench_attachments(id,draft_id,task_id,upload_task_id,name,mime,size,sha256,storage_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,draftId,null,taskId,name,mime,bytes.length,sha256,storagePath,Date.now())
        return publicAttachment(get(id)!)
      })()
    },
    select:(ids:unknown,taskId?:string,draftId?:string):Attachment[]=>selected(ids,taskId,draftId).map(publicAttachment),
    bind(ids:string[],taskId:string,draftId?:string):Attachment[] {
      return db.transaction(()=>{
        requireTask(taskId);const rows=selected(ids,taskId,draftId)
        for(const row of rows)if(row.taskId===null)db.query('UPDATE workbench_attachments SET task_id=? WHERE id=? AND task_id IS NULL').run(taskId,row.id)
        return rows.map(publicAttachment)
      })()
    },
    getTask:(taskId:string,id:string):Attachment=>publicAttachment(getTaskRow(taskId,id)),
    list(taskId:string):Attachment[]{requireTask(taskId);return db.query<StoredAttachment,[string]>(SELECT+' WHERE task_id=? ORDER BY created_at,rowid').all(taskId).map(publicAttachment)},
    read(taskId:string,id:string,stateDir:string):{attachment:Attachment;base64:string}{const row=getTaskRow(taskId,id);return{attachment:publicAttachment(row),base64:snapshot(row,stateDir).toString('base64')}},
    prepare(taskId:string,refs:Attachment[],project:string,stateDir:string):AgentAttachment[] {
      const rows=selected(refs.map(ref=>ref.id),taskId)
      return rows.map((row,index)=>{
        const ref=refs[index]!
        if(row.name!==ref.name||row.mime!==ref.mime||row.size!==ref.size||row.sha256!==ref.sha256)throw Error('attachment_changed')
        const bytes=snapshot(row,stateDir),parts=['.cc-workbench-inputs',taskId,row.id],path=join(project,...parts,row.name)
        withDirectory(project,parts,fd=>writeImmutable(fd,row.name,bytes,row.sha256))
        return{name:row.name,mime:row.mime,path,sha256:row.sha256,...(IMAGE_MIMES.has(row.mime)||row.mime==='application/pdf'?{data:bytes.toString('base64')}:{})}
      })
    },
    copyToTask(sourceTaskId:string,ids:string[],targetTaskId:string):Attachment[] {
      return db.transaction(()=>{
        requireTask(sourceTaskId);requireTask(targetTaskId)
        // Task-scoped lookup intentionally returns not_found for foreign references.
        const rows=attachmentIds(ids).map(id=>getTaskRow(sourceTaskId,id))
        if(rows.reduce((sum,row)=>sum+row.size,0)>MAX_ATTACHMENT_BATCH_BYTES)throw Error('invalid_attachment_size')
        return rows.map(row=>{
          const id=randomUUID()
          db.query('INSERT INTO workbench_attachments(id,draft_id,task_id,upload_task_id,name,mime,size,sha256,storage_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,randomUUID(),targetTaskId,targetTaskId,row.name,row.mime,row.size,row.sha256,row.storagePath,Date.now())
          return{...publicAttachment(row),id}
        })
      })()
    },
    discard(id:string,draftId:string):void {
      const normalized=uuid(id),draft=uuid(draftId)
      db.transaction(()=>{
        const row=get(normalized);if(!row)return
        if(row.taskId!==null||row.draftId!==draft)throw Error('attachment_scope')
        const root=dirname(row.storagePath)
        if(basename(root)!=='workbench-attachments'||basename(row.storagePath)!==row.sha256)throw Error('invalid_attachment_path')
        db.query('DELETE FROM workbench_attachments WHERE id=? AND task_id IS NULL').run(normalized)
        withDirectory(dirname(root),[basename(root)],fd=>collectUnusedBlobs(db,root,fd))
      })()
    },
  }
}
