import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../lib/db'
import { createProviderRegistry } from '../provider-registry'
import type { AgentEvent, AgentProvider, AgentSession, SpawnContext } from '../agent-provider'
import { makeWorkbenchStore } from './store'
import { makeWorkbenchService, type WorkbenchService } from './service'

let root: string, project: string, db: Db, service: WorkbenchService
const result: AgentEvent = { kind: 'result', sessionId: 'session-one', numTurns: 1, durationMs: 1 }
function setup(provider: AgentProvider, owner: () => string | null = () => 'owner', permissionTimeoutMs?: number, extra: {
  timeoutMs?:number; closeTimeoutMs?:number; holdBusy?:(label:string)=>()=>void
  mintSessionToken?:(key:string)=>string; revokeSessionToken?:(key:string)=>void
} = {}) {
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true })
  registry.register('codex', provider, { displayName: 'Codex', canResume: () => true })
  service = makeWorkbenchService({ store: makeWorkbenchStore(db), registry, stateDir: root, ownerChatId: owner, permissionTimeoutMs, ...extra })
  return service
}
function create(text = '整理周报') { return service.create({ path: project, providerId: 'claude', text }) }
function createAt(path: string, text = '整理周报', providerId = 'claude') { return service.create({ path, providerId, text }) }
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
async function settle(id: string) {
  await expect.poll(() => service.detail(id).task.status).not.toMatch(/^(queued|running|cancelling)$/)
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-workbench-')))
  project = join(root, 'project'); mkdirSync(project)
  db = openDb({ path: join(root, 'state.db') })
})
afterEach(async () => { await service?.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }) })

