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

/**
 * 交办那一刻的出生地(docs/cc-workbench.md「一件事」;task-2,2026-09-23):
 * 从微信交办的事要记住来自哪个 chat(origin matter)、哪条消息(origin message);
 * 桌面 `service.create()` 亲手派的事没有出生地,两个字段都留空。
 */
let area:string,project:string,db:Db,service:WorkbenchService,matters:MatterStore
beforeEach(()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'cc-service-origin-')));project=join(area,'project');mkdirSync(project)
  db=openDb({path:join(area,'state.db')});matters=makeMatterStore(db)
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(){return{
    async *dispatch(text:string){yield{kind:'text' as const,text:'结果：'+text};yield{kind:'result' as const,sessionId:'native-session',numTurns:1,durationMs:1}},async close(){},
  }}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'chat-1',matters,registeredProjects:()=>[{alias:'project',path:project}]})
})
afterEach(async()=>{await service?.shutdown();db.close();removeTempDir(area)})

it('从微信交办的事记住出生地;桌面亲手派的不记',async()=>{
  const projectId=service.projects()[0]!.id
  const receipt=service.createWechat({ownerChatId:'chat-1',accountId:'acct-1',requestId:randomUUID(),commandHash:createHash('sha256').update('改首页').digest('hex'),originMessageId:'msg-7',projectId,providerId:'claude',text:'改首页'})
  const chat=matters.ensureChat('chat-1')
  expect(matters.get(receipt.taskId)).toMatchObject({originMatterId:chat.id,originMessageId:'msg-7'})

  const handmade=service.create({path:project,providerId:'claude',text:'手动派的'})
  expect(matters.get(handmade.id)).toMatchObject({originMatterId:null,originMessageId:null})
})

it('没有 msgId 时不拦创建,origin message 存 null',async()=>{
  const projectId=service.projects()[0]!.id
  const receipt=service.createWechat({ownerChatId:'chat-1',accountId:'acct-1',requestId:randomUUID(),commandHash:createHash('sha256').update('无锚点').digest('hex'),projectId,providerId:'claude',text:'无锚点'})
  const chat=matters.ensureChat('chat-1')
  expect(matters.get(receipt.taskId)).toMatchObject({originMatterId:chat.id,originMessageId:null})
})

it('走微信入口(handleWechat)时,identity.msgId 也落到 originMessageId',async()=>{
  const projectId=service.projects()[0]!.id
  const reply=await service.handleWechat('chat-1',`任务 新建 ${projectId} 改首页`,{accountId:'acct-1',userId:'chat-1',msgId:'msg-99',createTimeMs:1})
  expect(reply).toBeTruthy()
  const task=service.list().tasks[0]!
  const chat=matters.ensureChat('chat-1')
  expect(matters.get(task.id)).toMatchObject({originMatterId:chat.id,originMessageId:'msg-99'})
})
