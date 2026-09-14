import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import type {AgentProvider,AgentEvent,SpawnContext} from '../agent-provider'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'

let root:string,project:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>,service:WorkbenchService,owner:string|null
const message={accountId:'account-one',userId:'owner',msgId:'create',createTimeMs:1}
const result:AgentEvent={kind:'result',sessionId:'native-one',numTurns:1,durationMs:1}
function setup(provider:AgentProvider){
  const registry=createProviderRegistry();registry.register('claude',provider,{displayName:'Claude',canResume:()=>true})
  service=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>owner,registeredProjects:()=>[{alias:'project',path:project}]})
}
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return{promise,resolve}}
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'cc-task-notices-')));project=join(root,'project');mkdirSync(project);db=openDb({path:join(root,'state.db')});store=makeWorkbenchStore(db);owner='owner'})
afterEach(async()=>{await service.shutdown();db.close();rmSync(root,{recursive:true,force:true})})
async function create(){return service.handleWechat('owner',`任务 新建 ${service.projects()[0]!.id} 整理报告`,message)}
const settled=async(id:string)=>expect.poll(()=>service.detail(id).task.status).toBe('completed')

describe('original task/run attention and completion notices',()=>{
  it('subscribes phone creations before first event and freezes completion before the next run',async()=>{
    let count=0
    setup({async spawn(){return{async *dispatch(){yield{kind:'text',text:`第 ${++count} 轮的结果`};yield result},async close(){}}}})
    const reply=await create(),task=service.list().tasks[0]!;await settled(task.id)
    expect(reply).toContain('提醒')
    const watch=store.wechatNotifications.subscription(task.id)
    expect(watch).toMatchObject({enabled:true,accountId:'account-one',ownerChatId:'owner'})
    const first=store.wechatNotifications.list(task.id)[0]!
    expect(first.kind).toBe('completed');expect(first.text).toContain('第 1 轮的结果')
    service.continueTask(task.id,'继续');await settled(task.id)
    expect(store.wechatNotifications.list(task.id).find(n=>n.id===first.id)).toEqual(first)
    expect(store.wechatNotifications.list(task.id)).toHaveLength(2)
    expect(service.notificationEligible(first)).toBe(true)
  })
  it('binds permission/question notices to exact live requests and suppresses resolved requests',async()=>{
    let context!:SpawnContext
    const hold=gate()
    setup({async spawn(_p,c){context=c;return{async *dispatch(){await c.requestPermission!({tool:'Bash',description:'write report'});await c.requestUserInput!({questions:[{id:'format',header:'格式',question:'选择格式',options:[{label:'PDF',description:''}]}]});await hold.promise;yield result},async close(){hold.resolve()}}}})
    await create();const task=service.list().tasks[0]!
    await expect.poll(()=>service.detail(task.id).permissions.length).toBe(1)
    const permission=service.detail(task.id).permissions[0]!,notice=store.wechatNotifications.list(task.id).find(n=>n.kind==='permission')!
    expect(notice.runId).toBe(service.detail(task.id).runId);expect(notice.requestId).toBe(permission.id)
    expect(service.notificationEligible(notice)).toBe(true)
    expect(await service.handleWechat('owner',`任务 ${task.id} 允许 ${permission.id}`,{...message,msgId:'allow'})).toContain('已允许')
    expect(service.notificationEligible(notice)).toBe(false)
    await expect.poll(()=>service.detail(task.id).questions.length).toBe(1)
    const question=service.detail(task.id).questions[0]!,qn=store.wechatNotifications.list(task.id).find(n=>n.kind==='question')!
    expect(qn.text).toContain(question.id);expect(service.notificationEligible(qn)).toBe(true)
    service.resolveAnswer(task.id,question.id,{format:['PDF']})
    expect(service.notificationEligible(qn)).toBe(false)
    expect(context).toBeDefined();hold.resolve();await settled(task.id)
  })
  it('keeps desktop tasks silent until asked, reserves reminder commands and honours mute/owner changes',async()=>{
    const hold=gate();setup({async spawn(){return{async *dispatch(){await hold.promise;yield result},async close(){hold.resolve()}}}})
    const task=service.create({path:project,providerId:'claude',text:'desktop task'})
    expect(store.wechatNotifications.subscription(task.id)).toBeNull()
    const userEvents=()=>store.events(task.id).filter(e=>e.kind==='user')
    expect(await service.handleWechat('owner',`任务 ${task.id} 提醒我`,message)).toContain('提醒')
    expect(userEvents()).toHaveLength(1)
    hold.resolve();await settled(task.id);const notice=store.wechatNotifications.list(task.id)[0]!
    expect(service.notificationEligible(notice)).toBe(true)
    expect(await service.handleWechat('owner',`任务 ${task.id} 静音`,{...message,msgId:'mute'})).toContain('关闭')
    expect(service.notificationEligible(notice)).toBe(false);expect(userEvents()).toHaveLength(1)
    await service.handleWechat('owner',`任务 ${task.id} 提醒我`,{...message,msgId:'watch-again'})
    expect(service.notificationEligible(notice)).toBe(false)
    owner='new-owner';expect(service.notificationEligible(notice)).toBe(false)
  })
  it('does not mark a retained idle runtime completed after its foreground reply',async()=>{
    const hold=gate()
    setup({async spawn(){return{async *dispatch(){throw Error('not used')},workbenchRuntime:{
      events:(async function*(){yield{kind:'text' as const,text:'foreground only'};yield result;await hold.promise})(),
      start(){},async submit(){},snapshot(){return{retained:true,foreground:'idle' as const,backgroundCount:0,input:'send' as const}},
    },async close(){hold.resolve()}}}})
    await create();const task=service.list().tasks[0]!
    await expect.poll(()=>service.detail(task.id).events.some(e=>e.text==='foreground only')).toBe(true)
    expect(service.detail(task.id).task.status).toBe('running')
    expect(store.wechatNotifications.list(task.id)).toEqual([])
    await service.cancel(task.id)
  })
  it('does not let a redelivered old watch command undo a later mute',async()=>{
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    const task=service.create({path:project,providerId:'claude',text:'desktop'})
    await settled(task.id)
    const watch=`任务 ${task.id} 提醒我`,mute=`任务 ${task.id} 静音`
    const original=await service.handleWechat('owner',watch,{...message,msgId:'watch'})
    await service.handleWechat('owner',mute,{...message,msgId:'mute'})
    expect(await service.handleWechat('owner',watch,{...message,msgId:'watch'})).toBe(original)
    expect(store.wechatNotifications.subscription(task.id)?.enabled).toBe(false)
  })
  it('keeps a terminal notification intent through outbox failure and service restart',async()=>{
    const provider:AgentProvider={async spawn(){return{async *dispatch(){yield{kind:'text',text:'已经保存的原结果'};yield result},async close(){}}}}
    setup(provider)
    db.exec("CREATE TRIGGER fail_notice_insert BEFORE INSERT ON workbench_wechat_notices BEGIN SELECT RAISE(FAIL, 'transient outbox failure'); END")
    await create();const task=service.list().tasks[0]!;await settled(task.id)
    expect(store.wechatNotifications.list(task.id)).toEqual([])
    await service.shutdown();db.close();db=openDb({path:join(root,'state.db')});store=makeWorkbenchStore(db);setup(provider)
    db.exec('DROP TRIGGER fail_notice_insert')
    store.wechatNotifications.materializeIntents()
    const notices=store.wechatNotifications.list(task.id)
    expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({kind:'completed',accountId:'account-one',ownerChatId:'owner'})
    expect(notices[0]!.text).toContain('已经保存的原结果')
    expect(service.detail(task.id).task.status).toBe('completed')
  })
  it('holds queued supplements when the terminal status and intent transaction rolls back',async()=>{
    const hold=gate(),seen:string[]=[]
    setup({async spawn(){return{async *dispatch(text){seen.push(text);yield{kind:'init',sessionId:'native-one'};await hold.promise;yield result},async close(){}}}})
    await create();const task=service.list().tasks[0]!
    await expect.poll(()=>seen.length).toBe(1)
    await service.submitInput(task.id,{runId:service.detail(task.id).runId!,requestId:crypto.randomUUID(),text:'second'})
    db.exec("CREATE TRIGGER fail_terminal_intent BEFORE INSERT ON workbench_wechat_notice_intents BEGIN SELECT RAISE(FAIL, 'terminal storage unavailable'); END")
    hold.resolve()
    await expect.poll(()=>service.detail(task.id).inputs[0]?.status).toBe('held')
    expect(seen).toHaveLength(1)
    expect(service.detail(task.id).task.status).not.toBe('completed')
    expect(store.wechatNotifications.list(task.id)).toEqual([])
  })
})
