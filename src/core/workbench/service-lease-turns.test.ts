import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {openDb,type Db} from '../../lib/db'
import {AsyncQueue} from '../async-queue'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {readArtifactSnapshot} from './artifacts'
import {removeTempDir} from '../../lib/test-temp'

/**
 * 租约按回合计代(评审 2026-09-21 #1)。交错是这样的:A 答复 ⇒ 释放租约前先截差异快照
 * (几十个文件要好一会儿);快照还在截,主人就续接了 A —— 此时 A 仍握着租约,续接照常开始。
 * 旧回合的那次释放醒来,只认 `Active` 不认回合,于是把**新回合正在用的**租约删掉、放 B 进来:
 * 两条任务并写同一个文件夹,旧快照还会把新回合的改动记到上一轮头上。
 *
 * 回合代数就是给这件事的答案:续接开新回合时代数 +1,旧回合的释放醒来发现代数对不上就放弃。
 */
const result:AgentEvent={kind:'result',sessionId:'turns-session',numTurns:1,durationMs:1}
class TurnRuntime {
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  subscribed=false; submitted=0
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{if(!this.subscribed)throw Error('runtime_start_without_consumer');this.queue.push({kind:'init',sessionId:'turns-session'});this.queue.push({kind:'text',itemId:'t0',text:'做。'})},
    submit:async()=>{this.submitted++;this.state={...this.state,foreground:'running'};this.queue.push({kind:'text',itemId:`t${this.submitted}`,text:'接着做。'})},
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{this.queue.end()}}
  finishTurn(){this.state={...this.state,foreground:'idle'};this.queue.push(result)}
}
let area:string,project:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>,runtimes:TurnRuntime[]
const git=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'}})
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-lease-turns-')));project=join(area,'project');mkdirSync(project)
  git('init','-q');writeFileSync(join(project,'README.md'),'base\n');git('add','.');git('commit','-q','-m','base')
  db=openDb({path:join(area,'state.db')});runtimes=[]
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(){const r=new TurnRuntime();runtimes.push(r);return r.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  store=makeWorkbenchStore(db);service=makeWorkbenchService({store,registry,stateDir:area,ownerChatId:()=>null})
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})
const reviews=(id:string)=>service.detail(id).artifacts.filter(a=>a.name.startsWith('代码变更')).sort((x,y)=>x.name.localeCompare(y.name)).map(a=>({name:a.name,files:(JSON.parse(readArtifactSnapshot(store.artifact(id,a.id).storagePath,area,a.sha256).toString()) as {files:Array<{path:string;kind:string}>}).files.filter(f=>f.kind!=='not_reviewed').map(f=>f.path).sort()}))

it('快照还在截时续接:旧回合的释放不能把新回合的租约删掉(评审 2026-09-21 #1)',async()=>{
  const a=service.create({path:project,providerId:'claude',text:'A'})
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text')).toBe(true)
  // 够多的文件,让这一轮的差异快照真的要花点时间 —— 续接就落在它截取的中途。
  for(let n=0;n<60;n++)writeFileSync(join(project,`a${n}.txt`),`A ${n}\n`)
  // 成果目录里放一份东西:result 分支会先登记成果、再去截快照放租约,所以它一出现在详情里,
  // 就说明那条释放已经开始等快照了(比睡固定毫秒稳)。
  writeFileSync(join(project,'.cc-workbench',a.id,'ready.txt'),'ready\n')
  const r=runtimes[0]!
  r.finishTurn()
  await expect.poll(()=>service.detail(a.id).artifacts.some(x=>x.name==='ready.txt'),{interval:1,timeout:10_000}).toBe(true)
  // 快照截取中续接 A:此时 A 还握着租约,这一句开的是新回合。
  await service.submitInput(a.id,{runId:service.detail(a.id).runId!,requestId:'33333333-3333-4333-8333-333333333333',text:'resume immediately'})
  expect(r.submitted).toBe(1)
  // 新回合写的文件:不能被记进上一轮的快照里。
  writeFileSync(join(project,'after-resume.txt'),'new turn\n')
  const b=service.create({path:project,providerId:'claude',text:'B'})
  await expect.poll(()=>reviews(a.id).length).toBe(1)
  expect(reviews(a.id)[0]!.files).toContain('a0.txt')
  expect(reviews(a.id)[0]!.files).not.toContain('after-resume.txt')
  // 旧回合的释放醒来只是放弃:B 一直排在 A 后面,没有第二个执行者被放进同一个文件夹。
  expect(service.detail(b.id).task.waitingFor?.taskId).toBe(a.id)
  expect(service.detail(b.id).task.status).toBe('queued')
  expect(runtimes).toHaveLength(1)
  expect(r.submitted).toBe(1)
  expect(service.detail(a.id).turn).toBe(2)
  // 新回合落定后照常放租约:B 起得来,租约没有被卡死。
  r.finishTurn()
  await expect.poll(()=>service.detail(b.id).task.status).toBe('running')
  await expect.poll(()=>reviews(a.id).length).toBe(2)
  // 两份快照各只含自己那一轮的文件(快照名的排序不是回合顺序,所以不按下标断言)。
  const files=reviews(a.id).map(r=>r.files)
  expect(files.some(f=>f.length===1&&f[0]==='after-resume.txt')).toBe(true)
  expect(files.some(f=>f.includes('a0.txt')&&!f.includes('after-resume.txt'))).toBe(true)
})

/**
 * 回合中间补一句话(Claude 的 runtime 在干活时也报 `input:'send'`,`submitInput` 不看 isReplied):
 * `beginTurn` 把代数推到下一格,而这一轮的基线还挂在上一格上 —— 之后每一次 `captureCodeChanges`
 * 都因为代数对不上而放弃,这条 run 的「代码变更」永远生不出来。基线要跟着进新回合(仍用原来的
 * 起点提交,前半段的改动才不会丢)。
 */
it('回合中间补一句话:基线跟着进新回合,这一轮的代码变更不会丢(评审 2026-09-21 #1 续)',async()=>{
  const a=service.create({path:project,providerId:'claude',text:'A'})
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text')).toBe(true)
  writeFileSync(join(project,'before-steer.txt'),'1\n')
  // 还在干活(前台 running、没有 result)时补一句:这是同一段工作的中途插话。
  await service.submitInput(a.id,{runId:service.detail(a.id).runId!,requestId:'44444444-4444-4444-8444-444444444444',text:'再加一条'})
  writeFileSync(join(project,'after-steer.txt'),'2\n')
  runtimes[0]!.finishTurn()
  await expect.poll(()=>reviews(a.id).length,{timeout:10_000}).toBe(1)
  expect(reviews(a.id)[0]!.files).toEqual(['after-steer.txt','before-steer.txt'])
})
