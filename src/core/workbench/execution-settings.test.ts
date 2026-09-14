import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openDb,type Db} from '../../lib/db'
import {makeWorkbenchStore} from './store'
import type {AgentExecutionChoice} from '../agent-provider'
import {executionFailureMessage,normalizeExecutionChoice,sameExecutionChoice} from './execution-settings'

const provider:AgentExecutionChoice={defaults:'provider',model:null,reasoningEffort:null}
const native:AgentExecutionChoice={defaults:'native',model:null,reasoningEffort:null}
const selected:AgentExecutionChoice={defaults:'provider',model:'model-a',reasoningEffort:'high'}

it('turns API task failures into actionable Chinese guidance',()=>{
  expect(executionFailureMessage('api_task_attachment_unsupported')).toContain('PDF')
  expect(executionFailureMessage('api_task_incomplete')).toContain('未完整结束')
  expect(executionFailureMessage('api_task_response_invalid')).toContain('响应')
  expect(executionFailureMessage('api_task_scope_changed')).toContain('文件夹')
  expect(executionFailureMessage('api_task_cancelled')).toContain('已停止')
})
let dir:string,db:Db,store:ReturnType<typeof makeWorkbenchStore>
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'cc-execution-'));db=openDb({path:join(dir,'db.sqlite')});store=makeWorkbenchStore(db)})
afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true})})
function task(){return store.create({title:'task',path:'/owned/project',providerId:'claude',ownerChatId:null})}
function execution(){expect(store).toHaveProperty('execution');return store.execution}

it('exposes automatic defaults for a just-created task within its acceptance transaction',()=>{
  store.atomic(()=>{
    const row=task(),before=store.get(row.id)
    expect(execution().choice(row.id)).toEqual(provider)
    expect(execution().last(row.id)).toBeNull()
    execution().accept(row.id,'run-one',selected)
    expect(execution().choice(row.id)).toEqual(selected)
    expect(store.get(row.id)).toEqual(before)
  })
  expect(()=>execution().choice('missing')).toThrow('not_found')
})

it('retains choices and native observations across database reopen without changing task or request history',()=>{
  const row=task(),before=store.get(row.id)
  execution().accept(row.id,'run-one',selected)
  const accepted=execution().run(row.id,'run-one')!
  expect(accepted).toMatchObject({taskId:row.id,runId:'run-one',choice:selected,effective:null,observedAt:null})
  expect(accepted.createdAt).toEqual(expect.any(Number))
  execution().observe(row.id,'run-one',{model:'resolved-model',source:'native_response',sessionId:'native-1'})
  const observed=execution().run(row.id,'run-one')!
  expect(observed.effective).toEqual({model:'resolved-model',source:'native_response',sessionId:'native-1'})
  expect(observed.observedAt).toEqual(expect.any(Number))
  expect(observed.choice).toEqual(selected)
  expect(store.get(row.id)).toEqual(before)
  expect(store.events(row.id)).toEqual([])
  db.close();db=openDb({path:join(dir,'db.sqlite')});store=makeWorkbenchStore(db)
  expect(execution().choice(row.id)).toEqual(selected)
  expect(execution().last(row.id)).toEqual(observed)
})

it('keeps immutable run identity and does not rewind current choice when an older acceptance is replayed',()=>{
  const a=task(),b=task()
  execution().accept(a.id,'run-one',selected)
  const original=execution().run(a.id,'run-one')!
  const later={...selected,model:'model-b'}
  execution().accept(a.id,'run-two',later)
  execution().accept(a.id,'run-one',{reasoningEffort:'high',model:'model-a',defaults:'provider'})
  expect(execution().run(a.id,'run-one')).toEqual(original)
  expect(execution().choice(a.id)).toEqual(later)
  expect(execution().last(a.id)?.runId).toBe('run-two')
  expect(execution().choice(b.id)).toEqual(provider)
  expect(execution().run(b.id,'run-one')).toBeNull()
  expect(()=>execution().accept(a.id,'run-one',native)).toThrow('execution_conflict')
  expect(()=>execution().accept(b.id,'run-one',selected)).toThrow('execution_conflict')
  expect(()=>execution().observe(b.id,'run-one',{model:'other',source:'native_message'})).toThrow('not_found')
})

