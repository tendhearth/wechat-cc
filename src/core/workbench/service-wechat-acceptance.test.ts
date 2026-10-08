import {afterEach,beforeEach,expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdirSync,mkdtempSync,realpathSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {removeTempDir} from '../../lib/test-temp'
import {createProviderRegistry} from '../provider-registry'
import {makeMatterStore} from '../matters/store'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {makeTaskChangeHub} from './task-changes'

let area:string,source:string,db:Db,service:WorkbenchService,store:ReturnType<typeof makeWorkbenchStore>
let dispatched:Array<{providerId:string;path:string}>,minted:number,published:number
const git=(...args:string[])=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim()
function setup(defaultProvider='claude'){
 const registry=createProviderRegistry(),changes=makeTaskChangeHub()
 changes.onChange(()=>published++)
 for(const providerId of ['claude','codex'])registry.register(providerId,{async spawn(options){dispatched.push({providerId,path:options.path});return{async *dispatch(){yield{kind:'result' as const,sessionId:randomUUID(),numTurns:1,durationMs:1}},async close(){}}}},{displayName:providerId,canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
 return makeWorkbenchService({store,registry,changes,stateDir:join(area,'state'),managedWorkspaceRoot:join(area,'Tasks'),ownerChatId:()=> 'owner',defaultProvider,registeredProjects:()=>[{alias:'Source',path:source}],matters:makeMatterStore(db),mintSessionToken:()=>{minted++;return 'fixture-token'},isolatedConfiguration:{environment:{HOME:join(area,'home')},systemDirectories:[]}})
}
beforeEach(()=>{
 // Use the same physical path form as the workspace identity guard on Windows.
 area=realpathSync.native(mkdtempSync(join(tmpdir(),'cc-wechat-acceptance-')));source=join(area,'source')
 for(const path of [source,join(area,'state'),join(area,'home')])mkdirSync(path)
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');writeFileSync(join(source,'file.txt'),'original\n');git('add','.');git('commit','-qm','initial')
 db=openDb({path:join(area,'state','state.db')});store=makeWorkbenchStore(db);dispatched=[];minted=0;published=0;service=setup()
})
afterEach(async()=>{await service?.shutdown();db?.close();removeTempDir(area)})

// A swallowed mandatory matter write must never produce an accepted receipt or a live run.
it.each(['link','binding'] as const)('rolls back keyed Wechat acceptance on a matter %s failure and retries the frozen workspace once',async(point)=>{
 const matters=makeMatterStore(db),chat=matters.ensureChat('owner')
 const input={ownerChatId:'owner',accountId:'account',commandHash:'e'.repeat(64),requestId:randomUUID(),projectId:service.projects()[0]!.id,text:'Keep this request'}
 const before={branch:git('symbolic-ref','HEAD'),index:git('ls-files','--stage'),bytes:readFileSync(join(source,'file.txt'),'utf8')}
 db.exec(point==='link'
  ? "CREATE TRIGGER matter_fault BEFORE UPDATE OF matter_id ON workbench_tasks BEGIN SELECT RAISE(ABORT,'matter_fault'); END"
  : "CREATE TRIGGER matter_fault BEFORE INSERT ON matter_bindings WHEN NEW.matter_id IN (SELECT id FROM matters WHERE kind='task') BEGIN SELECT RAISE(ABORT,'matter_fault'); END")
 await expect(service.createWechat(input)).rejects.toThrow('matter_fault')
 expect(dispatched).toEqual([]);expect(minted).toBe(0);expect(published).toBe(0)
 for(const table of ['workbench_tasks','workbench_events','workbench_run_execution','workbench_creation_receipts','workbench_projects','workbench_wechat_subscriptions','workbench_wechat_notices','workbench_wechat_notice_intents'])expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([])
 expect(matters.list({kind:'task'})).toEqual([])
 expect(db.query('SELECT * FROM matter_bindings WHERE matter_id <> ?').all(chat.id)).toEqual([])
 const reserved=store.entryRequests.get('owner',input.requestId)!,workspace=store.gitWorkspaces.get(reserved.workspaceId!)!
 expect(reserved).toMatchObject({phase:'reserved',hashVersion:2,sourcePath:source,resolvedMode:'isolated',providerId:'claude',resolvedPath:workspace.executionPath,taskId:null,matterId:null,runId:null,acceptedAt:null})
 db.exec('DROP TRIGGER matter_fault');await service.shutdown();service=setup('codex')
 await expect(service.createWechat({...input,executionMode:'project'})).rejects.toThrow('creation_conflict')
 writeFileSync(join(source,'file.txt'),'changed source\n')
 await expect(service.createWechat(input)).rejects.toThrow('git_workspace_changed')
 expect(store.list()).toEqual([]);expect(dispatched).toEqual([]);expect(minted).toBe(0);expect(published).toBe(0)
 writeFileSync(join(source,'file.txt'),'original\n')
 const accepted=await service.createWechat(input)
 expect(accepted).toMatchObject({path:workspace.executionPath,providerId:'claude'})
 await expect.poll(()=>service.detail(accepted.taskId).task.status).toBe('completed')
 expect(await service.createWechat(input)).toEqual(accepted)
 expect(store.list()).toHaveLength(1);expect(dispatched).toEqual([{providerId:'claude',path:workspace.executionPath}]);expect(minted).toBe(1)
 const {updatedAt:_checkedAt,...frozenWorkspace}=workspace
 expect(store.gitWorkspaces.get(workspace.id)).toMatchObject(frozenWorkspace);expect(db.query('SELECT * FROM workbench_git_workspaces').all()).toHaveLength(1)
 expect(store.entryRequests.get('owner',input.requestId)).toMatchObject({phase:'accepted',taskId:accepted.taskId,matterId:accepted.taskId,runId:accepted.runId,sourcePath:source,resolvedPath:workspace.executionPath,providerId:'claude'})
 expect(store.taskMatterId(accepted.taskId)).toBe(accepted.taskId)
 expect(matters.get(accepted.taskId)).toMatchObject({projectPath:source,ownerChatId:'owner',originMatterId:chat.id,originMessageId:null})
 expect(matters.bindings(accepted.taskId)).toEqual([{matterId:accepted.taskId,surface:'wechat',surfaceKey:'owner',lastSeenAt:expect.any(Number)}])
 expect(store.wechatNotifications.subscription(accepted.taskId)).toMatchObject({ownerChatId:'owner',accountId:'account',enabled:true})
 expect({branch:git('symbolic-ref','HEAD'),index:git('ls-files','--stage'),bytes:readFileSync(join(source,'file.txt'),'utf8')}).toEqual(before)
})
