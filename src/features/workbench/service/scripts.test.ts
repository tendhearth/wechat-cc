import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { removeTempDir } from '../../../lib/test-temp'
import { createProviderRegistry } from '../../../app/provider-registry'
import { makeWorkbenchStore } from '../../../core/workbench/store'
import { ensureWorktree, planWorktree } from '../../../core/workbench/worktree-workspaces'
import { pinnedScriptSha, readPinnedScripts, repoKeyOf } from '../worktree-scripts'
import { makeRuntimeState } from './state'
import { makeScriptsDomain, psStartMs, type ScriptsOptions } from './scripts'
import { makeWorktreeDomain } from './worktree'
import type { ServiceCtx, ServiceDeps } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []; const stops: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const db of dbs.splice(0)) db.close()
  for (const d of dirs.splice(0)) removeTempDir(d)
})
const PID = 'p-0123456789abcdef0123'
const BASE = { PATH: '/usr/bin:/bin', HOME: tmpdir() }

/** 真 git 仓库 + 真工作区 + 真 store;脚本用 /bin/sh 真跑。log = 脚本往外写的记号文件(不弄脏工作区)。 */
function setup(scripts: Record<string, string> | null, deps: Partial<ServiceDeps> = {}, opts: ScriptsOptions = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wb-scripts-domain-'))); dirs.push(root)
  const project = join(root, 'repo'), stateDir = join(root, 'state'), log = join(root, 'log')
  mkdirSync(project); mkdirSync(stateDir); mkdirSync(log)
  const g = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'pipe' })
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  writeFileSync(join(project, 'a.txt'), 'one\n')
  if (scripts) writeFileSync(join(project, 'tendhearth.json'), JSON.stringify({ scripts: Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replaceAll('$LOG', log)])) }))
  g('add', '-A'); g('commit', '-q', '-m', 'init')
  const db = openTestDb(); dbs.push(db)
  const store = makeWorkbenchStore(db)
  const state = makeRuntimeState()
  const hub = { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }
  const ctx: ServiceCtx = { store, stateDir, state, hub, deps: { ownerChatId: () => 'owner', registry: createProviderRegistry(), ...deps }, ensureAccepting: () => { if (state.stopping) throw new Error('workbench_stopping') }, now: Date.now }
  const scriptsDomain = makeScriptsDomain(ctx, { shell: '/bin/sh', baseEnv: BASE, outputIntervalMs: 10, probe: async () => true, ...opts })
  stops.push(() => scriptsDomain.shutdown())
  const worktree = makeWorktreeDomain(ctx, { scripts: scriptsDomain, view: { isReplied: () => true } })
  const plan = planWorktree({ stateDir, projectId: PID, projectPath: project, repoRoot: project, id: 'abcd1234' })
  const path = ensureWorktree(plan)
  const task = store.create({ title: '事', path, providerId: 'claude', ownerChatId: 'owner', registerProject: false })
  store.worktrees.record({ taskId: task.id, projectPath: project, repoRoot: project, root: plan.root, branch: plan.branch, scriptSha: pinnedScriptSha(plan.root) })
  const hash = () => { const p = readPinnedScripts(project, store.worktrees.get(task.id)!.scriptSha!); return p.kind === 'ok' ? p.hash : '' }
  const approve = () => store.scriptApprovals.add(repoKeyOf(project), hash())
  const read = (name: string) => existsSync(join(log, name)) ? readFileSync(join(log, name), 'utf8') : ''
  const events = () => store.detail(task.id).events
  const scriptEvents = () => events().filter(e => e.runId?.startsWith('script-'))
  const notes = () => events().filter(e => e.kind === 'system').map(e => e.text)
  return { db, store, ctx, hub, scripts: scriptsDomain, worktree, task, plan, project, log, hash, approve, read, scriptEvents, notes }
}
const until = (fn: () => unknown, timeout = 8000) => expect.poll(fn, { timeout, interval: 30 })

