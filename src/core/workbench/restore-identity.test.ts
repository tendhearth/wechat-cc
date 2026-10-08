import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import * as fs from 'node:fs'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {createRestoreManager,type RestoreReview} from './restore-manager'
import {directoryId} from './restore-snapshots'
import {RESTORE_SCHEMA_SQL} from './restore-store'

const state=vi.hoisted(()=>({ids:new Map<string,bigint>(),mapTemporary:false}))
vi.mock('node:fs',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs')>()
  const key=(s:{dev:bigint;ino:bigint})=>`${s.dev}:${s.ino}`
  const replace=(stats:fs.Stats|fs.BigIntStats,id:bigint|undefined)=>id===undefined?stats:new Proxy(stats,{get(target,property){return property==='ino'?(typeof target.ino==='bigint'?id:Number(id)):Reflect.get(target,property)}})
  return {...actual,
    lstatSync:((...args:Parameters<typeof actual.lstatSync>)=>{
      const stats=actual.lstatSync(...args),identity=actual.lstatSync(args[0],{bigint:true})
      return replace(stats!,state.ids.get(key(identity)))
    }),
    fstatSync:((...args:Parameters<typeof actual.fstatSync>)=>{
      const stats=actual.fstatSync(...args),identity=actual.fstatSync(args[0],{bigint:true})
      return replace(stats!,state.ids.get(key(identity)))
    }),
    openSync:((...args:Parameters<typeof actual.openSync>)=>{
      const fd=actual.openSync(...args)
      if(state.mapTemporary&&String(args[0]).includes('.cc-workbench-restore-'))state.ids.set(key(actual.fstatSync(fd,{bigint:true})),9007199254740992n)
      return fd
    }),
  }
})
const actual=await vi.importActual<typeof import('node:fs')>('node:fs')
const A=9007199254740992n,B=9007199254740993n
let root:string,project:string,blobRoot:string,db:Db,manager:ReturnType<typeof createRestoreManager>
const git=(...args:string[])=>execFileSync('git',args,{cwd:project,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}})
const make=()=>createRestoreManager({db,blobRoot,withMutation:async(_id,operation)=>operation(),assertWriterClosed:()=>{},readGitState:async()=>{
  const index:Record<string,string>={}
  for(const row of git('ls-files','--stage','-z').split('\0').filter(Boolean)){const [meta,path]=row.split('\t');index[path!]=meta!}
  return {head:git('rev-parse','HEAD').trim(),index}
}})
function mapped(path:string,id:bigint){const s=actual.lstatSync(path,{bigint:true});state.ids.set(`${s.dev}:${s.ino}`,id)}
const request=(review:RestoreReview)=>({workspaceId:'workspace',taskId:'task',artifactId:'artifact',path:'file.txt',changeId:review.files[0]!.changeId,requestId:randomUUID()})
async function changed(){const run=await manager.begin({workspaceId:'workspace',taskId:'task',runId:randomUUID(),path:project,directoryIdentity:directoryId(project)});fs.writeFileSync(join(project,'file.txt'),'after');await manager.close(run.restoreRunId);manager.bindArtifact(run.restoreRunId,'artifact','a'.repeat(64));return manager.list('workspace')[0]!}
beforeEach(()=>{
  state.ids.clear();state.mapTemporary=false
  root=actual.realpathSync.native(actual.mkdtempSync(join(tmpdir(),'cc-inode-audit-')));project=join(root,'work');blobRoot=join(root,'private');fs.mkdirSync(project)
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');fs.writeFileSync(join(project,'file.txt'),'before');git('add','.');git('commit','-qm','base')
  db=openDb({path:join(root,'state.sqlite')});db.exec(RESTORE_SCHEMA_SQL);manager=make()
})
afterEach(()=>{state.ids.clear();state.mapTemporary=false;db.close();actual.rmSync(root,{recursive:true,force:true})})

