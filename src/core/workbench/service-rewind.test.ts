import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
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
import {REWIND_GOAL_REASON,REWIND_RETAIN_MS,type RewindOptions} from './service/rewind'
import type {AgentEvent,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime} from '../agent-provider'
import type {EntryInput} from './task-entry'

/**
 * 回退核心(切片 2,2026-10-21):真临时仓库 + 独立工作区(linked worktree),假执行者每轮按脚本改文件。
 * 任务目录是仓库里的子目录 pkg/(monorepo 那种),checkpoint 打的是整个工作区根。
 */
vi.setConfig({testTimeout:60_000})
const win=process.platform==='win32'
let area:string,stateDir:string,repo:string,project:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>,service:WorkbenchService
let turns:Array<(path:string)=>void>,requests:string[]
const context={ownerKey:'owner',surface:'desktop' as const}
const g=(cwd:string,...a:string[])=>execFileSync('git',['-c','core.autocrlf=false',...a],{cwd,stdio:'pipe'}).toString().trim()
const registry=()=>{
  const r=createProviderRegistry()
  r.register('claude',{async spawn(){return{async *dispatch(request:string){requests.push(request);const turn=turns.shift();turn?.(current);yield{kind:'text' as const,text:'完成'};yield{kind:'result' as const,sessionId:'native',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  return r
}
let current=''
const make=(rewind?:RewindOptions,extra:Partial<Parameters<typeof makeWorkbenchService>[0]>={})=>makeWorkbenchService({store,registry:registry(),stateDir,managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=>'owner',defaultProvider:'claude',registeredProjects:()=>[{alias:'project',path:project}],matters:makeMatterStore(db),changes:makeTaskChangeHub(),mintSessionToken:()=>'t',...(rewind?{rewind}:{}),...extra})
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-rewind-service-')));stateDir=join(area,'state');repo=join(area,'repo');project=join(repo,'pkg')
  mkdirSync(stateDir);mkdirSync(project,{recursive:true})
  g(repo,'init','-q','-b','main');g(repo,'config','user.email','t@t');g(repo,'config','user.name','t')
  writeFileSync(join(repo,'root.txt'),'root\n');writeFileSync(join(project,'a.txt'),'base\n');writeFileSync(join(repo,'.gitignore'),'dist/\n');g(repo,'add','-A');g(repo,'commit','-q','-m','init')
  db=openDb({path:join(stateDir,'state.db')});store=makeWorkbenchStore(db)
  turns=[];requests=[]
  service=make()
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})

const settle=(id:string,status='completed')=>expect.poll(()=>service.detail(id).task.status,{timeout:20_000}).toBe(status)
async function start(first:(path:string)=>void,plain=false){
  const isolation=plain?undefined:'worktree' as const
  turns.push(p=>first(p))
  const id=service.createEntry({requestId:randomUUID(),text:'改一下',target:{kind:'project',projectId:service.projects()[0]!.id,...(isolation?{isolation}:{})}} as EntryInput,context).receipt.taskId
  current=service.detail(id).task.path
  await settle(id)
  return id
}
async function next(id:string,turn:(path:string)=>void,status='completed'){
  turns.push(turn)
  service.continueTask(id,'再改',{inputRequestId:randomUUID()})
  await settle(id,status)
}
const rounds=(id:string)=>[...service.reviewList(id)].reverse()
const read=(id:string,rel:string)=>readFileSync(join(service.detail(id).task.path,rel),'utf8')
const has=(id:string,rel:string)=>existsSync(join(service.detail(id).task.path,rel))
const commitIn=(path:string,file:string,text:string)=>{writeFileSync(join(path,file),text);g(path,'add',file);g(path,'-c','user.email=t@t','-c','user.name=t','commit','-q','-m',file)}
/** 两轮:第 1 轮改 a、建 r1;第 2 轮改 a、建 r2、删 r1,并在分支上提交一次。 */
async function twoRounds(){
  const id=await start(p=>{writeFileSync(join(p,'a.txt'),'r1\n');writeFileSync(join(p,'r1.txt'),'one\n')})
  const wt=store.worktrees.get(id)!,P=g(wt.root,'rev-parse','HEAD')
  await next(id,p=>{writeFileSync(join(p,'a.txt'),'r2\n');writeFileSync(join(p,'r2.txt'),'two\n');rmSync(join(p,'r1.txt'));commitIn(p,'c.txt','committed\n')})
  return {id,wt,P,oldHead:g(wt.root,'rev-parse','HEAD')}
}

describe('预览 + 令牌 + 执行 + 撤销', () => {
  it('rewinds to the end of round 1: files, untracked, branch back to P; round 2 marked discarded; undo restores exactly', async () => {
    const {id,wt,P,oldHead}=await twoRounds()
    writeFileSync(join(wt.root,'pkg','extra.txt'),'owner edit\n')
    const [r1,r2]=rounds(id)
    expect(r1!.rewindable).toEqual({start:true,end:true});expect(r2!.rewindable).toEqual({start:true,end:true})
    const preview=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'end'})
    expect(preview).toMatchObject({target:{round:1,to:'end'},discarded:[{artifactId:r2!.artifactId,round:2}],droppedCommits:{count:1,elsewhere:false},ignoredUntouched:true,session:'none',goal:null})
    expect(preview.token).toMatch(/^[a-f0-9]{64}$/)
    expect(preview.files.paths.map(f=>f.path)).toEqual(expect.arrayContaining(['pkg/a.txt','pkg/r2.txt','pkg/r1.txt','pkg/c.txt','pkg/extra.txt']))
    expect(preview.extraChanges?.paths).toEqual([{status:'A',path:'pkg/extra.txt'}])
    expect(preview.rebuildHint).toContain('重新构建');expect(preview.refsNote).toContain('refs/tendhearth/')
    await expect(service.rewind(id,{artifactId:r1!.artifactId,to:'end'})).rejects.toThrow('rewind_confirmation_required')
    await expect(service.rewind(id,{artifactId:r1!.artifactId,to:'end',token:'0'.repeat(64)})).rejects.toThrow('rewind_confirmation_stale')
    const before={a:read(id,'a.txt'),r2:read(id,'r2.txt'),extra:read(id,'extra.txt')}
    const done=await service.rewind(id,{artifactId:r1!.artifactId,to:'end',token:preview.token})
    expect(done).toMatchObject({head:P,discarded:[r2!.artifactId]})
    expect(read(id,'a.txt')).toBe('r1\n');expect(read(id,'r1.txt')).toBe('one\n')
    expect(has(id,'r2.txt')).toBe(false);expect(has(id,'c.txt')).toBe(false);expect(has(id,'extra.txt')).toBe(false)
    expect(g(wt.root,'rev-parse','HEAD')).toBe(P);expect(g(repo,'rev-parse',wt.branch)).toBe(P)
    expect(g(repo,'rev-parse',done.backupRef)).toMatch(/^[0-9a-f]{40}$/)
    const after=rounds(id)
    expect(after[1]!.discarded).toBe(true);expect(after[1]!.rewindable).toEqual({start:false,end:false});expect(after[0]!.discarded).toBeUndefined()
    expect(service.detail(id).events.map(e=>e.text)).toContain('已回到第 1 轮结束时，撤掉了第 2 轮（已备份，可撤销）。')
    expect(store.rewinds.get(done.rewindId)!.state).toBe('done')
    // 撤销回退:回到回退前的样子,一个字节不差
    await service.undoRewind(id)
    expect(read(id,'a.txt')).toBe(before.a);expect(read(id,'r2.txt')).toBe(before.r2);expect(read(id,'extra.txt')).toBe(before.extra);expect(has(id,'r1.txt')).toBe(false)
    expect(g(wt.root,'rev-parse','HEAD')).toBe(oldHead)
    expect(rounds(id).every(r=>!r.discarded)).toBe(true)
    await expect(service.undoRewind(id)).rejects.toThrow('rewind_undo_unavailable')
  })

  it('to:start of round 1 undoes the first round too; a changed workspace makes the token stale', async () => {
    const id=await start(p=>writeFileSync(join(p,'a.txt'),'r1\n'))
    const [r1]=rounds(id)
    const preview=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'start'})
    expect(preview.discarded.map(d=>d.round)).toEqual([1])
    writeFileSync(join(service.detail(id).task.path,'later.txt'),'x\n')
    await expect(service.rewind(id,{artifactId:r1!.artifactId,to:'start',token:preview.token})).rejects.toThrow('rewind_confirmation_stale')
    const fresh=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'start'})
    await service.rewind(id,{artifactId:r1!.artifactId,to:'start',token:fresh.token})
    expect(read(id,'a.txt')).toBe('base\n');expect(has(id,'later.txt')).toBe(false)
    expect(service.detail(id).events.map(e=>e.text)).toContain('已回到第 1 轮开始前，撤掉了第 1 轮（已备份，可撤销）。')
  })

  it('undo is refused once a newer review round exists', async () => {
    const {id}=await twoRounds()
    const [r1]=rounds(id),p=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'end'})
    await service.rewind(id,{artifactId:r1!.artifactId,to:'end',token:p.token})
    await next(id,p=>writeFileSync(join(p,'a.txt'),'r3\n'))
    await expect(service.undoRewind(id)).rejects.toThrow('rewind_undo_stale')
  })
})

