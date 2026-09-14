import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {mkdtempSync,mkdirSync,realpathSync,renameSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'

let root:string,project:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>,service:WorkbenchService
let owner:string|null,registered:Array<{alias:string,path:string}>,seen:Array<{path:string,text:string,provider:string}>
const message={accountId:'wechat-account',userId:'owner',msgId:'create-message',createTimeMs:1}
function setup(defaultProvider='codex'){
  const registry=createProviderRegistry()
  for(const provider of ['claude','codex'])registry.register(provider,{async spawn(project){return{
    async *dispatch(text){seen.push({path:project.path,text,provider});yield{kind:'text' as const,text:'结果：'+text};yield{kind:'result' as const,sessionId:'native-session',numTurns:1,durationMs:1}},async close(){},
  }}},{displayName:provider,canResume:()=>true})
  store=makeWorkbenchStore(db)
  service=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>owner,defaultProvider,registeredProjects:()=>registered})
}
beforeEach(()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),'cc-wechat-create-')));project=join(root,'project');mkdirSync(project)
  db=openDb({path:join(root,'state.db')});owner='owner';registered=[{alias:'project',path:project}];seen=[];setup()
})
afterEach(async()=>{await service.shutdown();db.close();rmSync(root,{recursive:true,force:true})})
const command=(text='整理周报')=>`任务 新建 ${service.projects()[0]!.id} ${text}`
const settle=async(id:string)=>expect.poll(()=>service.detail(id).task.status).toBe('completed')

describe('create one shared workbench task from WeChat',()=>{
  it('lists known projects and creates the same desktop-visible task with an explicit executor',async()=>{
    const projects=await service.handleWechat('owner','任务 项目',message)
    expect(projects).toContain(project);expect(projects).toContain(service.projects()[0]!.id)
    const reply=await service.handleWechat('owner',command('用 Claude 保留原接口\n整理周报'),message)
    const task=service.list().tasks[0]!;await settle(task.id)
    expect(reply).toContain(task.id);expect(reply).toContain('claude');expect(reply).toContain(project)
    expect(task).toMatchObject({providerId:'claude',path:project})
    expect(store.events(task.id).filter(e=>e.kind==='user').map(e=>e.text)).toEqual(['保留原接口\n整理周报'])
    expect(seen).toEqual([{path:project,text:'保留原接口\n整理周报',provider:'claude'}])
    service.continueTask(task.id,'桌面追加说明');await settle(task.id)
    expect(await service.handleWechat('owner',`任务 ${task.id}`)).toContain('桌面追加说明')
  })
  it('replays its original acceptance after finish, restart, provider change and missing project',async()=>{
    const text=command(),first=await service.handleWechat('owner',text,message),task=service.list().tasks[0]!
    expect(await service.handleWechat('owner',text,message)).toBe(first);await settle(task.id)
    await service.shutdown();db.close();db=openDb({path:join(root,'state.db')});registered=[];setup('claude')
    renameSync(project,project+'-moved')
    expect(await service.handleWechat('owner',text,message)).toBe(first)
    expect(service.list().tasks).toHaveLength(1);expect(seen).toHaveLength(1)
    expect(store.events(task.id).filter(e=>e.kind==='user')).toHaveLength(1)
  })
  it('rejects changed content on the same message without creating another task',async()=>{
    const text=command(),first=await service.handleWechat('owner',text,message)
    const reply=await service.handleWechat('owner',text+' changed',message)
    expect(first).toContain(service.list().tasks[0]!.id);expect(reply).toContain('不一致')
    expect(service.list().tasks).toHaveLength(1)
  })
  it('does not confuse equal timestamps from different messages',async()=>{
    const text=command()
    await service.handleWechat('owner',text,message)
    await service.handleWechat('owner',text,{...message,msgId:'other-create'})
    expect(service.list().tasks).toHaveLength(2)
  })
  it('requires an authorized real sender and account for creation',async()=>{
    const text=command()
    expect(await service.handleWechat('other',text,{...message,userId:'other'})).toBeNull()
    expect(await service.handleWechat('owner',text,{...message,userId:'other'})).toBeNull()
    expect(await service.handleWechat('owner',text)).toContain('无法确认')
    expect(await service.handleWechat('owner',text,{...message,accountId:''})).toContain('无法确认')
    expect(service.list().tasks).toHaveLength(0)
  })
  it('never retargets a project ID after directory replacement or owner change',async()=>{
    const text=command()
    renameSync(project,project+'-old');mkdirSync(project)
    expect(await service.handleWechat('owner',text,message)).toContain('项目')
    expect(service.list().tasks).toHaveLength(0)
    const valid=command();owner='new-owner'
    expect(await service.handleWechat('new-owner',valid,{...message,userId:'new-owner'})).toContain('项目')
    expect(service.list().tasks).toHaveLength(0)
  })
  it('rolls back all task/run/input acceptance and schedules nothing if receipt persistence fails',async()=>{
    const text=command()
    store.creationReceipts.add=()=>{throw Error('disk failure')}
    const reply=await service.handleWechat('owner',text,message)
    expect(reply).toContain('暂时无法')
    await Promise.resolve();await Promise.resolve()
    expect(service.list().tasks).toHaveLength(0);expect(seen).toHaveLength(0)
    expect(db.query('SELECT count(*) AS n FROM workbench_events').get()).toEqual({n:0})
    expect(db.query('SELECT count(*) AS n FROM workbench_run_execution').get()).toEqual({n:0})
    expect(service.attention().tasks).toHaveLength(0)
  })
})
