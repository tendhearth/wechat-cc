import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPlugins, pluginMcpSpecs, setPluginEnabled, cmpVersion } from './registry'
import { MANIFEST_FILE } from './paths'

function writePlugin(root: string, name: string, manifest: unknown): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest))
  return dir
}

// /bin/sh is absolute + always present → plugins built from good() are ready,
// keeping tests hermetic (no dependency on python3 being on the CI PATH). PATH
// resolution of a *bare* command is exercised explicitly further down.
const good = (name: string) => ({
  name,
  kind: 'mcp',
  displayName: name,
  spawn: { command: '/bin/sh', args: ['${pluginDir}/main.py'], env: { DATA: '${pluginDir}/data' } },
})

describe('plugin registry', () => {
  let stateDir: string
  let bundledDir: string

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'plugins-test-'))
    stateDir = join(base, 'state')
    bundledDir = join(base, 'bundled')
    mkdirSync(join(stateDir, 'plugins'), { recursive: true })
    mkdirSync(bundledDir, { recursive: true })
  })
  afterEach(() => {
    try { rmSync(join(stateDir, '..'), { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('user plugin is discovered but DISABLED by default (security gate)', () => {
    writePlugin(join(stateDir, 'plugins'), 'wxvault', good('wxvault'))
    const loaded = loadPlugins({ stateDir, bundledDir })
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.source).toBe('user')
    expect(loaded[0]!.enabled).toBe(false)
    expect(pluginMcpSpecs(loaded)).toEqual({})
  })

  it('bundled plugin is ENABLED by default (trusted)', () => {
    writePlugin(bundledDir, 'firstparty', good('firstparty'))
    const loaded = loadPlugins({ stateDir, bundledDir })
    expect(loaded[0]!.enabled).toBe(true)
    expect(Object.keys(pluginMcpSpecs(loaded))).toEqual(['firstparty'])
  })

  it('plugins.json enables a user plugin and expands ${pluginDir}', () => {
    const dir = writePlugin(join(stateDir, 'plugins'), 'wxvault', good('wxvault'))
    writeFileSync(join(stateDir, 'plugins', 'plugins.json'), JSON.stringify({ enabled: { wxvault: true } }))
    const specs = pluginMcpSpecs(loadPlugins({ stateDir, bundledDir }))
    expect(specs.wxvault).toEqual({
      command: '/bin/sh',
      args: [join(dir, 'main.py')],
      env: { DATA: join(dir, 'data') },
    })
  })

  it('resolves a bare command to an absolute path (child gets no daemon PATH)', () => {
    writePlugin(bundledDir, 'bare', { ...good('bare'), spawn: { command: 'sh' } })
    const loaded = loadPlugins({ stateDir, bundledDir })
    expect(loaded[0]!.ready).toBe(true)
    expect(loaded[0]!.spec.command).toMatch(/^\/.*\/sh$/)   // rewritten to absolute
  })

  it('a command not on PATH makes the plugin not-ready (no silent spawn ENOENT)', () => {
    writePlugin(bundledDir, 'ghost', { ...good('ghost'), spawn: { command: 'definitely-not-a-real-cmd-xyz' } })
    const loaded = loadPlugins({ stateDir, bundledDir })
    expect(loaded[0]!.ready).toBe(false)
    expect(loaded[0]!.notReadyReason).toContain('not found on PATH')
    expect(pluginMcpSpecs(loaded)).toEqual({})
  })

  it('plugins.json can disable a bundled plugin', () => {
    writePlugin(bundledDir, 'firstparty', good('firstparty'))
    writeFileSync(join(stateDir, 'plugins', 'plugins.json'), JSON.stringify({ enabled: { firstparty: false } }))
    expect(pluginMcpSpecs(loadPlugins({ stateDir, bundledDir }))).toEqual({})
  })

  it('user plugin overrides a same-named bundled plugin', () => {
    writePlugin(bundledDir, 'dup', { ...good('dup'), spawn: { command: 'bundled-cmd' } })
    writePlugin(join(stateDir, 'plugins'), 'dup', { ...good('dup'), spawn: { command: 'user-cmd' } })
    writeFileSync(join(stateDir, 'plugins', 'plugins.json'), JSON.stringify({ enabled: { dup: true } }))
    const loaded = loadPlugins({ stateDir, bundledDir })
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.source).toBe('user')
    expect(loaded[0]!.spec.command).toBe('user-cmd')
  })

  it('rejects reserved names, bad kind, and malformed manifests', () => {
    writePlugin(join(stateDir, 'plugins'), 'reserved', good('wechat'))          // reserved name
    writePlugin(join(stateDir, 'plugins'), 'badkind', { ...good('badkind'), kind: 'a2a' })
    writePlugin(join(stateDir, 'plugins'), 'nospawn', { name: 'nospawn', kind: 'mcp' })
    const skipped: string[] = []
    const loaded = loadPlugins({ stateDir, bundledDir, log: m => skipped.push(m) })
    expect(loaded).toHaveLength(0)
    expect(skipped.filter(m => m.startsWith('skip')).length).toBe(3)
  })

  it('reserved-name check is case-insensitive but only matches exact names, not substrings', () => {
    writePlugin(join(stateDir, 'plugins'), 'casedelegate', good('Delegate'))     // case variant — still reserved
    writePlugin(join(stateDir, 'plugins'), 'wechat2', good('wechat2'))          // near-miss — allowed
    writePlugin(join(stateDir, 'plugins'), 'mywechat', good('my-wechat'))       // near-miss — allowed
    writeFileSync(
      join(stateDir, 'plugins', 'plugins.json'),
      JSON.stringify({ enabled: { wechat2: true, 'my-wechat': true } }),
    )
    const skipped: string[] = []
    const loaded = loadPlugins({ stateDir, bundledDir, log: m => skipped.push(m) })
    expect(loaded.map(p => p.manifest.name).sort()).toEqual(['my-wechat', 'wechat2'])
    expect(skipped.filter(m => m.startsWith('skip')).length).toBe(1)
  })

  it('missing dirs are a no-op, not a crash', () => {
    expect(loadPlugins({ stateDir: join(stateDir, 'nope'), bundledDir: null })).toEqual([])
  })

  it('cmpVersion orders dotted versions and returns null on garbage', () => {
    expect(cmpVersion('1.2.0', '1.2.0')).toBe(0)
    expect(cmpVersion('0.6.4', '1.0.0')).toBe(-1)
    expect(cmpVersion('1.2.10', '1.2.2')).toBe(1)   // numeric, not lexical
    expect(cmpVersion('1.2', '1.2.0')).toBe(0)      // missing segment = 0
    expect(cmpVersion('1.0.0-beta', '1.0.0')).toBe(0) // pre-release suffix ignored
    expect(cmpVersion('abc', '1.0.0')).toBe(null)
  })

  it('minWechatCcVersion: withholds a plugin when the host is too old', () => {
    writePlugin(bundledDir, 'needsnew', { ...good('needsnew'), version: '2.0.0', minWechatCcVersion: '1.0.0' })
    const old = loadPlugins({ stateDir, bundledDir, hostVersion: '0.6.4' })
    expect(old[0]!.ready).toBe(false)
    expect(old[0]!.notReadyReason).toContain('requires wechat-cc >= 1.0.0')
    expect(pluginMcpSpecs(old)).toEqual({})
    // Host new enough → ready, version surfaced via manifest.
    const ok = loadPlugins({ stateDir, bundledDir, hostVersion: '1.2.0' })
    expect(ok[0]!.ready).toBe(true)
    expect(ok[0]!.manifest.version).toBe('2.0.0')
  })

  it('setPluginEnabled persists the toggle (round-trips through loadPlugins)', () => {
    writePlugin(join(stateDir, 'plugins'), 'wxvault', good('wxvault'))
    expect(loadPlugins({ stateDir, bundledDir })[0]!.enabled).toBe(false)  // user default
    setPluginEnabled(stateDir, 'wxvault', true)
    expect(loadPlugins({ stateDir, bundledDir })[0]!.enabled).toBe(true)
    setPluginEnabled(stateDir, 'wxvault', false)
    expect(loadPlugins({ stateDir, bundledDir })[0]!.enabled).toBe(false)
  })

  it('healthcheck: enabled-but-not-ready plugin is withheld from the agent', () => {
    const dir = writePlugin(join(stateDir, 'plugins'), 'wxvault', {
      ...good('wxvault'),
      healthcheck: { requiresPaths: ['${pluginDir}/out/decrypted'] },
      requires: { setup: 'run decrypt.py' },
    })
    writeFileSync(join(stateDir, 'plugins', 'plugins.json'), JSON.stringify({ enabled: { wxvault: true } }))
    const loaded = loadPlugins({ stateDir, bundledDir })
    expect(loaded[0]!.enabled).toBe(true)
    expect(loaded[0]!.ready).toBe(false)
    expect(loaded[0]!.notReadyReason).toContain('run decrypt.py')
    expect(pluginMcpSpecs(loaded)).toEqual({})          // withheld

    mkdirSync(join(dir, 'out', 'decrypted'), { recursive: true })   // now set up
    const ready = loadPlugins({ stateDir, bundledDir })
    expect(ready[0]!.ready).toBe(true)
    expect(Object.keys(pluginMcpSpecs(ready))).toEqual(['wxvault'])
  })
})
