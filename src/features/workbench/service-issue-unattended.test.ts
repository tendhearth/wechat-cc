import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdirSync,mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../../app/provider-registry'
import {makeWorkbenchStore} from '../../core/workbench/store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {UNATTENDED_CAPABILITIES} from '../../core/workbench/executor-capabilities'
import {issueTaskText} from './issue-intake'

// 评审 #446:免审执行者不收从 issue 建的任务 —— 没人看着 + 外来文字,两道闸都没了(同 until 拒免审)。
let area:string,project:string,db:Db,service:WorkbenchService
beforeEach(()=>{area=realpathSync(mkdtempSync(join(tmpdir(),'cc-issue-ua-')));project=join(area,'project');mkdirSync(project);db=openDb({path:join(area,'state.db')})
  const registry=createProviderRegistry()
  registry.register('agy',{async spawn(){return{async *dispatch(){yield{kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'agy',canResume:()=>true,workbench:UNATTENDED_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'owner',unattendedAck:{get:()=>1,set:()=>undefined}})})
afterEach(async()=>{await service.shutdown();db.close();removeTempDir(area)})

it('an unattended executor refuses a task created from an issue, even after the owner acknowledged unattended mode; ordinary text still runs',()=>{
  const text=issueTaskText({number:3,title:'t',body:'b',url:'u',state:'OPEN',comments:[]})
  expect(()=>service.create({path:project,providerId:'agy',text})).toThrow('issue_unattended_unsupported')
  expect(()=>service.create({path:project,providerId:'agy',text:'整理周报'})).not.toThrow()
})
