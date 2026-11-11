import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDb } from '../../lib/db'
import { removeTempDir } from '../../lib/test-temp'
import { createProviderRegistry } from '../../app/provider-registry'
import { makeWorkbenchStore } from '../../adapters/store/workbench/store'
import { createWorkbenchCodexProvider } from '../../adapters/executors/codex/codex-app-server'
import { workbenchCodexConfig } from '../../adapters/executors/codex/codex-config'
import { createScriptedCodex, type ScriptedRpc } from '../../test-support/executors/codex-scripted'
import { MANAGED_NATIVE_CAPABILITIES } from '../../domain/workbench/executor-capabilities'
import { makeWorkbenchService, type WorkbenchService } from './service'
vi.mock('../../adapters/executors/codex/codex-config', async original => ({
  ...await original<typeof import('../../adapters/executors/codex/codex-config')>(),
  discoverWorkbenchCodexConfig: async () => ({ servers: [], config: workbenchCodexConfig([]) }),
}))
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn() })
describe.skipIf(process.platform === 'win32')('native Codex task service',()=>{
it('review P1 input: a delivered new owner instruction resets earlier rejections within the same native turn',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-denial-direction-'))),project=join(root,'project');mkdirSync(project)
  const db=openDb({path:join(root,'state.db')});let service:WorkbenchService|undefined
  cleanup.push(async()=>{await service?.shutdown();db.close();removeTempDir(root)})
  const params={itemId:'command',kind:'command',command:'ssh other-host',cwd:project,availableDecisions:['accept','decline']}
  let third=false
  const native=createScriptedCodex({threadId:'owned-session',turns:[{steps:[{request:{method:'item/commandExecution/requestApproval',params}},{request:{method:'item/commandExecution/requestApproval',params}},{delayMs:60000}]}],rewrite:message=>{
    if(!third&&message.result?.turnId&&native.steers.at(-1)==='换个方向做本地检查'){
      third=true;return [message,{id:'third-after-input',method:'item/commandExecution/requestApproval',params:{...params,threadId:'owned-session',turnId:'turn-1'}}]
    }
    return message
  }})
  const registry=createProviderRegistry()
  registry.register('codex',createWorkbenchCodexProvider({codexPathOverride:'/unused-codex',spawnProcess:native.spawn}),{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:root,ownerChatId:()=>null})
  const task=service.create({path:project,providerId:'codex',text:'检查'})
  for(let i=0;i<2;i++){
    await expect.poll(()=>service!.detail(task.id).permissions).toHaveLength(1)
    service.resolvePermission(task.id,service.detail(task.id).permissions[0]!.id,'deny')
  }
  const inputId=randomUUID()
  await service.submitInput(task.id,{runId:service.detail(task.id).runId!,requestId:inputId,text:'换个方向做本地检查'})
  await expect.poll(()=>service!.detail(task.id).inputs?.find(i=>i.id===inputId)?.status).toBe('delivered')
  await expect.poll(()=>service!.detail(task.id).permissions).toHaveLength(1)
  service.resolvePermission(task.id,service.detail(task.id).permissions[0]!.id,'deny')
  await expect.poll(()=>native.responses.some(r=>r.result&&JSON.stringify(r.result)==='{"decision":"decline"}')).toBe(true)
  await new Promise(resolve=>setTimeout(resolve,20))
  expect(service.detail(task.id).task.status).toBe('running')
  expect(service.detail(task.id).events.some(e=>e.text.includes('已连续拒绝三次'))).toBe(false)
})
it('native rejection keeps the real task running and delivers an immediate followup in the same session',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'cc-native-denial-'))),project=join(root,'project');mkdirSync(project)
  const db=openDb({path:join(root,'state.db')});let service:WorkbenchService|undefined
  cleanup.push(async()=>{await service?.shutdown();db.close();removeTempDir(root)})
  const native=createScriptedCodex({threadId:'owned-session',turns:[{steps:[{request:{method:'item/commandExecution/requestApproval',params:{itemId:'command',kind:'command',command:'ssh other-host',cwd:project,availableDecisions:['accept','cancel']}}}]},{steps:[{delayMs:200},{say:'本机验证完成'}]}],rewrite:message=>message.method==='turn/completed'&&message.params.turn.id==='turn-1'?{...message,params:{...message.params,turn:{...message.params.turn,status:'interrupted'}}}:message})
  const registry=createProviderRegistry()
  registry.register('codex',createWorkbenchCodexProvider({codexPathOverride:'/unused-codex',spawnProcess:native.spawn}),{displayName:'Codex',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  service=makeWorkbenchService({store:makeWorkbenchStore(db),registry,stateDir:root,ownerChatId:()=>null})
  const task=service.create({path:project,providerId:'codex',text:'检查代码'})
  await expect.poll(()=>service!.detail(task.id).permissions).toHaveLength(1)
  service.resolvePermission(task.id,service.detail(task.id).permissions[0]!.id,'deny','不要 SSH，只在本机验证')
  await expect.poll(()=>native.inputs).toHaveLength(2)
  expect(service.detail(task.id).task.status).toBe('running')
  expect(native.inputs[1]).toContain('不要 SSH，只在本机验证');expect(native.inputs[1]).toContain('ssh other-host')
  const runId=service.detail(task.id).runId!
  const requestId=randomUUID()
  await service.submitInput(task.id,{runId,requestId,text:'继续本地测试'})
  await expect.poll(()=>service!.detail(task.id).inputs?.find(i=>i.id===requestId)?.status).toBe('delivered')
  expect(native.steers).toContain('继续本地测试')
  await expect.poll(()=>service!.detail(task.id).task.phase).toBe('replied')
  expect(service.detail(task.id).task.status).toBe('running')
  expect(service.detail(task.id).events.some(e=>e.kind==='error')).toBe(false)
  expect(native.threadStarts).toHaveLength(1)
  expect(native.spawned).toHaveLength(1)
  expect(native.responses[0]?.result).toEqual({decision:'cancel'})
  await service.cancel(task.id)
  await expect.poll(()=>service!.detail(task.id).task.status).toBe('completed')
})
it('real-shaped child output flood preserves completion, one notice, followup and folder reuse', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-output-regression-'))), project = join(root, 'project')
  mkdirSync(project)
  const db = openDb({ path: join(root, 'state.db') }); let service: WorkbenchService | undefined
  cleanup.push(async () => { await service?.shutdown(); db.close(); removeTempDir(root) })
  let injected = false
  const native = createScriptedCodex({
    threadId: 'owned-parent',
    turns: [{ steps: [
      { notify: { method: 'item/started', params: { item: { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', receiverThreadIds: ['owned-child'], status: 'inProgress' } } } },
      { say: 'parent final' },
    ] }, { steps: [{ say: 'followup complete' }] }, { steps: [{ say: 'next task complete' }] }],
    rewrite: message => {
      if (message.error?.message !== 'scripted codex: thread/read not implemented' || injected) return message
      injected = true
      const at = { threadId: 'owned-child', turnId: 'child-turn-1' }, frames: ScriptedRpc[] = [
        { method: 'turn/started', params: { threadId: at.threadId, turn: { id: at.turnId } } },
        { method: 'item/started', params: { ...at, item: { type: 'commandExecution', id: 'child-command', command: 'test', status: 'inProgress' } } },
      ]
      for (let i = 0; i < 1200; i++) frames.push({ method: 'item/commandExecution/outputDelta', params: { ...at, itemId: 'child-command', delta: 'PRIVATE TEST OUTPUT\n'.repeat(400) } })
      frames.push(
        { method: 'item/completed', params: { ...at, item: { type: 'commandExecution', id: 'child-command', command: 'test', status: 'completed', exitCode: 0 } } },
        { method: 'item/completed', params: { ...at, item: { type: 'agentMessage', id: 'child-answer', text: 'child final' } } },
        { method: 'turn/completed', params: { threadId: at.threadId, turn: { id: at.turnId, status: 'completed', items: [{ type: 'agentMessage', id: 'child-answer', text: 'child final' }] } } },
        { id: message.id, result: { thread: { id: at.threadId, cwd: project, source: { subAgent: { thread_spawn: { parent_thread_id: 'owned-parent' } } } } } },
      )
      return frames
    },
  })
  const registry = createProviderRegistry()
  registry.register('codex', createWorkbenchCodexProvider({ codexPathOverride: '/unused-codex', spawnProcess: native.spawn }), { displayName: 'Codex', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  service = makeWorkbenchService({ store: makeWorkbenchStore(db), registry, stateDir: root, ownerChatId: () => null })
  const task = service.create({ path: project, providerId: 'codex', text: 'do work' })
  await expect.poll(() => service!.detail(task.id).task.phase).toBe('replied')
  const detail = service.detail(task.id), serialized = JSON.stringify(detail.events)
  expect(detail.task.error).toBeNull(); expect(serialized).toContain('parent final'); expect(serialized).toContain('child final')
  expect(detail.events.filter(e => e.kind === 'error')).toEqual([])
  expect(detail.events.filter(e => e.kind === 'system' && e.text.includes('实时预览'))).toHaveLength(1)
  expect(serialized).not.toContain('PRIVATE TEST OUTPUT')
  await service.submitInput(task.id, { runId: detail.runId!, requestId: randomUUID(), text: 'followup' })
  await expect.poll(() => JSON.stringify(service!.detail(task.id).events)).toContain('followup complete')
  await service.cancel(task.id)
  await expect.poll(() => native.alive()).toBe(0)
  const next = service.create({ path: project, providerId: 'codex', text: 'next task' })
  await expect.poll(() => service!.detail(next.id).task.status).toBe('completed')
  expect(service.detail(next.id).task.error).toBeNull()
})

})