describe('拒绝', () => {
  it('not a worktree / archived / writer not closed / pending input / noop', async () => {
    const plain=await start(p=>writeFileSync(join(p,'a.txt'),'x\n'),true)
    expect(rounds(plain)[0]!.rewindable).toBeUndefined()
    expect(rounds(plain)[0]!.rewindable).toBeUndefined()
    const id=await start(p=>writeFileSync(join(p,'a.txt'),'r1\n'))
    const [r1]=rounds(id),target={artifactId:r1!.artifactId,to:'end' as const}
    await expect(service.rewindPreview(id,target)).rejects.toThrow('rewind_noop')
    store.update(id,'interrupted','writer_not_closed')
    await expect(service.rewindPreview(id,{...target,to:'start'})).rejects.toThrow('workbench_busy')
    store.clearWriterError(id)
    store.liveInputs.add({id:randomUUID(),taskId:id,runId:'r',text:'补一句'})
    await expect(service.rewindPreview(id,{...target,to:'start'})).rejects.toThrow('workbench_busy')
    store.liveInputs.hold(id,'x')
    service.setArchived(id,true)
    await expect(service.rewindPreview(id,{...target,to:'start'})).rejects.toThrow('workbench_archived')
  })

  it('branch moved / merge in progress / shared folder / merged into the project / ignored file in the way', async () => {
    const {id,wt}=await twoRounds()
    const [r1]=rounds(id),target={artifactId:r1!.artifactId,to:'end' as const}
    const tip=g(wt.root,'rev-parse','HEAD')
    g(wt.root,'checkout','-q','--detach')
    await expect(service.rewindPreview(id,target)).rejects.toMatchObject({message:'rewind_unavailable',reason:'branch_moved'})
    g(wt.root,'checkout','-q',wt.branch)
    const gitDir=realpathSync(join(repo,'.git','worktrees',g(wt.root,'rev-parse','--git-dir').split(/[\\/]/).pop()!))
    writeFileSync(join(gitDir,'MERGE_HEAD'),tip+'\n')
    await expect(service.rewindPreview(id,target)).rejects.toMatchObject({message:'rewind_unavailable',reason:'git_in_progress'})
    rmSync(join(gitDir,'MERGE_HEAD'))
    // 另一件没归档的事也在这个文件夹里、有更新的成果
    const other=store.create({title:'接手',path:service.detail(id).task.path,providerId:'claude',ownerChatId:'owner',registerProject:false})
    store.update(other.id,'completed')
    store.addArtifact({taskId:other.id,name:'x.txt',mime:'text/plain',size:1,sha256:'0'.repeat(64),storagePath:'x'})
    await expect(service.rewindPreview(id,target)).rejects.toThrow('rewind_shared_folder')
    store.setArchived(other.id,true)
    // 要丢的提交已经快进进了项目
    g(repo,'merge','-q','--ff-only',wt.branch)
    await expect(service.rewindPreview(id,target)).rejects.toThrow('rewind_merged')
  })

  it('refuses to overwrite a file a later round ignored (and the owner changed)', async () => {
    const id=await start(p=>writeFileSync(join(p,'local.json'),'{"v":1}\n'))
    const wt=store.worktrees.get(id)!
    await next(id,p=>{writeFileSync(join(wt.root,'.gitignore'),'dist/\nlocal.json\n');writeFileSync(join(p,'local.json'),'{"v":2,"mine":true}\n')})
    const [r1]=rounds(id)
    await expect(service.rewindPreview(id,{artifactId:r1!.artifactId,to:'end'})).rejects.toMatchObject({message:'rewind_ignored_conflict',paths:['pkg/local.json']})
  })

  it('discarded rounds: mark / return / revert / rewind ⇒ review_round_discarded', async () => {
    const {id}=await twoRounds()
    const [r1,r2]=rounds(id),p=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'end'})
    await service.rewind(id,{artifactId:r1!.artifactId,to:'end',token:p.token})
    const aid=r2!.artifactId,path=r2!.files.find(f=>f.kind!=='not_reviewed')!.path
    expect(()=>service.markReviewFile(id,{artifactId:aid,path,mark:'accepted'})).toThrow('review_round_discarded')
    expect(()=>service.returnReviewFiles(id,{artifactId:aid,paths:[path],comment:'改'})).toThrow('review_round_discarded')
    expect(()=>service.revertReviewFile(id,{artifactId:aid,path})).toThrow('review_round_discarded')
    await expect(service.rewindPreview(id,{artifactId:aid,to:'end'})).rejects.toThrow('review_round_discarded')
  })
})

