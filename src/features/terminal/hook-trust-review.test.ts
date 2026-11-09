import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { makeTerminalHooksService } from './hooks'
import { terminalRoutes, type TerminalRoutesDeps } from './routes'
import { installHooks, ownedHookDefinitions } from '../../cli/hook'
import type { TerminalHooksDeps } from '../../cli/terminal-hooks'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cc-hook-review-'))); dirs.push(home)
  const file = join(home, 'hooks.json'), evidenceFile = join(home, 'evidence.json')
  installHooks(file, 'codex', '"/opt/cc" hook codex')
  writeFileSync(join(home, 'config.toml'), 'invalid [')
  let version = '0.167.0'
  const d: TerminalHooksDeps = { home, env: { CODEX_HOME: home }, self: { execPath: '/opt/cc', compiled: true, cliEntry: '' }, locate: () => null, exists: () => true, evidenceFile, codexVersion: () => version }
  const service = makeTerminalHooksService({ deps: () => d, sessions: () => [] })
  const routes = terminalRoutes({ cliHooks: service, projectMemory: async () => ({ context: 'project context', reason: 'ok' }), cliEvents: { ingest: async () => 'noop' }, cliPermissions: { open: async () => ({ status: 'owner_present' }) } } as unknown as TerminalRoutesDeps)
  const invoke = () => routes['POST /v1/cli/project-memory']!(new URLSearchParams(), { source: 'codex', session_id: 'old-session', cwd: home }, { origin: 'file', tier: 'trusted' })
  const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v
  const oldFingerprint = `sha256:${createHash('sha256').update(JSON.stringify(sorted({ file, definitions: ownedHookDefinitions(file, 'codex') }))).digest('hex')}`
  return { home, file, evidenceFile, service, routes, invoke, oldFingerprint,
    changeDefinition: () => { d.self = { ...d.self, execPath: '/another/cc' }; return service.install(['codex']) },
    version: (v: string) => { version = v }, trust: () => service.status().find(s => s.source === 'codex')!.trust! }
}

describe('PR #888: requests cannot vouch for loaded Codex definitions', () => {
  it('a local process self-reporting Codex cannot grant trust when config is unreadable', async () => {
    const f = fixture()
    await f.invoke()
    expect(f.trust().state).toBe('untrusted')
  })
  it.each(['definition', 'position', 'version'])('an old session cannot undo %s invalidation', async change => {
    const f = fixture()
    // A pre-fix daemon could have persisted this receipt. It is observation, not proof.
    writeFileSync(f.evidenceFile, JSON.stringify({ fingerprint: f.oldFingerprint, version: '0.167.0', observedAt: 1 }))
    if (change === 'definition') expect(f.changeDefinition().results[0]!.reconfirmationRequired).toBe(true)
    if (change === 'position') {
      const cfg = JSON.parse(readFileSync(f.file, 'utf8'))
      cfg.hooks.SessionStart.unshift({ hooks: [{ type: 'command', command: 'other' }] })
      writeFileSync(f.file, JSON.stringify(cfg))
    }
    if (change === 'version') f.version('0.168.0')
    expect(f.trust().state).toBe('changed')
    await f.invoke()
    expect(f.trust().state).toBe('changed')
  })
  it('a matching legacy receipt with a fresh timestamp is still insufficient proof after invalidation', async () => {
    const f = fixture()
    writeFileSync(f.evidenceFile, JSON.stringify({ fingerprint: f.oldFingerprint, version: '0.167.0', changedAt: 10, observedAt: 11 }))
    await f.invoke()
    expect(f.trust().state).not.toBe('trusted')
  })
  it('project context responds without reading definitions or persisting invocation receipts', async () => {
    const f = fixture()
    const before = readFileSync(f.file, 'utf8')
    const result = await f.invoke()
    expect(result).toMatchObject({ status: 200, body: { context: 'project context' } })
    expect(existsSync(f.evidenceFile)).toBe(false)
    expect(readFileSync(f.file, 'utf8')).toBe(before)
  })
  it('event and permission ingress also leave invalidation receipts untouched', async () => {
    const f = fixture(), before = JSON.stringify({ fingerprint: 'definition-changed', changedAt: 2 })
    writeFileSync(f.evidenceFile, before)
    const caller = { origin: 'file', tier: 'trusted' } as const
    const request = { source: 'codex', session_id: 'old-session', cwd: f.home }
    await f.routes['POST /v1/cli/event']!(new URLSearchParams(), { ...request, kind: 'stop', text: 'done' }, caller)
    await f.routes['POST /v1/cli/permission']!(new URLSearchParams(), { ...request, tool_name: 'Bash', summary: 'echo done' }, caller)
    expect(readFileSync(f.evidenceFile, 'utf8')).toBe(before)
  })
})
