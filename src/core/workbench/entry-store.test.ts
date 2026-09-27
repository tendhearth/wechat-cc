import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {makeWorkbenchStore} from './store'
import {createEntryStore,type EntryReservation} from './entry-store'

let root:string,path:string,db:Db
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'cc-entry-store-'));path=join(root,'state.db');db=openDb({path})})
afterEach(()=>{db.close();removeTempDir(root)})
const reservation=(changes:Partial<EntryReservation>={}):EntryReservation=>({
  ownerKey:'owner',requestId:randomUUID(),canonicalRequestHash:'a'.repeat(64),
  target:{kind:'managed'},workspaceId:randomUUID(),resolvedPath:null,directoryIdentity:null,
  providerId:'claude',execution:{defaults:'provider',model:null,reasoningEffort:null},materialSnapshot:[],...changes,
})
function accepted(){
  const task=makeWorkbenchStore(db).create({title:'entry',path:'/work/task',providerId:'claude',ownerChatId:'owner'})
  db.query("INSERT INTO matters(id,kind,title,status,owner_chat_id,created_at,updated_at) VALUES(?,'task','entry','open','owner',1,1)").run(task.id)
  return {taskId:task.id,matterId:task.id,runId:randomUUID(),acceptedAt:Date.now(),resolvedPath:'/work/task',directoryIdentity:'1:2'}
}

describe('durable entry reservation',()=>{
  it('freezes the first choice, isolates owners, and rejects changed content',()=>{
    const store=createEntryStore(db),input=reservation(),first=store.reserve(input)
    expect(first.phase).toBe('reserved')
    expect(store.reserve({...input,providerId:'codex',workspaceId:randomUUID()})).toEqual(first)
    expect(()=>store.reserve({...input,canonicalRequestHash:'b'.repeat(64)})).toThrow('creation_conflict')
    expect(store.get('another-owner',input.requestId)).toBeNull()
    expect(store.reserve({...input,ownerKey:'another-owner',workspaceId:randomUUID()}).ownerKey).toBe('another-owner')
  })

  it('pins allocation identity and never replaces it on a retry',()=>{
    const store=createEntryStore(db),input=reservation();store.reserve(input)
    const allocated=store.allocate(input.ownerKey,input.requestId,'/work/task','1:2')
    expect(allocated).toMatchObject({phase:'reserved',resolvedPath:'/work/task',directoryIdentity:'1:2'})
    expect(store.allocate(input.ownerKey,input.requestId,'/work/task','1:2')).toEqual(allocated)
    expect(()=>store.allocate(input.ownerKey,input.requestId,'/elsewhere','1:2')).toThrow('creation_conflict')
    expect(()=>store.allocate(input.ownerKey,input.requestId,'/work/task','1:3')).toThrow('creation_conflict')
  })

  it('accepts a complete receipt once, reopens it, and prevents replacement',()=>{
    const store=createEntryStore(db),input=reservation(),receipt=accepted();store.reserve(input)
    const first=store.accept(input.ownerKey,input.requestId,receipt)
    expect(first).toMatchObject({...receipt,phase:'accepted'})
    expect(store.accept(input.ownerKey,input.requestId,receipt)).toEqual(first)
    expect(()=>store.accept(input.ownerKey,input.requestId,{...receipt,runId:randomUUID()})).toThrow('creation_conflict')
    db.close();db=openDb({path})
    expect(createEntryStore(db).get(input.ownerKey,input.requestId)).toEqual(first)
  })

  it('participates in the caller transaction, leaving the retry reservation after rollback',()=>{
    const store=createEntryStore(db),input=reservation();store.reserve(input)
    expect(()=>db.transaction(()=>{store.accept(input.ownerKey,input.requestId,accepted());throw Error('abort')})()).toThrow('abort')
    expect(store.get(input.ownerKey,input.requestId)?.phase).toBe('reserved')
    expect(db.query('SELECT id FROM workbench_tasks').all()).toEqual([])
    expect(db.query('SELECT id FROM matters').all()).toEqual([])
  })

  it('rejects incomplete acceptance at both the API and schema boundaries',()=>{
    const store=createEntryStore(db),input=reservation(),receipt=accepted();store.reserve(input)
    for(const field of ['taskId','matterId','runId','acceptedAt','resolvedPath','directoryIdentity']) {
      const incomplete={...receipt};delete incomplete[field as keyof typeof incomplete]
      expect(()=>store.accept(input.ownerKey,input.requestId,incomplete)).toThrow()
    }
    expect(()=>store.accept(input.ownerKey,input.requestId,{...receipt,matterId:'deadbeef'})).toThrow()
    expect(()=>db.query("UPDATE workbench_entry_requests SET phase='accepted' WHERE owner_key=? AND request_id=?").run(input.ownerKey,input.requestId)).toThrow()
    expect(store.get(input.ownerKey,input.requestId)?.phase).toBe('reserved')
  })

  it('two database connections converge on the same frozen reservation',()=>{
    const second=openDb({path})
    try {
      const input=reservation(),a=createEntryStore(db),b=createEntryStore(second)
      expect(b.reserve({...input,providerId:'codex'})).toEqual(a.reserve({...input,providerId:'claude'}))
      const receipt=accepted();expect(a.accept(input.ownerKey,input.requestId,receipt)).toEqual(b.get(input.ownerKey,input.requestId))
      expect(db.query('SELECT request_id FROM workbench_entry_requests').all()).toHaveLength(1)
    } finally {second.close()}
  })
})
