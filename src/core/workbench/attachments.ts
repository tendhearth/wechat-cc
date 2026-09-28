import {createHash,randomUUID} from 'node:crypto'
import {closeSync,constants,fstatSync,lstatSync,readdirSync,readSync,unlinkSync,writeFileSync} from 'node:fs'
import {basename,dirname,extname,isAbsolute,join,resolve} from 'node:path'
import type {Db} from '../../lib/db'
import type {AgentAttachment} from '../agent-provider'
import {ATTACHMENT_METADATA_BYTES,UPLOAD_METADATA_BYTES,UPLOAD_TOMBSTONE_BYTES,type AttachmentBudgetInput} from './attachment-budget'
import {O_NONBLOCK,readBounded,lstatNoLink,mkdirAnchored,openAnchored} from './anchored-fs'

export interface Attachment {id:string;name:string;mime:string;size:number;sha256:string}
export interface AttachmentUpload {id:string;draftId:string;taskId?:string;name:string;mime:string;base64:string}
export interface AttachmentScope {ownerKey:string;allowLegacyUnbound?:boolean}
interface StoredAttachment extends Attachment {draftId:string;taskId:string|null;uploadTaskId:string|null;storagePath:string;createdAt:number;ownerKey:string|null}
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
const SELECT='SELECT id,draft_id AS draftId,task_id AS taskId,upload_task_id AS uploadTaskId,name,mime,size,sha256,storage_path AS storagePath,created_at AS createdAt,owner_key AS ownerKey FROM workbench_attachments'
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
function writeImmutable(dir:string,name:string,bytes:Buffer,sha256:string,verifyExisting?:()=>void):void {
  const leaf=fileName(name)
  let created:number|undefined
  try{created=openAnchored(dir,[leaf],constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600,'invalid_attachment_path')}catch{/* exists (or a link): compare below */}
  if(created!==undefined){try{writeFileSync(created,bytes)}finally{closeSync(created)};return}
  if(verifyExisting){verifyExisting();return}
  const existing=openAnchored(dir,[leaf],constants.O_RDONLY|O_NONBLOCK,0,'invalid_attachment_path')
  try{if(hash(readFileDescriptor(existing))!==sha256)throw Error('attachment_changed')}finally{closeSync(existing)}
}
function snapshot(row:Pick<StoredAttachment,'sha256'|'storagePath'|'size'>,stateDir:string,onVerified?:(check:()=>void)=>void):Buffer {
  const root=resolve(stateDir,'workbench-attachments')
  if(row.storagePath!==join(root,row.sha256))throw Error('invalid_attachment_path')
  let bytes:Buffer,check:()=>void
  try{
    const fd=openAnchored(root,[row.sha256],constants.O_RDONLY|O_NONBLOCK,0,'invalid_artifact_path')
    try{
      const {bytes:read,before}=readBounded(fd,MAX_ATTACHMENT_BYTES,'invalid_artifact_size','artifact_changed');bytes=read
      // Captured from the descriptor used for the verified bytes, not a later path lookup.
      check=()=>{
        const currentFd=openAnchored(root,[row.sha256],constants.O_RDONLY|O_NONBLOCK,0,'invalid_attachment_path')
        try{
          const current=fstatSync(currentFd,{bigint:true})
          if(!current.isFile()||current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||current.mtimeNs!==before.mtimeNs||current.ctimeNs!==before.ctimeNs)throw Error('attachment_changed')
        }finally{closeSync(currentFd)}
      }
    }finally{closeSync(fd)}
  }catch(error){
    if(error instanceof Error&&error.message==='artifact_changed')throw Error('attachment_changed')
    throw Error('invalid_attachment_path')
  }
  if(hash(bytes)!==row.sha256||bytes.length!==row.size)throw Error('attachment_changed')
  onVerified?.(check)
  return bytes
}
/** Called with the SQLite write transaction held, so another process cannot claim a collected blob. */
function collectUnusedBlobs(db:Db,root:string,dir:string):Map<string,number> {
  const files=directoryFiles(dir),names=[...files.keys()].filter(name=>/^[a-f0-9]{64}$/.test(name))
  if(!names.length)return files
  // Return only references to the bounded disk inventory, not all historical
  // attachment rows. The shared write lock protects these references to unlink.
  const referenced=new Set(db.query<{storagePath:string},[string]>(`SELECT DISTINCT storage_path AS storagePath FROM workbench_attachments
    WHERE storage_path IN (SELECT value FROM json_each(?))`).all(JSON.stringify(names.map(name=>join(root,name)))).map(row=>row.storagePath))
  for(const row of db.query<{sha256:string},[string]>(`SELECT DISTINCT sha256 FROM workbench_attachment_uploads
    WHERE status IN ('uploading','finalizing') AND sha256 IN (SELECT value FROM json_each(?))`).all(JSON.stringify(names)))referenced.add(join(root,row.sha256))
  for(const name of names){
    if(referenced.has(join(root,name)))continue
    // directoryFiles already checked every entry; unlink never follows links.
    try{unlinkSync(join(dir,name))}catch{throw Error('invalid_attachment_path')}
    files.delete(name)
  }
  return files
}
/** Include unknown/orphan files. A corrupt path fails closed rather than disappearing from the budget. */
function directoryFiles(dir:string):Map<string,number> {
  const entries=readdirSync(dir)
  if(entries.length>4096)throw Error('attachment_storage_limit')
  const files=new Map<string,number>()
  for(const name of entries){const stat=lstatNoLink(join(dir,name),'invalid_attachment_path');if(!stat.isFile())throw Error('invalid_attachment_path');files.set(name,Number(stat.size))}
  return files
}
const diskFiles=(stateDir:string,leaf:string)=>withDirectory(resolve(stateDir),[leaf],directoryFiles)

