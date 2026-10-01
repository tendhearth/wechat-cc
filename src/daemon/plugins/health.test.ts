/**
 * 插件健康快照(2026-09-30):09-11 起 daemon 一个插件都没加载,整整三周
 * 只有客户回顾那一行「disabled」作旁证。快照把「找没找到插件目录、该在的
 * 插件丢没丢」放进 /v1/health,`self deploy` 的健康门据此判红。
 *
 * 「该在的」= 登记来源时记下的插件名 ∪ plugins.json 里明确开着的 − 明确关掉的
 * (fix round 1:主人的 plugins.json 根本不列 wxvault —— 内置默认开 —— 只看
 * 明确开着的,wxvault 丢了照样绿)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'
import { writePluginsSourcePointer } from '../../lib/plugins-source'
import { setPluginEnabled, type LoadedPlugin } from './registry'
import { buildPluginsHealth, pluginsHealthForTier, pluginsHealthWarning } from './health'

let stateDir: string
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wcc-plugin-health-')); stateDir = join(root, 'state') })
afterEach(() => { removeTempDir(root) })

const plugin = (name: string, over: Partial<LoadedPlugin> = {}): LoadedPlugin => ({
  name, source: 'bundled', dir: `/p/${name}`, enabled: true, ready: true,
  manifest: { name } as LoadedPlugin['manifest'], spec: { command: 'x', args: [], env: {} }, ...over,
})

function pluginsDir(names: string[]): string {
  const d = join(root, 'owner-plugins')
  for (const n of names) { mkdirSync(join(d, n), { recursive: true }); writeFileSync(join(d, n, 'wechat-cc.plugin.json'), '{}') }
  mkdirSync(d, { recursive: true })
  return d
}

describe('buildPluginsHealth', () => {
  it('fresh install: nothing registered, nothing chosen ⇒ not expected, no warning', () => {
    const h = buildPluginsHealth({ stateDir, resolution: null, loaded: [] })
    expect(h.expected_missing).toEqual([])
    expect(h.pointer_broken).toBe(false)
    expect(pluginsHealthWarning(h)).toBeNull()
  })

  it('registered names count as expected even though plugins.json never lists them (wxvault is default-on)', () => {
    const dir = pluginsDir(['wxvault', 'wxsearch'])
    writePluginsSourcePointer(stateDir, dir)            // records [wxsearch, wxvault]
    const h = buildPluginsHealth({ stateDir, resolution: { dir, via: 'pointer' }, loaded: [plugin('wxsearch')] })
    expect(h.expected_missing).toEqual(['wxvault'])
    expect(pluginsHealthWarning(h)).toContain('wxvault')
  })

  it('an explicit disable removes a registered name from the expectation', () => {
    const dir = pluginsDir(['wxvault', 'wxsearch'])
    writePluginsSourcePointer(stateDir, dir)
    setPluginEnabled(stateDir, 'wxvault', false)
    const h = buildPluginsHealth({ stateDir, resolution: { dir, via: 'pointer' }, loaded: [plugin('wxsearch')] })
    expect(h.expected_missing).toEqual([])
  })

  it('explicit enables still count (the 09-11 shape: plugins.json trues, nothing discovered)', () => {
    setPluginEnabled(stateDir, 'wxsearch', true)
    setPluginEnabled(stateDir, 'wxmedia', true)
    const h = buildPluginsHealth({ stateDir, resolution: null, loaded: [] })
    expect(h.expected_missing).toEqual(['wxmedia', 'wxsearch'])
    expect(pluginsHealthWarning(h)).toContain('plugin source')
  })

  it('a registered pointer that now resolves to no real plugin ⇒ pointer_broken + warning, even if names are found elsewhere', () => {
    const dir = pluginsDir(['wxvault'])
    writePluginsSourcePointer(stateDir, dir)
    const gone = join(root, 'gone')
    writePluginsSourcePointer(stateDir, gone, ['wxvault'])
    const h = buildPluginsHealth({ stateDir, resolution: { dir: '/app/plugins', via: 'app' }, loaded: [plugin('wxvault')] })
    expect(h.pointer_broken).toBe(true)
    expect(h.pointer_dir).toBe(gone)
    expect(pluginsHealthWarning(h)).toContain(gone)
  })

  it('discovered (even if not ready) ⇒ not missing; readiness is reported per plugin', () => {
    setPluginEnabled(stateDir, 'wxsearch', true)
    const h = buildPluginsHealth({
      stateDir,
      resolution: { dir: '/owner/plugins', via: 'pointer' },
      loaded: [plugin('wxvault'), plugin('wxsearch', { ready: false, notReadyReason: 'missing x' })],
    })
    expect(h.expected_missing).toEqual([])
    expect(h.plugins).toEqual([
      { name: 'wxvault', source: 'bundled', enabled: true, ready: true },
      { name: 'wxsearch', source: 'bundled', enabled: true, ready: false, reason: 'missing x' },
    ])
    expect(pluginsHealthWarning(h)).toBeNull()
  })
})

describe('pluginsHealthForTier (/v1/health is guest tier)', () => {
  const full = () => {
    setPluginEnabled(stateDir, 'wxgraph', true)
    return buildPluginsHealth({
      stateDir,
      resolution: { dir: '/Users/owner/plugins', via: 'pointer' },
      loaded: [plugin('wxvault'), plugin('wxsearch', { ready: false, notReadyReason: 'missing /Users/owner/x' })],
    })
  }
  it('below admin: counts + expected_missing names only — no paths, no reasons, no plugin list', () => {
    const w = pluginsHealthForTier(full(), false)
    expect(w).toEqual({ via: 'pointer', count: 2, ready_count: 1, expected_missing: ['wxgraph'], pointer_broken: false })
    expect(JSON.stringify(w)).not.toContain('/Users/owner')
  })
  it('admin keeps the detail', () => {
    const w = pluginsHealthForTier(full(), true)
    expect(w.bundled_dir).toBe('/Users/owner/plugins')
    expect(w.plugins?.[1]?.reason).toContain('/Users/owner/x')
  })
})
