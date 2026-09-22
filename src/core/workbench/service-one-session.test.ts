import {afterEach,beforeEach,expect,it,vi} from 'vitest'
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
 * 一个文件夹,同时只有一个**还能写它**的会话:占用从派发开始,到那个会话被关闭为止。
 *
 * 「还能写」是能力不是行为 —— 一条保留下来的原生会话随时可能被后台通知唤醒、自己又动手
 * (`claude-workbench-runtime` 里 `retained` 是黏性的,`foreground` 能从 idle 自己翻回 running,
 * 没有任何事件预告「我要开始写了」)。所以「已答复 = 文件夹空了」这个等式本来就不成立,
 * 之前那套回合代数 / 状态转移探测器 / fail-closed 结束会话都是在用事后观察逼近它。
 *
 * 文件夹让出来靠三条路:执行者自己收工、主人收工、**空闲自动收工**(本文件)。安静之后起一个
 * 计时器,有人等这个文件夹就短让位,没人等就长空闲;任何一下互动都取消计时。
 */
/**
 * 计时器驱动的测试:注入的档位是毫秒级,但「到点之后真的收工、下一件事真的起来」这一串
 * (关会话 → 结算 → pump → spawn)在满载套件里会被放大好几倍(见 vitest.config.ts 那笔账)。
 * 所以等待一律给足余量:一次假红的代价是整条流水线重跑,还教人别看红。
 */
vi.setConfig({testTimeout:60_000})
const POLL={timeout:20_000}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
let sessions=0
class SessionRuntime {
  /** spawn 时的上下文:测试用它替「执行者」问主人权限/问题,也用它读 resumeSessionId。 */
  context:SpawnContext
  sid:string
  queue=new AsyncQueue<AgentEvent>()
  state:AgentRuntimeSnapshot={retained:true,foreground:'running',backgroundCount:0,input:'send'}
  subscribed=false; submitted=0
  /** 投递成功不等于新回合已经开始:原生会话要到真动起来才报 running。开着这个开关,
   *  补一句话之后会话仍然「安静」—— 它能不能活下来就全看取消计时那一下(场景 4)。 */
  quietSubmit=false
  runtime:AgentWorkbenchRuntime={
    events:{[Symbol.asyncIterator]:()=>{this.subscribed=true;return this.queue.iterable()[Symbol.asyncIterator]()}},
    start:()=>{if(!this.subscribed)throw Error('runtime_start_without_consumer');this.queue.push({kind:'init',sessionId:this.sid});this.queue.push({kind:'text',itemId:'t0',text:'做。'})},
    submit:async()=>{this.submitted++;if(this.quietSubmit)return;this.state={...this.state,foreground:'running'};this.queue.push({kind:'text',itemId:`t${this.submitted}`,text:'接着做。'})},
    snapshot:()=>this.state,
  }
  session:AgentSession={workbenchRuntime:this.runtime,async *dispatch(){},close:async()=>{this.queue.end()}}
  constructor(context:SpawnContext){this.context=context;this.sid=context.resumeSessionId??`one-session-${++sessions}`}
  said=0
  /** 本轮做完:前台闲下来(还可以留着 background 个子任务在写)。 */
  finish(background=0){this.state={...this.state,foreground:'idle',backgroundCount:background};this.queue.push({kind:'result',sessionId:this.sid,numTurns:1,durationMs:1})}
  say(text:string){this.queue.push({kind:'text',itemId:`s${++this.said}`,text})}
  /** 保留会话自己又开始干活:没有任何事件说「新回合开始了」,只有快照在跳。 */
  write(){this.state={...this.state,foreground:'running'};this.queue.push({kind:'tool_call',tool:'Write',activity:{id:`w${++this.said}`,type:'tool',label:'自动续作',status:'running'}})}
  /** 最后一个后台子任务结束:只推一条 tool_call,backgroundCount 归零,没有新的 result。 */
  endChild(){this.state={...this.state,backgroundCount:0};this.queue.push({kind:'tool_call',tool:'Agent',activity:{id:'child',type:'agent',label:'子任务',status:'completed'}})}
}
let area:string,project:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>,runtimes:SessionRuntime[],spawned:SpawnContext[]
const git=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'}})
/** 两档计时都按测试注入:缺省是 10 分钟 / 15 秒,套件等不起。 */
function setup(knobs:{handoffGraceMs?:()=>number;retainedIdleCloseMs?:()=>number}={}){
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(_project,context){const r=new SessionRuntime(context);runtimes.push(r);spawned.push(context);return r.session}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  store=makeWorkbenchStore(db)
  service=makeWorkbenchService({store,registry,stateDir:area,ownerChatId:()=>null,closeTimeoutMs:50,...knobs})
  return service
}
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-one-session-')));project=join(area,'project');mkdirSync(project)
  git('init','-q');writeFileSync(join(project,'README.md'),'base\n');git('add','.');git('commit','-q','-m','base')
  db=openDb({path:join(area,'state.db')});runtimes=[];spawned=[]
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})
const create=(text:string)=>service.create({path:project,providerId:'claude',text})
const status=(id:string)=>service.detail(id).task.status
const phase=(id:string)=>service.detail(id).task.phase
const said=async(id:string)=>expect.poll(()=>service.detail(id).events.some(e=>e.kind==='text'),POLL).toBe(true)
const CLOSED='自动收工'
const closedEvent=(id:string)=>service.detail(id).events.some(e=>e.kind==='system'&&e.text.includes(CLOSED))
const reviews=(id:string)=>service.detail(id).artifacts.filter(a=>a.name.startsWith('代码变更')).sort((x,y)=>x.name.localeCompare(y.name)).map(a=>({name:a.name,files:(JSON.parse(readArtifactSnapshot(store.artifact(id,a.id).storagePath,area,a.sha256).toString()) as {files:Array<{path:string;kind:string}>}).files.filter(f=>f.kind!=='not_reviewed').map(f=>f.path).sort()}))
/** 一份变更快照里某个文件的 diff 原文:场景 8 要看「这一轮的改动有没有被记到上一轮」。 */
const diffOf=(id:string,name:string,path:string)=>{
  const artifact=service.detail(id).artifacts.find(a=>a.name===name)!
  const parsed=JSON.parse(readArtifactSnapshot(store.artifact(id,artifact.id).storagePath,area,artifact.sha256).toString()) as {files:Array<{path:string;diff?:string}>}
  return parsed.files.find(f=>f.path===path)?.diff??''
}

