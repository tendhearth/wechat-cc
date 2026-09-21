import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {openDb,type Db} from '../../lib/db'
import {AsyncQueue} from '../async-queue'
import {createProviderRegistry} from '../provider-registry'
import type {AgentEvent,AgentRuntimeSnapshot,AgentSession,AgentWorkbenchRuntime,SpawnContext} from '../agent-provider'
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
  /** spawn 时的上下文:测试要用它替「后台子任务」问主人一个问题。 */
  context?:SpawnContext
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
  said=0
  finishTurn(background=0){this.state={...this.state,foreground:'idle',backgroundCount:background};this.queue.push(result)}
  say(text:string){this.queue.push({kind:'text',itemId:`s${++this.said}`,text})}
  /** 最后一个后台子任务结束:runtime 只推一条 tool_call,backgroundCount 归零,再没有新的 result。 */
  endChild(){this.state={...this.state,backgroundCount:0};this.queue.push({kind:'tool_call',tool:'Agent',activity:{id:'child',type:'agent',label:'子任务',status:'completed'}})}
  /** 保留会话被后台通知唤醒,自己又动手写。 */
  autonomousWrite(){this.state={...this.state,foreground:'running'};this.queue.push({kind:'tool_call',tool:'Write',activity:{id:'late',type:'tool',label:'自动续作',status:'running'}})}
}
let area:string,project:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>,runtimes:TurnRuntime[]
const git=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'}})
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-lease-turns-')));project=join(area,'project');mkdirSync(project)
  git('init','-q');writeFileSync(join(project,'README.md'),'base\n');git('add','.');git('commit','-q','-m','base')
  db=openDb({path:join(area,'state.db')});runtimes=[]
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(_project,context){const r=new TurnRuntime();r.context=context;runtimes.push(r);return r.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
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
  // 这一等要跨过 60 个文件的第二份快照:机器忙的时候默认 1 秒不够(node runner 整目录并行时会红)。
  await expect.poll(()=>service.detail(b.id).task.status,{timeout:10_000}).toBe('running')
  await expect.poll(()=>reviews(a.id).length,{timeout:10_000}).toBe(2)
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

/**
 * 最后一个后台子任务结束时,`claude-workbench-runtime` 只推一条 `tool_call`(terminalTask):
 * `backgroundCount` 归零,却没有新的 `result`。收尾的动作全挂在 `result` 上 ⇒ A 显示「已答复」
 * 却一件成果都没有,同文件夹的 B 永远排队(评审 2026-09-21 #6)。落定要按状态转移判,不是按事件种类。
 */
const CHILD_STILL_WRITING='父回合结束了，子任务还在写。'
it('最后一个后台子任务只推 tool_call:回合照样落定,成果登记、同目录的 B 起得来(评审 2026-09-21 #6)',async()=>{
  const a=service.create({path:project,providerId:'claude',text:'A'})
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text')).toBe(true)
  const r=runtimes[0]!
  // 父回合结束时还有一个子任务在写:此刻不能落定。后面这句话排在 result 之后,它出现就说明 result 已被消费。
  r.finishTurn(1)
  r.say(CHILD_STILL_WRITING)
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.text===CHILD_STILL_WRITING)).toBe(true)
  writeFileSync(join(project,'.cc-workbench',a.id,'late.txt'),'子任务最后写的东西\n')
  const b=service.create({path:project,providerId:'claude',text:'B'})
  expect(service.detail(a.id).artifacts.map(x=>x.name)).not.toContain('late.txt')
  expect(service.detail(b.id).task.status).toBe('queued')
  expect(service.detail(b.id).task.waitingFor).toMatchObject({taskId:a.id,reason:'same_path'})
  // 子任务结束:只有一条 tool_call,没有新的 result。
  r.endChild()
  await expect.poll(()=>service.detail(a.id).artifacts.map(x=>x.name),{timeout:10_000}).toContain('late.txt')
  expect(service.detail(a.id).task.phase).toBe('replied')
  await expect.poll(()=>service.detail(b.id).task.status,{timeout:10_000}).toBe('running')
})

