import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { makeWorkbenchStore } from '../../../adapters/store/workbench/store'
import { saveRestartContinuations, type RestartContinuation } from '../../../adapters/workbench/restart-continuations'
import { recoverRestartContinuations, RESTART_RESUME_TEXT } from './restart-resume'
import type { ServiceCtx } from './ctx'
import { createProviderRegistry } from '../../../app/provider-registry'
import { directoryIdentity } from './directory-identity'

const dirs:string[]=[],dbs:Db[]=[]
afterEach(()=>{for(const db of dbs.splice(0))db.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
function setup() {
  const stateDir=realpathSync(mkdtempSync(join(tmpdir(),'restart-resume-')));dirs.push(stateDir)
  const db=openTestDb();dbs.push(db)
  const store=makeWorkbenchStore(db),task=store.create({title:'工作',path:stateDir,providerId:'claude',ownerChatId:'owner'})
  store.execution.accept(task.id,'before',{defaults:'provider',model:null,reasoningEffort:null})
  const lastUserId=store.addEvent(task.id,'user','原要求',null,'before')
  store.update(task.id,'cancelled','daemon_restarted')
  const entry:RestartContinuation={taskId:task.id,runId:'before',lastUserId,pendingDecision:false,directoryIdentity:directoryIdentity(stateDir),unstarted:false}
  const registry=createProviderRegistry();registry.register('claude',{spawn:async()=>{throw Error('not used')}},{canResume:()=>true})
  const ctx={store,stateDir,state:{runsByTask:new Map(),stopping:false},deps:{registry},log:vi.fn()} as unknown as ServiceCtx
  const continueTask=vi.fn(()=>({}) as never)
  const save=(over:Partial<RestartContinuation>={})=>saveRestartContinuations(stateDir,[{...entry,...over}])
  const recover=()=>recoverRestartContinuations(ctx,{continueTask})
  return {task,store,ctx,save,recover,continueTask,entry,stateDir}
}
describe('部署重启的一次续接',()=>{
  it('同一份凭据只消费一次；使用稳定request id及中断说明',()=>{
    const s=setup();s.save();s.recover();s.recover()
    expect(s.continueTask).toHaveBeenCalledTimes(1)
    expect(s.continueTask).toHaveBeenCalledWith(s.task.id,RESTART_RESUME_TEXT,{inputRequestId:expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/)})
    const request=s.continueTask.mock.calls[0]
    s.save();s.recover();expect(s.continueTask.mock.calls[1]).toEqual(request)
  })
  it('原生会话恢复门拒绝时只说明一次，不擅自fresh或重复尝试',()=>{
    const s=setup();s.save();s.continueTask.mockImplementation(()=>{throw Error('restart_confirmation_required')})
    s.recover();s.recover()
    expect(s.continueTask).toHaveBeenCalledTimes(1)
    expect(s.store.events(s.task.id).at(-1)?.text).toContain('restart_confirmation_required')
    expect(s.store.events(s.task.id).at(-1)?.text).toContain('不会重复尝试')
  })
  it('主人取消、归档、已完成、未确认退出都不能被重启凭据唤醒',()=>{
    for(const state of ['cancelled','archived','completed','writer_not_closed'] as const) {
      const s=setup();s.save()
      if(state==='archived')s.store.setArchived(s.task.id,true)
      else s.store.update(s.task.id,state==='writer_not_closed'?'interrupted':state,state==='writer_not_closed'?'writer_not_closed':null)
      s.recover();expect(s.continueTask).not.toHaveBeenCalled()
    }
  })
  it('主人有新输入、新运行或当前仍有run时，旧凭据失效',()=>{
    const input=setup();input.save();input.store.addEvent(input.task.id,'user','新要求');input.recover();expect(input.continueTask).not.toHaveBeenCalled()
    const run=setup();run.save();run.store.execution.accept(run.task.id,'new',{defaults:'provider',model:null,reasoningEffort:null});run.recover();expect(run.continueTask).not.toHaveBeenCalled()
    const live=setup();live.save();live.ctx.state.runsByTask.set(live.task.id,{} as never);live.recover();expect(live.continueTask).not.toHaveBeenCalled()
  })
  it('重启时正在等批准或回答，不替主人作决定；留下可见说明',()=>{
    const s=setup();s.save({pendingDecision:true});s.recover()
    expect(s.continueTask).not.toHaveBeenCalled()
    expect(s.store.events(s.task.id).at(-1)?.text).toContain('当时有待批准或待回答')
  })
})