it('rolls accepted choice and run back with the surrounding input acceptance transaction',()=>{
  const row=task()
  expect(()=>store.atomic(()=>{execution().accept(row.id,'run-one',selected);throw Error('input-failed')})).toThrow('input-failed')
  expect(execution().choice(row.id)).toEqual(provider)
  expect(execution().run(row.id,'run-one')).toBeNull()
})

it('imports original native sessions with native defaults and never resets a managed import on retry',()=>{
  const input={providerId:'claude' as const,nativeId:'native-existing',cwd:'/owned/project',title:'import',ownerChatId:null,snapshotSha256:'a'.repeat(64),observedFingerprint:'b'.repeat(64),truncated:false,snapshotJson:'{}',pagesJson:'[]',messages:[]}
  const first=store.importSource(input)
  expect(execution().choice(first.task.id)).toEqual(native)
  execution().accept(first.task.id,'run-native',{...native,model:'chosen-native'})
  expect(store.importSource(input).created).toBe(false)
  expect(execution().choice(first.task.id)).toEqual({...native,model:'chosen-native'})
})

it('returns detached choices and observations and stores the latest native reroute without rewriting intent',()=>{
  const row=task(),input={...selected}
  execution().accept(row.id,'run-one',input);input.model='changed-client'
  const effective={model:'effective-a',reasoningEffort:'medium',source:'native_message' as const}
  execution().observe(row.id,'run-one',effective);effective.model='changed-client'
  const snapshot=execution().last(row.id)!
  snapshot.choice.model='changed-reader';snapshot.effective!.model='changed-reader'
  expect(execution().choice(row.id)).toEqual(selected)
  expect(execution().last(row.id)?.effective?.model).toBe('effective-a')
  execution().observe(row.id,'run-one',{model:'effective-b',source:'native_reroute'})
  expect(execution().last(row.id)?.effective).toEqual({model:'effective-b',source:'native_reroute'})
  expect(execution().last(row.id)?.choice).toEqual(selected)
})

it('normalizes omission separately from explicit automatic values and rejects malformed or unknown choice fields',()=>{
  expect(normalizeExecutionChoice(undefined,selected)).toEqual(selected)
  expect(normalizeExecutionChoice({model:null},selected)).toEqual({...selected,model:null})
  expect(normalizeExecutionChoice({defaults:'native',reasoningEffort:null},selected)).toEqual({...selected,defaults:'native',reasoningEffort:null})
  expect(normalizeExecutionChoice({model:'vendor/model-v2[1m]'},provider).model).toBe('vendor/model-v2[1m]')
  for(const value of [null,[],false,'model',{defaults:'other'},{model:undefined},{model:''},{model:' has-space'},{model:'x\0'},{model:'x'.repeat(201)},{reasoningEffort:''},{reasoningEffort:'x'.repeat(65)},{reasoningEffort:1},{model:'ok',extra:'secret'}]){
    expect(()=>normalizeExecutionChoice(value,provider)).toThrow('invalid_execution')
  }
  expect(normalizeExecutionChoice({},selected)).toEqual(selected)
  expect(sameExecutionChoice(selected,{reasoningEffort:'high',model:'model-a',defaults:'provider'})).toBe(true)
  expect(sameExecutionChoice(selected,{...selected,defaults:'native'})).toBe(false)
})

it('rejects non-native or unbounded observations and preserves the original unknown effective state',()=>{
  const row=task();execution().accept(row.id,'run-one',selected)
  for(const value of [{model:'requested',source:'request'},{model:'',source:'native_response'},{model:'x'.repeat(201),source:'native_response'},{model:'ok',source:'native_response',reasoningEffort:' '},{model:'ok',source:'native_response',sessionId:'bad\n'},{model:'ok',source:'native_response',thinking:'private'}]){
    expect(()=>execution().observe(row.id,'run-one',value as never)).toThrow('invalid_execution_observation')
  }
  expect(execution().last(row.id)?.effective).toBeNull()
  expect(()=>execution().accept(row.id,'bad\nrun',selected)).toThrow('invalid_execution')
  expect(()=>execution().accept('missing','valid-run',selected)).toThrow('not_found')
})
