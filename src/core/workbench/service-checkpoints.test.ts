import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdirSync,mkdtempSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../provider-registry'
import {makeMatterStore} from '../matters/store'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {makeTaskChangeHub} from './task-changes'
import {readArtifactSnapshot} from './artifacts'
import {parseGitReviewSnapshot} from './review'
import type {EntryInput} from './task-entry'

/** 回退切片 1(2026-10-21):独立工作区的每轮代码变更带 checkpointBefore/After;普通项目任务一个都没有。 */
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
  service=makeWorkbenchService({checkpointDeadlineMs:120_000,store,registry,stateDir,managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=>'owner',defaultProvider:'claude',registeredProjects:()=>[{alias:'project',path:project}],matters:makeMatterStore(db),changes:makeTaskChangeHub(),mintSessionToken:()=>'t'})
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})
const create=(isolation?:'worktree')=>service.createEntry({requestId:randomUUID(),text:'改一下',target:{kind:'project',projectId:service.projects()[0]!.id,...(isolation?{isolation}:{})}} as EntryInput,context).receipt.taskId
const settle=(id:string)=>expect.poll(()=>service.detail(id).task.status,{timeout:20_000}).toBe('completed')
const reviews=(id:string)=>service.detail(id).artifacts.filter(a=>a.name.startsWith('代码变更')).map(a=>parseGitReviewSnapshot(readArtifactSnapshot(store.artifact(id,a.id).storagePath,stateDir,a.sha256))!)

it('worktree task: the round review carries before/after checkpoints of the whole worktree root',async()=>{
  const id=create('worktree');await settle(id)
  const wt=store.worktrees.get(id)!,[review]=reviews(id)
  expect(review?.files.map(f=>f.path)).toEqual(['out.txt'])
  const {checkpointBefore:before,checkpointAfter:after}=review!
  expect(before).toMatch(/^[0-9a-f]{40}$/);expect(after).toMatch(/^[0-9a-f]{40}$/);expect(after).not.toBe(before)
  // 整个工作区根(task.path 是 pkg/ 子目录)
  const files=g(wt.root,'ls-tree','-r','--name-only',after!).split('\n')
  expect(files).toEqual(expect.arrayContaining(['root.txt','pkg/a.txt','pkg/out.txt']))
  expect(g(wt.root,'ls-tree','-r','--name-only',before!).split('\n')).not.toContain('pkg/out.txt')
  // 都挂了 ref,在主仓库看得见;分支 / 主人的 HEAD 没动
  const refs=g(repo,'for-each-ref','--format=%(objectname)',`refs/tendhearth/checkpoints/${id}/`).split('\n')
  expect(refs).toEqual(expect.arrayContaining([before,after]))
  expect(g(wt.root,'rev-parse','HEAD')).toBe(g(repo,'rev-parse','main'))
})

it('worktree task: a binary-only round is still saved (tree changed)',async()=>{
  write=path=>writeFileSync(join(path,'pic.png'),Buffer.from([0,1,2,3]))
  const id=create('worktree');await settle(id)
  const [review]=reviews(id)
  expect(review?.files).toEqual([expect.objectContaining({path:'pic.png',kind:'not_reviewed'})])
  expect(review?.checkpointAfter).toMatch(/^[0-9a-f]{40}$/)
})

it('plain project task: no checkpoints, no refs, nothing new saved for binary-only rounds',async()=>{
  const id=create();await settle(id)
  const [review]=reviews(id)
  expect(review?.files.map(f=>f.path)).toEqual(['out.txt'])
  expect('checkpointBefore' in review!).toBe(false);expect('checkpointAfter' in review!).toBe(false)
  expect(g(repo,'for-each-ref','refs/tendhearth/')).toBe('')
  write=path=>writeFileSync(join(path,'pic2.png'),Buffer.from([0,9]))
  const second=create();await settle(second)
  expect(reviews(second)).toEqual([])
})
