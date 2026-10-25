import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdirSync,mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../../app/provider-registry'
import {makeWorkbenchStore} from '../../core/workbench/store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from '../../core/workbench/executor-capabilities'

// 项目经验(第二轮对标 ★2):不管哪家执行者,指令里都带上这个项目的经验;没有就不带。
let area:string,project:string,db:Db,service:WorkbenchService,seen:string[]
const lessons:Record<string,string>={}
beforeEach(()=>{area=realpathSync(mkdtempSync(join(tmpdir(),'cc-lessons-')));project=join(area,'project');mkdirSync(project);db=openDb({path:join(area,'state.db')});seen=[]
  const registry=createProviderRegistry()
  registry.register('codex',{async spawn(_p,ctx){seen.push(ctx.appendInstructions??'');return{async *dispatch(){yield{kind:'result' as const,sessionId:'s',numTurns:1,durationMs:1}},async close(){}}}},{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:area,ownerChatId:()=>'owner',projectLessons:(p)=>p?lessons[p]??null:null})})
afterEach(async()=>{await service.shutdown();db.close();removeTempDir(area)})

it('the project lessons ride along in every executor instructions; a project without lessons gets none',async()=>{
  lessons[project]='这个项目的经验(主人写的,所有执行者都照着做):\n- 用 bun,不要 npm'
  const t=service.create({path:project,providerId:'codex',text:'x'})
  await expect.poll(()=>seen.length).toBe(1)
  expect(seen[0]).toContain('- 用 bun,不要 npm')
  delete lessons[project]
  const t2=service.create({path:project,providerId:'codex',text:'y'})
  await expect.poll(()=>seen.length).toBe(2)
  expect(seen[1]).not.toContain('这个项目的经验')
  void t;void t2
})
