import {createHash} from 'node:crypto'
import {closeSync,constants,existsSync,fsyncSync,fstatSync,ftruncateSync,readSync,unlinkSync,writeSync} from 'node:fs'
import {join,resolve} from 'node:path'
import type {Db} from '../../lib/db'
import {MAX_ATTACHMENT_BYTES,MAX_IMAGE_ATTACHMENT_BYTES,type Attachment,type makeTaskAttachmentStore} from './attachments'
import {mkdirAnchored,openAnchored,O_NONBLOCK,verifyOpened} from './anchored-fs'
import type {EntryContext} from './task-entry'

export interface UploadChunk {
  id:string;draftId:string;taskId?:string;name:string;mime:string;size:number;sha256:string;offset:number;contentBase64:string
}
export interface UploadState {
  id:string;draftId:string;taskId:string|null;size:number;sha256:string;nextOffset:number;status:'uploading'|'ready';attachment?:Attachment
}
interface Identity {id:string;draftId:string}
type UploadStatus='uploading'|'finalizing'|'ready'|'discarded'|'expired'
interface Block {offset:number;size:number;sha256:string}
interface Row extends Omit<UploadChunk,'offset'|'contentBase64'|'taskId'> {
  taskId:string|null;ownerKey:string;status:UploadStatus;nextOffset:number;chunksJson:string;partIdentity:string|null;reservedBytes:number;createdAt:number;updatedAt:number;expiresAt:number
}
type AttachmentStore=Pick<ReturnType<typeof makeTaskAttachmentStore>,'upload'|'verify'|'discard'|'checkUploadQuota'|'assertDiscardable'>
interface Options {
  db:Db;stateDir:string;attachments:AttachmentStore;ownerChatId:()=>string|null;now?:()=>number
  /** Emitted after the write lock has been released; diagnostic failures never affect acceptance. */
  onTransaction?:(event:{operation:string;durationMs:number})=>void
}
const BLOCK_BYTES=128*1024,METADATA_BYTES=16*1024,TOMBSTONE_BYTES=1024,RETENTION_MS=7*24*60*60*1000
const PARTS='workbench-attachment-uploads',CHANGED='upload_changed',PATH_ERROR='invalid_attachment_path'
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const HASH=/^[a-f0-9]{64}$/
const MIMES=new Set(['text/plain','text/markdown','text/csv','application/json','image/png','image/jpeg','image/gif','image/webp','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation'])
const SELECT=`SELECT id,owner_key AS ownerKey,draft_id AS draftId,task_id AS taskId,name,mime,size,sha256,status,
  next_offset AS nextOffset,chunks_json AS chunksJson,part_identity AS partIdentity,reserved_bytes AS reservedBytes,
  created_at AS createdAt,updated_at AS updatedAt,expires_at AS expiresAt FROM workbench_attachment_uploads`
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const code=(error:unknown)=>error instanceof Error?error.message:String(error)
function strictObject(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).some(key=>typeof key!=='string'||!keys.includes(key)))throw Error('invalid_upload_chunk')
  return value as Record<string,unknown>
}
function uuid(value:unknown):string {if(typeof value!=='string'||!UUID.test(value))throw Error('invalid_upload_chunk');return value.toLowerCase()}
function identity(value:unknown):Identity {const v=strictObject(value,['id','draftId']);return{id:uuid(v.id),draftId:uuid(v.draftId)}}
function parse(value:unknown):{input:UploadChunk;bytes:Buffer} {
  const v=strictObject(value,['id','draftId','taskId','name','mime','size','sha256','offset','contentBase64'])
  const id=uuid(v.id),draftId=uuid(v.draftId)
  if(v.taskId!==undefined&&(typeof v.taskId!=='string'||! /^[a-f0-9]{8}$/.test(v.taskId)))throw Error('invalid_upload_chunk')
  if(typeof v.name!=='string'||!v.name.trim()||Buffer.byteLength(v.name)>240||v.name==='.'||v.name==='..'||/[\\/\u0000-\u001f\u007f]/.test(v.name)||/[. ]$/.test(v.name))throw Error('invalid_attachment')
  if(typeof v.mime!=='string'||!MIMES.has(v.mime))throw Error('invalid_attachment')
  if(typeof v.size!=='number'||!Number.isSafeInteger(v.size)||v.size<=0||v.size>(v.mime.startsWith('image/')?MAX_IMAGE_ATTACHMENT_BYTES:MAX_ATTACHMENT_BYTES))throw Error('invalid_attachment_size')
  if(typeof v.sha256!=='string'||!HASH.test(v.sha256)||typeof v.offset!=='number'||!Number.isSafeInteger(v.offset)||v.offset<0||v.offset>=v.size||v.offset%BLOCK_BYTES!==0)throw Error('invalid_upload_chunk')
  if(typeof v.contentBase64!=='string'||!v.contentBase64.length||v.contentBase64.length>4*Math.ceil(BLOCK_BYTES/3)||v.contentBase64.length%4||/[^A-Za-z0-9+/=]/.test(v.contentBase64))throw Error('invalid_upload_chunk')
  const bytes=Buffer.from(v.contentBase64,'base64')
  if(bytes.toString('base64')!==v.contentBase64||bytes.length!==Math.min(BLOCK_BYTES,v.size-v.offset))throw Error('invalid_upload_chunk')
  return{input:{id,draftId,...(v.taskId?{taskId:v.taskId as string}:{}),name:v.name,mime:v.mime,size:v.size,sha256:v.sha256,offset:v.offset,contentBase64:v.contentBase64},bytes}
}
function blocks(row:Row):Block[] {
  let value:unknown
  try{value=JSON.parse(row.chunksJson)}catch{throw Error(CHANGED)}
  if(!Array.isArray(value)||value.length>Math.ceil(MAX_ATTACHMENT_BYTES/BLOCK_BYTES))throw Error(CHANGED)
  let offset=0
  for(const b of value){if(!b||b.offset!==offset||b.size!==Math.min(BLOCK_BYTES,row.size-offset)||typeof b.sha256!=='string'||!HASH.test(b.sha256))throw Error(CHANGED);offset+=b.size}
  if(offset!==row.nextOffset)throw Error(CHANGED)
  return value as Block[]
}
const sameMetadata=(row:Row,input:UploadChunk)=>row.draftId===input.draftId&&row.taskId===(input.taskId??null)&&row.name===input.name&&row.mime===input.mime&&row.size===input.size&&row.sha256===input.sha256

