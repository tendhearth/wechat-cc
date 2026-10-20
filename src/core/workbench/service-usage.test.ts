import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdirSync,mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../provider-registry'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'

// 每件事花了多少额度(v82):执行者在 result 上带的用量落一行,详情里给合计;不报的那家就是 null(「这家不报」)。
let area:string,project:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>
beforeEach(()=>{area=realpathSync(mkdtempSync(join(tmpdir(),'cc-usage-')));project=join(area,'project');mkdirSync(project);db=openDb({path:join(area,'state.db')})
  const registry=createProviderRegistry()
  registry.register('claude',{async spawn(){return{async *dispatch(){yield{kind:'text' as const,text:'好了'};yield{kind:'result' as const,sessionId:'s',numTurns:1,durationMs:3,usage:{input:120,output:30,cacheRead:900}}},async close(){}}}},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  registry.register('codex',{async spawn(){return{async *dispatch(){yield{kind:'text' as const,text:'好了'};yield{kind:'result' as const,sessionId:'s',numTurns:1,durationMs:3}},async close(){}}}},{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  store=makeWorkbenchStore(db);service=makeWorkbenchService({store,registry,stateDir:area,ownerChatId:()=>'owner'})})
afterEach(async()=>{await service.shutdown();db.close();removeTempDir(area)})
const settled=async(id:string)=>{await expect.poll(()=>service.detail(id).task.status).toBe('completed')}

it('records the reported usage per turn and shows a per-task total in detail',async()=>{
  const t=service.create({path:project,providerId:'claude',text:'x'})
  await settled(t.id)
  expect(service.detail(t.id).task.usage).toEqual({turns:1,input:120,output:30,cacheRead:900,cacheWrite:null,reasoning:null,costUsd:null})
})
it('an executor that reports nothing ⇒ no usage on the task (not zeros)',async()=>{
  const t=service.create({path:project,providerId:'codex',text:'x'})
  await settled(t.id)
  expect(service.detail(t.id).task.usage).toBeUndefined()
})
