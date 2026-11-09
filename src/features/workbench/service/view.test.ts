import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { createProviderRegistry } from '../../../app/provider-registry'
import { makeWorkbenchStore, type WorkbenchStore, type Task, publicTask } from '../../../adapters/store/workbench/store'
import { MANAGED_NATIVE_CAPABILITIES } from '../../../domain/workbench/executor-capabilities'
import { removeTempDir } from '../../../lib/test-temp'
import type { AgentProvider, AgentRuntimeSnapshot } from '../../../ports/agent-provider'
import { makeRuntimeState, type Active } from './state'
import { makeViewDomain, ATTENTION_TEXT_MAX } from './view'
import type { ServiceCtx } from './ctx'
import { safePetTurn } from '../../../domain/pet-turn'
import { makeRunPermissions } from '../../../adapters/workbench/permissions'
import { makeRunUserInput } from '../../../adapters/workbench/user-input'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })
const provider: AgentProvider = { async spawn() { throw new Error('not spawned') } }

function setup(over: { defaultProvider?: string; owner?: string | null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-view-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const registry = createProviderRegistry()
  registry.register('claude', provider, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  registry.register('codex', provider, { displayName: 'Codex', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  const state = makeRuntimeState()
  const ctx: ServiceCtx = { store, stateDir, state, hub: { bumped: vi.fn(), dispose: vi.fn() }, deps: { ownerChatId: () => over.owner === undefined ? 'owner' : over.owner, registry, nativeHistory: { claude: {} as never }, ...(over.defaultProvider ? { defaultProvider: over.defaultProvider } : {}) }, ensureAccepting: () => {}, now: Date.now }
  const domain = makeViewDomain(ctx, { admission: { provider: id => { const p = registry.get(id); if (!p) throw new Error('unavailable_provider'); return p as never }, continuation: () => ({ mode: 'new' }) }, quota: { quotaExhausted: () => null } })
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  const snapshot = (over: Partial<AgentRuntimeSnapshot> = {}): AgentRuntimeSnapshot => ({ retained: true, foreground: 'idle', backgroundCount: 0, input: 'send', ...over })
  /** 假 Active:带 runtime 快照与空的待决队列。 */
  const running = (over: Partial<Active> & { snap?: AgentRuntimeSnapshot } = {}): Active => {
    const { snap, ...rest } = over
    return { identity: 'run-1', taskId: task.id, title: task.title, task, path: project, order: 1, state: 'active', cancelled: false, finishing: false, uncertain: false, permissions: { pending: () => [] }, questions: { pending: () => [] }, session: snap ? { workbenchRuntime: { snapshot: () => snap } } : undefined, ...rest } as unknown as Active
  }
  return { store, state, domain, task, project, running, snapshot, db, hub: ctx.hub }
}

describe('makeViewDomain · 进度', () => {
  it('projectActivity reads real pending brokers without detail or audit bodies and authorizes the stored owner first', async () => {
    const { domain, store, state, task, running, snapshot, db, project } = setup()
    store.update(task.id, 'running')
    const permissions = makeRunPermissions({ taskId: task.id, audit: event => { store.addEvent(task.id, 'system', event.type === 'request' ? '权限请求审计正文' : '权限已处理') } })
    const questions = makeRunUserInput({ taskId: task.id, audit: () => { store.addEvent(task.id, 'system', '执行者提问审计正文') } })
    state.runsByTask.set(task.id, running({ permissions, questions, snap: snapshot() }))
    const permission = permissions.request({ tool: 'Bash', description: '运行本地检查' })
    const question = questions.request({ questions: [{ id: 'format', header: '格式', question: '要哪种报告？', options: [], allowOther: true }] })
    const permissionId = permissions.pending()[0]!.id, questionId = questions.pending()[0]!.id
    const detail = vi.spyOn(store, 'detail').mockImplementation(() => { throw new Error('detail must not run') })
    expect(db.query("SELECT id FROM matter_items WHERE kind IN ('permission','question')").all()).toEqual([])
    expect(domain.projectActivity(task.id)).toEqual({ phase: 'working', requestId: permissionId, waitingFor: 'Bash: 运行本地检查' })
    permissions.resolve(permissionId, 'allow'); await permission
    expect(domain.projectActivity(task.id)).toEqual({ phase: 'working', requestId: questionId, waitingFor: '要哪种报告？' })
    questions.close(); await question
    expect(domain.projectActivity(task.id)).toEqual({ phase: 'replied', requestId: null, waitingFor: null })
    const foreign = store.create({ title: '外人的任务', path: project, providerId: 'claude', ownerChatId: 'guest' })
    const forbidden = vi.fn(() => { throw new Error('foreign pending must not be read') })
    state.runsByTask.set(foreign.id, running({ permissions: { pending: forbidden } } as never))
    expect(domain.projectActivity(foreign.id)).toBeNull()
    expect(domain.projectActivity('missing')).toBeNull()
    expect(forbidden).not.toHaveBeenCalled(); expect(detail).not.toHaveBeenCalled()
  })
  it('isReplied:retained + idle + 无后台 + 无待决 ⇒ true;取消/在写/有待决 ⇒ false', () => {
    const { domain, running, snapshot } = setup()
    expect(domain.isReplied(running({ snap: snapshot() }))).toBe(true)
    expect(domain.isReplied(running({ snap: snapshot({ foreground: 'running' }) }))).toBe(false)
    expect(domain.isReplied(running({ snap: snapshot(), cancelled: true }))).toBe(false)
    expect(domain.isReplied(running({ snap: snapshot(), permissions: { pending: () => [{}] } } as never))).toBe(false)
    expect(domain.isReplied(running())).toBe(false)   // 没有 runtime 快照
  })
  it('phaseOf / taskView:queued→queued;running 已答复→replied 否则 working;completed→replied;终态照抄;canArchive 只对没在跑的终态', () => {
    const { domain, running, snapshot, task, store, state } = setup()
    const t = (status: string) => ({ ...publicTask(store.get(task.id)), status } as unknown as Task)
    expect(domain.phaseOf(t('queued'), undefined)).toBe('queued')
    expect(domain.phaseOf(t('running'), running({ snap: snapshot() }))).toBe('replied')
    expect(domain.phaseOf(t('running'), running())).toBe('working')
    expect(domain.phaseOf(t('completed'), undefined)).toBe('replied')
    expect(domain.phaseOf(t('failed'), undefined)).toBe('failed')
    expect(domain.taskView(t('completed')).canArchive).toBe(true)
    expect(domain.taskView({ ...t('completed'), error: 'writer_not_closed' } as never).canArchive).toBe(false)
    state.runsByTask.set(task.id, running())
    expect(domain.taskView(t('completed')).canArchive).toBe(false)
    expect(domain.taskView(t('running'), true)).toMatchObject({ pendingPermissionCount: 0, pendingQuestionCount: 0 })
  })
  it('waitingFor:不在排队 ⇒ null;同路径被占、持有者已答复 ⇒ holderWriting=false 且 closeInMs≥0;持有者找不到 ⇒ holderWriting=true', () => {
    const { domain, running, snapshot, state } = setup()
    expect(domain.waitingFor(running())).toBeNull()
    const holder = running({ identity: 'holder', snap: snapshot(), idleClose: { timer: 0 as never, at: Date.now() + 5000, reason: 'idle' } })
    state.reservations.set('holder', holder); state.runsByTask.set(holder.taskId, holder)
    const waiter = running({ identity: 'waiter', taskId: 'other', order: 2, state: 'queued' })
    const w = domain.waitingFor(waiter)
    expect(w).toMatchObject({ holderWriting: false }); expect(w!.closeInMs).toBeGreaterThanOrEqual(0)
    state.runsByTask.clear()
    expect(domain.waitingFor(waiter)).toMatchObject({ holderWriting: true, closeInMs: null })
  })
  it('attention:只列有待决权限/提问的 run', () => {
    const { domain, running, state, task } = setup()
    state.runsByTask.set(task.id, running())
    expect(domain.attention().tasks).toEqual([])
    state.runsByTask.set(task.id, running({ permissions: { pending: () => [{ id: 'p1' }] } } as never))
    expect(domain.attention().tasks).toMatchObject([{ id: task.id, pendingPermissionCount: 1, pendingQuestionCount: 0 }])
  })
  it('attention:每条带第一件待决的原文(权限优先,与手机同一个格式),压成一行、有上限', () => {
    const { domain, running, state, task } = setup()
    const perm = (id: string, createdAt: number, description = '安装图片处理组件') => ({ id, taskId: task.id, tool: 'Bash', description, createdAt })
    const ask = (id: string, question: string) => ({ id, taskId: task.id, createdAt: 1, questions: [{ id: 'q', header: 'h', question, options: [] }] })
    state.runsByTask.set(task.id, running({ permissions: { pending: () => [perm('p2', 20, '第二件'), perm('p1', 10)] }, questions: { pending: () => [ask('q1', '要哪个?')] } } as never))
    expect(domain.attention().tasks[0]!.first).toEqual({ kind: 'permission', text: 'Bash: 安装图片处理组件' })
    state.runsByTask.set(task.id, running({ questions: { pending: () => [ask('q1', '  可以\n安装图片处理组件吗?  ')] } } as never))
    expect(domain.attention().tasks[0]!.first).toEqual({ kind: 'question', text: '可以 安装图片处理组件吗?' })
    state.runsByTask.set(task.id, running({ permissions: { pending: () => [perm('p1', 1, 'x'.repeat(500))] } } as never))
    const text = domain.attention().tasks[0]!.first!.text
    expect(text.length).toBe(ATTENTION_TEXT_MAX); expect(text.endsWith('…')).toBe(true)
  })
})

describe('makeViewDomain · 列表与详情', () => {
  it('list:执行者带能力/额度/用量;defaultProvider 不在名单 ⇒ 回落第一个;historyProviders / canWechat / unattendedAcknowledgedAt', () => {
    const { domain } = setup({ defaultProvider: 'nope' })
    const l = domain.list()
    expect(l.providers.map(p => p.id)).toEqual(['claude', 'codex'])
    expect(l.defaultProvider).toBe('claude'); expect(l.historyProviders).toEqual(['claude']); expect(l.canWechat).toBe(true); expect(l.unattendedAcknowledgedAt).toBeNull()
    expect(setup({ defaultProvider: 'codex' }).domain.list().defaultProvider).toBe('codex')
  })
  it('list:agentNames 给出列表里每家执行者的正式名字(收敛清单 ⑥,registry.namesOf,桌面不存名字表)', () => {
    const l = setup().domain.list()
    expect(l.agentNames).toEqual({ claude: 'Claude', codex: 'Codex' })
  })
  it('projects:没配主人 ⇒ [];addProject:未知执行者 ⇒ unavailable_provider、畸形 ⇒ invalid_request', () => {
    expect(setup({ owner: null }).domain.projects()).toEqual([])
    const { domain, project } = setup()
    expect(() => domain.addProject({ path: project, providerId: 'nope' })).toThrow('unavailable_provider')
    expect(() => domain.addProject({ path: project, providerId: 'claude', name: '' })).toThrow('invalid_request')
    expect(domain.addProject({ path: project, providerId: 'claude' })).toMatchObject({ path: project })
  })
  it('detail:没在跑 ⇒ 带 continuation(经注入的 admission.continuation)、没有 inputMode;在跑 ⇒ runId + inputMode', () => {
    const { domain, running, snapshot, task, state } = setup()
    const d1 = domain.detail(task.id)
    expect(d1).toMatchObject({ continuation: { mode: 'new' }, wechatNotifications: { enabled: false } }); expect(d1).not.toHaveProperty('inputMode')
    state.runsByTask.set(task.id, running({ snap: snapshot({ input: 'steer' }) }))
    expect(domain.detail(task.id)).toMatchObject({ runId: 'run-1', inputMode: 'steer' })
  })
})


describe('pet owner activity projection',()=>{
 it('P2-5: real pending script input never enters pet activity details or the trusted projection',()=>{
  const {domain,state,running,task,store}=setup();store.update(task.id,'running')
  state.runsByTask.set(task.id,running({permissions:{pending:()=>[{id:'p',taskId:task.id,tool:'Bash',description:'python3 -c "private-inline-source API_KEY=private-credential"',createdAt:1}]}} as never))
  const activities=domain.petActivities()
  expect(JSON.stringify(activities)).not.toContain('private-inline-source')
  expect(JSON.stringify(activities)).not.toContain('private-credential')
  const pet=safePetTurn({owner_last_contact_at:null,turn:{phase:'permission',since:null},last_done_at:null,pending_permissions:[],activities})
  expect(JSON.stringify(pet)).not.toContain('private-inline-source')
  expect(JSON.stringify(pet)).not.toContain('private-credential')
  expect(pet.activities?.[0]?.phase).toBe('needs_input')
 })
 it('includes older live owner decisions before truncation, excludes foreign and archived tasks, and stays read-only',()=>{
  const {store,state,domain,task,project,running,db,hub}=setup()
  store.update(task.id,'running')
  db.query('UPDATE workbench_tasks SET updated_at=1 WHERE id=?').run(task.id)
  state.runsByTask.set(task.id,running({permissions:{pending:()=>[{id:'p1',taskId:task.id,tool:'Bash',description:'运行本地检查',createdAt:1}]}} as never))
  for(let i=0;i<25;i++)store.create({title:'近期自己的事',path:project,providerId:'claude',ownerChatId:'owner'})
  let foreign:any
  for(let i=0;i<205;i++)foreign=store.create({title:'他人的私事',path:project,providerId:'claude',ownerChatId:'other'})
  state.runsByTask.set(foreign.id,running({taskId:foreign.id,task:foreign,title:foreign.title,permissions:{pending:()=>[{id:'secret',taskId:foreign.id,tool:'Bash',description:'private',createdAt:0}]}} as never))
  const archived=store.create({title:'已归档',path:project,providerId:'claude',ownerChatId:'owner'});store.update(archived.id,'completed');store.setArchived(archived.id,true)
  const before=db.query<{n:number},[]>('SELECT total_changes() AS n').get()!.n
  const result=domain.petActivities()
  expect(result).toHaveLength(8)
  expect(result[0]).toEqual({taskId:task.id,title:'事',phase:'needs_input',detail:'需要你决定',updatedAt:store.get(task.id).updatedAt})
  expect(result.some((a:any)=>a.taskId===foreign.id||a.taskId===archived.id||a.title==='他人的私事')).toBe(false)
  expect(db.query<{n:number},[]>('SELECT total_changes() AS n').get()!.n).toBe(before)
  expect(hub.bumped).not.toHaveBeenCalled()
 })
 it('without a trusted owner returns no task summaries even if active runs exist',()=>{
  const {domain,state,running,task}=setup({owner:null});state.runsByTask.set(task.id,running())
  expect(domain.petActivities()).toEqual([])
 })
 it('reports actual questions, suspended work, stopping and recent replies without claiming unread',()=>{
  const {domain,state,running,store,task,project,db}=setup()
  store.update(task.id,'running');state.runsByTask.set(task.id,running({questions:{pending:()=>[{id:'q',taskId:task.id,createdAt:1,questions:[{question:'  选择\n哪一种?  '}]}]}} as never))
  const paused=store.create({title:'暂停的事',path:project,providerId:'claude',ownerChatId:'owner'});store.update(paused.id,'running');state.runsByTask.set(paused.id,running({taskId:paused.id,task:paused,networkSuspended:{since:'2026-11-01T00:00:00Z'}} as never))
  const stopping=store.create({title:'停下中的事',path:project,providerId:'claude',ownerChatId:'owner'});store.update(stopping.id,'cancelling')
  const reply=store.create({title:'已答复的事',path:project,providerId:'claude',ownerChatId:'owner'});store.update(reply.id,'completed')
  const old=store.create({title:'旧答复',path:project,providerId:'claude',ownerChatId:'owner'});store.update(old.id,'completed');db.query('UPDATE workbench_tasks SET updated_at=? WHERE id=?').run(Date.now()-600001,old.id)
  const cancel=store.create({title:'已取消',path:project,providerId:'claude',ownerChatId:'owner'});store.update(cancel.id,'cancelled')
  const result=domain.petActivities()
  expect(result.find((x:any)=>x.taskId===task.id)).toMatchObject({phase:'needs_input',detail:'需要你决定'})
  expect(result.find((x:any)=>x.taskId===paused.id)).toMatchObject({phase:'paused'})
  expect(result.find((x:any)=>x.taskId===stopping.id)).toMatchObject({phase:'stopping'})
  expect(result.find((x:any)=>x.taskId===reply.id)).toMatchObject({phase:'replied'})
  expect(result.some((x:any)=>x.taskId===old.id||x.taskId===cancel.id)).toBe(false)
  expect(result.every((x:any)=>!('unread' in x))).toBe(true)
 })
 it('bounds owner-provided titles and pending summaries and preserves the exact task identity',()=>{
  const {domain,state,running,task,store,db}=setup();db.query('UPDATE workbench_tasks SET title=? WHERE id=?').run('  标题\n'+'字'.repeat(100),task.id);store.update(task.id,'running')
  state.runsByTask.set(task.id,running({permissions:{pending:()=>[{id:'p',taskId:task.id,tool:'Bash',description:'x'.repeat(500),createdAt:1}]}} as never))
  const activity=domain.petActivities()[0]!;expect(activity.taskId).toBe(task.id);expect(activity.title.length).toBeLessThanOrEqual(80);expect(activity.title).not.toMatch(/\n/);expect(activity.detail!.length).toBeLessThanOrEqual(120)
 })
})