describe.skipIf(process.platform === 'win32')('workbench scripts domain (real git + /bin/sh)', () => {
  it('busy / serving(回退用,2026-10-21):setup 在跑 ⇒ busy;只有 run 在跑 ⇒ 不 busy、serving', async () => {
    const t = setup({ setup: 'sleep 30', run: 'sleep 30' })
    t.approve()
    expect(t.scripts.busy(t.task.id)).toBe(false)
    t.scripts.afterCheckout(t.task.id)
    await until(() => t.scripts.busy(t.task.id)).toBe(true)
    expect(t.scripts.serving(t.task.id)).toBe(false)
  })
  it('not approved ⇒ afterCheckout only says 待确认; run refuses with 428 code; nothing runs', async () => {
    const t = setup({ setup: 'echo s > $LOG/setup', run: 'echo r > $LOG/run' })
    t.scripts.afterCheckout(t.task.id)
    expect(t.notes().some(n => n.includes('待确认'))).toBe(true)
    await expect(t.scripts.scriptAction(t.task.id, 'run')).rejects.toThrow('script_approval_required')
    await new Promise(r => setTimeout(r, 200))
    expect(t.read('setup') + t.read('run')).toBe('')
    expect(t.scripts.status(t.task.id)).toMatchObject({ configured: true, approved: false, setup: 'pending', run: 'idle', config: { setup: expect.stringContaining('echo s'), archive: null } })
  })

  it('approve: wrong hash ⇒ script_config_changed; right hash ⇒ pending setup starts, holds busy, marks setup done', async () => {
    const releases: string[] = []
    const holdBusy = vi.fn((label: string) => () => { releases.push(label) })
    const t = setup({ setup: 'echo "port=$TENDHEARTH_PORT" > $LOG/setup' }, { holdBusy })
    expect(() => t.scripts.approveScripts(t.task.id, 'b'.repeat(64))).toThrow('script_config_changed')
    expect(t.store.scriptApprovals.has(repoKeyOf(t.project), t.hash())).toBe(false)
    t.scripts.approveScripts(t.task.id, t.hash())
    await until(() => t.store.worktrees.get(t.task.id)?.setupAt).not.toBeNull()
    expect(t.read('setup').trim()).toBe('port=47100')
    expect(t.store.worktrees.getPort(t.task.id)).toBe(47100)
    expect(holdBusy).toHaveBeenCalledWith(`wt-setup:${t.task.id}`)
    await until(() => releases).toEqual([`wt-setup:${t.task.id}`])
    expect(t.scriptEvents().map(e => [e.kind, e.activity?.label, e.activity?.status])).toEqual([['tool_call', 'setup', 'completed']])
    expect(t.scripts.status(t.task.id)).toMatchObject({ approved: true, setup: 'done' })
  })

  it('afterCheckout with an approved config runs setup right away; a failure shows as failed and `run` retries setup first', async () => {
    const t = setup({ setup: 'if [ -f $LOG/ok ]; then echo fine; else echo nope; exit 4; fi', run: 'echo r > $LOG/run; sleep 30' })
    t.approve()
    t.scripts.afterCheckout(t.task.id)
    await until(() => t.scripts.status(t.task.id)).toMatchObject({ setup: 'failed' })
    expect(t.scriptEvents()[0]?.activity).toMatchObject({ status: 'failed', output: expect.stringContaining('nope') })
    writeFileSync(join(t.log, 'ok'), '')
    await t.scripts.scriptAction(t.task.id, 'run')
    expect(t.scripts.status(t.task.id)).toMatchObject({ run: 'queued' })
    await until(() => t.read('run').trim()).toBe('r')
    expect(t.scripts.status(t.task.id)).toMatchObject({ setup: 'done', run: 'running' })
  }, 15_000)

  it('run: one per worktree, no holdBusy, output tail is redacted, stop ⇒ cancelled; the group is recorded then cleared', async () => {
    const holdBusy = vi.fn(() => () => {})
    const t = setup({ run: 'echo "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx"; echo ready > $LOG/run; sleep 30' }, { holdBusy })
    t.approve()
    const result = await t.scripts.scriptAction(t.task.id, 'run')
    expect(result).toMatchObject({ branch: 'cc/abcd1234', port: 47100, scripts: { run: 'running', setup: 'none' } })
    expect(t.store.worktrees.scriptGroups(t.task.id).groups).toHaveLength(1)
    expect(t.store.worktrees.scriptGroups(t.task.id).starts).toHaveLength(1)
    await expect(t.scripts.scriptAction(t.task.id, 'run')).rejects.toThrow('script_running')
    expect(holdBusy).not.toHaveBeenCalled()
    await until(() => t.scriptEvents()[0]?.activity?.output ?? '').toContain('[已打码]')
    expect(JSON.stringify(t.scriptEvents())).not.toContain('sk-abcdefghijklmnop')
    await t.scripts.scriptAction(t.task.id, 'stop')
    await until(() => t.scriptEvents()[0]?.activity?.status).toBe('cancelled')
    expect(t.store.worktrees.scriptGroups(t.task.id).groups).toBeNull()
    expect(t.scripts.status(t.task.id)).toMatchObject({ run: 'idle' })
  }, 15_000)

  it('no run script ⇒ no_scripts; archived task ⇒ workbench_archived; not a worktree ⇒ not_worktree', async () => {
    const t = setup({ setup: 'true' })
    t.approve()
    await expect(t.scripts.scriptAction(t.task.id, 'run')).rejects.toThrow('no_scripts')
    t.db.query("UPDATE workbench_tasks SET status='completed' WHERE id=?").run(t.task.id)
    t.store.setArchived(t.task.id, true)
    await expect(t.scripts.scriptAction(t.task.id, 'run')).rejects.toThrow('workbench_archived')
    const other = t.store.create({ title: 'x', path: t.project, providerId: 'claude', ownerChatId: 'owner' })
    await expect(t.scripts.scriptAction(other.id, 'run')).rejects.toThrow('not_worktree')
    expect(t.scripts.status(other.id)).toBeNull()
  })

  it('remove without archive / running scripts stays synchronous (unchanged)', () => {
    const t = setup(null)
    expect(t.worktree.worktreeAction(t.task.id, 'remove')).toEqual({ branch: 'cc/abcd1234', removed: true })
    expect(existsSync(t.plan.root)).toBe(false)
  })

  it('remove with an approved archive: stops run, runs archive (holds busy), then removes; reports removing', async () => {
    const holdBusy = vi.fn((_label: string) => () => {})
    const t = setup({ run: 'echo up > $LOG/run; sleep 30', archive: 'echo "archived $TENDHEARTH_BRANCH" > $LOG/archive' }, { holdBusy })
    t.approve()
    await t.scripts.scriptAction(t.task.id, 'run')
    await until(() => t.read('run').trim()).toBe('up')
    expect(t.worktree.worktreeAction(t.task.id, 'remove')).toEqual({ branch: 'cc/abcd1234', removing: true })
    expect(t.scripts.status(t.task.id)).toMatchObject({ archiving: true })
    await until(() => t.store.worktrees.get(t.task.id)?.removedAt).not.toBeNull()
    expect(t.read('archive').trim()).toBe('archived cc/abcd1234')
    expect(existsSync(t.plan.root)).toBe(false)
    expect(holdBusy).toHaveBeenCalledWith(`wt-archive:${t.task.id}`)
    expect(t.scriptEvents().map(e => [e.activity?.label, e.activity?.status])).toEqual([['run', 'cancelled'], ['archive', 'completed']])
    expect(t.notes().at(-1)).toContain('独立工作区已删除')
  }, 15_000)

  it('archive failure still removes, with a note; unapproved archive is skipped (sync) with a note', async () => {
    const t = setup({ archive: 'echo bad; exit 2' })
    t.approve()
    expect(t.worktree.worktreeAction(t.task.id, 'remove')).toMatchObject({ removing: true })
    await until(() => t.notes().some(n => n.includes('没跑成功'))).toBe(true)
    expect(existsSync(t.plan.root)).toBe(false)

    const u = setup({ archive: 'echo x > $LOG/archive' })
    expect(u.worktree.worktreeAction(u.task.id, 'remove')).toEqual({ branch: 'cc/abcd1234', removed: true })
    expect(u.read('archive')).toBe('')
    expect(u.notes().some(n => n.includes('还没确认'))).toBe(true)
  }, 15_000)

  it('dirty worktree is refused before any archive runs', () => {
    const t = setup({ archive: 'echo x > $LOG/archive' })
    t.approve()
    writeFileSync(join(t.plan.root, 'new.txt'), 'x')
    expect(() => t.worktree.worktreeAction(t.task.id, 'remove')).toThrow('worktree_dirty')
    expect(t.scripts.status(t.task.id)).toMatchObject({ archiving: false })
  })

  it('reopen clears setup_at and runs setup again', async () => {
    const t = setup({ setup: 'echo s >> $LOG/setup' })
    t.approve()
    t.scripts.afterCheckout(t.task.id)
    await until(() => t.store.worktrees.get(t.task.id)?.setupAt).not.toBeNull()
    t.worktree.worktreeAction(t.task.id, 'remove')
    t.worktree.worktreeAction(t.task.id, 'reopen')
    await until(() => t.read('setup').split('\n').filter(Boolean).length).toBe(2)
  }, 15_000)

  it('shutdown stops every script and refuses new ones', async () => {
    const t = setup({ run: 'echo up > $LOG/run; sleep 30' })
    t.approve()
    await t.scripts.scriptAction(t.task.id, 'run')
    await t.scripts.shutdown()
    expect(t.scriptEvents()[0]?.activity?.status).toBe('cancelled')
    expect(t.store.worktrees.scriptGroups(t.task.id).groups).toBeNull()
    await expect(t.scripts.scriptAction(t.task.id, 'run')).rejects.toThrow('workbench_stopping')
  }, 15_000)
})