describe('执行段失败与开机对账', () => {
  it('an injected verify failure rolls back: workspace and branch unchanged, intent row failed, event names the backup', async () => {
    await service.shutdown();service=make({inject:s=>{if(s==='verify')throw new Error('boom')}})
    const {id,wt,oldHead}=await twoRounds()
    const before={a:read(id,'a.txt'),r2:read(id,'r2.txt')}
    const [r1]=rounds(id),p=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'end'})
    await expect(service.rewind(id,{artifactId:r1!.artifactId,to:'end',token:p.token})).rejects.toMatchObject({message:'rewind_failed',rolledBack:true})
    expect(read(id,'a.txt')).toBe(before.a);expect(read(id,'r2.txt')).toBe(before.r2);expect(has(id,'r1.txt')).toBe(false)
    expect(g(wt.root,'rev-parse','HEAD')).toBe(oldHead)
    const [row]=store.rewinds.list(id)
    expect(row!.state).toBe('failed')
    expect(service.detail(id).events.at(-1)!.text).toContain(row!.backupRef)
    expect(rounds(id).every(r=>!r.discarded)).toBe(true)
  })

  it('boot: an applying row whose rewind fully happened is finished; one nobody can explain stops the task', async () => {
    const {id,wt,P}=await twoRounds()
    const [r1,r2]=rounds(id),p=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'end'})
    const done=await service.rewind(id,{artifactId:r1!.artifactId,to:'end',token:p.token})
    // 假装 CC 在记 done 之前退出了;分支也还没挪(files_only)
    db.query("UPDATE workbench_rewinds SET state='applying',notice_sent_at=NULL WHERE id=?").run(done.rewindId)
    g(wt.root,'update-ref',`refs/heads/${wt.branch}`,store.rewinds.get(done.rewindId)!.priorHead)
    await service.shutdown();service=make()
    await expect.poll(()=>store.rewinds.get(done.rewindId)!.state,{timeout:20_000}).toBe('done')
    expect(g(wt.root,'rev-parse','HEAD')).toBe(P)
    expect(rounds(id).find(r=>r.artifactId===r2!.artifactId)!.discarded).toBe(true)
    expect(service.detail(id).events.map(e=>e.text)).toContain('CC 上次退出时回退刚做完，记录已经补上。')
    // 现场对不上:谁也说不清 ⇒ 停住这件事,写备份 ref
    db.query("UPDATE workbench_rewinds SET state='applying' WHERE id=?").run(done.rewindId)
    writeFileSync(join(wt.root,'pkg','a.txt'),'someone\n')
    await service.shutdown();service=make()
    await expect.poll(()=>store.rewinds.get(done.rewindId)!.state,{timeout:20_000}).toBe('needs_owner')
    expect(service.detail(id).task).toMatchObject({status:'interrupted',error:'rewind_needs_owner'})
    expect(service.detail(id).events.at(-1)!.text).toContain(done.backupRef)
    // 持久的闸:派发 / 工作区动作 / 回退一律拒绝,直到主人拍板
    expect(()=>service.continueTask(id,'接着做',{inputRequestId:randomUUID()})).toThrow('rewind_needs_owner')
    expect(()=>service.worktreeAction(id,'commit')).toThrow('rewind_needs_owner')
    await expect(service.rewindPreview(id,{artifactId:r1!.artifactId,to:'start'})).rejects.toThrow('rewind_needs_owner')
    await service.rewindResolve(id,'keep')
    expect(service.detail(id).task.error).toBeNull()
    await next(id,()=>{})
    expect(requests.at(-1)).toContain('主人确认保留现在的样子')
  })

  it('boot: a reconcile that itself errors (branch ref locked during files_only) parks the task instead of failing quietly', async () => {
    const {id,wt}=await twoRounds()
    const [r1]=rounds(id),p=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'end'})
    const done=await service.rewind(id,{artifactId:r1!.artifactId,to:'end',token:p.token})
    db.query("UPDATE workbench_rewinds SET state='applying' WHERE id=?").run(done.rewindId)
    g(wt.root,'update-ref',`refs/heads/${wt.branch}`,store.rewinds.get(done.rewindId)!.priorHead)
    const lock=join(repo,'.git','refs','heads',`${wt.branch}.lock`);writeFileSync(lock,'')
    await service.shutdown();service=make()
    await expect.poll(()=>store.rewinds.get(done.rewindId)!.state,{timeout:20_000}).toBe('needs_owner')
    expect(service.detail(id).events.at(-1)!.text).toContain('停住')
    rmSync(lock)
  })
})

