import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {makeWorkbenchStore} from './store'
import type {WorkbenchMediaItem} from '../../lib/ilink-workbench'
import {initializeArtifactDeliverySchema,makeArtifactDeliveryStore,makeArtifactDeliveryWorker,parseWorkbenchMediaItem,type ArtifactDeliveryReceipt} from './artifact-deliveries'

let dir:string,path:string,db:Db,taskId:string,artifactId:string
const bytes=Buffer.from('immutable report'),sha256=createHash('sha256').update(bytes).digest('hex')
const item:WorkbenchMediaItem={type:4,file_item:{media:{encrypt_query_param:'download',aes_key:'YWVz',encrypt_type:1},file_name:'report.txt',len:String(bytes.length)}}
beforeEach(()=>{
  dir=mkdtempSync(join(tmpdir(),'cc-artifact-delivery-'));path=join(dir,'state.db');db=openDb({path});initializeArtifactDeliverySchema(db)
  const workbench=makeWorkbenchStore(db),task=workbench.create({title:'report',path:'/tmp/project',providerId:'claude',ownerChatId:'owner'});taskId=task.id
  workbench.addArtifact({taskId,name:'report.txt',mime:'text/plain',size:bytes.length,sha256,storagePath:'/snapshot'})
  artifactId=workbench.artifacts(taskId)[0]!.id
})
afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true})})
const input=(changes:Partial<Omit<ArtifactDeliveryReceipt,'status'|'mediaItemJson'|'reason'|'createdAt'|'updatedAt'>>={})=>({id:randomUUID(),commandHash:'c'.repeat(64),taskId,artifactId,artifactSha256:sha256,name:'report.txt',mime:'text/plain',size:bytes.length,ownerChatId:'owner',accountId:'account',...changes})
const payload={name:'report.txt',mime:'text/plain',size:bytes.length,sha256,contentBase64:bytes.toString('base64')}

describe('artifact delivery receipt store',()=>{
  it('returns an exact duplicate and conflicts on every immutable field',()=>{
    const store=makeArtifactDeliveryStore(db),value=input({id:randomUUID()}),first=store.reserve(value)
    expect(first.created).toBe(true);expect(store.reserve(value)).toEqual({receipt:first.receipt,created:false})
    const changes={commandHash:'d'.repeat(64),taskId:'deadbeef',artifactId:randomUUID(),artifactSha256:'e'.repeat(64),name:'other.txt',mime:'application/pdf',size:99,ownerChatId:'other',accountId:'other-account'}
    for(const [field,replacement] of Object.entries(changes))expect(()=>store.reserve({...value,[field]:replacement})).toThrow('artifact_delivery_conflict')
  })

  it('persists across reopen, rolls back, and enforces task and artifact foreign keys',()=>{
    const store=makeArtifactDeliveryStore(db),value=input(),saved=store.reserve(value).receipt
    db.close();db=openDb({path});initializeArtifactDeliverySchema(db);expect(makeArtifactDeliveryStore(db).get(value.id)).toEqual(saved)
    const rollback=input();expect(()=>db.transaction(()=>{makeArtifactDeliveryStore(db).reserve(rollback);throw Error('abort')})()).toThrow('abort')
    expect(makeArtifactDeliveryStore(db).get(rollback.id)).toBeNull()
    expect(()=>makeArtifactDeliveryStore(db).reserve(input({id:randomUUID(),taskId:'deadbeef'}))).toThrow()
    expect(()=>makeArtifactDeliveryStore(db).reserve(input({id:randomUUID(),artifactId:randomUUID()}))).toThrow()
    const other=makeWorkbenchStore(db).create({title:'other',path:'/tmp/other',providerId:'codex',ownerChatId:'owner'})
    expect(()=>makeArtifactDeliveryStore(db).reserve(input({id:randomUUID(),taskId:other.id}))).toThrow('artifact_delivery_scope')
  })

  it('recovers invisible uploads as prepared and possibly-visible sends as unknown',()=>{
    const store=makeArtifactDeliveryStore(db),upload=store.reserve(input()).receipt,send=store.reserve(input()).receipt
    expect(store.claimUpload(upload.id)?.status).toBe('uploading')
    expect(store.claimUpload(send.id)?.status).toBe('uploading');store.uploaded(send.id,item);expect(store.claimSend(send.id)?.status).toBe('sending')
    expect(store.recover()).toEqual({uploadsReset:1,sendsUnknown:1})
    expect(store.get(upload.id)).toMatchObject({status:'prepared',reason:'worker_restarted'})
    expect(store.get(send.id)).toMatchObject({status:'unknown',reason:'worker_restarted'})
  })

  it('validates the persisted media descriptor boundary',()=>{
    expect(parseWorkbenchMediaItem(JSON.stringify(item))).toEqual(item)
    for(const invalid of [{type:1,text_item:{text:'smuggled'}},{type:3,voice_item:{}},{...item,extra:true},{type:4,file_item:{...item.file_item,media:{...item.file_item.media,full_url:'https://bad'}}}]){
      expect(()=>parseWorkbenchMediaItem(JSON.stringify(invalid))).toThrow('invalid_artifact_media')
    }
  })
})