describe('persistent workbench', () => {
  it('preserves task events and immutable artifact versions across continuation and restart', async () => {
    let n = 0
    setup({ async spawn(p) { return {
      async *dispatch() {
        const id = p.alias.split(':')[1]!
        writeFileSync(join(project, '.cc-workbench', id, '周报.md'), `第 ${++n} 版`)
        yield { kind: 'text', text: '完成周报' } as AgentEvent; yield result
      }, async close() {},
    } } })
    const task = create(); await settle(task.id)
    const first = service.detail(task.id).artifacts[0]!
    expect(Buffer.from(service.artifact(task.id, first.id).contentBase64, 'base64').toString()).toBe('第 1 版')
    service.approve(task.id, first.id, first.sha256)
    service.continueTask(task.id, '简短一点'); await settle(task.id)
    const detail = service.detail(task.id)
    expect(detail.artifacts).toHaveLength(2)
    expect(detail.artifacts.filter(a => a.approvedAt !== null)).toHaveLength(1)
    expect(service.artifact(task.id, first.id).sha256).toBe(first.sha256)
    await service.shutdown()
    const reopened = makeWorkbenchStore(db)
    expect(reopened.detail(task.id).events.filter(e => e.kind === 'user').map(e => e.text)).toEqual(['整理周报', '简短一点'])
    expect(reopened.detail(task.id).task.status).toBe('completed')
  })

  it('queues another task on the same folder but rejects a duplicate turn on the same task', async () => {
    let release!: () => void, dispatched = false
    const wait = new Promise<void>(r => { release = r })
    setup({ async spawn() { await wait; return {
      async *dispatch() { dispatched = true; yield result }, async close() {},
    } } })
    const task = create()
    expect(() => service.continueTask(task.id, '重复补充')).toThrow('workbench_busy')
    const queued = create('第二件事')
    expect(service.detail(queued.id).task.status).toBe('queued')
    expect(service.detail(queued.id).task.waitingFor).toMatchObject({ taskId: task.id, reason: 'same_path' })
    const cancellation = service.cancel(task.id)
    release(); await cancellation; await settle(task.id); await settle(queued.id)
    expect(dispatched).toBe(true)
    expect(service.detail(task.id).task.status).toBe('cancelled')
  })

  it('runs unrelated folders concurrently with isolated sessions, events, artifacts, and resume ids', async () => {
    const other = join(root, 'project-other'); mkdirSync(other)
    const gates = new Map([[project, deferred()], [other, deferred()]])
    const starts: string[] = []
    const contexts: Array<{ path: string; resume?: string }> = []
    setup({ async spawn(p, ctx) {
      contexts.push({ path:p.path, resume:ctx.resumeSessionId })
      return { async *dispatch() {
        starts.push(p.path)
        await gates.get(p.path)!.promise
        const id=p.alias.split(':')[1]!
        writeFileSync(join(p.path,'.cc-workbench',id,'result.txt'),`bytes:${p.path}`)
        yield {kind:'text',text:`text:${p.path}`} as AgentEvent
        yield {kind:'result',sessionId:`session:${p.path}`,numTurns:1,durationMs:1} as AgentEvent
      },async close(){} }
    } })

    const one=createAt(project,'one')
    const two=createAt(other,'two')
    await expect.poll(() => new Set(starts)).toEqual(new Set([project,other]))
    expect(service.detail(one.id).task.waitingFor).toBeNull()
    expect(service.detail(two.id).task.waitingFor).toBeNull()
    expect(() => service.continueTask(one.id,'duplicate')).toThrow('workbench_busy')

    gates.get(project)!.resolve(); gates.get(other)!.resolve()
    await Promise.all([settle(one.id),settle(two.id)])
    expect(service.detail(one.id).events.some(e=>e.text===`text:${project}`)).toBe(true)
    expect(service.detail(two.id).events.some(e=>e.text===`text:${other}`)).toBe(true)
    expect(Buffer.from(service.artifact(one.id,service.detail(one.id).artifacts[0]!.id).contentBase64,'base64').toString()).toBe(`bytes:${project}`)
    expect(Buffer.from(service.artifact(two.id,service.detail(two.id).artifacts[0]!.id).contentBase64,'base64').toString()).toBe(`bytes:${other}`)

    service.continueTask(one.id,'resume one'); await settle(one.id)
    expect(contexts.filter(c=>c.path===project).map(c=>c.resume)).toEqual([undefined,`session:${project}`])
    expect(contexts.filter(c=>c.path===other).map(c=>c.resume)).toEqual([undefined])
  })

  it('uses conflict-scoped FIFO without serializing sibling or prefix folders', async () => {
    const childA=join(project,'child-a'), childB=join(project,'child-b'), prefix=join(root,'project-other')
    mkdirSync(childA); mkdirSync(childB); mkdirSync(prefix)
    const gates=new Map([[childA,deferred()],[project,deferred()],[childB,deferred()]])
    const starts:string[]=[]
    setup({ async spawn(p) { return { async *dispatch() {
      starts.push(p.path)
      await gates.get(p.path)?.promise
      yield {kind:'result',sessionId:`session:${p.path}`,numTurns:1,durationMs:1} as AgentEvent
    },async close(){} } } })

    const first=createAt(childA,'first child')
    await expect.poll(()=>starts).toEqual([childA])
    const parent=createAt(project,'parent')
    const laterSibling=createAt(childB,'later sibling')
    const prefixSibling=createAt(prefix,'prefix sibling')
    await expect.poll(()=>starts).toContain(prefix)
    expect(starts).not.toContain(project)
    expect(starts).not.toContain(childB)
    expect(service.detail(parent.id).task.waitingFor).toMatchObject({taskId:first.id,reason:'nested_path'})
    expect(service.detail(laterSibling.id).task.waitingFor).toMatchObject({taskId:parent.id,reason:'nested_path'})

    gates.get(childA)!.resolve(); await settle(first.id)
    await expect.poll(()=>starts).toContain(project)
    expect(starts).not.toContain(childB)
    gates.get(project)!.resolve(); await settle(parent.id)
    await expect.poll(()=>starts).toContain(childB)
    gates.get(childB)!.resolve()
    await Promise.all([settle(laterSibling.id),settle(prefixSibling.id)])
  })

  it('serializes canonical symlink aliases as the same folder', async () => {
    const alias=join(root,'project-alias'); symlinkSync(project,alias)
    const gate=deferred(); let starts=0
    setup({ async spawn() { return { async *dispatch() {
      starts++
      if(starts===1)await gate.promise
      yield result
    },async close(){} } } })
    const first=createAt(project,'real path')
    await expect.poll(()=>starts).toBe(1)
    const second=createAt(alias,'alias path')
    expect(service.detail(second.id).task.waitingFor).toMatchObject({taskId:first.id,reason:'same_path'})
    expect(starts).toBe(1)
    gate.resolve(); await Promise.all([settle(first.id),settle(second.id)])
    expect(starts).toBe(2)
  })

  it('can shut down and revoke busy ownership when startup never resolves', async () => {
    setup({ spawn: () => new Promise(() => {}) })
    const task=create()
    await expect.poll(() => service.detail(task.id).task.status).toBe('running')
    await service.shutdown()
    expect(service.detail(task.id).task).toMatchObject({status:'interrupted',error:'writer_not_closed'})
  })

  it('does not let 100 old files hide a new artifact on the next turn', async () => {
    let turn=0
    setup({ async spawn(p) { return { async *dispatch() {
      const dir=join(project,'.cc-workbench',p.alias.split(':')[1]!)
      if (++turn===1) for(let i=0;i<100;i++) writeFileSync(join(dir,`file-${String(i).padStart(3,'0')}.txt`),'old')
      else writeFileSync(join(dir,'zzz-new.txt'),'new')
      yield result
    },async close(){} } } })
    const task=create(); await settle(task.id)
    expect(service.detail(task.id).artifacts).toHaveLength(100)
    service.continueTask(task.id,'one more'); await settle(task.id)
    expect(service.detail(task.id).artifacts).toHaveLength(101)
  })

  it('does not call a stream without a result successful; preserves the error', async () => {
    setup({ async spawn() { return { async *dispatch() { yield { kind: 'text', text: '还在处理' } }, async close() {} } } })
    const task = create(); await settle(task.id)
    expect(service.detail(task.id).task).toMatchObject({ status: 'failed', error: 'stream_ended_without_result' })
  })

  it('keeps a task running and locked until its writer is closed and artifacts are captured', async () => {
    let release!: () => void
    const closing=new Promise<void>(r => { release=r })
    setup({ async spawn(p) { return { async *dispatch() { yield result }, async close() {
      await closing
      writeFileSync(join(project,'.cc-workbench',p.alias.split(':')[1]!,'last.txt'),'final bytes')
    } } } })
    const task=create()
    await expect.poll(() => service.detail(task.id).task.status).toBe('running')
    expect(() => service.continueTask(task.id,'again')).toThrow('workbench_busy')
    release(); await settle(task.id)
    expect(service.detail(task.id).artifacts.map(a => a.name)).toEqual(['last.txt'])
  })

  it('does not start a conflicting task until close finishes and final artifacts are captured', async () => {
    const closing=deferred(); let firstId='',spawns=0,artifactSeenAtSecondSpawn=false
    setup({ async spawn(p) {
      spawns++
      if(spawns===2)artifactSeenAtSecondSpawn=service.detail(firstId).artifacts.some(a=>a.name==='last.txt')
      return {async *dispatch(){yield result},async close(){
        if(spawns===1){await closing.promise;writeFileSync(join(project,'.cc-workbench',p.alias.split(':')[1]!,'last.txt'),'final')}
      }}
    } })
    const first=create('first'); firstId=first.id
    await expect.poll(()=>service.detail(first.id).task.status).toBe('running')
    const second=create('second')
    await new Promise(resolve=>setTimeout(resolve,10))
    expect(spawns).toBe(1)
    closing.resolve(); await Promise.all([settle(first.id),settle(second.id)])
    expect(spawns).toBe(2)
    expect(artifactSeenAtSecondSpawn).toBe(true)
  })

  it('cancels a queued task without spawning it and starts the next eligible task', async () => {
    const gate=deferred(); const spawned:string[]=[]
    setup({async spawn(p){const id=p.alias.split(':')[1]!;spawned.push(id);return{async *dispatch(){if(spawned.length===1)await gate.promise;yield result},async close(){}}}})
    const first=create('first'); await expect.poll(()=>spawned).toEqual([first.id])
    const cancelled=create('cancel me'), next=create('next')
    await service.cancel(cancelled.id)
    expect(service.detail(cancelled.id).task.status).toBe('cancelled')
    gate.resolve(); await Promise.all([settle(first.id),settle(next.id)])
    expect(spawned).toEqual([first.id,next.id])
  })

  it('keeps two tasks permission-local when one is cancelled', async () => {
    const other=join(root,'permission-other');mkdirSync(other)
    const answers=new Map<string,boolean>(); const cancelled:string[]=[],closed:string[]=[]
    setup({async spawn(p,ctx){return{async *dispatch(){
      const answer=await ctx.requestPermission!({tool:'Bash',description:`permission:${p.path}`})
      answers.set(p.path,answer);yield {kind:'result',sessionId:`session:${p.path}`,numTurns:1,durationMs:1} as AgentEvent
    },async cancel(){cancelled.push(p.path)},async close(){closed.push(p.path)}}}})
    const one=createAt(project,'one'),two=createAt(other,'two')
    await expect.poll(()=>service.detail(one.id).permissions).toHaveLength(1)
    await expect.poll(()=>service.detail(two.id).permissions).toHaveLength(1)
    const oneRequest=service.detail(one.id).permissions[0]!.id,twoRequest=service.detail(two.id).permissions[0]!.id
    expect(()=>service.resolvePermission(one.id,twoRequest,'allow')).toThrow('permission_stale')
    await service.cancel(one.id); await settle(one.id)
    expect(service.detail(two.id).permissions).toHaveLength(1)
    service.resolvePermission(two.id,twoRequest,'allow'); await settle(two.id)
    expect(answers).toEqual(new Map([[project,false],[other,true]]))
    expect(cancelled).toEqual([project])
    expect(new Set(closed)).toEqual(new Set([project,other]))
    expect(()=>service.resolvePermission(one.id,oneRequest,'allow')).toThrow('permission_stale')
  })

  it('revokes a cancelled run credential before waiting for its writer to close', async () => {
    const closeGate=deferred();const revoked:string[]=[]
    setup({async spawn(){return{async *dispatch(){await new Promise(()=>{})},async cancel(){},async close(){await closeGate.promise}}}},()=> 'owner',undefined,{
      mintSessionToken:key=>`token:${key}`,revokeSessionToken:key=>{revoked.push(key)},
    })
    const task=create();await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
    await service.cancel(task.id)
    expect(revoked).toEqual([`workbench/${task.id}`])
    closeGate.resolve();await settle(task.id)
    expect(revoked).toEqual([`workbench/${task.id}`])
  })

  it('still stops and closes a writer when recording the cancelling status fails', async () => {
    const registry=createProviderRegistry(),dispatchGate=deferred();let cancelled=false,closed=false
    registry.register('claude',{async spawn(){return{
      async *dispatch(){await dispatchGate.promise;yield result},
      async cancel(){cancelled=true},async close(){closed=true},
    }}},{displayName:'Claude',canResume:()=>true})
    const base=makeWorkbenchStore(db)
    const store={...base,update(id:string,status:Parameters<typeof base.update>[1],error?:string|null){
      if(status==='cancelling')throw new Error('status storage unavailable')
      base.update(id,status,error)
    }}
    service=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>null})
    const task=create();await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
    const cancellation=service.cancel(task.id)
    dispatchGate.resolve()
    await expect(cancellation).resolves.toMatchObject({id:task.id})
    await settle(task.id)
    expect(cancelled).toBe(true)
    expect(closed).toBe(true)
  })

  it('quarantines a cancelled late spawn until that session later closes without dispatch', async () => {
    const spawned=deferred<AgentSession>(),closed=deferred();let calls=0,dispatches=0,lateCloseCalled=false
    setup({async spawn(){
      if(++calls===1)return spawned.promise
      return{async *dispatch(){dispatches++;yield result},async close(){}}
    }})
    const first=create('late spawn');await expect.poll(()=>service.detail(first.id).task.status).toBe('running')
    const second=create('waiter')
    await service.cancel(first.id);await settle(first.id)
    expect(service.detail(second.id).task.waitingFor).toMatchObject({taskId:first.id,reason:'writer_not_closed'})
    expect(calls).toBe(1)
    spawned.resolve({async *dispatch(){dispatches++;yield result},async close(){lateCloseCalled=true;await closed.promise}})
    await expect.poll(()=>lateCloseCalled).toBe(true)
    expect(calls).toBe(1)
    closed.resolve();await settle(second.id)
    expect(calls).toBe(2)
    expect(dispatches).toBe(1)
  })

  it('releases a timed-out close only after its late confirmation and artifact capture', async () => {
    const closeGate=deferred();let spawns=0
    const released=new Set<string>()
    setup({async spawn(p){const call=++spawns;return{async *dispatch(){yield result},async close(){
      if(call===1){await closeGate.promise;writeFileSync(join(p.path,'.cc-workbench',p.alias.split(':')[1]!,'late.txt'),'late-safe')}
    }}}},()=> 'owner',undefined,{closeTimeoutMs:5,holdBusy:label=>()=>{released.add(label)}})
    const first=create('first'),second=create('second')
    await settle(first.id)
    expect(service.detail(first.id).task).toMatchObject({status:'interrupted',error:'writer_not_closed'})
    expect(service.detail(second.id).task.waitingFor).toMatchObject({taskId:first.id,reason:'writer_not_closed'})
    expect(spawns).toBe(1)
    expect(released.has(`workbench/${first.id}`)).toBe(false)
    closeGate.resolve();await settle(second.id)
    expect(spawns).toBe(2)
    expect(service.detail(first.id).artifacts.map(a=>a.name)).toEqual(['late.txt'])
    expect(released.has(`workbench/${first.id}`)).toBe(true)
  })

  it('does not unlock an uncertain writer when final status storage throws', async () => {
    const registry=createProviderRegistry(),closeGate=deferred();let spawns=0
    registry.register('claude',{async spawn(){spawns++;return{async *dispatch(){yield result},async close(){if(spawns===1)await closeGate.promise}}}},{displayName:'Claude',canResume:()=>true})
    const base=makeWorkbenchStore(db)
    const store={...base,update(id:string,status:Parameters<typeof base.update>[1],error?:string|null){
      if(status==='interrupted')throw new Error('status storage unavailable')
      base.update(id,status,error)
    }}
    service=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>null,closeTimeoutMs:5})
    const first=create('first'),second=create('second')
    await new Promise(resolve=>setTimeout(resolve,30))
    expect(spawns).toBe(1)
    expect(service.detail(second.id).task.waitingFor).toMatchObject({taskId:first.id,reason:'writer_not_closed'})
    await service.shutdown()
    closeGate.resolve()
  })

  it('fails a queued run when its accepted directory identity was replaced', async () => {
    const child=join(project,'child'),oldChild=join(project,'child-old');mkdirSync(child)
    const gate=deferred();const spawned:string[]=[]
    setup({async spawn(p){spawned.push(p.path);return{async *dispatch(){if(p.path===project)await gate.promise;yield result},async close(){}}}})
    const parent=createAt(project,'parent');await expect.poll(()=>spawned).toEqual([project])
    const queued=createAt(child,'child')
    renameSync(child,oldChild);mkdirSync(child)
    gate.resolve();await Promise.all([settle(parent.id),settle(queued.id)])
    expect(spawned).toEqual([project])
    expect(service.detail(queued.id).task).toMatchObject({status:'failed',error:'invalid_path'})
    expect(existsSync(join(child,'.cc-workbench',queued.id))).toBe(false)
  })

  it('rejects a replaced output-directory symlink instead of collecting files outside the project', async () => {
    setup({ async spawn(p) { return { async *dispatch() {
      const dir=join(project,'.cc-workbench',p.alias.split(':')[1]!)
      rmSync(dir,{recursive:true}); symlinkSync(root,dir)
      writeFileSync(join(root,'outside.txt'),'private')
      yield result
    },async close() {} } } })
    const task=create(); await settle(task.id)
    expect(service.detail(task.id).artifacts).toEqual([])
    expect(service.detail(task.id).events.some(e => e.kind==='system' && e.text.includes('成果目录无法读取'))).toBe(true)
  })

  it('does not auto-approve new bytes under the same filename', async () => {
    let version=0
    setup({ async spawn(p) { return { async *dispatch() {
      writeFileSync(join(project,'.cc-workbench',p.alias.split(':')[1]!,'report.txt'),++version===1?'first':'second')
      yield result
    },async close(){} } } })
    const task=create(); await settle(task.id)
    const a=service.detail(task.id).artifacts[0]!
    service.approve(task.id,a.id,a.sha256)
    service.continueTask(task.id,'revise'); await settle(task.id)
    const b=service.detail(task.id).artifacts.find(x=>x.id!==a.id)!
    expect(b.approvedAt).toBeNull()
    expect(Buffer.from(service.artifact(task.id,a.id).contentBase64,'base64').toString()).toBe('first')
  })

  it('gives each task its own session and resumes only its own context', async () => {
    const contexts: SpawnContext[] = []
    setup({ async spawn(_p, ctx) { contexts.push(ctx); return { async *dispatch() { yield result }, async close() {} } } })
    const one = create(); await settle(one.id)
    service.continueTask(one.id, '继续'); await settle(one.id)
    const two = create(); await settle(two.id)
    expect(contexts.map(c => c.resumeSessionId)).toEqual([undefined, 'session-one', undefined])
    expect(contexts.every(c => c.permissionMode === 'strict')).toBe(true)
    expect(contexts[0]!.requestPermission).not.toBe(contexts[1]!.requestPermission)
    await expect(contexts[0]!.requestPermission!({tool:'Bash',description:'stale run'})).resolves.toBe(false)
    expect(contexts[0]!.appendInstructions).toContain(one.id)
    expect(contexts[2]!.appendInstructions).not.toContain(one.id)
  })

  it('lets the admin desktop resolve an ownerless active request once', async () => {
    let requestPermission: NonNullable<SpawnContext['requestPermission']> | undefined
    setup({ async spawn(_p, ctx) { requestPermission=ctx.requestPermission; return {
      async *dispatch() {
        const allowed = await requestPermission!({ tool:'Bash', description:'remove generated output' })
        yield { kind:'text', text:allowed ? 'allowed' : 'denied' }
        yield result
      }, async close() {},
    } } }, () => null)
    const task=create()
    await expect.poll(() => service.detail(task.id).permissions).toHaveLength(1)
    const requestId=service.detail(task.id).permissions[0]!.id
    expect(service.resolvePermission(task.id,requestId,'allow')).toBeUndefined()
    expect(() => service.resolvePermission(task.id,requestId,'deny')).toThrow('permission_stale')
    await settle(task.id)
    expect(service.detail(task.id).events.some(e => e.kind==='text' && e.text==='allowed')).toBe(true)
  })

  it('shows only the active task permission count in the list and clears it after resolve or cancel', async () => {
    setup({ async spawn(_p, ctx) { return {
      async *dispatch() {
        await ctx.requestPermission!({ tool:'Bash', description:'remove generated output' })
        yield result
      }, async cancel() {}, async close() {},
    } } }, () => null)

    const resolved=create()
    await expect.poll(() => service.list().tasks.find(task => task.id===resolved.id)?.pendingPermissionCount).toBe(1)
    const requestId=service.detail(resolved.id).permissions[0]!.id
    service.resolvePermission(resolved.id,requestId,'allow')
    expect(service.list().tasks.find(task => task.id===resolved.id)?.pendingPermissionCount).toBe(0)
    await settle(resolved.id)

    const cancelled=create()
    await expect.poll(() => service.list().tasks.find(task => task.id===cancelled.id)?.pendingPermissionCount).toBe(1)
    expect(service.list().tasks.find(task => task.id===resolved.id)?.pendingPermissionCount).toBe(0)
    await service.cancel(cancelled.id)
    expect(service.list().tasks.every(task => task.pendingPermissionCount===0)).toBe(true)
    await settle(cancelled.id)
  })

  it('denies, audits, and clears a pending request on explicit denial and expiry', async () => {
    setup({ async spawn(_p, ctx) { return { async *dispatch() {
      const allowed=await ctx.requestPermission!({tool:'Bash',description:'remove output'})
      yield {kind:'text',text:allowed?'allowed':'denied'}; yield result
    },async close(){} } } }, () => null, 5)
    const task=create()
    await settle(task.id)
    const detail=service.detail(task.id)
    expect(detail.permissions).toEqual([])
    expect(detail.events.filter(e=>e.kind==='system').map(e=>e.text).join('\n')).toMatch(/权限请求[\s\S]*权限结果.*expired/)
    expect(detail.events.some(e=>e.kind==='text'&&e.text==='denied')).toBe(true)
  })

  it('records an explicit denial and never persists the pending card', async () => {
    setup({ async spawn(_p, ctx) { return { async *dispatch() {
      const allowed=await ctx.requestPermission!({tool:'Bash',description:'remove output'})
      yield {kind:'text',text:allowed?'allowed':'denied'}; yield result
    },async close(){} } } }, () => null)
    const task=create()
    await expect.poll(() => service.detail(task.id).permissions).toHaveLength(1)
    service.resolvePermission(task.id,service.detail(task.id).permissions[0]!.id,'deny')
    await settle(task.id)
    const detail=service.detail(task.id)
    expect(detail.permissions).toEqual([])
    expect(detail.events.some(e=>e.kind==='system'&&e.text.includes('deny'))).toBe(true)
    expect(detail.events.some(e=>e.kind==='text'&&e.text==='denied')).toBe(true)
    await service.shutdown()
    const reopened=makeWorkbenchService({
      store:makeWorkbenchStore(db),registry:createProviderRegistry(),stateDir:root,ownerChatId:()=>null,
    })
    expect(reopened.detail(task.id).permissions).toEqual([])
    expect(() => reopened.resolvePermission(task.id,'123e4567-e89b-42d3-a456-426614174000','allow')).toThrow('permission_stale')
    await reopened.shutdown()
  })

  it('denies a detached pending callback when the provider finishes', async () => {
    let answer: Promise<boolean> | undefined
    setup({ async spawn(_p, ctx) { return { async *dispatch() {
      answer=ctx.requestPermission!({tool:'Bash',description:'late request'})
      yield result
    },async close(){} } } }, () => null)
    const task=create(); await settle(task.id)
    await expect(answer!).resolves.toBe(false)
    expect(service.detail(task.id).permissions).toEqual([])
    expect(service.detail(task.id).events.some(e=>e.kind==='system'&&e.text.includes('ended'))).toBe(true)
  })

  it('rejects cross-task, stale-run, and cancelled permission responses', async () => {
    let firstRequest: string | undefined
    setup({ async spawn(_p, ctx) { return { async *dispatch() {
      await ctx.requestPermission!({tool:'Bash',description:'remove output'})
      yield result
    },async cancel(){},async close(){} } } }, () => null)
    const one=create()
    await expect.poll(() => service.detail(one.id).permissions).toHaveLength(1)
    firstRequest=service.detail(one.id).permissions[0]!.id
    await service.cancel(one.id); await settle(one.id)
    expect(service.detail(one.id).permissions).toEqual([])
    expect(() => service.resolvePermission(one.id,firstRequest!,'allow')).toThrow('permission_stale')

    const two=create()
    await expect.poll(() => service.detail(two.id).permissions).toHaveLength(1)
    const secondRequest=service.detail(two.id).permissions[0]!.id
    expect(() => service.resolvePermission(one.id,secondRequest,'allow')).toThrow('permission_stale')
    await service.cancel(two.id); await settle(two.id)
  })

  it('replays only prior task history when a failed turn never supplied a session id', async () => {
    const prompts: string[] = []
    setup({ async spawn() { return { async *dispatch(prompt) {
      prompts.push(prompt)
      yield { kind:'text',text:'已读到销售记录' }
      if (prompts.length>1) yield result
    },async close() {} } } })
    const task=create('统计销售'); await settle(task.id)
    service.continueTask(task.id,'继续生成周报'); await settle(task.id)
    expect(prompts[1]).toContain('统计销售')
    expect(prompts[1]).toContain('已读到销售记录')
    expect(prompts[1]!.split('继续生成周报')).toHaveLength(2)
  })

  it('quarantines only overlapping paths and retains busy ownership when a writer fails to close', async () => {
    const other=join(root,'close-other');mkdirSync(other)
    const released=new Set<string>()
    setup({ async spawn(p) { return { async *dispatch() {
      writeFileSync(join(p.path,'.cc-workbench',p.alias.split(':')[1]!,'unstable.txt'),'still changing')
      yield result
    },async close() { if(p.path===project)throw new Error('writer still alive') } } } },()=> 'owner',undefined,{
      holdBusy:label=>()=>{released.add(label)},
    })
    const task=create(); await settle(task.id)
    expect(service.detail(task.id).task).toMatchObject({status:'interrupted',error:'writer_not_closed'})
    expect(service.detail(task.id).artifacts).toEqual([])
    const blocked=create('blocked')
    expect(service.detail(blocked.id).task.waitingFor).toMatchObject({taskId:task.id,reason:'writer_not_closed'})
    const free=createAt(other,'free');await settle(free.id)
    expect(service.detail(free.id).task.status).toBe('completed')
    expect(released.has(`workbench/${task.id}`)).toBe(false)
    await service.shutdown()
    expect(released.has(`workbench/${task.id}`)).toBe(true)
  })

  it('marks abandoned running work interrupted without replaying it', async () => {
    setup({ async spawn() { return { async *dispatch() { yield result }, async close() {} } } })
    const task = create(); await settle(task.id); await service.shutdown()
    const pendingFile=join(project,'.cc-workbench',task.id,'pending.txt')
    writeFileSync(pendingFile,'last partial output')
    db.query("UPDATE workbench_tasks SET status='running' WHERE id=?").run(task.id)
    let spawns = 0
    setup({ async spawn() { spawns++; throw new Error('must not replay') } })
    expect(service.detail(task.id).task.status).toBe('interrupted')
    expect(service.detail(task.id).events.at(-1)!.text).toContain(`.cc-workbench/${task.id}`)
    expect(readFileSync(pendingFile,'utf8')).toBe('last partial output')
    expect(spawns).toBe(0)
  })

  it('interrupts queued and active rows on recovery without replaying either', async () => {
    setup({async spawn(){return{async *dispatch(){yield result},async close(){}}}})
    await service.shutdown()
    const store=makeWorkbenchStore(db)
    const queued=store.create({title:'queued',path:project,providerId:'claude',ownerChatId:null})
    const running=store.create({title:'running',path:project,providerId:'claude',ownerChatId:null});store.update(running.id,'running')
    const cancelling=store.create({title:'cancelling',path:project,providerId:'claude',ownerChatId:null});store.update(cancelling.id,'cancelling')
    let spawns=0
    setup({async spawn(){spawns++;throw new Error('must not replay')}})
    expect(service.detail(queued.id).task.status).toBe('interrupted')
    expect(service.detail(running.id).task.status).toBe('interrupted')
    expect(service.detail(cancelling.id).task.status).toBe('interrupted')
    expect(service.detail(queued.id).events.at(-1)?.text).toContain('未自动派发')
    expect(spawns).toBe(0)
  })

  it('shuts down all running folders together, cancels queued work, and rejects new starts', async () => {
    const other=join(root,'shutdown-other');mkdirSync(other)
    const started:string[]=[],cancelled:string[]=[],closed:string[]=[]
    setup({async spawn(p){return{async *dispatch(){started.push(p.path);await new Promise(()=>{})},async cancel(){cancelled.push(p.path)},async close(){closed.push(p.path)}}}})
    const one=createAt(project,'one'),two=createAt(other,'two')
    await expect.poll(()=>new Set(started)).toEqual(new Set([project,other]))
    const queued=createAt(project,'queued')
    const shutdown=service.shutdown()
    expect(()=>createAt(join(root,'missing'),'no')).toThrow('workbench_stopping')
    await shutdown
    expect(service.detail(queued.id).task.status).toBe('cancelled')
    expect(service.detail(one.id).task.status).toBe('cancelled')
    expect(service.detail(two.id).task.status).toBe('cancelled')
    expect(new Set(cancelled)).toEqual(new Set([project,other]))
    expect(new Set(closed)).toEqual(new Set([project,other]))
  })

  it('captures artifacts from a confirmed close before shutdown releases the folder', async () => {
    setup({async spawn(p){return{
      async *dispatch(){await new Promise(()=>{})},async cancel(){},
      async close(){writeFileSync(join(p.path,'.cc-workbench',p.alias.split(':')[1]!,'shutdown.txt'),'closed')},
    }}})
    const task=create();await expect.poll(()=>service.detail(task.id).task.status).toBe('running')
    await service.shutdown()
    expect(service.detail(task.id).artifacts.map(artifact=>artifact.name)).toEqual(['shutdown.txt'])
  })

  it('captures regular outputs but never follows symlinks or arbitrary artifact paths', async () => {
    writeFileSync(join(root, 'private.txt'), 'secret')
    setup({ async spawn(p) { return { async *dispatch() {
      const dir = join(project, '.cc-workbench', p.alias.split(':')[1]!)
      writeFileSync(join(dir, 'good.txt'), 'public')
      symlinkSync(join(root, 'private.txt'), join(dir, 'secret.txt'))
      symlinkSync(root, join(dir, 'outside'))
      yield result
    }, async close() {} } } })
    const task = create(); await settle(task.id)
    expect(service.detail(task.id).artifacts.map(a => a.name)).toEqual(['good.txt'])
    expect(() => service.artifact(task.id, '../private.txt')).toThrow('not_found')
    expect(() => service.approve(task.id, service.detail(task.id).artifacts[0]!.id, '0'.repeat(64))).toThrow('artifact_changed')
  })

  it('binds explicit WeChat commands to the original owner and shares the task history', async () => {
    let owner = 'owner'
    setup({ async spawn() { return { async *dispatch() { yield { kind: 'text', text: '周报已更新' }; yield result }, async close() {} } } }, () => owner)
    const task = create(); await settle(task.id)
    expect(await service.handleWechat('stranger', `任务 ${task.id}`)).toBeNull()
    expect(await service.handleWechat('owner', '普通聊天')).toBeNull()
    expect(await service.handleWechat('owner', `任务 ${task.id} 简短一点`)).toContain(task.id)
    await settle(task.id)
    expect(service.detail(task.id).events.filter(e => e.kind === 'user').map(e => e.text)).toEqual(['整理周报', '简短一点'])
    expect(await service.handleWechat('owner', `任务 ${task.id}`)).toContain('周报已更新')
    owner = 'new-owner'
    expect(await service.handleWechat('new-owner', `任务 ${task.id}`)).not.toContain('周报已更新')
  })
})
