import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../lib/db'
import { createProviderRegistry } from '../provider-registry'
import type { AgentEvent, AgentProvider, SpawnContext } from '../agent-provider'
import { makeWorkbenchStore } from './store'
import { makeWorkbenchService, type WorkbenchService } from './service'

let root: string, project: string, db: Db, service: WorkbenchService
const result: AgentEvent = { kind: 'result', sessionId: 'session-one', numTurns: 1, durationMs: 1 }
function setup(provider: AgentProvider, owner: () => string | null = () => 'owner', permissionTimeoutMs?: number) {
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true })
  registry.register('codex', provider, { displayName: 'Codex', canResume: () => true })
  service = makeWorkbenchService({ store: makeWorkbenchStore(db), registry, stateDir: root, ownerChatId: owner, permissionTimeoutMs })
  return service
}
function create(text = '整理周报') { return service.create({ path: project, providerId: 'claude', text }) }
async function settle(id: string) {
  await expect.poll(() => service.detail(id).task.status).not.toMatch(/^(queued|running|cancelling)$/)
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-workbench-'))
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

  it('rejects double submits before spawn and cancels during spawn without dispatching', async () => {
    let release!: () => void, dispatched = false
    const wait = new Promise<void>(r => { release = r })
    setup({ async spawn() { await wait; return {
      async *dispatch() { dispatched = true; yield result }, async close() {},
    } } })
    const task = create()
    expect(() => create()).toThrow('workbench_busy')
    const cancellation = service.cancel(task.id)
    release(); await cancellation; await settle(task.id)
    expect(dispatched).toBe(false)
    expect(service.detail(task.id).task.status).toBe('cancelled')
  })

  it('can shut down and revoke busy ownership when startup never resolves', async () => {
    setup({ spawn: () => new Promise(() => {}) })
    const task=create()
    await expect.poll(() => service.detail(task.id).task.status).toBe('running')
    await service.shutdown()
    expect(service.detail(task.id).task.status).toBe('cancelled')
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

  it('does not snapshot still-writable files when the agent fails to close', async () => {
    setup({ async spawn(p) { return { async *dispatch() {
      writeFileSync(join(project,'.cc-workbench',p.alias.split(':')[1]!,'unstable.txt'),'still changing')
      yield result
    },async close() { throw new Error('writer still alive') } } } })
    const task=create(); await settle(task.id)
    expect(service.detail(task.id).task).toMatchObject({status:'interrupted',error:'writer_not_closed'})
    expect(service.detail(task.id).artifacts).toEqual([])
    expect(() => create()).toThrow('workbench_busy')
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