/**
 * 答复即释放租约之后,保留下来的原生会话可能被后台通知唤醒、自己又开始写 —— 服务端今天只在
 * `result` 上看状态,`foreground` 从 idle 变回 running 没有任何钩子(评审 2026-09-21 #2)。
 * 拦不到它动手之前,但窗口最多一个事件:目录被别人占着就结束这条会话,而不是两条任务并写。
 */
it('保留会话在 B 占了目录之后自己又开始干活:结束会话并说清楚(评审 2026-09-21 #2)',async()=>{
  const a=service.create({path:project,providerId:'claude',text:'A'})
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text')).toBe(true)
  runtimes[0]!.finishTurn()
  // A 答复即释放租约,同目录的 B 拿到文件夹开始干活。
  const b=service.create({path:project,providerId:'claude',text:'B'})
  await expect.poll(()=>service.detail(b.id).task.status,{timeout:10_000}).toBe('running')
  runtimes[0]!.autonomousWrite()
  // A 申请不到租约 ⇒ fail-closed:结束会话。答复早已交付,终态是「做完了」而不是「取消」。
  await expect.poll(()=>service.detail(a.id).task.status,{timeout:10_000}).toBe('completed')
  const title=service.detail(b.id).task.title
  expect(service.detail(a.id).events.some(e=>e.kind==='system'&&e.text.includes('自己又开始干活')&&e.text.includes(title))).toBe(true)
  expect(service.detail(b.id).task.phase).toBe('working')
})

it('没人占着目录时的自动续作:重新拿到租约、开新回合(评审 2026-09-21 #2)',async()=>{
  const a=service.create({path:project,providerId:'claude',text:'A'})
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text')).toBe(true)
  writeFileSync(join(project,'a0.txt'),'A\n')
  runtimes[0]!.finishTurn()
  // 这一轮的快照落库 ⇒ 释放已经走到底,租约确实不在 A 手里了。
  await expect.poll(()=>reviews(a.id).length,{timeout:10_000}).toBe(1)
  await new Promise(resolve=>setTimeout(resolve,20))
  runtimes[0]!.autonomousWrite()
  await expect.poll(()=>service.detail(a.id).turn,{timeout:10_000}).toBe(2)
  expect(service.detail(a.id).task.status).toBe('running')
  // 租约真的回到了 A 手里:此刻进来的 B 得排在它后面。
  const b=service.create({path:project,providerId:'claude',text:'B'})
  expect(service.detail(b.id).task.status).toBe('queued')
  expect(service.detail(b.id).task.waitingFor?.taskId).toBe(a.id)
  expect(runtimes).toHaveLength(1)
})

/**
 * 释放是异步的:`settleTurn` 放手之前要先把差异快照截完,期间 `reservations` 里那一份还在。
 * 保留会话若正好在这个窗口里自己又动手(评审 #2 的老场景,只是早了几百毫秒),「手里还有租约」
 * 让它看起来像一个正常回合 —— 没人补回合,代数不变,于是那条过期的释放认得出自己、把租约删掉,
 * 同目录的 B 被放进一个正在被写的文件夹。落定过的回合要当成「没有租约」看(Task 2 复审 #1)。
 */