export function makeTaskAttachmentStore(db:Db) {
  const get=(id:string)=>db.query<StoredAttachment,[string]>(SELECT+' WHERE id=?').get(id)
  const requireTask=(id:string,scope?:AttachmentScope)=>{
    taskIdentity(id);const task=db.query<{ownerKey:string|null},[string]>('SELECT owner_chat_id AS ownerKey FROM workbench_tasks WHERE id=?').get(id)
    if(!task)throw Error('not_found')
    if(scope&&(!scope.ownerKey||task.ownerKey!==scope.ownerKey))throw Error('attachment_scope')
    return task
  }
  const requireOwner=(row:StoredAttachment,taskId?:string,scope?:AttachmentScope)=>{
    const owner=taskId?requireTask(taskId,scope).ownerKey:scope?.ownerKey
    if(scope&&!scope.ownerKey)throw Error('attachment_scope')
    if(scope&&row.taskId!==null)requireTask(row.taskId,scope)
    if(row.ownerKey!==null){if(row.ownerKey!==owner)throw Error('attachment_scope')}
    else if(row.taskId===null&&scope&&!scope.allowLegacyUnbound)throw Error('attachment_scope')
  }
  const activeReservation=(id:string)=>!!db.query<{present:number},[number,string]>(`SELECT 1 AS present FROM workbench_entry_requests e, json_each(e.frozen_json,'$.materialSnapshot') material
    WHERE e.phase='reserved' AND e.created_at>=? AND json_extract(material.value,'$.id')=? LIMIT 1`).get(Date.now()-STAGED_RETENTION_MS,id)
  const inUse=(id:string)=>activeReservation(id)||!!db.query<{present:number},[string]>(`SELECT 1 AS present FROM workbench_live_inputs i, json_each(i.attachments_json) material WHERE json_extract(material.value,'$.id')=? LIMIT 1`).get(id)
  const requireConsumable=(id:string)=>{
    const state=db.query<{status:string},[string]>('SELECT status FROM workbench_attachment_uploads WHERE id=?').get(id)
    if(state?.status==='discarded'||state?.status==='expired')throw Error('upload_'+state.status)
  }
  const assertDiscardable=(id:string,draftId:string,scope?:AttachmentScope)=>{
    const normalized=uuid(id),draft=uuid(draftId),row=get(normalized)
    const partial=db.query<{ownerKey:string;draftId:string},[string]>('SELECT owner_key AS ownerKey,draft_id AS draftId FROM workbench_attachment_uploads WHERE id=?').get(normalized)
    if(partial&&(partial.draftId!==draft||partial.ownerKey!==scope?.ownerKey))throw Error('attachment_scope')
    if(row){requireOwner(row,undefined,scope);if(row.draftId!==draft)throw Error('attachment_scope');if(row.taskId!==null)throw Error('attachment_in_use')}
    if(inUse(normalized))throw Error('attachment_in_use')
  }
  /** Caller holds the shared SQLite write lock; reservations cover future bytes as well as every existing file. */
  const checkQuota=(input:AttachmentBudgetInput,stateDir:string,scope?:AttachmentScope,collectedBlobs?:ReadonlyMap<string,number>)=>{
    const id=uuid(input.id),draftId=uuid(input.draftId)
    if(scope&&!scope.ownerKey)throw Error('attachment_scope')
    if(input.taskId)requireTask(input.taskId,scope)
    if(!Number.isSafeInteger(input.size)||input.size<=0||input.size>MAX_ATTACHMENT_BYTES||!/^[a-f0-9]{64}$/.test(input.sha256)||!['staged','resumable','tombstone'].includes(input.kind))throw Error('invalid_attachment')
    if(input.kind!=='tombstone'){
      const draft=db.query<{count:number;bytes:number},[string,string,string]>(`SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM (
        SELECT id,MAX(size) AS size FROM (
          SELECT id,size FROM workbench_attachments WHERE task_id IS NULL AND draft_id=?
          UNION ALL SELECT u.id,u.size FROM workbench_attachment_uploads u LEFT JOIN workbench_attachments a ON a.id=u.id
            WHERE u.draft_id=? AND u.status NOT IN ('discarded','expired') AND a.task_id IS NULL
        ) WHERE id<>? GROUP BY id
      )`).get(draftId,draftId,id)!
      if(draft.count+1>MAX_ATTACHMENTS)throw Error('attachment_limit')
      if(draft.bytes+input.size>MAX_ATTACHMENT_BATCH_BYTES)throw Error('invalid_attachment_size')
    }
    const metadata=db.query<{bytes:number},[number,number,number]>(`SELECT
      (SELECT COUNT(*) FROM workbench_attachments a WHERE NOT EXISTS (SELECT 1 FROM workbench_attachment_uploads u WHERE u.id=a.id))*? +
      (SELECT COALESCE(SUM(CASE WHEN status IN ('discarded','expired') THEN ? ELSE ? END),0) FROM workbench_attachment_uploads) AS bytes
    `).get(ATTACHMENT_METADATA_BYTES,UPLOAD_TOMBSTONE_BYTES,UPLOAD_METADATA_BYTES)!
    // This inventory is reused only by the collecting upload in the same
    // synchronous write transaction. Every new request recounts real bytes.
    const blobs=collectedBlobs??diskFiles(stateDir,'workbench-attachments'),parts=diskFiles(stateDir,'workbench-attachment-uploads')
    let total=metadata.bytes
    for(const size of blobs.values())total+=size
    for(const size of parts.values())total+=size
    const uploads=db.query<{id:string;size:number;sha256:string},[]>("SELECT id,size,sha256 FROM workbench_attachment_uploads WHERE status IN ('uploading','finalizing')").all()
    for(const row of uploads){
      total+=Math.max(0,row.size-(parts.get(row.id+'.part')??0))+Math.max(0,row.size-(blobs.get(row.sha256)??0))
    }
    const existing=db.query<{present:number},[string,string]>(`SELECT 1 AS present FROM workbench_attachments WHERE id=?
      UNION ALL SELECT 1 AS present FROM workbench_attachment_uploads WHERE id=? LIMIT 1`).get(id,id)
    if(!existing){
      if(input.kind==='tombstone')total+=UPLOAD_TOMBSTONE_BYTES
      else if(input.kind==='resumable')total+=UPLOAD_METADATA_BYTES+input.size+Math.max(0,input.size-(blobs.get(input.sha256)??0))
      else total+=ATTACHMENT_METADATA_BYTES+Math.max(0,input.size-(blobs.get(input.sha256)??0))
    }
    if(total>MAX_STORAGE_BYTES)throw Error('attachment_storage_limit')
  }
  const getTaskRow=(taskId:string,id:string):StoredAttachment=>{
    taskIdentity(taskId);const row=get(uuid(id));if(!row||row.taskId!==taskId)throw Error('not_found');requireOwner(row,taskId);return row
  }
  const selected=(ids:unknown,taskId?:string,draftId?:string,scope?:AttachmentScope):StoredAttachment[]=>{
    if(taskId!==undefined)requireTask(taskId,scope)
    const draft=draftId===undefined?undefined:uuid(draftId)
    const rows=attachmentIds(ids).map(id=>{
      requireConsumable(id);const row=get(id);if(!row)throw Error('not_found')
      if(row.taskId===null&&row.createdAt<Date.now()-STAGED_RETENTION_MS&&!activeReservation(row.id))throw Error('not_found')
      if(row.taskId!==null?row.taskId!==taskId:!draft||row.draftId!==draft||(row.uploadTaskId!==null&&row.uploadTaskId!==taskId))throw Error('attachment_scope')
      requireOwner(row,taskId,scope)
      return row
    })
    if(rows.reduce((sum,row)=>sum+row.size,0)>MAX_ATTACHMENT_BATCH_BYTES)throw Error('invalid_attachment_size')
    return rows
  }
  return {
    checkUploadQuota:(input:AttachmentBudgetInput,stateDir:string,scope?:AttachmentScope)=>checkQuota(input,stateDir,scope),assertDiscardable,
    upload(input:AttachmentUpload,stateDir:string,scope?:AttachmentScope):Attachment {
      if(!input||typeof input!=='object'||['ownerKey','ownerChatId','accountId','surface'].some(key=>Object.hasOwn(input,key)))throw Error('invalid_attachment')
      if(scope&&!scope.ownerKey)throw Error('attachment_scope')
      const id=uuid(input.id),draftId=uuid(input.draftId),taskId=input.taskId===undefined?null:taskIdentity(input.taskId),name=fileName(input.name)
      const mime=inferredMime(name,input.mime),bytes=decodeUpload(mime,input.base64),sha256=hash(bytes),storageRoot=resolve(stateDir,'workbench-attachments'),storagePath=join(storageRoot,sha256)
      const checkRequest=()=>{
        // Check ownership before collection; an expired foreign ID cannot be reclaimed.
        requireConsumable(id)
        const reservation=db.query<{ownerKey:string;draftId:string;taskId:string|null;name:string;mime:string;size:number;sha256:string;status:string},[string]>('SELECT owner_key AS ownerKey,draft_id AS draftId,task_id AS taskId,name,mime,size,sha256,status FROM workbench_attachment_uploads WHERE id=?').get(id)
        if(reservation){
          if(reservation.ownerKey!==scope?.ownerKey)throw Error('attachment_scope')
          if(reservation.draftId!==draftId||reservation.taskId!==taskId||reservation.name!==name||reservation.mime!==mime||reservation.size!==bytes.length||reservation.sha256!==sha256||!['finalizing','ready'].includes(reservation.status))throw Error('attachment_conflict')
        }
        const existing=get(id)
        if(existing)requireOwner(existing,taskId??undefined,scope)
        else if(reservation?.status==='ready')throw Error('attachment_changed')
        return existing
      }
      const checkPrior=(prior:StoredAttachment)=>{
        if(prior.draftId!==draftId||prior.uploadTaskId!==taskId||prior.name!==name||prior.mime!==mime||prior.sha256!==sha256)throw Error('attachment_conflict')
        if(prior.size!==bytes.length)throw Error('attachment_changed')
        if(prior.storagePath!==storagePath)throw Error('invalid_attachment_path')
      }
      const existing=checkRequest()
      if(existing&&(existing.taskId!==null||existing.createdAt>=Date.now()-STAGED_RETENTION_MS||inUse(existing.id)))checkPrior(existing)
      if(taskId)requireTask(taskId,scope)
      // Both a deduplicated blob and an exact replay need a complete digest,
      // but never while holding SQLite's writer lock. Keep the descriptor's
      // identity/timestamps for the cheap check at the actual write boundary.
      let verified:(()=>void)|undefined
      let present:boolean
      try{present=!!lstatSync(storagePath,{throwIfNoEntry:false})}catch{throw Error('invalid_attachment_path')}
      if(present)snapshot({sha256,storagePath,size:bytes.length},stateDir,check=>{verified=check})
      const verifyExisting=()=>{
        // A concurrent upload may have created this blob after preflight.
        // Fail recoverably rather than falling back to a full read under lock;
        // retrying the same ID verifies the newly appeared file outside it.
        if(!verified)throw Error('attachment_changed')
        verified()
      }
      return db.transaction(()=>{
        checkRequest()
        // Expired unsent uploads can be explicitly selected and uploaded afresh.
        for(const expired of db.query<{id:string},[number]>('SELECT id FROM workbench_attachments WHERE task_id IS NULL AND created_at<?').all(Date.now()-STAGED_RETENTION_MS))if(!inUse(expired.id))db.query('DELETE FROM workbench_attachments WHERE id=? AND task_id IS NULL').run(expired.id)
        const prior=get(id)
        if(prior){
          checkPrior(prior);verifyExisting();return publicAttachment(prior)
        }
        if(taskId)requireTask(taskId,scope)
        // Only unclaimed metadata expires. Collection below retains every blob
        // referenced by any remaining draft, submitted task, or handoff copy.
        const staged=db.query<{count:number},[]>('SELECT COUNT(*) AS count FROM workbench_attachments WHERE task_id IS NULL').get()!
        if(staged.count>=512)throw Error('attachment_storage_limit')
        withDirectory(resolve(stateDir),['workbench-attachments'],fd=>{
          const blobs=collectUnusedBlobs(db,storageRoot,fd)
          checkQuota({id,draftId,...(taskId?{taskId}:{}),size:bytes.length,sha256,kind:'staged'},stateDir,scope,blobs)
          writeImmutable(fd,sha256,bytes,sha256,verifyExisting)
        })
        db.query('INSERT INTO workbench_attachments(id,draft_id,task_id,upload_task_id,name,mime,size,sha256,storage_path,created_at,owner_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,draftId,null,taskId,name,mime,bytes.length,sha256,storagePath,Date.now(),scope?.ownerKey??null)
        return publicAttachment(get(id)!)
      }).immediate()
    },
    select:(ids:unknown,taskId?:string,draftId?:string,scope?:AttachmentScope):Attachment[]=>selected(ids,taskId,draftId,scope).map(publicAttachment),
    verify(ids:unknown,taskId:string|undefined,draftId:string|undefined,stateDir:string,scope?:AttachmentScope):Attachment[]{
      return selected(ids,taskId,draftId,scope).map(row=>{snapshot(row,stateDir);return publicAttachment(row)})
    },
    /** Full bytes are checked before the acceptance lock; metadata and file identity are rechecked under it. */
    prepareAcceptance(ids:unknown,taskId:string|undefined,draftId:string|undefined,stateDir:string,scope?:AttachmentScope){
      const rows=selected(ids,taskId,draftId,scope),checks:(()=>void)[]=[]
      for(const row of rows)snapshot(row,stateDir,check=>checks.push(check))
      const attachments=rows.map(publicAttachment)
      return{attachments,assertCurrent:()=>{
        const current=selected(ids,taskId,draftId,scope)
        if(JSON.stringify(current.map(publicAttachment))!==JSON.stringify(attachments)||current.some((row,index)=>row.storagePath!==rows[index]?.storagePath))throw Error('attachment_changed')
        checks.forEach(check=>check())
      }}
    },
    bind(ids:string[],taskId:string,draftId?:string,scope?:AttachmentScope):Attachment[] {
      return db.transaction(()=>{
        requireTask(taskId,scope);const rows=selected(ids,taskId,draftId,scope)
        for(const row of rows)if(row.taskId===null)db.query('UPDATE workbench_attachments SET task_id=? WHERE id=? AND task_id IS NULL').run(taskId,row.id)
        return rows.map(publicAttachment)
      }).immediate()
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
    copyToTask(sourceTaskId:string,ids:string[],targetTaskId:string,scope?:AttachmentScope):Attachment[] {
      return db.transaction(()=>{
        const source=requireTask(sourceTaskId,scope),target=requireTask(targetTaskId,scope)
        if(source.ownerKey!==target.ownerKey)throw Error('attachment_scope')
        // Task-scoped lookup intentionally returns not_found for foreign references.
        const rows=attachmentIds(ids).map(id=>getTaskRow(sourceTaskId,id))
        if(rows.reduce((sum,row)=>sum+row.size,0)>MAX_ATTACHMENT_BATCH_BYTES)throw Error('invalid_attachment_size')
        return rows.map(row=>{
          const id=randomUUID(),draftId=randomUUID(),root=dirname(row.storagePath)
          if(basename(root)!=='workbench-attachments'||basename(row.storagePath)!==row.sha256)throw Error('invalid_attachment_path')
          checkQuota({id,draftId,taskId:targetTaskId,size:row.size,sha256:row.sha256,kind:'staged'},dirname(root),scope)
          db.query('INSERT INTO workbench_attachments(id,draft_id,task_id,upload_task_id,name,mime,size,sha256,storage_path,created_at,owner_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,draftId,targetTaskId,targetTaskId,row.name,row.mime,row.size,row.sha256,row.storagePath,Date.now(),row.ownerKey)
          return{...publicAttachment(row),id}
        })
      }).immediate()
    },
    discard(id:string,draftId:string,scope?:AttachmentScope):void {
      const normalized=uuid(id),draft=uuid(draftId)
      db.transaction(()=>{
        assertDiscardable(normalized,draft,scope)
        const row=get(normalized);if(!row)return
        const root=dirname(row.storagePath)
        if(basename(root)!=='workbench-attachments'||basename(row.storagePath)!==row.sha256)throw Error('invalid_attachment_path')
        db.query('DELETE FROM workbench_attachments WHERE id=? AND task_id IS NULL').run(normalized)
        withDirectory(dirname(root),[basename(root)],fd=>collectUnusedBlobs(db,root,fd))
      }).immediate()
    },
  }
}
