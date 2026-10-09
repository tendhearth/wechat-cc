import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import {tmpdir} from 'node:os'
import {basename,dirname,join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {createRestoreManager,type RestoreReview} from './restore-manager'
import {RESTORE_SCHEMA_SQL} from './restore-store'
import {directoryId,verifyDirectoryAfterWrite} from './restore-snapshots'

// Model only the OS syscall differences/failures. Git, file contents, identity
// observations and the on-disk SQLite journal stay real.
const boundary=vi.hoisted(()=>({windows:false,denyFileFlush:false,denyTemporaryCreateIn:'',beforeCreateDenial:null as null|(()=>void),afterStat:null as null|((path:string)=>void)}))
vi.mock('node:os',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:os')>()
  return {...actual,platform:()=>boundary.windows?'win32':actual.platform()}
})
vi.mock('node:fs',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs')>()
  return {...actual,
    openSync:((...args:Parameters<typeof actual.openSync>)=>{
      if(boundary.windows&&actual.existsSync(args[0])&&actual.lstatSync(args[0]).isDirectory())throw Object.assign(Error('directory_open_denied'),{code:'EPERM'})
      const path=String(args[0]),flags=args[1]
      if(boundary.denyTemporaryCreateIn&&dirname(path)===boundary.denyTemporaryCreateIn&&/^\.cc-workbench-restore-[0-9a-f-]{36}\.tmp$/.test(basename(path))&&typeof flags==='number'&&(flags&actual.constants.O_CREAT)!==0){
        boundary.beforeCreateDenial?.()
        throw Object.assign(Error('temporary_create_denied'),{code:'EACCES'})
      }
      return actual.openSync(...args)
    }),
    fsyncSync:(fd:number)=>{
      const stat=actual.fstatSync(fd)
      if(boundary.windows&&stat.isDirectory())throw Object.assign(Error('directory_flush_unsupported'),{code:'EPERM'})
      if(boundary.denyFileFlush&&stat.isFile())throw Object.assign(Error('file_flush_denied'),{code:'EPERM'})
      return actual.fsyncSync(fd)
    },
    lstatSync:((...args:Parameters<typeof actual.lstatSync>)=>{
      const result=actual.lstatSync(...args);boundary.afterStat?.(String(args[0]));return result
    }),
  }
})

let root:string,project:string,blobRoot:string,db:Db
const git=(...args:string[])=>execFileSync('git',args,{cwd:project,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}})
const make=()=>createRestoreManager({db,blobRoot,withMutation:async(_id,operation)=>operation(),assertWriterClosed:()=>{},readGitState:async()=>{
  const index:Record<string,string>={}
  for(const row of git('ls-files','--stage','-z').split('\0').filter(Boolean)){const [meta,path]=row.split('\t');index[path!]=meta!}
  return {head:git('rev-parse','HEAD').trim(),index}
}})
let manager:ReturnType<typeof make>
const begin=()=>manager.begin({workspaceId:'workspace',taskId:'task',runId:randomUUID(),path:project,directoryIdentity:directoryId(project)})
const request=(review:RestoreReview)=>({workspaceId:'workspace',taskId:'task',artifactId:'artifact',path:'file.txt',changeId:review.files[0]!.changeId,requestId:randomUUID()})
async function changed(){const run=await begin();fs.writeFileSync(join(project,'file.txt'),'after');await manager.close(run.restoreRunId);manager.bindArtifact(run.restoreRunId,'artifact','a'.repeat(64));return manager.list('workspace')[0]!}
beforeEach(()=>{
  boundary.windows=false;boundary.denyFileFlush=false;boundary.denyTemporaryCreateIn='';boundary.beforeCreateDenial=null;boundary.afterStat=null
  root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'cc-restore-durability-')));project=join(root,'work');blobRoot=join(root,'private');fs.mkdirSync(project)
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');fs.writeFileSync(join(project,'file.txt'),'before');git('add','.');git('commit','-qm','base')
  db=openDb({path:join(root,'state.sqlite')});db.exec(RESTORE_SCHEMA_SQL);manager=make()
})
afterEach(()=>{boundary.windows=false;boundary.denyFileFlush=false;boundary.denyTemporaryCreateIn='';boundary.beforeCreateDenial=null;boundary.afterStat=null;db.close();fs.rmSync(root,{recursive:true,force:true})})