describe('explicit artifact delivery worker',()=>{
  it('uploads and sends once, then returns an accepted receipt without replay',async()=>{
    const store=makeArtifactDeliveryStore(db),receipt=store.reserve(input()).receipt
    const load=vi.fn(async()=>payload),upload=vi.fn(async()=>({status:'uploaded' as const,item})),send=vi.fn(async()=>({status:'accepted' as const}))
    const worker=makeArtifactDeliveryWorker({store,load,upload,send})
    await expect(worker.deliver(receipt.id)).resolves.toMatchObject({status:'accepted'})
    await expect(worker.deliver(receipt.id)).resolves.toMatchObject({status:'accepted'})
    expect(load).toHaveBeenCalledOnce();expect(upload).toHaveBeenCalledOnce();expect(send).toHaveBeenCalledOnce();await worker.close()
  })

  it('serializes different explicit deliveries and deduplicates concurrent calls for one receipt',async()=>{
    const store=makeArtifactDeliveryStore(db),one=store.reserve(input()).receipt,two=store.reserve(input()).receipt
    let active=0,max=0,release!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve}),upload=vi.fn(async receipt=>{active++;max=Math.max(max,active);if(receipt.id===one.id)await gate;active--;return{status:'uploaded' as const,item}})
    const worker=makeArtifactDeliveryWorker({store,load:async()=>payload,upload,send:async()=>({status:'accepted'})})
    const first=worker.deliver(one.id),duplicate=worker.deliver(one.id),second=worker.deliver(two.id)
    expect(duplicate).toBe(first);await vi.waitFor(()=>expect(upload).toHaveBeenCalledTimes(1));release();await Promise.all([first,duplicate,second])
    expect(max).toBe(1);expect(upload).toHaveBeenCalledTimes(2);await worker.close()
  })

  it('reuses a persisted upload and treats a definitive refusal as explicitly retryable',async()=>{
    const store=makeArtifactDeliveryStore(db),receipt=store.reserve(input()).receipt
    store.claimUpload(receipt.id);store.uploaded(receipt.id,item)
    const upload=vi.fn(),send=vi.fn().mockResolvedValueOnce({status:'deferred',reason:'window_closed'}).mockResolvedValueOnce({status:'accepted'})
    const worker=makeArtifactDeliveryWorker({store,load:vi.fn(),upload,send})
    await expect(worker.deliver(receipt.id)).resolves.toMatchObject({status:'uploaded',reason:'window_closed'})
    await expect(worker.deliver(receipt.id)).resolves.toMatchObject({status:'accepted'})
    expect(upload).not.toHaveBeenCalled();expect(send).toHaveBeenCalledTimes(2);await worker.close()
  })

  it('blocks immutable payload mismatch but leaves transient load IO retryable',async()=>{
    const store=makeArtifactDeliveryStore(db),mismatch=store.reserve(input()).receipt,io=store.reserve(input()).receipt,unknown=store.reserve(input()).receipt
    const worker=makeArtifactDeliveryWorker({store,load:async receipt=>{if(receipt.id===mismatch.id)return{...payload,sha256:'f'.repeat(64)};if(receipt.id===io.id)throw Object.assign(Error('busy'),{code:'EBUSY'});throw Error('unclassified read failure')},upload:vi.fn(),send:vi.fn()})
    await expect(worker.deliver(mismatch.id)).resolves.toMatchObject({status:'blocked',reason:'artifact_changed'})
    await expect(worker.deliver(io.id)).resolves.toMatchObject({status:'prepared',reason:'load_retryable'})
    await expect(worker.deliver(unknown.id)).resolves.toMatchObject({status:'blocked',reason:'load_invalid'})
    await worker.close()
  })

  it('cancels an invisible upload back to prepared and performs no late write',async()=>{
    const store=makeArtifactDeliveryStore(db),receipt=store.reserve(input()).receipt
    let finish!:(value:{status:'uploaded';item:WorkbenchMediaItem})=>void
    const upload=vi.fn(()=>new Promise<{status:'uploaded';item:WorkbenchMediaItem}>(resolve=>{finish=resolve})),send=vi.fn()
    const worker=makeArtifactDeliveryWorker({store,load:async()=>payload,upload,send}),delivery=worker.deliver(receipt.id)
    await vi.waitFor(()=>expect(store.get(receipt.id)?.status).toBe('uploading'))
    await worker.close();await expect(delivery).resolves.toMatchObject({status:'prepared',reason:'worker_closed'})
    finish({status:'uploaded',item});await new Promise(resolve=>setImmediate(resolve))
    expect(store.get(receipt.id)).toMatchObject({status:'prepared',mediaItemJson:null});expect(send).not.toHaveBeenCalled()
  })

  it('marks cancellation after final-send claim unknown and never accepts a late result',async()=>{
    const store=makeArtifactDeliveryStore(db),receipt=store.reserve(input()).receipt
    let finish!:(value:{status:'accepted'})=>void
    const send=vi.fn(()=>new Promise<{status:'accepted'}>(resolve=>{finish=resolve}))
    const worker=makeArtifactDeliveryWorker({store,load:async()=>payload,upload:async()=>({status:'uploaded',item}),send}),delivery=worker.deliver(receipt.id)
    await vi.waitFor(()=>expect(store.get(receipt.id)?.status).toBe('sending'))
    await worker.close();await expect(delivery).resolves.toMatchObject({status:'unknown',reason:'worker_closed'})
    finish({status:'accepted'});await new Promise(resolve=>setImmediate(resolve))
    expect(store.get(receipt.id)?.status).toBe('unknown')
  })

  it('returns one close promise and does not start a callback queued before close',async()=>{
    const store=makeArtifactDeliveryStore(db),receipt=store.reserve(input()).receipt,load=vi.fn(async()=>payload)
    const worker=makeArtifactDeliveryWorker({store,load,upload:vi.fn(),send:vi.fn()})
    const claimUpload=store.claimUpload.bind(store)
    let firstClose!:Promise<void>
    vi.spyOn(store,'claimUpload').mockImplementation(id=>{const claimed=claimUpload(id);firstClose=worker.close();return claimed})
    const delivery=worker.deliver(receipt.id)
    await vi.waitFor(()=>expect(firstClose).toBeDefined())
    const secondClose=worker.close()
    expect(secondClose).toBe(firstClose)
    await firstClose
    await expect(delivery).resolves.toMatchObject({status:'prepared'})
    expect(load).not.toHaveBeenCalled()
  })
})
