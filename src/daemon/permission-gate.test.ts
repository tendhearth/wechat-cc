import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../lib/db'
import { NetworkUnprotectedError } from '../lib/network-gate'
import { makePermissionDecisionsStore } from './permission-decisions-store'
import { makePermissionGate, RUNAWAY_MAX } from './permission-gate'
import { RULES_FILE } from '../core/permission-rules/rules-file'
import type { PermissionAsk } from '../core/permission-rules/types'

const ask = (over: Partial<PermissionAsk> = {}): PermissionAsk => ({
  surface: 'terminal', provider: 'claude', tool: 'Bash', command: 'ls', cwd: '/w', project: '/w',
  isolatedWorktree: false, tier: 'admin', scope: 'sess1', ...over,
})

function setup(rules: unknown | null, o: { cheap?: ((p: string) => Promise<string>) | null } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'perm-gate-'))
  if (rules !== null) writeFileSync(join(stateDir, RULES_FILE), typeof rules === 'string' ? rules : JSON.stringify(rules))
  const store = makePermissionDecisionsStore(openTestDb())
  const notifyOwner = vi.fn()
  const cheap = o.cheap === undefined ? vi.fn(async () => 'allow') : o.cheap
  let t = 1_000_000
  const gate = makePermissionGate({ stateDir, store, cheapEval: () => cheap, notifyOwner, now: () => t, log: () => {} })
  return { stateDir, store, notifyOwner, cheap, gate, tick: (ms: number) => { t += ms } }
}

describe('makePermissionGate', () => {
  it('no rules file ⇒ ask, disabled', async () => {
    const { gate } = setup(null)
    expect((await gate.decide(ask())).verdict).toBe('ask')
    expect(gate.status()).toMatchObject({ enabled: false, rules: 0, errors: [] })
  })
  it('broken rules file ⇒ ask + one error in status', async () => {
    const { gate } = setup('{oops')
    expect((await gate.decide(ask())).verdict).toBe('ask')
    expect(gate.status().enabled).toBe(false)
    expect(gate.status().errors.length).toBe(1)
  })
  it('a rule allow is recorded', async () => {
    const { gate, store } = setup({ version: 1, enabled: true, rules: [{ id: 'ls', when: { command: '^ls$' }, then: 'allow' }] })
    expect(await gate.decide(ask())).toMatchObject({ verdict: 'allow', by: 'rule', ruleId: 'ls' })
    expect(store.since(0)).toEqual([expect.objectContaining({ by: 'rule', ruleId: 'ls', verdict: 'allow', summary: 'ls', scope: 'sess1' })])
  })
  it('asks are never recorded', async () => {
    const { gate, store } = setup({ version: 1, enabled: true, rules: [] })
    await gate.decide(ask({ command: 'git push' }))
    expect(store.since(0)).toEqual([])
  })
  it('picks up edits to the file', async () => {
    const { gate, stateDir } = setup({ version: 1, enabled: false, rules: [] })
    expect(gate.status().enabled).toBe(false)
    const f = join(stateDir, RULES_FILE)
    writeFileSync(f, JSON.stringify({ version: 1, enabled: true, rules: [] }))
    utimesSync(f, new Date(), new Date(Date.now() + 5000))
    expect(gate.status().enabled).toBe(true)
  })
  it('review allows a low-risk request and records it', async () => {
    const { gate, store, cheap } = setup({ version: 1, enabled: true, review: 'low_risk', rules: [] })
    expect(await gate.decide(ask())).toMatchObject({ verdict: 'allow', by: 'review' })
    expect(cheap).toHaveBeenCalledTimes(1)
    expect(store.since(0)[0]).toMatchObject({ by: 'review' })
  })
  it('after 20 review allows in 10 minutes the scope goes back to asking, owner told once', async () => {
    const { gate, notifyOwner, tick } = setup({ version: 1, enabled: true, review: 'low_risk', rules: [] })
    for (let i = 0; i < RUNAWAY_MAX; i++) { expect((await gate.decide(ask())).verdict).toBe('allow'); tick(1000) }
    expect((await gate.decide(ask())).verdict).toBe('ask')
    expect((await gate.decide(ask())).verdict).toBe('ask')
    expect(notifyOwner).toHaveBeenCalledTimes(1)
    expect((await gate.decide(ask({ scope: 'other' }))).verdict).toBe('allow')
  })
  it('the window slides: old allows stop counting', async () => {
    const { gate, tick } = setup({ version: 1, enabled: true, review: 'low_risk', rules: [] })
    for (let i = 0; i < RUNAWAY_MAX; i++) await gate.decide(ask())
    tick(10 * 60_000 + 1)
    expect((await gate.decide(ask())).verdict).toBe('allow')
  })
  it('network guard refusal ⇒ ask, tried once, no retry', async () => {
    const cheap = vi.fn(async () => { throw new NetworkUnprotectedError({ safe: false, source: 'bx', detail: 'x' }) })
    const { gate } = setup({ version: 1, enabled: true, review: 'low_risk', rules: [] }, { cheap })
    expect((await gate.decide(ask())).verdict).toBe('ask')
    expect(cheap).toHaveBeenCalledTimes(1)
  })
  it('no cheap model ⇒ no review', async () => {
    const { gate } = setup({ version: 1, enabled: true, review: 'low_risk', rules: [] }, { cheap: null })
    expect((await gate.decide(ask())).verdict).toBe('ask')
  })
  it('cannot record ⇒ ask (no unrecorded approvals), never throws', async () => {
    const { gate, store } = setup({ version: 1, enabled: true, rules: [{ id: 'ls', when: { command: '^ls$' }, then: 'allow' }] })
    store.record = () => { throw new Error('disk full') }
    expect((await gate.decide(ask())).verdict).toBe('ask')
  })
})