describe('restore platform durability boundaries',()=>{
  it('completes restore when Windows cannot open or flush directories',async()=>{
    boundary.windows=true
    const review=await changed(),result=await manager.revert(request(review))
    expect(result.state).toBe('reverted');expect(fs.readFileSync(join(project,'file.txt'),'utf8')).toBe('before')
    expect(manager.blocked('workspace')).toBe(false)
  })
  it('rejects regular files and changed ancestor identities at the Windows directory boundary',()=>{
    boundary.windows=true
    expect(()=>verifyDirectoryAfterWrite(join(project,'file.txt'))).toThrow('directory_identity_changed')
    const parent=join(root,'parent'),child=join(parent,'child');fs.mkdirSync(child,{recursive:true})
    boundary.afterStat=path=>{if(path===parent){boundary.afterStat=null;fs.renameSync(parent,join(root,'replaced'));fs.mkdirSync(child,{recursive:true})}}
    expect(()=>verifyDirectoryAfterWrite(child)).toThrow('directory_identity_changed')
  })
  it('rejects a directory redirected through a symlink at the Windows boundary',()=>{
    boundary.windows=true
    const original=join(root,'original'),alias=join(root,'alias');fs.mkdirSync(original);fs.symlinkSync(original,alias,process.platform==='win32'?'junction':'dir')
    expect(()=>verifyDirectoryAfterWrite(alias)).toThrow('directory_identity_changed')
    expect(fs.readdirSync(original)).toEqual([])
  })
  it('keeps the journal blocked and target unchanged after a regular-file flush failure',async()=>{
    boundary.windows=true
    const review=await changed(),input=request(review)
    boundary.denyFileFlush=true
    await expect(manager.revert(input)).rejects.toThrow('filesystem_EPERM')
    expect(fs.readFileSync(join(project,'file.txt'),'utf8')).toBe('after')
    expect((await manager.revert(input)).state).toBe('needs_recovery')
    expect(manager.blocked('workspace')).toBe(true)
    await expect(begin()).rejects.toThrow('workspace_blocked')
    db.close();db=openDb({path:join(root,'state.sqlite')});manager=make()
    await manager.recover('workspace')
    expect(manager.blocked('workspace')).toBe(true)
    expect((await manager.revert(input)).state).toBe('needs_recovery')
    expect(fs.readFileSync(join(project,'file.txt'),'utf8')).toBe('after')
  })
  it('persists prepared before denied temporary creation and recovers the same operation after SQLite reopen',async()=>{
    boundary.windows=true
    const review=await changed(),input=request(review),entries=fs.readdirSync(project).sort()
    let preparedAtDenial: {state:string;requestId:string;effectReady?:boolean}|undefined
    boundary.denyTemporaryCreateIn=project
    boundary.beforeCreateDenial=()=>{
      const row=db.query<{state:string;data:string},[string]>('SELECT state,data FROM workbench_restore_operations WHERE request_id=?').get(input.requestId)
      if(row){const operation=JSON.parse(row.data);preparedAtDenial={state:row.state,requestId:operation.receipt.requestId,effectReady:operation.effectReady}}
    }
    await expect(manager.revert(input)).rejects.toThrow('filesystem_EACCES')
    expect(preparedAtDenial).toEqual({state:'prepared',requestId:input.requestId,effectReady:undefined})
    expect(fs.readFileSync(join(project,'file.txt'),'utf8')).toBe('after')
    expect(fs.readdirSync(project).sort()).toEqual(entries)
    const receipt=await manager.revert(input)
    expect(receipt).toMatchObject({state:'needs_recovery',reason:'filesystem_EACCES'})
    expect(manager.blocked('workspace')).toBe(true)
    await expect(begin()).rejects.toThrow('workspace_blocked')
    boundary.denyTemporaryCreateIn='';boundary.beforeCreateDenial=null
    db.close();db=openDb({path:join(root,'state.sqlite')});manager=make()
    expect(manager.blocked('workspace')).toBe(true)
    await manager.recover('workspace')
    expect(await manager.revert(input)).toMatchObject({operationId:receipt.operationId,requestId:input.requestId,state:'reverted'})
    expect(manager.blocked('workspace')).toBe(false)
    expect(fs.readFileSync(join(project,'file.txt'),'utf8')).toBe('before')
    expect(fs.readdirSync(project).sort()).toEqual(entries)
  })
  it('recovers the same operation after effect then receipt failure and SQLite reopen on Windows',async()=>{
    boundary.windows=true
    const review=await changed(),input=request(review)
    db.exec("CREATE TRIGGER deny_receipt BEFORE UPDATE ON workbench_restore_operations WHEN NEW.state='reverted' BEGIN SELECT RAISE(ABORT,'receipt_failed'); END")
    // Bun and Node report different SQLite error codes through the sanitizer.
    await expect(manager.revert(input)).rejects.toThrow()
    expect(fs.readFileSync(join(project,'file.txt'),'utf8')).toBe('before')
    expect(manager.blocked('workspace')).toBe(true)
    const operationId=(await manager.revert(input)).operationId
    db.exec('DROP TRIGGER deny_receipt');db.close();db=openDb({path:join(root,'state.sqlite')});manager=make()
    await manager.recover('workspace')
    expect(await manager.revert(input)).toMatchObject({operationId,state:'reverted'})
    expect(manager.blocked('workspace')).toBe(false)
    expect(fs.readFileSync(join(project,'file.txt'),'utf8')).toBe('before')
  })
})