it('释放还在截快照时保留会话自己又开始写:补新回合,过期的释放抽不走租约(Task 2 复审 #1)',async()=>{
  const a=service.create({path:project,providerId:'claude',text:'A'})
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text')).toBe(true)
  for(let n=0;n<60;n++)writeFileSync(join(project,`a${n}.txt`),`A ${n}\n`)
  writeFileSync(join(project,'.cc-workbench',a.id,'ready.txt'),'ready\n')
  const r=runtimes[0]!
  r.finishTurn()
  // 成果登记完 ⇒ 那条释放已经在等快照了(比睡固定毫秒稳)。
  await expect.poll(()=>service.detail(a.id).artifacts.some(x=>x.name==='ready.txt'),{interval:1,timeout:10_000}).toBe(true)
  const b=service.create({path:project,providerId:'claude',text:'B'})
  r.autonomousWrite()
  await expect.poll(()=>service.detail(a.id).turn,{timeout:10_000}).toBe(2)
  await expect.poll(()=>reviews(a.id).length,{timeout:10_000}).toBe(1)
  expect(service.detail(a.id).task.status).toBe('running')
  expect(service.detail(b.id).task.status).toBe('queued')
  expect(service.detail(b.id).task.waitingFor?.taskId).toBe(a.id)
  expect(runtimes).toHaveLength(1)
})

/**
 * 后台子任务问的问题活过了父回合的答复:最后一个子任务结束时会话静下来,但还有一个待决请求。
 * 旧判据在「有待决请求」时直接跳过这次转移,而 `wasQuiet` 已经变成 true —— 再没有人回来收尾,
 * 成果不登记、租约不放(#6 从另一个门又回来了)。落定要照常叫,由 `settleTurn` 自己因为
 * 「还在等主人拍板」而只收成果、不放租约;拍完板那一下补上落定(Task 2 复审 #2)。
 */
it('静下来时还有一个待决问题:成果先收、租约不放;拍完板才放行(Task 2 复审 #2)',async()=>{
  const a=service.create({path:project,providerId:'claude',text:'A'})
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text')).toBe(true)
  const r=runtimes[0]!
  const answered=r.context!.requestUserInput!({questions:[{id:'q',header:'格式',question:'要哪一种?',options:[],allowOther:true}]})
  await expect.poll(()=>service.detail(a.id).questions.length).toBe(1)
  // 父回合结束时子任务还在写;子任务结束只推一条 tool_call(#6 的形状)。
  r.finishTurn(1)
  writeFileSync(join(project,'.cc-workbench',a.id,'late.txt'),'子任务最后写的东西\n')
  const b=service.create({path:project,providerId:'claude',text:'B'})
  r.endChild()
  // 成果照收,但还在等主人 ⇒ 租约不放,B 不能起来。
  await expect.poll(()=>service.detail(a.id).artifacts.map(x=>x.name),{timeout:10_000}).toContain('late.txt')
  expect(service.detail(a.id).task.phase).toBe('working')
  expect(service.detail(b.id).task.status).toBe('queued')
  // 拍板:这一下没有任何事件,落定得由它自己补上。
  service.resolveAnswer(a.id,service.detail(a.id).questions[0]!.id,{q:['PDF']})
  await expect(answered).resolves.toEqual({q:['PDF']})
  await expect.poll(()=>service.detail(b.id).task.status,{timeout:10_000}).toBe('running')
  expect(service.detail(a.id).task.phase).toBe('replied')
})

/**
 * 排队原因要说人话(spec §D)。挡路的是一条**保留会话**、而且已经开了新回合 —— 主人续接了它 ——
 * 这时说「同一个文件夹」是对的但不够:主人看到的应该是「A 正在续接」,否则会以为队伍卡住了。
 */
it('挡路的是一条正在续接的保留会话:排队原因是 retained_turn(spec §D)',async()=>{
  const a=service.create({path:project,providerId:'claude',text:'A'})
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.kind==='text')).toBe(true)
  runtimes[0]!.finishTurn()
  await expect.poll(()=>service.detail(a.id).task.phase,{timeout:10_000}).toBe('replied')
  await service.submitInput(a.id,{runId:service.detail(a.id).runId!,requestId:'55555555-5555-4555-8555-555555555555',text:'接着改'})
  expect(service.detail(a.id).turn).toBe(2)
  const b=service.create({path:project,providerId:'claude',text:'B'})
  expect(service.detail(b.id).task.status).toBe('queued')
  expect(service.detail(b.id).task.waitingFor).toMatchObject({taskId:a.id,title:service.detail(a.id).task.title,reason:'retained_turn'})
})
