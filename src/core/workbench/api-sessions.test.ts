import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {makeWorkbenchStore} from './store'
import {makeApiSessionStore,type ApiSessionBinding} from './api-sessions'
import type {ChatMessage} from './api-model'

let dir:string,path:string,db:Db,taskId:string
const messages=(text='hello'):ChatMessage[]=>[{role:'user',content:text}]
const binding=(changes:Partial<ApiSessionBinding>={}):ApiSessionBinding=>({taskId,owner:'owner',path:'/tmp/project',directoryIdentity:'directory-1',configHash:'a'.repeat(64),...changes})

beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'cc-api-sessions-'));path=join(dir,'state.db');db=openDb({path});taskId=makeWorkbenchStore(db).create({title:'api',path:'/tmp/project',providerId:'api-model',ownerChatId:'owner'}).id})
afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true})})

describe('API session transcript store',()=>{
  it('creates an active revision-zero session and persists it across reopen',()=>{
    const created=makeApiSessionStore(db).create(binding(),messages())
    expect(created).toMatchObject({revision:0,state:'active',binding:binding(),messages:messages()})
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    db.close();db=openDb({path})
    expect(makeApiSessionStore(db).get(created.id)).toEqual(created)
  })

  it('acquires only a ready session with an exact binding and advances its revision atomically',()=>{
    const store=makeApiSessionStore(db),created=store.create(binding(),messages())
    const ready=store.save(created.id,created.revision,messages('checkpoint'),'ready')
    for(const changes of [{taskId:'deadbeef'},{owner:'other'},{path:'/tmp/other'},{directoryIdentity:'directory-2'},{configHash:'b'.repeat(64)}]){
      expect(()=>store.acquire(created.id,binding(changes))).toThrow()
      expect(store.get(created.id)).toEqual(ready)
    }
    const acquired=store.acquire(created.id,binding())
    expect(acquired).toMatchObject({state:'active',revision:2,messages:messages('checkpoint')})
    expect(()=>store.acquire(created.id,binding())).toThrow()
  })

  it('uses CAS saves only from active state and never mutates on stale or invalid transitions',()=>{
    const store=makeApiSessionStore(db),created=store.create(binding(),messages())
    expect(()=>store.save(created.id,99,messages('stale'),'ready')).toThrow('api_session_conflict')
    expect(store.get(created.id)).toEqual(created)
    const interrupted=store.save(created.id,0,messages('safe checkpoint'),'interrupted')
    expect(interrupted).toMatchObject({revision:1,state:'interrupted'})
    expect(()=>store.save(created.id,1,messages('revived'),'ready')).toThrow('api_session_conflict')
    expect(store.canResume(created.id,binding().path,binding().directoryIdentity,binding().configHash)).toBe(false)
  })

  it('never considers active sessions resumable after reopening, but allows an exact ready checkpoint',()=>{
    const store=makeApiSessionStore(db),active=store.create(binding(),messages()),ready=store.create(binding(),messages('two'))
    store.save(ready.id,0,messages('two complete'),'ready')
    db.close();db=openDb({path});const reopened=makeApiSessionStore(db)
    expect(reopened.canResume(active.id,'/tmp/project','directory-1','a'.repeat(64))).toBe(false)
    expect(reopened.canResume(ready.id,'/tmp/project','directory-1','a'.repeat(64))).toBe(true)
    expect(reopened.canResume(ready.id,'/tmp/project','wrong','a'.repeat(64))).toBe(false)
  })

  it('verifies the current task path and effective owner before every permission-bearing mutation',()=>{
    const store=makeApiSessionStore(db)
    expect(()=>store.create(binding({owner:'wrong'}),messages())).toThrow('api_session_binding')
    expect(()=>store.create(binding({path:'/tmp/other'}),messages())).toThrow('api_session_binding')
    const local=makeWorkbenchStore(db).create({title:'local',path:'/tmp/local',providerId:'api-model',ownerChatId:null})
    const localBinding=binding({taskId:local.id,owner:`workbench:${local.id}`,path:'/tmp/local'})
    const session=store.create(localBinding,messages())
    expect(session.binding).toEqual(localBinding)
    db.query('UPDATE workbench_tasks SET path=? WHERE id=?').run('/tmp/moved',local.id)
    expect(()=>store.save(session.id,0,messages('changed'),'ready')).toThrow('api_session_binding')
    expect(store.get(session.id)).toMatchObject({revision:0,state:'active'})
  })

  it('rejects malformed, non-serializable, oversized and over-count transcripts',()=>{
    const store=makeApiSessionStore(db)
    for(const invalid of [null,[{role:'unknown',content:'x'}],[{role:'user'}],[{role:'user',content:()=>{}}],[{role:'user',content:BigInt(1)}]]){
      expect(()=>store.create(binding(),invalid as never)).toThrow('invalid_api_messages')
    }
    expect(()=>store.create(binding(),messages('x'.repeat(16*1024*1024)))).toThrow('api_messages_too_large')
    expect(()=>store.create(binding(),Array.from({length:10_001},()=>user('x')))).toThrow('invalid_api_messages')
  })

  it('fails closed on corrupted stored JSON and never marks it resumable',()=>{
    const store=makeApiSessionStore(db),session=store.create(binding(),messages())
    store.save(session.id,0,messages(),'ready')
    db.query('UPDATE workbench_api_sessions SET messages_json=? WHERE id=?').run('{bad',session.id)
    expect(()=>store.get(session.id)).toThrow('invalid_api_session')
    expect(store.canResume(session.id,'/tmp/project','directory-1','a'.repeat(64))).toBe(false)
  })
})

function user(text:string):ChatMessage{return{role:'user',content:text}}
