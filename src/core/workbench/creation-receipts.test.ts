import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {makeWorkbenchStore} from './store'
import {makeCreationReceiptStore,type CreationReceipt} from './creation-receipts'

let dir:string,path:string,db:Db,taskId:string
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'cc-creation-receipts-'));path=join(dir,'state.db');db=openDb({path});taskId=makeWorkbenchStore(db).create({title:'task',path:'/tmp/project',providerId:'claude',ownerChatId:'owner'}).id})
afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true})})
const input=(changes:Partial<Omit<CreationReceipt,'createdAt'>>={})=>({id:'request-1',accountId:'account',ownerChatId:'owner',commandHash:'hash',projectId:'p-123',path:'/tmp/project',providerId:'claude',taskId,runId:'run-1',reply:'created',...changes})

describe('creation receipt store',()=>{
  it('returns the original receipt for an exact duplicate and rejects every changed immutable field',()=>{
    const store=makeCreationReceiptStore(db),original=store.add(input())
    expect(store.add(input())).toEqual(original)
    for(const [field,value] of Object.entries({accountId:'other-account',ownerChatId:'other-owner',commandHash:'other-hash',projectId:'p-456',path:'/other',providerId:'codex',taskId:'deadbeef',runId:'run-2',reply:'other reply'})) {
      expect(()=>store.add(input({[field]:value}))).toThrow('creation_conflict')
    }
  })

  it('survives SQLite reopen',()=>{
    const stored=makeCreationReceiptStore(db).add(input());db.close();db=openDb({path})
    expect(makeCreationReceiptStore(db).get(stored.id)).toEqual(stored)
  })

  it('rolls back with its surrounding transaction',()=>{
    const store=makeCreationReceiptStore(db)
    expect(()=>db.transaction(()=>{store.add(input());throw new Error('abort')})()).toThrow('abort')
    expect(store.get('request-1')).toBeNull()
  })

  it('enforces the task foreign key',()=>{
    expect(()=>makeCreationReceiptStore(db).add(input({taskId:'missing-task'}))).toThrow()
  })
})