/** Synchronous, bounded disk operations inside SQLite immediate transactions.
 * Reservation commits before file creation; finalization and ready have separate commits. */
export function createAttachmentUploads(options:Options) {
  const {db,attachments}=options,stateDir=resolve(options.stateDir),now=options.now??Date.now
  const get=(id:string)=>db.query<Row,[string]>(SELECT+' WHERE id=?').get(id)
  const scope=(row:Row)=>({ownerKey:row.ownerKey})
  const transaction=<T>(operation:string,fn:()=>T):T=>{
    const started=performance.now()
    try{return db.transaction(fn).immediate()}
    finally{try{options.onTransaction?.({operation,durationMs:performance.now()-started})}catch{/* diagnostics are not part of the receipt */}}
  }
  const authorize=(context:EntryContext)=>{if(!context?.ownerKey||context.ownerKey!==options.ownerChatId()||!['desktop','phone'].includes(context.surface))throw Error('attachment_scope')}
  const taskOwner=(taskId:string|null,ownerKey:string)=>{
    if(!taskId)return
    const task=db.query<{ownerKey:string|null},[string]>('SELECT owner_chat_id AS ownerKey FROM workbench_tasks WHERE id=?').get(taskId)
    if(!task||task.ownerKey!==ownerKey)throw Error('attachment_scope')
  }
  const owned=(key:Identity,context:EntryContext):Row=>{
    authorize(context);const row=get(key.id)
    if(!row)throw Error('upload_not_found')
    if(row.ownerKey!==context.ownerKey||row.draftId!==key.draftId)throw Error('attachment_scope')
    taskOwner(row.taskId,row.ownerKey);return row
  }
  const terminal=(row:Row)=>{if(row.status==='discarded'||row.status==='expired')throw Error(`upload_${row.status}`)}
  const partName=(row:Row)=>`${row.id}.part`
  const fileIdentity=(fd:number)=>{const s=fstatSync(fd,{bigint:true});if(!s.isFile()||s.nlink!==1n)throw Error(PATH_ERROR);return`${s.dev}:${s.ino}`}
  /** Any excess bytes are uncommitted. Never invent bytes for a short committed prefix. */
  function openPart(row:Row,create=false):{fd:number;bytes:Buffer;identity:string}|null {
    const path=join(stateDir,PARTS,partName(row))
    if(!existsSync(path)&&!create){if(row.nextOffset||row.partIdentity)throw Error(CHANGED);return null}
    if(!existsSync(path)&&row.partIdentity)throw Error(CHANGED)
    mkdirAnchored(stateDir,[PARTS],PATH_ERROR)
    const fd=openAnchored(stateDir,[PARTS,partName(row)],constants.O_RDWR|O_NONBLOCK|(create?constants.O_CREAT:0),0o600,PATH_ERROR)
    try{
      const id=fileIdentity(fd),stat=fstatSync(fd)
      if(row.partIdentity!==null&&id!==row.partIdentity)throw Error(CHANGED)
      if(stat.size<row.nextOffset)throw Error(CHANGED)
      if(stat.size>row.nextOffset){ftruncateSync(fd,row.nextOffset);fsyncSync(fd)}
      const bytes=Buffer.alloc(row.nextOffset);let length=0
      while(length<bytes.length){const n=readSync(fd,bytes,length,bytes.length-length,length);if(!n)throw Error(CHANGED);length+=n}
      for(const b of blocks(row))if(hash(bytes.subarray(b.offset,b.offset+b.size))!==b.sha256)throw Error(CHANGED)
      verifyOpened(fd,stateDir,[PARTS,partName(row)],PATH_ERROR)
      return{fd,bytes,identity:id}
    }catch(error){closeSync(fd);throw error}
  }
  function removePart(row:Row):void {
    const path=join(stateDir,PARTS,partName(row));if(!existsSync(path))return
    const fd=openAnchored(stateDir,[PARTS,partName(row)],constants.O_RDONLY|O_NONBLOCK,0,PATH_ERROR)
    try{if(row.partIdentity&&fileIdentity(fd)!==row.partIdentity)throw Error(CHANGED);verifyOpened(fd,stateDir,[PARTS,partName(row)],PATH_ERROR)}finally{closeSync(fd)}
    unlinkSync(path)
  }
  function cleanup(row:Row):void {
    transaction('cleanup',()=>{
      const latest=get(row.id);if(!latest)return
      if(latest.status==='discarded'||latest.status==='expired')attachments.discard(latest.id,latest.draftId,scope(latest))
      if(['ready','discarded','expired'].includes(latest.status))removePart(latest)
    })
  }
  function expireRow(id:string):boolean {
    const changed=transaction('expire',()=>{
      const row=get(id);if(!row||row.expiresAt>now()||!['uploading','finalizing','ready'].includes(row.status))return null
      try{attachments.assertDiscardable(row.id,row.draftId,scope(row))}catch(error){if(code(error)==='attachment_in_use')return null;throw error}
      db.query("UPDATE workbench_attachment_uploads SET status='expired',chunks_json='[]',reserved_bytes=?,updated_at=? WHERE id=?").run(TOMBSTONE_BYTES,now(),id)
      return get(id)!
    })
    if(changed){try{cleanup(changed)}catch{/* The tombstone stays authoritative; remnants remain charged. */}}
    return!!changed
  }
  let expiryCursor:{ownerKey:string;expiresAt:number;id:string}|null=null
  function expire():number {
    const ownerKey=options.ownerChatId();if(!ownerKey)return 0
    if(expiryCursor?.ownerKey!==ownerKey)expiryCursor=null
    const page=()=>db.query<{id:string;expiresAt:number},[string,number,number,number,string]>(`SELECT u.id,u.expires_at AS expiresAt FROM workbench_attachment_uploads u
      WHERE u.owner_key=? AND u.expires_at<=? AND u.status IN ('uploading','finalizing','ready')
      AND NOT EXISTS (SELECT 1 FROM workbench_attachments a WHERE a.id=u.id AND a.task_id IS NOT NULL)
      AND (u.expires_at>? OR (u.expires_at=? AND u.id>?)) ORDER BY u.expires_at,u.id LIMIT 64`).all(ownerKey,now(),expiryCursor?.expiresAt??-1,expiryCursor?.expiresAt??-1,expiryCursor?.id??'')
    let rows=page()
    if(!rows.length&&expiryCursor){expiryCursor=null;rows=page()}
    // Keep each sweep bounded but advance past temporarily protected reservations.
    const last=rows.at(-1);expiryCursor=rows.length===64&&last?{ownerKey,...last}:null
    let count=0;for(const row of rows)if(expireRow(row.id))count++;return count
  }

  function current(key:Identity,context:EntryContext):Row {
    const row=owned(key,context);terminal(row);return row
  }
  /** Expiry must commit before a later operation throws its terminal response. */
  function refresh(key:Identity,context:EntryContext):void {
    const row=owned(key,context)
    if(row.expiresAt<=now()&&!['discarded','expired'].includes(row.status))expireRow(row.id)
    current(key,context)
  }
  function attachment(row:Row,verify:boolean):Attachment|null {
    const a=db.query<Attachment&{ownerKey:string|null;draftId:string;taskId:string|null;uploadTaskId:string|null},[string]>(`SELECT id,name,mime,size,sha256,owner_key AS ownerKey,draft_id AS draftId,task_id AS taskId,upload_task_id AS uploadTaskId FROM workbench_attachments WHERE id=?`).get(row.id)
    if(!a)return null
    if(a.ownerKey!==row.ownerKey||a.draftId!==row.draftId||a.uploadTaskId!==row.taskId||a.name!==row.name||a.mime!==row.mime||a.size!==row.size||a.sha256!==row.sha256)throw Error('upload_conflict')
    taskOwner(a.taskId,row.ownerKey)
    if(verify)attachments.verify([row.id],a.taskId??row.taskId??undefined,row.draftId,stateDir,scope(row))
    return{id:a.id,name:a.name,mime:a.mime,size:a.size,sha256:a.sha256}
  }
  const state=(row:Row):UploadState=>{
    terminal(row)
    const ready=row.status==='ready'?attachment(row,false):null
    if(row.status==='ready'&&!ready)throw Error(CHANGED)
    return{id:row.id,draftId:row.draftId,taskId:row.taskId,size:row.size,sha256:row.sha256,nextOffset:row.nextOffset,status:row.status==='ready'?'ready':'uploading',...(ready?{attachment:ready}:{})}
  }
  function finalize(key:Identity,context:EntryContext):UploadState {
    refresh(key,context)
    transaction('finalize',()=>{
      const row=current(key,context);if(row.status==='ready')return
      if(row.status!=='finalizing'||row.nextOffset!==row.size)throw Error(CHANGED)
      if(attachment(row,true))return
      const part=openPart(row);if(!part)throw Error(CHANGED)
      try{
        if(hash(part.bytes)!==row.sha256)throw Error(CHANGED)
        const result=attachments.upload({id:row.id,draftId:row.draftId,...(row.taskId?{taskId:row.taskId}:{}),name:row.name,mime:row.mime,base64:part.bytes.toString('base64')},stateDir,scope(row))
        if(result.id!==row.id||result.name!==row.name||result.mime!==row.mime||result.size!==row.size||result.sha256!==row.sha256)throw Error('upload_conflict')
      }finally{closeSync(part.fd)}
    })
    refresh(key,context)
    const ready=transaction('ready',()=>{
      const row=current(key,context);if(row.status==='ready')return row
      if(row.status!=='finalizing'||!attachment(row,true))throw Error(CHANGED)
      db.query("UPDATE workbench_attachment_uploads SET status='ready',reserved_bytes=?,updated_at=? WHERE id=?").run(METADATA_BYTES,now(),row.id)
      return get(row.id)!
    })
    try{cleanup(ready)}catch{/* Ready no longer needs the part; a leftover still counts against disk quota. */}
    return state(ready)
  }
  return{
    chunk(value:UploadChunk,context:EntryContext):UploadState {
      authorize(context);const {input,bytes}=parse(value),key={id:input.id,draftId:input.draftId}
      if(!get(input.id)){
        expire()
        transaction('reserve',()=>{
          authorize(context);if(get(input.id))return
          taskOwner(input.taskId??null,context.ownerKey)
          if(input.offset!==0)throw Error('upload_conflict')
          if(db.query('SELECT id FROM workbench_attachments WHERE id=?').get(input.id))throw Error('upload_conflict')
          const unfinished=db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM workbench_attachment_uploads WHERE owner_key=? AND status IN ('uploading','finalizing')").get(context.ownerKey)!.n
          if(unfinished>=32)throw Error('upload_unfinished_limit')
          const reservedBytes=input.size*2+METADATA_BYTES
          attachments.checkUploadQuota({id:input.id,draftId:input.draftId,...(input.taskId?{taskId:input.taskId}:{}),size:input.size,sha256:input.sha256,reservedBytes},stateDir,{ownerKey:context.ownerKey})
          const timestamp=now()
          db.query(`INSERT INTO workbench_attachment_uploads(id,owner_key,draft_id,task_id,name,mime,size,sha256,status,next_offset,chunks_json,part_identity,reserved_bytes,created_at,updated_at,expires_at)
            VALUES(?,?,?,?,?,?,?,?,'uploading',0,'[]',NULL,?,?,?,?)`).run(input.id,context.ownerKey,input.draftId,input.taskId??null,input.name,input.mime,input.size,input.sha256,reservedBytes,timestamp,timestamp,timestamp+RETENTION_MS)
        })
      }
      refresh(key,context)
      const next=transaction('write',()=>{
        const row=current(key,context);if(!sameMetadata(row,input))throw Error('upload_conflict')
        const committed=blocks(row),digest=hash(bytes),prior=committed.find(b=>b.offset===input.offset)
        if(input.offset<row.nextOffset){
          if(!prior||prior.size!==bytes.length||prior.sha256!==digest)throw Error('upload_conflict')
          if(row.status==='uploading'){const part=openPart(row);if(part)closeSync(part.fd)}
          return row
        }
        if(row.status!=='uploading'||input.offset!==row.nextOffset)throw Error('upload_conflict')
        const part=openPart(row,true);if(!part)throw Error(CHANGED)
        try{
          let written=0
          while(written<bytes.length){const n=writeSync(part.fd,bytes,written,bytes.length-written,input.offset+written);if(!n)throw Error(CHANGED);written+=n}
          fsyncSync(part.fd);verifyOpened(part.fd,stateDir,[PARTS,partName(row)],PATH_ERROR)
          const offset=row.nextOffset+bytes.length
          if(offset===row.size&&createHash('sha256').update(part.bytes).update(bytes).digest('hex')!==row.sha256)throw Error(CHANGED)
          committed.push({offset:input.offset,size:bytes.length,sha256:digest})
          db.query('UPDATE workbench_attachment_uploads SET next_offset=?,chunks_json=?,part_identity=?,status=?,updated_at=? WHERE id=?').run(offset,JSON.stringify(committed),part.identity,offset===row.size?'finalizing':'uploading',now(),row.id)
          return get(row.id)!
        }finally{closeSync(part.fd)}
      })
      if(next.status==='finalizing')return finalize(key,context)
      return state(next)
    },
    status(value:Identity,context:EntryContext):UploadState {
      const key=identity(value);authorize(context)
      refresh(key,context)
      const row=transaction('status',()=>{const row=current(key,context);if(row.status==='uploading'){const part=openPart(row);if(part)closeSync(part.fd)}return row})
      return row.status==='finalizing'?finalize(key,context):state(row)
    },
    discard(value:Identity,context:EntryContext):void {
      const key=identity(value);authorize(context)
      const row=transaction('discard',()=>{
        authorize(context)
        if(!get(key.id)){
          attachments.assertDiscardable(key.id,key.draftId,{ownerKey:context.ownerKey})
          attachments.checkUploadQuota({...key,size:1,sha256:'0'.repeat(64),reservedBytes:TOMBSTONE_BYTES},stateDir,{ownerKey:context.ownerKey})
          const timestamp=now()
          db.query(`INSERT INTO workbench_attachment_uploads(id,owner_key,draft_id,task_id,name,mime,size,sha256,status,next_offset,chunks_json,part_identity,reserved_bytes,created_at,updated_at,expires_at)
            VALUES(?,?,?,NULL,'','',1,?,'discarded',0,'[]',NULL,?,?,?,?)`).run(key.id,context.ownerKey,key.draftId,'0'.repeat(64),TOMBSTONE_BYTES,timestamp,timestamp,timestamp+RETENTION_MS)
          return get(key.id)!
        }
        const row=owned(key,context)
        if(row.status==='discarded'||row.status==='expired')return row
        attachments.assertDiscardable(row.id,row.draftId,scope(row))
        db.query("UPDATE workbench_attachment_uploads SET status='discarded',chunks_json='[]',reserved_bytes=?,updated_at=? WHERE id=?").run(TOMBSTONE_BYTES,now(),row.id)
        return get(row.id)!
      })
      try{cleanup(row)}catch{/* Persisted cancellation wins over cleanup failures. */}
    },
    expire,
  }
}