it('must reject a later same-content leaf with a distinct uint64 inode that rounds to the recorded number',async()=>{
  const file=join(project,'file.txt');mapped(file,A)
  const review=await changed(),input=request(review),oldActual=actual.lstatSync(file,{bigint:true}).ino
  fs.renameSync(file,join(root,'saved-after'));fs.writeFileSync(file,'after');mapped(file,B)
  expect(actual.lstatSync(file,{bigint:true}).ino).not.toBe(oldActual)
  expect(fs.lstatSync(file,{bigint:true}).ino).toBe(B);expect(Number(A)).toBe(Number(B))
  let outcome:string
  try{outcome=(await manager.revert(input)).state}catch(error){outcome=(error as Error).message}
  expect({outcome,bytes:fs.readFileSync(file,'utf8')}).toEqual({outcome:'file_changed',bytes:'after'})
})

it('must retain needs_recovery after an effect is replaced by another same-content uint64 inode',async()=>{
  const review=await changed(),input=request(review),file=join(project,'file.txt')
  state.mapTemporary=true
  db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON workbench_restore_operations WHEN NEW.state='reverted' BEGIN SELECT RAISE(ABORT,'receipt_failed'); END")
  await expect(manager.revert(input)).rejects.toThrow()
  expect(fs.readFileSync(file,'utf8')).toBe('before');expect(fs.lstatSync(file,{bigint:true}).ino).toBe(A)
  const pending=await manager.revert(input);expect(pending.state).toBe('needs_recovery')
  db.exec('DROP TRIGGER fail_receipt')
  const oldActual=actual.lstatSync(file,{bigint:true}).ino
  fs.renameSync(file,join(root,'saved-effect'));fs.writeFileSync(file,'before');mapped(file,B)
  expect(actual.lstatSync(file,{bigint:true}).ino).not.toBe(oldActual)
  expect(fs.lstatSync(file,{bigint:true}).ino).toBe(B);expect(Number(A)).toBe(Number(B))
  db.close();db=openDb({path:join(root,'state.sqlite')});manager=make()
  await manager.recover('workspace')
  const recovered=await manager.revert(input)
  expect({operationId:recovered.operationId,state:recovered.state,reason:recovered.reason,blocked:manager.blocked('workspace')}).toEqual({operationId:pending.operationId,state:'needs_recovery',reason:'effect_identity_changed',blocked:true})
})

it('rejects historical imprecise leaf records before any file or journal effect',async()=>{
 const review=await changed(),input=request(review),file=join(project,'file.txt')
 const {createRestoreStore}=await import('./restore-store'),store=createRestoreStore(db),run=store.runs('workspace')[0]!
 for(const change of run.changes)for(const version of [change.before,change.after])if(version.kind==='file')version.identity=version.identity.replace(/^fs2:/,'')
 store.putRun(run)
 await expect(manager.revert(input)).rejects.toThrow('legacy_file_identity')
 expect(fs.readFileSync(file,'utf8')).toBe('after');expect(store.operations('workspace')).toHaveLength(0)
})

it('keeps a historical temporary identity blocked on recovery but permits receipt-only keep-current',async()=>{
 const review=await changed(),input=request(review),file=join(project,'file.txt')
 db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON workbench_restore_operations WHEN NEW.state='reverted' BEGIN SELECT RAISE(ABORT,'receipt_failed'); END")
 await expect(manager.revert(input)).rejects.toThrow();db.exec('DROP TRIGGER fail_receipt')
 const {createRestoreStore}=await import('./restore-store'),store=createRestoreStore(db),op=store.operations('workspace')[0]!
 op.temporaryIdentity=op.temporaryIdentity!.replace(/^fs2:/,'');store.putOperation(op)
 const before=actual.lstatSync(file,{bigint:true}),bytes=fs.readFileSync(file)
 db.close();db=openDb({path:join(root,'state.sqlite')});manager=make();await manager.recover('workspace')
 const receipt=await manager.revert(input)
 expect(receipt.state).toBe('needs_recovery');expect(manager.blocked('workspace')).toBe(true)
 const result=await manager.resolveKeepCurrent({workspaceId:'workspace',taskId:'task',operationId:receipt.operationId,observedFingerprint:receipt.observedFingerprint!})
 expect(result.state).toBe('resolved_keep_current');expect(fs.readFileSync(file)).toEqual(bytes);expect(actual.lstatSync(file,{bigint:true}).ino).toBe(before.ino)
})