describe('回滚没回干净 ⇒ 停住,主人拍板', () => {
  it('a file edited inside the switch window is not overwritten; the task parks until restore_backup', async () => {
    let wtRoot='',once=true
    await service.shutdown();service=make({inject:s=>{if(s==='branch'&&once){once=false;writeFileSync(join(wtRoot,'pkg','a.txt'),'edited mid-rewind\n');throw new Error('boom')}}})
    const {id,wt,oldHead}=await twoRounds();wtRoot=wt.root
    const [r1]=rounds(id),p=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'end'})
    await expect(service.rewind(id,{artifactId:r1!.artifactId,to:'end',token:p.token})).rejects.toMatchObject({message:'rewind_failed',rolledBack:false,conflicts:['pkg/a.txt']})
    expect(read(id,'a.txt')).toBe('edited mid-rewind\n')
    const [row]=store.rewinds.list(id)
    expect(row!.state).toBe('needs_owner')
    const text=service.detail(id).events.at(-1)!.text
    expect(text).toContain('分支已恢复');expect(text).toContain('pkg/a.txt');expect(text).toContain(row!.backupRef)
    expect(()=>service.continueTask(id,'接着做',{inputRequestId:randomUUID()})).toThrow('rewind_needs_owner')
    await service.rewindResolve(id,'restore_backup')
    expect(read(id,'a.txt')).toBe('r2\n');expect(read(id,'r2.txt')).toBe('two\n')
    expect(g(wt.root,'rev-parse','HEAD')).toBe(oldHead)
    expect(store.rewinds.get(row!.id)).toMatchObject({state:'failed',resolution:'restore_backup'})
    await expect(service.rewindResolve(id,'keep')).rejects.toThrow('rewind_not_blocked')
    await next(id,()=>{})
    expect(requests.at(-1)).toContain('主人把它恢复成了回退之前的样子')
  })

  it.skipIf(win)('an eol attribute that changes checked-out bytes is reported as a line-ending issue and rolled back', async () => {
    writeFileSync(join(repo,'.gitattributes'),'*.txt text eol=crlf\n');g(repo,'add','-A');g(repo,'commit','-q','-m','attrs')
    const {id,oldHead}=await twoRounds()
    const before=read(id,'a.txt')
    const [r1]=rounds(id),p=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'end'})
    await expect(service.rewind(id,{artifactId:r1!.artifactId,to:'end',token:p.token})).rejects.toMatchObject({message:'rewind_failed',rolledBack:true,reason:'eol_mismatch',path:'a.txt'})
    // 回滚只保证 git 等价:eol 属性下检出的换行跟着属性走(已知限制,设计稿)
    expect(read(id,'a.txt').replace(/\r\n/g,'\n')).toBe(before.replace(/\r\n/g,'\n'));expect(g(store.worktrees.get(id)!.root,'rev-parse','HEAD')).toBe(oldHead)
    expect(service.detail(id).events.at(-1)!.text).toContain('换行')
  })
})

