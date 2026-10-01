/**
 * 插件健康快照(2026-09-30):09-11 起 daemon 一个插件都没加载,整整三周
 * 只有客户回顾那一行「disabled」作旁证。快照把「找没找到插件目录、主人
 * 明确开着的插件丢没丢」放进 /v1/health,`self deploy` 的健康门据此判红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'
import { setPluginEnabled, type LoadedPlugin } from './registry'
import { buildPluginsHealth, pluginsHealthWarning } from './health'

let stateDir: string
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'wcc-plugin-health-')) })
afterEach(() => { removeTempDir(stateDir) })

const plugin = (name: string, over: Partial<LoadedPlugin> = {}): LoadedPlugin => ({
  name, source: 'bundled', dir: `/p/${name}`, enabled: true, ready: true,
  manifest: { name } as LoadedPlugin['manifest'], spec: { command: 'x', args: [], env: {} }, ...over,
})

describe('buildPluginsHealth', () => {
  it('fresh install: nothing found, nothing chosen ⇒ not expected, no warning', () => {
    const h = buildPluginsHealth({ stateDir, resolution: null, loaded: [] })
    expect(h).toEqual({ bundled_dir: null, via: null, plugins: [], expected_missing: [] })
    expect(pluginsHealthWarning(h)).toBeNull()
  })

  it('the 09-11 regression: operator enabled plugins in plugins.json but none were discovered', () => {
    setPluginEnabled(stateDir, 'wxsearch', true)
    setPluginEnabled(stateDir, 'wxmedia', true)
    setPluginEnabled(stateDir, 'oldthing', false) // explicit OFF is not an expectation
    const h = buildPluginsHealth({ stateDir, resolution: null, loaded: [] })
    expect(h.expected_missing).toEqual(['wxmedia', 'wxsearch'])
    const w = pluginsHealthWarning(h)
    expect(w).toContain('wxmedia')
    expect(w).toContain('plugin source') // tells the operator how to fix it
  })

  it('discovered (even if not ready) ⇒ not missing; readiness is reported per plugin', () => {
    setPluginEnabled(stateDir, 'wxsearch', true)
    const h = buildPluginsHealth({
      stateDir,
      resolution: { dir: '/owner/plugins', via: 'pointer' },
      loaded: [plugin('wxvault'), plugin('wxsearch', { ready: false, notReadyReason: 'missing x' })],
    })
    expect(h.expected_missing).toEqual([])
    expect(h.bundled_dir).toBe('/owner/plugins')
    expect(h.via).toBe('pointer')
    expect(h.plugins).toEqual([
      { name: 'wxvault', source: 'bundled', enabled: true, ready: true },
      { name: 'wxsearch', source: 'bundled', enabled: true, ready: false, reason: 'missing x' },
    ])
    expect(pluginsHealthWarning(h)).toBeNull()
  })
})