describe('workbench scripts recover (after a crash)', () => {
  function crashed(row: { groups: number[]; boot: number; starts: number[] }, opts: ScriptsOptions, deps: Partial<ServiceDeps>) {
    const db = openTestDb(); dbs.push(db)
    const store = makeWorkbenchStore(db)
    const task = store.create({ title: '事', path: '/w', providerId: 'claude', ownerChatId: 'owner' })
    store.worktrees.record({ taskId: task.id, projectPath: '/p', repoRoot: '/p', root: '/w', branch: 'cc/x' })
    store.worktrees.setScriptGroups(task.id, row.groups, row.boot, row.starts)
    const ctx: ServiceCtx = { store, stateDir: '/s', state: makeRuntimeState(), hub: { touched: vi.fn(), bumped: vi.fn(), dispose: vi.fn() }, deps: { ownerChatId: () => 'owner', registry: createProviderRegistry(), bootTimeMs: () => 1_000_000, ...deps }, ensureAccepting: () => {}, now: Date.now }
    makeScriptsDomain(ctx, opts).recover()
    return { store, task, notes: store.detail(task.id).events.filter(e => e.kind === 'system').map(e => e.text) }
  }
  it('same boot + group alive + leader start matches ⇒ SIGTERM the group; column cleared; one note', () => {
    const kill = vi.fn()
    const { store, task, notes } = crashed({ groups: [4242], boot: 1_000_000, starts: [5_000_000] }, { kill, processStartMs: () => 5_001_000 }, { writerGroupAlive: () => true })
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(store.worktrees.scriptGroups(task.id).groups).toBeNull()
    expect(notes).toEqual(['CC 上次退出时工作区脚本还在跑，已停掉。'])
  })
  it('leader start does not match (pid reused) ⇒ no signal, an honest note', () => {
    const kill = vi.fn()
    const { notes } = crashed({ groups: [4242], boot: 1_000_000, starts: [5_000_000] }, { kill, processStartMs: () => 9_000_000 }, { writerGroupAlive: () => true })
    expect(kill).not.toHaveBeenCalled()
    expect(notes[0]).toContain('核对不上')
  })
  it('the machine rebooted / group gone / start unreadable ⇒ no signal', () => {
    const kill = vi.fn()
    crashed({ groups: [4242], boot: 1_000_000 + 60 * 60_000, starts: [5_000_000] }, { kill, processStartMs: () => 5_000_000 }, { writerGroupAlive: () => true })
    crashed({ groups: [4242], boot: 1_000_000, starts: [5_000_000] }, { kill, processStartMs: () => 5_000_000 }, { writerGroupAlive: () => false })
    crashed({ groups: [4242], boot: 1_000_000, starts: [5_000_000] }, { kill, processStartMs: () => null }, { writerGroupAlive: () => true })
    expect(kill).not.toHaveBeenCalled()
  })
  it.skipIf(process.platform === 'win32')('psStartMs reads this process start time (UTC, seconds)', () => {
    const started = Date.now() - process.uptime() * 1000
    expect(Math.abs((psStartMs(process.pid) ?? 0) - started)).toBeLessThan(5_000)
    expect(psStartMs(2 ** 22 + 12345)).toBeNull()
  })
})