describe('until 与执行者告知', () => {
  it('an active goal becomes stopped; a passed goal whose passing round was discarded too', async () => {
    const {id}=await twoRounds()
    store.goals.create(id,{command:'true',maxRounds:3})
    const [r1]=rounds(id)
    let p=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'end'})
    expect(p.goal).toEqual({status:'active',willStop:true})
    await service.rewind(id,{artifactId:r1!.artifactId,to:'end',token:p.token})
    expect(store.goals.get(id)).toMatchObject({status:'stopped',stopReason:REWIND_GOAL_REASON})
    // passed:通过的那一轮被撤掉 ⇒ stopped
    const second=await start(p2=>writeFileSync(join(p2,'a.txt'),'x1\n'))
    await next(second,p2=>writeFileSync(join(p2,'a.txt'),'x2\n'))
    store.goals.create(second,{command:'true',maxRounds:3});store.goals.finish(second,'passed')
    const [s1]=rounds(second)
    p=await service.rewindPreview(second,{artifactId:s1!.artifactId,to:'end'})
    expect(p.goal).toEqual({status:'passed',willStop:true})
    await service.rewind(second,{artifactId:s1!.artifactId,to:'end',token:p.token})
    expect(store.goals.get(second)).toMatchObject({status:'stopped',stopReason:REWIND_GOAL_REASON})
  })

  it('a running until check blocks the rewind', async () => {
    await service.shutdown()
    let release:()=>void=()=>{}
    service=make(undefined,{until:{start:()=>({done:new Promise(resolve=>{release=()=>resolve({code:0,tail:''} as never)}),stop:async()=>release()}) as never}})
    const id=await start(p=>writeFileSync(join(p,'a.txt'),'r1\n'))
    store.goals.create(id,{command:'true',maxRounds:3})
    await next(id,p=>writeFileSync(join(p,'a.txt'),'r2\n'))
    const [r1]=rounds(id)
    await expect(service.rewindPreview(id,{artifactId:r1!.artifactId,to:'end'})).rejects.toThrow('workbench_busy')
    release()
  })

  it('the next turn is told once; a failed dispatch keeps the notice for the turn after', async () => {
    const {id,P}=await twoRounds()
    const [r1]=rounds(id),p=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'end'})
    await service.rewind(id,{artifactId:r1!.artifactId,to:'end',token:p.token})
    const told=`【工作区已被主人回到第 1 轮结束时】第 2 轮的文件改动已撤销、分支回到 ${P.slice(0,7)}`
    await next(id,()=>{throw new Error('dispatch failed')},'failed')
    expect(requests.at(-1)).toContain(told)
    expect(store.rewinds.pendingNotice(id)).toHaveLength(1)
    await next(id,()=>{})
    expect(requests.at(-1)).toContain(told);expect(requests.at(-1)).toContain('除非主人要求,别重做')
    expect(store.rewinds.pendingNotice(id)).toHaveLength(0)
    await next(id,()=>{})
    expect(requests.at(-1)).not.toContain('工作区已被主人回到')
  })
})

