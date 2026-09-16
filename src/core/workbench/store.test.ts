import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {mkdirSync,mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { openTestDb, type Db } from '../../lib/db'
import { makeWorkbenchStore } from './store'
import {makeProjectCatalog} from './project-catalog'
import {removeTempDir} from '../../lib/test-temp'

let db:Db,store:ReturnType<typeof makeWorkbenchStore>
beforeEach(()=>{db=openTestDb();store=makeWorkbenchStore(db)})
afterEach(()=>db.close())
function task(title='task') { const row=store.create({title,path:'/tmp/project',providerId:'claude',ownerChatId:'owner'});store.update(row.id,'completed');return row }

describe('workbench full history and archive storage',()=>{
  it('returns each owner project once with its latest provider, including archived history',()=>{
    const old=store.create({title:'old',path:'/tmp/shared',providerId:'claude',ownerChatId:'owner'});store.update(old.id,'completed');store.setArchived(old.id,true)
    const latest=store.create({title:'latest',path:'/tmp/shared',providerId:'codex',ownerChatId:'owner'})
    db.query('UPDATE workbench_tasks SET updated_at=? WHERE id=?').run(1,old.id)
    db.query('UPDATE workbench_tasks SET updated_at=? WHERE id=?').run(2,latest.id)
    store.create({title:'other',path:'/tmp/other-owner',providerId:'claude',ownerChatId:'other'})
    const archivedOnly=store.create({title:'archived',path:'/tmp/archived-only',providerId:'claude',ownerChatId:'owner'});store.update(archivedOnly.id,'completed');store.setArchived(archivedOnly.id,true)
    db.query('UPDATE workbench_tasks SET updated_at=? WHERE id=?').run(3,archivedOnly.id)
    expect(store.ownedProjects('owner')).toEqual([
      {path:'/tmp/archived-only',providerId:'claude'},
      {path:'/tmp/shared',providerId:'codex'},
    ])
    expect(latest.providerId).toBe('codex')
  })
  it('selects the newest available historical provider before project deduplication without dropping unavailable-only paths',()=>{
    const root=mkdtempSync(join(tmpdir(),'cc-owned-projects-')),project=join(root,'project'),fallbackOnly=join(root,'fallback-only')
    try {
      mkdirSync(project);mkdirSync(fallbackOnly)
      const older=store.create({title:'older',path:project,providerId:'codex',ownerChatId:'owner'})
      const newest=store.create({title:'newest',path:project,providerId:'removed',ownerChatId:'owner'})
      const unavailable=store.create({title:'unavailable',path:fallbackOnly,providerId:'removed',ownerChatId:'owner'})
      db.query('UPDATE workbench_tasks SET updated_at=? WHERE id=?').run(older.createdAt-1,older.id)
      db.query('UPDATE workbench_tasks SET updated_at=? WHERE id=?').run(newest.createdAt+1,newest.id)
      db.query('UPDATE workbench_tasks SET updated_at=? WHERE id=?').run(unavailable.createdAt+2,unavailable.id)
      const known=store.ownedProjects('owner',['claude','codex'])
      expect(known).toEqual([{path:fallbackOnly,providerId:'removed'},{path:project,providerId:'codex'}])
      expect(makeProjectCatalog({ownerChatId:'owner',registered:[],known,providers:['claude','codex'],defaultProvider:'claude'}).map(row=>[row.path,row.providerId])).toEqual([
        [realpathSync(fallbackOnly),'claude'],[realpathSync(project),'codex'],
      ])
    } finally {removeTempDir(root)}
  })
  it('filters the phone owner before limiting recent tasks and omits archived tasks',()=>{
    const mine=task('mine'),archived=task('archived');store.setArchived(archived.id,true)
    db.query('UPDATE workbench_tasks SET updated_at=1 WHERE id=?').run(mine.id)
    for(let i=0;i<205;i++)store.create({title:'other owner',path:'/tmp/other',providerId:'claude',ownerChatId:'other'})
    expect(store.listOwned('owner',8).map(t=>t.id)).toEqual([mine.id])
    expect(store.listOwned('nobody',8)).toEqual([])
  })
  it('paginates beyond 200 rows with identical timestamps without gaps or duplicates',()=>{
    const ids=Array.from({length:251},(_,i)=>task(`task ${i}`).id).sort().reverse()
    db.query('UPDATE workbench_tasks SET updated_at=1234').run()
    const found:string[]=[];let cursor:string|undefined
    do {
      const result=store.listPage({limit:37,...(cursor?{cursor}:{})})
      expect(result.page.total).toBe(251);expect(result.page.limit).toBe(37)
      expect(result.tasks.length).toBeLessThanOrEqual(37)
      found.push(...result.tasks.map(t=>t.id))
      expect(result.page.hasMore).toBe(result.page.nextCursor!==null)
      cursor=result.page.nextCursor??undefined
    } while(cursor)
    expect(found).toEqual(ids)
  })

  it('searches old tasks before pagination and treats percent, underscore and backslash literally',()=>{
    const old=task('very old unique needle')
    db.query('UPDATE workbench_tasks SET updated_at=1 WHERE id=?').run(old.id)
    for(let i=0;i<205;i++)task(`new ${i}`)
    const percent=task('100% ready'),underscore=task('snake_case'),slash=task('path\\file'),dots=task('release..done')
    for(const [q,id] of [[' needle ',old.id],['%',percent.id],['_',underscore.id],['\\',slash.id],['..',dots.id],[old.id,old.id]]) {
      const page=store.listPage({q,limit:1})
      expect(page.tasks.map(t=>t.id)).toEqual([id]);expect(page.page.total).toBe(1)
    }
    expect(store.listPage({q:'/tmp/project',limit:1}).page.total).toBe(210)
    store.addEvent(old.id,'text','body-only-phrase')
    expect(store.listPage({q:'body-only-phrase'}).page.total).toBe(0)
  })

  it('binds cursors to normalized filters, validates them, and keeps total independent of cursor',()=>{
    task('match one');task('match two');task('match three')
    const page=store.listPage({q:' match ',limit:1}),cursor=page.page.nextCursor!
    expect(store.listPage({q:'match',limit:2,cursor}).page).toMatchObject({total:3,hasMore:false})
    expect(()=>store.listPage({q:'other',cursor})).toThrow('invalid_cursor')
    expect(()=>store.listPage({q:'match',archived:'all',cursor})).toThrow('invalid_cursor')
    for(const bad of ['', 'not+base64', 'x'.repeat(1025),Buffer.from('{}').toString('base64url'),Buffer.from(JSON.stringify({v:9,updatedAt:1,id:'deadbeef',filterHash:'a'.repeat(64)})).toString('base64url')]) {
      expect(()=>store.listPage({cursor:bad})).toThrow('invalid_cursor')
    }
    for(const limit of [0,101,1.5,NaN])expect(()=>store.listPage({limit})).toThrow('invalid_request')
    expect(()=>store.listPage({q:'x'.repeat(201)})).toThrow('invalid_request')
  })

  it('archives and restores idempotently without changing history, artifacts, session or updated time',()=>{
    const original=task();store.session(original.id,'native-original');store.addEvent(original.id,'user','original request')
    store.addArtifact({taskId:original.id,name:'report.md',mime:'text/plain',size:5,sha256:'a'.repeat(64),storagePath:'/immutable/report'})
    const artifact=store.artifacts(original.id)[0]!;store.approve(original.id,artifact.id,artifact.sha256)
    const before=store.detail(original.id),archived=store.setArchived(original.id,true)
    expect(archived.archivedAt).toEqual(expect.any(Number))
    expect(store.setArchived(original.id,true).archivedAt).toBe(archived.archivedAt)
    expect(store.listPage().page.total).toBe(0)
    expect(store.listPage({archived:'only'}).tasks.map(t=>t.id)).toEqual([original.id])
    expect(store.listPage({archived:'all'}).page.total).toBe(1)
    expect(store.detail(original.id)).toEqual({...before,task:{...before.task,archivedAt:archived.archivedAt}})
    expect(store.get(original.id).sessionId).toBe('native-original')
    expect(store.setArchived(original.id,false).archivedAt).toBeNull()
    expect(store.setArchived(original.id,false).archivedAt).toBeNull()
    expect(store.detail(original.id)).toEqual(before)
  })

  it('guards archive writes with terminal status even when invoked below the service',()=>{
    const row=task()
    for(const status of ['queued','running','cancelling'] as const){store.update(row.id,status);expect(()=>store.setArchived(row.id,true)).toThrow('workbench_busy')}
    store.update(row.id,'interrupted','writer_not_closed')
    expect(()=>store.setArchived(row.id,true)).toThrow('workbench_busy')
    expect(()=>store.setArchived('deadbeef',true)).toThrow('not_found')
  })
})
