import {afterEach,beforeEach,expect,it} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../provider-registry'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {makeMatterStore,type MatterStore} from '../matters/store'
import {wechatTaskMessageKey} from './wechat-control'

/**
 * 交办那一刻的出生地(docs/cc-workbench.md「一件事」;task-2,2026-09-23):
 * 从微信交办的事要记住来自哪个 chat(origin matter)、哪条消息(origin message);
 * 桌面 `service.create()` 亲手派的事没有出生地,两个字段都留空。
 */
function registerEcho(registry:ReturnType<typeof createProviderRegistry>){
  registry.register('claude',{async spawn(){return{
    async *dispatch(text:string){yield{kind:'text' as const,text:'结果：'+text};yield{kind:'result' as const,sessionId:'native-session',numTurns:1,durationMs:1}},async close(){},
  }}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
}
let area:string,project:string,db:Db,service:WorkbenchService,matters:MatterStore,logs:Array<[string,string]>
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-service-origin-')));project=join(area,'project');mkdirSync(project)
  db=openDb({path:join(area,'state.db')});matters=makeMatterStore(db);logs=[]
  const registry=createProviderRegistry();registerEcho(registry)
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'chat-1',matters,registeredProjects:()=>[{alias:'project',path:project}],log:(tag,line)=>logs.push([tag,line])})
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})

it('从微信交办的事记住出生地;桌面亲手派的不记',async()=>{
  const projectId=service.projects()[0]!.id
  const receipt=service.createWechat({ownerChatId:'chat-1',accountId:'acct-1',requestId:randomUUID(),commandHash:createHash('sha256').update('改首页').digest('hex'),originMessageId:'msg-7',projectId,providerId:'claude',text:'改首页'})
  const chat=matters.ensureChat('chat-1')
  expect(matters.get(receipt.taskId)).toMatchObject({originMatterId:chat.id,originMessageId:'msg-7'})

  const handmade=service.create({path:project,providerId:'claude',text:'手动派的'})
  expect(matters.get(handmade.id)).toMatchObject({originMatterId:null,originMessageId:null})
  // 正常路径不留痕 —— 日志只在 ensureChat 真的抛错时才响,不然"出错"和"本来就没有出生地"就分不清了。
  expect(logs).toEqual([])
})

it('没有 msgId 时不拦创建,origin message 存 null',async()=>{
  const projectId=service.projects()[0]!.id
  const receipt=service.createWechat({ownerChatId:'chat-1',accountId:'acct-1',requestId:randomUUID(),commandHash:createHash('sha256').update('无锚点').digest('hex'),projectId,providerId:'claude',text:'无锚点'})
  const chat=matters.ensureChat('chat-1')
  expect(matters.get(receipt.taskId)).toMatchObject({originMatterId:chat.id,originMessageId:null})
})

it('走微信入口(handleWechat)时,originMessageId 是 wechatTaskMessageKey 算出来的 messages.id,不是平台原始 msgId(终审第 5 项)',async()=>{
  const projectId=service.projects()[0]!.id
  const text=`任务 新建 ${projectId} 改首页`
  const identity={accountId:'acct-1',userId:'chat-1',msgId:'msg-99',createTimeMs:1}
  const reply=await service.handleWechat('chat-1',text,identity)
  expect(reply).toBeTruthy()
  const task=service.list().tasks[0]!
  const chat=matters.ensureChat('chat-1')
  const expectedId=wechatTaskMessageKey({...identity,chatId:'chat-1',text})
  expect(expectedId).not.toBe('msg-99') // 反证:wechatTaskMessageKey 算出来的确实不是原始 msgId
  expect(matters.get(task.id)).toMatchObject({originMatterId:chat.id,originMessageId:expectedId})
})

it('ensureChat 抛错时不拦建任务、origin 记 null,但留下能区分"出错"和"没有出生地"的痕迹',async()=>{
  const registry=createProviderRegistry();registerEcho(registry)
  const brokenLogs:Array<[string,string]>=[]
  const broken:MatterStore={...matters,ensureChat:()=>{throw new Error('schema drift')}}
  const service2=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'chat-1',matters:broken,registeredProjects:()=>[{alias:'project',path:project}],log:(tag,line)=>brokenLogs.push([tag,line])})
  try{
    const projectId=service2.projects()[0]!.id
    const receipt=service2.createWechat({ownerChatId:'chat-1',accountId:'acct-1',requestId:randomUUID(),commandHash:createHash('sha256').update('抛错也要建').digest('hex'),originMessageId:'msg-err',projectId,providerId:'claude',text:'抛错也要建'})
    // 任务照建、有回执 —— 出生地算不出来绝不阻塞交办。
    expect(receipt.taskId).toBeTruthy()
    // originMatterId 是 null,和"桌面亲手派的"字面上一样,但这不是设计里"没有出生地"的那种 null——
    // 下面这条日志就是区分两者的痕迹。
    expect(matters.get(receipt.taskId)).toMatchObject({originMatterId:null,originMessageId:'msg-err'})
    expect(brokenLogs).toHaveLength(1)
    expect(brokenLogs[0]![0]).toBe('MATTER_ORIGIN')
    expect(brokenLogs[0]![1]).toContain('schema drift')
    expect(brokenLogs[0]![1]).toContain('chat-1')
  }finally{await service2.shutdown()}
})