describe('terminalAsk / projectRootOf', () => {
  it('maps a hook request; project from the git root resolver', async () => {
    const { terminalAsk } = await import('./permission-gate')
    const a = terminalAsk({ source: 'codex', session_id: 's9', cwd: '/w/p/sub', tool_name: 'Bash', command: 'ls', paths: ['/w/p/a'] }, () => '/w/p')
    expect(a).toEqual({ surface: 'terminal', provider: 'codex', tool: 'Bash', command: 'ls', paths: ['/w/p/a'], cwd: '/w/p/sub', project: '/w/p', isolatedWorktree: false, tier: 'admin', scope: 's9' })
    expect(terminalAsk({ source: 'claude', session_id: 's', cwd: '/x', tool_name: 'Read' }, () => null)).not.toHaveProperty('command')
    expect(terminalAsk({ source: 'claude', session_id: 's', cwd: '/x', tool_name: 'Bash', summary: 'ls -la' }, () => null).description).toBe('ls -la')
  })
  it('projectRootOf: a real repo resolves, a plain dir is null', async () => {
    const { projectRootOf } = await import('./permission-gate')
    const { realpathSync } = await import('node:fs')
    expect(projectRootOf(process.cwd())).toBe(realpathSync(process.cwd()))
    expect(projectRootOf(mkdtempSync(join(tmpdir(), 'not-a-repo-')))).toBeNull()
  })
})

describe('makePermissionGate × 终审', () => {
  it('rules off ⇒ the request is never even built (no git, no realpath)', async () => {
    const { gate } = setup({ version: 1, enabled: false, rules: [] })
    const build = vi.fn(() => ask())
    expect((await gate.decide(build)).verdict).toBe('ask')
    expect(build).not.toHaveBeenCalled()
    const none = setup(null)
    await none.gate.decide(build)
    expect(build).not.toHaveBeenCalled()
  })
  it('a path through a symlink that leaves the worktree is outside', async () => {
    const { mkdirSync, symlinkSync, realpathSync } = await import('node:fs')
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'perm-link-')))
    mkdirSync(join(base, 'tree')); mkdirSync(join(base, 'outside'))
    symlinkSync(join(base, 'outside'), join(base, 'tree', 'link'), 'junction')
    const { gate, cheap } = setup({ version: 1, enabled: true, review: 'low_risk', rules: [] })
    const d = await gate.decide(ask({ surface: 'workbench', tool: 'Edit', command: undefined, paths: [join(base, 'tree', 'link', 'x.plist')], project: join(base, 'tree'), isolatedWorktree: true }))
    expect(d).toMatchObject({ verdict: 'ask', by: 'floor' })
    expect(cheap).not.toHaveBeenCalled()
  })
  it('relative paths resolve against the project', async () => {
    const { realpathSync, mkdirSync } = await import('node:fs')
    const proj = realpathSync.native(mkdtempSync(join(tmpdir(), 'perm-rel-')))
    mkdirSync(join(proj, 'src'))
    const glob = `${proj.replace(/\\/g, '/')}/src/**`
    const { gate } = setup({ version: 1, enabled: true, rules: [{ id: 'src', when: { paths: glob }, then: 'allow' }] })
    expect((await gate.decide(ask({ surface: 'workbench', tool: 'Edit', command: undefined, paths: ['src/a.ts'], project: proj, isolatedWorktree: true }))).verdict).toBe('allow')
  })
  it('parallel reviews cannot overshoot the runaway cap', async () => {
    let release!: () => void
    const gateOpen = new Promise<void>(r => { release = r })
    const cheap = vi.fn(async () => { await gateOpen; return 'allow' })
    const { gate } = setup({ version: 1, enabled: true, review: 'low_risk', rules: [] }, { cheap })
    const all = Array.from({ length: 30 }, () => gate.decide(ask()))
    release()
    const verdicts = (await Promise.all(all)).map(d => d.verdict)
    expect(verdicts.filter(v => v === 'allow').length).toBe(RUNAWAY_MAX)
  })
  it("CC's state directory is a red line", async () => {
    const { gate, stateDir } = setup({ version: 1, enabled: true, rules: [{ id: 'r', when: { tool: 'Read' }, then: 'allow' }] })
    expect((await gate.decide(ask({ tool: 'Read', command: undefined, paths: [join(stateDir, 'internal-operator-token')] }))).verdict).toBe('ask')
  })
})

describe('terminalAskAsync', () => {
  it('finds the git root without blocking', async () => {
    const { terminalAskAsync } = await import('./permission-gate')
    const { realpathSync } = await import('node:fs')
    const a = await terminalAskAsync({ source: 'claude', session_id: 's', cwd: process.cwd(), tool_name: 'Bash', command: 'ls' })
    expect(a.project).toBe(realpathSync(process.cwd()))
    expect((await terminalAskAsync({ source: 'claude', session_id: 's', cwd: mkdtempSync(join(tmpdir(), 'nr-')), tool_name: 'Bash' })).project).toBeNull()
  })
})
