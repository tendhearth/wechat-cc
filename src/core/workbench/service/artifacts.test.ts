import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { outputDirectory, saveArtifactSnapshot } from '../artifacts'
import { removeTempDir } from '../../../lib/test-temp'
import { makeRuntimeState, type Active } from './state'
import { makeArtifactsDomain } from './artifacts'
import { directoryIdentity } from './directory-identity'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-artifacts-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const state = makeRuntimeState()
  const touched = vi.fn()
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched, bumped: vi.fn() }, deps: { ownerChatId: () => 'owner', registry: createProviderRegistry() }, ensureAccepting: () => {}, now: Date.now, actions: new Ref<ServiceActions>('t') }
  const domain = makeArtifactsDomain(ctx)
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  const running = (over: Partial<Active> = {}): Active => ({ identity: 'run-1abcdef', taskId: task.id, title: task.title, task, path: project, directoryIdentity: directoryIdentity(project), cancelled: false, finishing: false, uncertain: false, artifactsCollected: false, ...over } as unknown as Active)
  const systemEvents = () => store.events(task.id).filter(e => e.kind === 'system').map(e => e.text)
  return { store, state, domain, task, project, stateDir, touched, running, systemEvents }
}

describe('makeArtifactsDomain · 成果收集', () => {
  it('noteWarnings:同一条只记一次 system 事件、touched 一次', () => {
    const { domain, running, systemEvents, touched } = setup()
    const r = running()
    domain.noteWarnings(r, ['a', 'a', 'b']); domain.noteWarnings(r, ['b'])
    expect(systemEvents()).toEqual(['a', 'b']); expect(touched).toHaveBeenCalledTimes(2)
  })
  it('captureTaskArtifacts:成果目录里的文件进成果列表', () => {
    const { domain, running, task, project, store } = setup()
    const out = outputDirectory(project, task.id); mkdirSync(out, { recursive: true }); writeFileSync(join(out, '报告.md'), '# 好')
    domain.captureTaskArtifacts(running())
    expect(store.artifacts(task.id).map(a => a.name)).toEqual(['报告.md'])
  })
  it('captureTaskArtifacts:项目身份变了 ⇒ 一条「项目文件夹已移动…」,重复失败不重复记;恢复后一条恢复文案', () => {
    const { domain, running, systemEvents } = setup()
    const r = running({ directoryIdentity: '0:0' })
    domain.captureTaskArtifacts(r); domain.captureTaskArtifacts(r)
    expect(systemEvents()).toEqual(['项目文件夹已移动、替换或无法访问，已停止收集成果。请检查原项目位置。'])
    expect(r.collectionFailure).toBe('project')
    ;(r as { directoryIdentity: string }).directoryIdentity = directoryIdentity(r.path)
    domain.captureTaskArtifacts(r)
    expect(systemEvents().at(-1)).toBe('成果收集已恢复，文件已保存，可在成果列表查看。')
    expect(r.collectionFailure).toBeUndefined()
  })
})

describe('makeArtifactsDomain · 结算与回合', () => {
  it('collect:同一 run 复用同一个 promise,进行中登记在 state.collections、结束后移除;shutdownComplete ⇒ 直接 resolve 不标记', async () => {
    const { domain, running, state } = setup()
    const r = running()
    const p = domain.collect(r)
    expect(domain.collect(r)).toBe(p); expect(state.collections.has(p)).toBe(true)
    await p
    expect(state.collections.size).toBe(0); expect(r.artifactsCollected).toBe(true)
    state.shutdownComplete = true
    const r2 = running()
    await domain.collect(r2); expect(r2.artifactsCollected).toBe(false)
  })
  it('collectTurnArtifacts:让出一拍后收集;已取消的 run 不收', async () => {
    const { domain, running, task, project, store } = setup()
    const out = outputDirectory(project, task.id); mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'x.txt'), 'x')
    const r = running()
    domain.collectTurnArtifacts(r)
    expect(store.artifacts(task.id)).toEqual([])          // 还没到 setImmediate
    await r.turnCollection
    expect(store.artifacts(task.id).map(a => a.name)).toEqual(['x.txt']); expect(r.turnCollection).toBeUndefined()
    const r2 = running({ cancelled: true })
    domain.collectTurnArtifacts(r2); await r2.turnCollection
    expect(store.artifacts(task.id)).toHaveLength(1)
  })
  it('captureCodeChanges:没有基线 ⇒ 什么都不做;在途的那份被复用', async () => {
    const { domain, running, task, store } = setup()
    const r = running()
    const p = domain.captureCodeChanges(r)
    expect(domain.captureCodeChanges(r)).toBe(p)
    await p
    expect(store.artifacts(task.id)).toEqual([]); expect(r.reviewCapture).toBeUndefined()
  })
  it('retakeBaseline:cancelled ⇒ 不取;非 git 目录 ⇒ 无基线但 baselineRetaking 复位', async () => {
    const { domain, running } = setup()
    const rc = running({ cancelled: true }); await domain.retakeBaseline(rc); expect(rc.reviewBaseline).toBeUndefined()
    const r = running(); await domain.retakeBaseline(r)
    expect(r.baselineRetaking).toBe(false)
  })
})

describe('makeArtifactsDomain · 成果读取与批准', () => {
  it('artifact:返回名字/mime/大小/sha/base64;approve 后 touched;不存在 ⇒ not_found', () => {
    const { domain, task, store, stateDir, touched } = setup()
    saveArtifactSnapshot(store, task.id, { name: 'a.txt', mime: 'text/plain', bytes: Buffer.from('hi') }, stateDir)
    const id = store.artifacts(task.id)[0]!.id
    const a = domain.artifact(task.id, id)
    expect(a).toMatchObject({ name: 'a.txt', mime: 'text/plain', size: 2, contentBase64: Buffer.from('hi').toString('base64') })
    domain.approve(task.id, id, a.sha256)
    expect(touched).toHaveBeenCalledWith(task.id)
    expect(() => domain.artifact(task.id, 'nope')).toThrow('not_found')
  })
})