/**
 * 场景 1:保留会话自己又开始写。旧模型里 A 的租约在答复那一刻就放掉了,B 已经在同一个文件夹里
 * 跑起来,于是 A 一动手就只能被 fail-closed 结束掉 —— 一次正常的后台续作换来一条被杀的会话。
 * 新模型里 A 从派发起就一直持有这个文件夹,它想写就写;B 老老实实排队。
 */
it('保留会话自己又开始写:不再抢文件夹,也不再被杀',async()=>{
  setup({handoffGraceMs:()=>60_000,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  const r=runtimes[0]!
  writeFileSync(join(project,'a0.txt'),'A\n')
  r.finish()
  // 等这一轮的差异快照落库:旧模型里「答复即释放」就是挂在它后面的,它一出现就说明租约真的
  // 放掉了(不等的话 B 只是恰好排在还没放完的租约后面,测的就不是这条不变式)。
  await expect.poll(()=>reviews(a.id).length,POLL).toBe(1)
  await expect.poll(()=>phase(a.id),POLL).toBe('replied')
  const b=create('B')
  r.write()
  await expect.poll(()=>service.detail(a.id).task.runtime?.foreground,POLL).toBe('running')
  await pause(200)
  // A 还在,没有那条「自己又开始干活,已结束会话」的告警,也没有被记成收工。
  expect(status(a.id)).toBe('running')
  expect(service.detail(a.id).events.some(e=>e.kind==='system'&&e.text.includes('自己又开始干活'))).toBe(false)
  expect(closedEvent(a.id)).toBe(false)
  // B 一直在等 A —— 没有第二个执行者被放进同一个文件夹。
  expect(status(b.id)).toBe('queued')
  expect(service.detail(b.id).task.waitingFor).toMatchObject({taskId:a.id,reason:'same_path'})
  expect(runtimes).toHaveLength(1)
})

/**
 * 场景 1 的另一半:计时是在会话安静的时候排下的,到点之前它可能自己又动了手 —— 而快照跳变
 * 没有任何事件预告(`noteTransition` 只在有事件时才跑)。所以落笔前那一道安静复查是唯一的
 * 防线:不复查就会砍掉一条正在写的会话 —— 等于把刚删掉的 fail-closed 换个地方又装回来。
 */
it('自动收工到点前会话自己又动了手:不关它',async()=>{
  setup({handoffGraceMs:()=>60,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  const r=runtimes[0]!
  r.finish()
  await expect.poll(()=>phase(a.id),POLL).toBe('replied')
  const b=create('B')
  // 一个事件都不推,只让快照跳回 running:探测器不会被叫起来,取消那条路走不到。
  r.state={...r.state,foreground:'running'}
  await pause(300)
  expect(status(a.id)).toBe('running')
  expect(closedEvent(a.id)).toBe(false)
  expect(status(b.id)).toBe('queued')
})

/**
 * 场景 2:有人等这个文件夹 ⇒ 短让位。2026-09-15 的真问题(主人只能取消一件做成了的事来疏通
 * 文件夹)由这条路解决 —— 自动化,而不是假装文件夹空了。收工之后终态是 completed / replied:
 * 答复早就交付了,这不是取消。
 */
it('有人等这个文件夹:到点自动收工,让给下一件事',async()=>{
  setup({handoffGraceMs:()=>20,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  runtimes[0]!.finish()
  await expect.poll(()=>phase(a.id),POLL).toBe('replied')
  const b=create('B')
  await expect.poll(()=>status(a.id),POLL).toBe('completed')
  expect(phase(a.id)).toBe('replied')
  expect(closedEvent(a.id)).toBe(true)
  expect(service.detail(a.id).events.some(e=>e.kind==='system'&&e.text.includes(service.detail(b.id).task.title))).toBe(true)
  await expect.poll(()=>status(b.id),POLL).toBe('running')
})

/**
 * 场景 3:没人等这个文件夹 ⇒ 长空闲(别让一个闲着的原生进程占着资源,但也不急着关)。
 * 有人来等了 ⇒ 立刻改按短让位重排 —— `pump` 里那个武装点就是「有人来等了」的唯一入口。
 */
it('没人等就按长空闲;有人来等了立刻改按短让位',async()=>{
  // 长档给一个套件里绝不会到点的值:不然「有人来等了才改档」会被长档自己兜住,测的就不是
  // `pump` 那个武装点了(这条一开始就是这么写错的)。
  setup({handoffGraceMs:()=>20,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  runtimes[0]!.finish()
  await expect.poll(()=>phase(a.id),POLL).toBe('replied')
  // 没人等 ⇒ 短档根本不该被用上。
  await pause(200)
  expect(status(a.id)).toBe('running')
  expect(closedEvent(a.id)).toBe(false)
  const b=create('B')
  await expect.poll(()=>status(a.id),POLL).toBe('completed')
  await expect.poll(()=>status(b.id),POLL).toBe('running')
})

/**
 * 场景 4:补一句话就是一下互动,计时必须在 `submitInput` 的**同步段**里就取消掉 —— 下面
 * 「B 进来」和「主人补一句」在同一拍里发生,中间没有 await,所以 150ms 那个短让位是排好了的:
 * 取消得不够早,这句话就投给了一个正在被关掉的会话。
 */
it('补一句话:自动收工的计时立刻取消,话不会投给一个正在被关掉的会话',async()=>{
  setup({handoffGraceMs:()=>150,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  const r=runtimes[0]!;r.quietSubmit=true
  r.finish()
  await expect.poll(()=>phase(a.id),POLL).toBe('replied')
  const b=create('B')
  await service.submitInput(a.id,{runId:service.detail(a.id).runId!,requestId:'33333333-3333-4333-8333-333333333333',text:'再补一句'})
  await pause(400)
  expect(status(a.id)).toBe('running')
  expect(closedEvent(a.id)).toBe(false)
  expect(r.submitted).toBe(1)
  expect(status(b.id)).toBe('queued')
  // 新回合跑完再静下来 ⇒ 重新计时,这次真的让位。
  r.write();r.finish()
  await expect.poll(()=>status(a.id),POLL).toBe('completed')
  await expect.poll(()=>status(b.id),POLL).toBe('running')
})

/**
 * 场景 5:有待决权限不算安静 —— 权限自己能等 5 分钟,不能在主人还没拍板时把会话关掉。
 * 拍完板要重新评估一次:那一下既没有事件、也没有转移,没人回来起计时的话 A 就停在
 * 「已答复却永远占着文件夹」(终审 I4 的那半仍然成立,只是现在保护的是计时而不是释放)。
 */
it('待决权限不算安静:不计时;拍完板仍安静 ⇒ 重新计时并最终收工',async()=>{
  setup({handoffGraceMs:()=>20,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  const r=runtimes[0]!
  const decision=r.context.requestPermission!({tool:'Read',description:'读一个文件'},new AbortController().signal)
  await expect.poll(()=>service.detail(a.id).permissions.length,POLL).toBe(1)
  r.finish()
  const b=create('B')
  await pause(200)
  expect(status(a.id)).toBe('running')
  expect(phase(a.id)).toBe('working')
  expect(closedEvent(a.id)).toBe(false)
  expect(status(b.id)).toBe('queued')
  service.resolvePermission(a.id,service.detail(a.id).permissions[0]!.id,'allow')
  await expect(decision).resolves.toBe(true)
  await expect.poll(()=>status(a.id),POLL).toBe('completed')
  await expect.poll(()=>status(b.id),POLL).toBe('running')
})

/**
 * 场景 6:后台子任务还在写不算安静(评审 2026-09-16 #6 的正确那一半仍然成立)。最后一个
 * 子任务结束时 runtime 只推一条 `tool_call` —— `backgroundCount` 归零却没有新的 `result`,
 * 所以判据必须是状态转移,不能只认 `result`。
 */
it('后台子任务还在写:不算安静;最后一个子任务结束才登记成果并开始计时',async()=>{
  setup({handoffGraceMs:()=>20,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  const r=runtimes[0]!
  r.finish(1)
  const b=create('B')
  await pause(200)
  expect(status(a.id)).toBe('running')
  expect(service.detail(a.id).artifacts).toEqual([])
  expect(status(b.id)).toBe('queued')
  writeFileSync(join(project,'.cc-workbench',a.id,'late.txt'),'子任务的产物\n')
  r.endChild()
  await expect.poll(()=>service.detail(a.id).artifacts.map(x=>x.name),POLL).toContain('late.txt')
  await expect.poll(()=>status(a.id),POLL).toBe('completed')
  await expect.poll(()=>status(b.id),POLL).toBe('running')
})

/**
 * 场景 7:关掉会话不贵 —— `task.sessionId` 在 `init`/`result` 时就落库了,关闭不清它
 * (只有主人明确选「重新开始」才清)。所以收工之后接着说,走的是原生 `--resume`,会话号不变。
 */
it('自动收工之后接着说:按原会话恢复,原生会话号不变',async()=>{
  setup({handoffGraceMs:()=>20,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  const sid=runtimes[0]!.sid
  runtimes[0]!.finish()
  await expect.poll(()=>phase(a.id),POLL).toBe('replied')
  const b=create('B')
  await expect.poll(()=>status(a.id),POLL).toBe('completed')
  await expect.poll(()=>status(b.id),POLL).toBe('running')
  expect(store.get(a.id).sessionId).toBe(sid)
  expect(service.detail(a.id).continuation).toEqual({mode:'resume'})
  // 文件夹此刻是 B 的,所以续接先排队(不抛错);B 收工之后 A 才起,spawn 拿到原会话号。
  expect(()=>service.continueTask(a.id,'再说一句')).not.toThrow()
  await expect.poll(()=>service.detail(a.id).task.waitingFor?.taskId,POLL).toBe(b.id)
  runtimes[1]!.finish()
  await service.cancel(b.id)
  await expect.poll(()=>status(a.id),POLL).toBe('running')
  expect(spawned.at(-1)!.resumeSessionId).toBe(sid)
  expect(runtimes.at(-1)!.sid).toBe(sid)
})

/**
 * 场景 8:上一轮的快照还在截(300 个文件的 git 差异要一秒多)时主人补了一句。旧模型里
 * 「答复即释放」就挂在这份快照后面,于是要靠回合代数去认出「这次释放已经过期」;现在
 * **构造上不可能**:没有任何释放动作。要保住的只有差异边界 —— 续接前先 await 在途的那份快照,
 * 别把新回合的改动记到上一轮头上。C 全程排队,证明文件夹一刻都没松手。
 */
it('上一轮快照还在截时补一句:这一轮的改动不会被记到上一轮,文件夹一刻没松手',async()=>{
  setup({handoffGraceMs:()=>60_000,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  const r=runtimes[0]!
  // 够多够大,截一份差异要好几百毫秒 —— 这条测试的前提就是「补一句的时候快照还在截」。
  // 别再往上加:`git-review` 的 GitReader 总预算是 15 秒,满载套件里这一步会慢十倍,
  // 一旦超预算报告就变 partial(只列出前一百来个文件),下面的断言会假红(实测 300 个就会)。
  for(let i=0;i<100;i++)writeFileSync(join(project,`f${i}.txt`),`第 ${i} 份\n`.repeat(200))
  r.finish()
  // `phase` 是从运行时快照派生的,`r.finish()` 一设状态它就变 replied —— 那时 `result` 事件
  // 可能还没被消费,快照也就还没开始截。用一条排在 result **后面**的文本当路标:看到它,
  // 就说明 result 已经消费过、这一轮的快照已经起跑了。
  r.say('这一轮到此')
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.text==='这一轮到此'),POLL).toBe(true)
  // 钉住前提:快照还在途中(已经落库就没什么可等的了,这条测试会变成空转)。
  expect(reviews(a.id).length).toBe(0)
  const c=create('C')
  await service.submitInput(a.id,{runId:service.detail(a.id).runId!,requestId:'44444444-4444-4444-8444-444444444444',text:'再来'})
  // 改一个**上一轮就在名单里**的文件,而且是名单最后才被读到的那个(按字符串排序 f99 在最后)。
  // 快照是一边跑一边逐个读文件的:不等它截完就放手,这一下改动会被读进上一轮那份快照。
  writeFileSync(join(project,'f99.txt'),'第 99 份\n'.repeat(200)+'续接之后改的\n')
  await expect.poll(()=>reviews(a.id).length,POLL).toBe(1)
  const first=reviews(a.id)[0]!
  expect(first.files).toContain('f99.txt')
  expect(first.files).toHaveLength(100)
  expect(diffOf(a.id,first.name,'f99.txt')).not.toContain('续接之后改的')
  r.finish()
  await expect.poll(()=>reviews(a.id).length,POLL).toBe(2)
  const second=reviews(a.id).find(shot=>shot.name.endsWith('-2.json'))!
  expect(second.files).toEqual(['f99.txt'])
  expect(diffOf(a.id,second.name,'f99.txt')).toContain('续接之后改的')
  // 全程没有任何一刻文件夹是空的。
  expect(status(c.id)).toBe('queued')
  expect(service.detail(c.id).task.waitingFor).toMatchObject({taskId:a.id,reason:'same_path'})
  expect(runtimes).toHaveLength(1)
})

/**
 * 修复轮 #2:`submitInput` 那两处 await(等在途快照、取新基线)可能等十几秒,而它刚在入口
 * 取消掉的计时会在它脚下被重新武装 —— 期间一轮自动续作正常收尾,`settleQuiet` 就又排下一个
 * 让位计时,到点把会话收工、文件夹交给 B。醒过来不复查过期,这句话就投给一条已经关掉的会话:
 * 坏的那头是原生进程还没死,于是在一个正在移交的文件夹里开始写。
 */
it('续接等在途快照时会话被自动收工:这一句认出自己过期,不投给已关掉的会话',async()=>{
  setup({handoffGraceMs:()=>50,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  const r=runtimes[0]!
  // 让上一轮的快照够慢(见场景 8 的注释:文件数别再往上加)。
  for(let i=0;i<100;i++)writeFileSync(join(project,`f${i}.txt`),`第 ${i} 份\n`.repeat(200))
  r.finish()
  r.say('这一轮到此')
  await expect.poll(()=>service.detail(a.id).events.some(e=>e.text==='这一轮到此'),POLL).toBe(true)
  expect(reviews(a.id).length).toBe(0)
  const b=create('B')
  const pending=service.submitInput(a.id,{runId:service.detail(a.id).runId!,requestId:'55555555-5555-4555-8555-555555555555',text:'再来'})
  // 入口那一下已经把计时取消了;紧接着 A 自己收了一个回合 ⇒ 重新武装 50ms 的让位,而上面那份
  // 快照要几百毫秒 —— 会话会在 `submitInput` 还挂着的时候被收工。
  r.finish()
  await expect(pending).rejects.toThrow('input_stale')
  expect(r.submitted).toBe(0)
  expect(service.detail(a.id).inputs.some(i=>i.text==='再来')).toBe(false)
  await expect.poll(()=>status(a.id),POLL).toBe('completed')
  await expect.poll(()=>status(b.id),POLL).toBe('running')
})

/**
 * 修复轮 #3:自己醒来干的那一轮也欠主人一份代码变更。上一轮安静时基线已经被消费,而取基线
 * 只有两个入口(起步、主人续接)—— 醒来这条路 BASE 靠 `onAutonomousStart → beginTurn` 重取,
 * 那两个函数这一轮删了。新不变式下「自己醒来干活」是合法工作,它的差异比以前更重要。
 */
it('自己醒来干的那一轮也有代码变更:醒来时重取基线',async()=>{
  setup({handoffGraceMs:()=>60_000,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  const r=runtimes[0]!
  writeFileSync(join(project,'a1.txt'),'第一轮\n')
  r.finish()
  await expect.poll(()=>reviews(a.id).length,POLL).toBe(1)
  expect(reviews(a.id)[0]!.files).toEqual(['a1.txt'])
  // 基线是醒来那一下**异步**重取的(实测一次约 100ms),从外面看不见它什么时候落位。所以按
  // 「醒来 → 写一个新文件 → 静下来」一轮一轮试:只要基线在某一轮的写之前到位,那一轮就会生出
  // 一份快照。完全不重取的话这里永远等不到第二份 —— 这就是这条测试钉住的东西。
  // 每轮里「醒来」和「静下来」之间必须真的隔开:两件事挤在同一拍里的话,tool_call 被消费时
  // 快照已经翻回 idle,探测器一次转移都看不到(前后都算安静)。用一条排在 tool_call 后面的
  // 文本当路标,等它落库就说明这一下「不再安静」已经被看见了。
  // 轮数给足:一轮里「基线落位」和「写文件」谁先谁后靠的是机器快慢(基线是 IO/CPU 活,会随
  // 负载放大;路标那 150ms 是墙钟计时器,不会),所以真正保证收敛的是「多试几轮」而不是某个等待
  // 时长。实测常态 2 轮内就成;满载的 node runner 上见过一次十轮不够。
  for(let round=1;round<=25&&reviews(a.id).length<2;round++){
    r.write()
    r.say(`醒来 ${round}`)
    await expect.poll(()=>service.detail(a.id).events.some(e=>e.text===`醒来 ${round}`),POLL).toBe(true)
    writeFileSync(join(project,`w${round}.txt`),`第 ${round} 次醒来\n`)
    r.finish()
    await pause(200)
  }
  // 不写精确相等:满载时第 1 轮的快照可能晚于那 200ms 才落库,循环会多跑一轮、于是多出一份 ——
  // 那不影响这条测试要证明的事(第二份里有醒来写的文件),但会是一条假红。
  expect(reviews(a.id).length).toBeGreaterThanOrEqual(2)
  const second=reviews(a.id).find(shot=>shot.name.endsWith('-2.json'))!
  expect(second.files.some(path=>/^w\d+\.txt$/.test(path))).toBe(true)
  // 第一轮那份没有被重写:醒来的差异是独立的一份(序号后缀只从第二份起有)。
  expect(reviews(a.id).find(shot=>!/-\d+\.json$/.test(shot.name))!.files).toEqual(['a1.txt'])
})

/**
 * 修复轮 #1:取消计时这一下必须在 `submitInput` 的**入口**,不能放进「能实时投递」那个分支里。
 * `isReplied` 不看 `inputMode` —— 一条安静的运行若 runtime 只肯把补充排进队列,分支里的取消
 * 根本走不到,而计时还武装着:让位到点会话被收工,`cancelRun → holdInputs` 把这句话记成
 * 「任务已停止,补充尚未发送」,正是主人刚刚交上来的东西。
 */
it('runtime 只收排队的补充:计时照样取消,补充不会被收工冲掉',async()=>{
  setup({handoffGraceMs:()=>60,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  const r=runtimes[0]!
  r.finish()
  await expect.poll(()=>phase(a.id),POLL).toBe('replied')
  // 原生会话此刻不接收实时补充:只能排队。
  r.state={...r.state,input:'queue'}
  const b=create('B')
  const saved=await service.submitInput(a.id,{runId:service.detail(a.id).runId!,requestId:'66666666-6666-4666-8666-666666666666',text:'排着'})
  expect(saved.status).toBe('pending')
  expect(r.submitted).toBe(0)
  await pause(300)
  expect(status(a.id)).toBe('running')
  expect(closedEvent(a.id)).toBe(false)
  expect(service.detail(a.id).inputs.find(i=>i.id===saved.id)?.status).toBe('pending')
  expect(status(b.id)).toBe('queued')
})

/**
 * 修复轮 #6:主人已经交上来、还没投给执行者的补充不能被自动收工盖掉。修复轮 #1 把取消计时提到
 * 入口之后,这条路的触发者换成了「之后才来的等待者」—— `pump` 会为它重新武装短让位,而
 * `closeForIdle` / `quiet` 都不看「有没有未投递的补充」;收工走 `cancelRun`,结算时
 * `running.cancelled` 让这批补充走 `holdInputs` 而不是 `drainInputs`,主人拿到的还是
 * 「补充尚未发送」—— 和修复轮 #1 同一个失败形状。
 */
it('有一句还没投出去的补充:后来的等待者也不能把它收工掉',async()=>{
  setup({handoffGraceMs:()=>50,retainedIdleCloseMs:()=>60_000})
  const a=create('A');await said(a.id)
  const r=runtimes[0]!
  r.finish()
  await expect.poll(()=>phase(a.id),POLL).toBe('replied')
  // 原生会话此刻不收实时补充:这句话只能先存下来排着。
  r.state={...r.state,input:'queue'}
  const saved=await service.submitInput(a.id,{runId:service.detail(a.id).runId!,requestId:'77777777-7777-4777-8777-777777777777',text:'排着'})
  expect(saved.status).toBe('pending')
  // 补充存下来**之后**才有人来等这个文件夹 —— pump 会为 B 重新武装短让位。
  const b=create('B')
  await pause(300)
  expect(status(a.id)).toBe('running')
  expect(closedEvent(a.id)).toBe(false)
  expect(service.detail(a.id).inputs.find(i=>i.id===saved.id)?.status).toBe('pending')
  expect(r.submitted).toBe(0)
  expect(status(b.id)).toBe('queued')
  // 不是把文件夹永久锁住:这一句有了结果(这里是主人撤回)之后,让位照常发生。
  service.withdrawInput(a.id,saved.id)
  const c=create('C')
  await expect.poll(()=>status(a.id),POLL).toBe('completed')
  await expect.poll(()=>status(b.id),POLL).toBe('running')
  expect(status(c.id)).toBe('queued')
})
