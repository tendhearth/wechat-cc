import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdirSync,mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../../app/provider-registry'
import {makeWorkbenchStore} from '../../adapters/store/workbench/store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from '../../domain/workbench/executor-capabilities'

// 话题 T3:起执行者时话题简报接在指令里;一轮真的完成了 ⇒ onTaskTurnCompleted(task.id);简报拿不到 / 抛错 ⇒ 照常起。
let area:string,project:string,db:Db,service:WorkbenchService,seen:string[],asked:Array<{matterId:string;title:string;text:string}>,done:string[]
let brief:(t:{matterId:string;title:string;text:string})=>Promise<string|null>
beforeEach(()=>{area=realpathSync(mkdtempSync(join(tmpdir(),'cc-topics-')));project=join(area,'project');mkdirSync(project);db=openDb({path:join(area,'state.db')});seen=[];asked=[];done=[]
  const registry=createProviderRegistry()
  registry.register('codex',{async spawn(_p,ctx){seen.push(ctx.appendInstructions??'');return{async *dispatch(){yield{kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'owner',
    topicBrief:async(t)=>{asked.push({matterId:t.matterId,title:t.title,text:t.text});return brief(t)},
    onTaskTurnCompleted:(id)=>{done.push(id)}})})
afterEach(async()=>{await service.shutdown();db.close();removeTempDir(area)})

it('简报接在执行者指令里;做完一轮报 task.id',async()=>{
  brief=async()=>'CC 记得的相关背景:\n话题「bx」\n- [决定] UDP 走 hysteria2'
  const t=service.create({path:project,providerId:'codex',text:'修一下 bx 的 UDP'})
  await expect.poll(()=>seen.length).toBe(1)
  expect(seen[0]).toContain('- [决定] UDP 走 hysteria2')
  expect(asked[0]!.text).toBe('修一下 bx 的 UDP')
  await expect.poll(()=>done).toEqual([t.id])
})

it('没有简报 / 抛错 ⇒ 指令里没有这一段,照常起',async()=>{
  brief=async()=>null
  service.create({path:project,providerId:'codex',text:'x'})
  await expect.poll(()=>seen.length).toBe(1)
  expect(seen[0]).not.toContain('CC 记得的相关背景')
  brief=async()=>{throw new Error('boom')}
  service.create({path:project,providerId:'codex',text:'y'})
  await expect.poll(()=>seen.length).toBe(2)
  expect(seen[1]).not.toContain('CC 记得的相关背景')
})