describe('自己那条安静的保留会话', () => {
  it.skipIf(win)('is closed first, then the rewind goes ahead', async () => {
    await service.shutdown()
    const queue:AgentEvent[]=[];let wake:()=>void=()=>{};let ended=false
    const push=(e:AgentEvent)=>{queue.push(e);wake()}
    let state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
    const runtime:AgentWorkbenchRuntime={
      events:{async *[Symbol.asyncIterator](){for(;;){while(queue.length)yield queue.shift()!;if(ended)return;await new Promise<void>(r=>{wake=r})}}},
      start:()=>{writeFileSync(join(current,'a.txt'),'live\n');push({kind:'init',sessionId:'live'});push({kind:'text',itemId:'t0',text:'做。'});state={...state,foreground:'idle'};push({kind:'result',sessionId:'live',numTurns:1,durationMs:1})},
      submit:async()=>{},snapshot:()=>state,
    }
    const session:AgentSession={workbenchRuntime:runtime,async *dispatch(){},close:async()=>{ended=true;wake()}}
    const r=createProviderRegistry()
    r.register('claude',{async spawn(){return session}},{displayName:'claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
    service=makeWorkbenchService({store,registry:r,stateDir,managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=>'owner',defaultProvider:'claude',registeredProjects:()=>[{alias:'project',path:project}],matters:makeMatterStore(db),changes:makeTaskChangeHub(),mintSessionToken:()=>'t',retainedIdleCloseMs:()=>9e9})
    const id=service.createEntry({requestId:randomUUID(),text:'改一下',target:{kind:'project',projectId:service.projects()[0]!.id,isolation:'worktree'}} as EntryInput,context).receipt.taskId
    current=service.detail(id).task.path
    await expect.poll(()=>service.detail(id).task.phase,{timeout:20_000}).toBe('replied')
    await expect.poll(()=>rounds(id).length,{timeout:20_000}).toBe(1)
    const [r1]=rounds(id),p=await service.rewindPreview(id,{artifactId:r1!.artifactId,to:'start'})
    expect(p.session).toBe('will_close')
    await service.rewind(id,{artifactId:r1!.artifactId,to:'start',token:p.token})
    expect(read(id,'a.txt')).toBe('base\n')
    expect(service.detail(id).task.status).toBe('completed')
    expect(service.detail(id).events.map(e=>e.text)).toContain('回退之前先收工:这件事安静着的会话已关掉,下一句会按原会话恢复。')
  })
})

describe('ref 的去留', () => {
  it('pruneRefs: archived for 30 days, or the cc/ branch gone ⇒ refs cleared; otherwise kept', async () => {
    const a=await start(p=>writeFileSync(join(p,'a.txt'),'a\n'))
    const b=await start(p=>writeFileSync(join(p,'a.txt'),'b\n'))
    const refs=(id:string)=>g(repo,'for-each-ref','--format=%(refname)',`refs/tendhearth/checkpoints/${id}/`).split('\n').filter(Boolean).length
    expect(refs(a)).toBeGreaterThan(0);expect(refs(b)).toBeGreaterThan(0)
    expect(await service.pruneRewindRefs()).toBe(0)
    service.setArchived(a,true)
    db.query('UPDATE workbench_tasks SET archived_at=? WHERE id=?').run(Date.now()-REWIND_RETAIN_MS-1000,a)
    const wtB=store.worktrees.get(b)!
    g(repo,'worktree','remove','--force',wtB.root);g(repo,'branch','-D',wtB.branch)
    expect(await service.pruneRewindRefs()).toBeGreaterThan(0)
    expect(refs(a)).toBe(0);expect(refs(b)).toBe(0)
  })
})
