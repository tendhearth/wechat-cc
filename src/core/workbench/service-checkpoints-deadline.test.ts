import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdirSync,mkdtempSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../../app/provider-registry'
import {makeMatterStore} from '../../adapters/store/matters-store'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {makeTaskChangeHub} from './task-changes'
import {readArtifactSnapshot} from './artifacts'
import {parseGitReviewSnapshot} from './review'
import type {EntryInput} from './task-entry'

/** 评审 #428:checkpoint 超时 / 被叫停时回合照样走完;取消能叫停卡在起点的 checkpoint。真 git 的期限测在 checkpoints.test.ts。 */
const fake=vi.hoisted(()=>({mode:'timeout' as 'timeout'|'hang',signals:[] as (AbortSignal|undefined)[]}))
vi.mock('./checkpoints',async importOriginal=>({...await importOriginal<typeof import('./checkpoints')>(),
  takeCheckpoint:async(input:{signal?:AbortSignal})=>{
    fake.signals.push(input.signal)
    return new Promise(done=>{
      input.signal?.addEventListener('abort',()=>done({skipped:'aborted'}),{once:true})
      if(fake.mode==='timeout')setTimeout(()=>done({skipped:'timeout'}),200)
    })
  }}))
vi.setConfig({testTimeout:60_000})
let area:string,stateDir:string,repo:string,project:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>,service:WorkbenchService
let write:(path:string)=>void
const context={ownerKey:'owner',surface:'desktop' as const}
const g=(cwd:string,...a:string[])=>execFileSync('git',a,{cwd,stdio:'pipe'}).toString().trim()
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-cp-service-')));stateDir=join(area,'state');repo=join(area,'repo');project=join(repo,'pkg')
  mkdirSync(stateDir);mkdirSync(project,{recursive:true})
  g(repo,'init','-q','-b','main');g(repo,'config','user.email','t@t');g(repo,'config','user.name','t')
  writeFileSync(join(repo,'root.txt'),'root\n');writeFileSync(join(project,'a.txt'),'one\n');g(repo,'add','-A');g(repo,'commit','-q','-m','init')
  db=openDb({path:join(stateDir,'state.db')});store=makeWorkbenchStore(db)
  write=path=>writeFileSync(join(path,'out.txt'),'done\n')
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(p){return{async *dispatch(){write(p.path);yield{kind:'text' as const,text:'完成'};yield{kind:'result' as const,sessionId:'native',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store,registry,stateDir,managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=>'owner',defaultProvider:'claude',registeredProjects:()=>[{alias:'project',path:project}],matters:makeMatterStore(db),changes:makeTaskChangeHub(),mintSessionToken:()=>'t'})
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})
const create=(isolation?:'worktree')=>service.createEntry({requestId:randomUUID(),text:'改一下',target:{kind:'project',projectId:service.projects()[0]!.id,...(isolation?{isolation}:{})}} as EntryInput,context).receipt.taskId
const settle=(id:string)=>expect.poll(()=>service.detail(id).task.status,{timeout:20_000}).toBe('completed')
const reviews=(id:string)=>service.detail(id).artifacts.filter(a=>a.name.startsWith('代码变更')).map(a=>parseGitReviewSnapshot(readArtifactSnapshot(store.artifact(id,a.id).storagePath,stateDir,a.sha256))!)

it('checkpoint timing out: the worktree round still completes and its review is saved without checkpoints',async()=>{
  fake.mode='timeout';fake.signals=[]
  const id=create('worktree');await settle(id)
  const [review]=reviews(id)
  expect(review?.files.map(f=>f.path)).toEqual(['out.txt'])
  expect('checkpointBefore' in review!).toBe(false);expect('checkpointAfter' in review!).toBe(false)
  expect(fake.signals.length).toBeGreaterThanOrEqual(1)
  expect(fake.signals.every(s=>s instanceof AbortSignal)).toBe(true)
})

it('a checkpoint stuck at round start is stopped by cancel',async()=>{
  fake.mode='hang';fake.signals=[]
  const id=create('worktree')
  await expect.poll(()=>fake.signals.length,{timeout:20_000}).toBe(1)
  await service.cancel(id)
  await expect.poll(()=>service.detail(id).task.status,{timeout:5_000}).toBe('cancelled')
  expect(fake.signals[0]?.aborted).toBe(true)
})
