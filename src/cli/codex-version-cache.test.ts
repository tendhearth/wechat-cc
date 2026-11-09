import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_VERSION_TTL_MS, defaultTerminalHooksDeps, makeCodexVersionReader, readTerminalHooksForCli, type TerminalHooksDeps } from './terminal-hooks'
import { makeTerminalHooksService } from '../features/terminal/hooks'
import { terminalRoutes, type TerminalRoutesDeps } from '../features/terminal/routes'
import { installHooks } from './hook'
import { codexHookDefinitions } from './codex-hook-trust'
import { stringify } from 'smol-toml'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))

describe('Codex version checks do not spend the SessionStart response budget', () => {
  const settle = () => new Promise<void>(resolve => setImmediate(resolve))
  it('returns cached versions during a single pending refresh, and never relabels another binary', async () => {
    let now = 1000, finish!: (value: string | null) => void
    const probe = vi.fn(() => new Promise<string | null>(resolve => { finish = resolve }))
    const read = makeCodexVersionReader({ probe, now: () => now })
    expect(read('/fixture/codex')).toBeNull()
    expect(read('/fixture/codex')).toBeNull()
    await settle(); expect(probe).toHaveBeenCalledTimes(1)
    finish('0.167.0'); await settle()
    expect(read('/fixture/codex')).toBe('0.167.0')
    now += CODEX_VERSION_TTL_MS
    expect(read('/fixture/codex')).toBe('0.167.0')
    expect(read('/fixture/codex')).toBe('0.167.0')
    expect(read('/other/codex')).toBeNull()
    await settle(); expect(probe).toHaveBeenCalledTimes(2)
    finish('0.168.0'); await settle()
    expect(read('/fixture/codex')).toBe('0.168.0')
    expect(read('/other/codex')).toBeNull()
    await settle(); expect(probe).toHaveBeenCalledTimes(3)
    finish('0.144.4'); await settle()
    expect(read('/other/codex')).toBe('0.144.4')
  })
  it('throttles failed probes and does not probe absent binaries', async () => {
    let now = 1000
    const probe = vi.fn(async () => { throw Error('offline fixture') })
    const read = makeCodexVersionReader({ probe, now: () => now })
    expect(read(null)).toBeNull(); await settle(); expect(probe).not.toHaveBeenCalled()
    expect(read('/fixture/codex')).toBeNull(); await settle()
    expect(read('/fixture/codex')).toBeNull(); await settle()
    expect(probe).toHaveBeenCalledTimes(1)
    now += CODEX_VERSION_TTL_MS
    expect(read('/fixture/codex')).toBeNull(); await settle()
    expect(probe).toHaveBeenCalledTimes(2)
  })
  it('awaits a cold CLI snapshot so an already approved configuration is reported trusted', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'cc-version-cli-'))); dirs.push(home)
    const file = join(home, 'hooks.json')
    installHooks(file, 'codex', 'cc hook codex')
    writeFileSync(join(home, 'config.toml'), stringify({ hooks: { state: Object.fromEntries(codexHookDefinitions(file, '0.167.0').map(d => [d.key, { trusted_hash: d.hash }])) } }))
    const d: TerminalHooksDeps = { home, env: { CODEX_HOME: home }, self: { execPath: '/fixture/cc', compiled: true, cliEntry: '' }, exists: () => true, locate: source => source === 'codex' ? '/fixture/codex' : null, codexVersion: () => null }
    let finish!: (version: string | null) => void, completed = false
    const probe = vi.fn(() => new Promise<string | null>(resolve => { finish = resolve }))
    const snapshot = readTerminalHooksForCli(d, probe).then(value => { completed = true; return value })
    await settle()
    expect(completed).toBe(false)
    expect(probe).toHaveBeenCalledExactlyOnceWith('/fixture/codex')
    finish('0.167.0')
    expect((await snapshot).find(s => s.source === 'codex')!.trust).toMatchObject({ state: 'trusted', evidence: 'config', version: '0.167.0' })
  })
  it.skipIf(process.platform === 'win32')('cold capability polling and project memory respond while a fixture version probe is unfinished', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-version-cache-')); dirs.push(home)
    const binary = join(home, 'codex'), gate = join(home, 'release')
    // Offline CLI fixture; never execute the installed Codex binary.
    writeFileSync(binary, '#!/bin/sh\nwhile [ ! -f "$0.release" ]; do /bin/sleep 0.02; done\nprintf "codex-cli 0.167.0\\n"\n', { mode: 0o700 })
    installHooks(join(home, 'hooks.json'), 'codex', 'cc hook codex')
    const previousPath = process.env.PATH
    process.env.PATH = home
    try {
      const d = { ...defaultTerminalHooksDeps(), home, env: { CODEX_HOME: home }, evidenceFile: join(home, 'evidence.json'), locate: (s: string) => s === 'codex' ? binary : null }
      const service = makeTerminalHooksService({ deps: () => d, sessions: () => [] })
      const routes = terminalRoutes({ cliHooks: service, projectMemory: async () => ({ context: 'project context', reason: 'ok' }) } as unknown as TerminalRoutesDeps)
      const start = performance.now()
      const initial = service.capabilityInput()
      const response = await routes['POST /v1/cli/project-memory']!(new URLSearchParams(), { source: 'codex' }, { origin: 'file', tier: 'trusted' })
      expect(performance.now() - start).toBeLessThan(650)
      expect(initial!.sources[0]!.trust?.version).toBeNull()
      expect(response).toMatchObject({ status: 200, body: { context: 'project context' } })
      // Release only after the response: the probe is necessarily unfinished at that point.
      writeFileSync(`${binary}.release`, gate)
      await expect.poll(() => service.capabilityInput()!.sources[0]!.trust?.version).toBe('codex-cli 0.167.0')
    } finally {
      writeFileSync(`${binary}.release`, gate)
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })
})
