// src/daemon/internal-api/routes-plugins.test.ts
//
// GET /v1/plugins/list (dashboard) and GET /v1/plugins/registry (marketplace)
// are the two user-facing discovery routes hidden (infrastructure) plugins
// must be excluded from — see docs/superpowers/specs/2026-07-11-hidden-plugins-design.md.
// Loading/toggle/execution are untouched by this feature and stay covered by
// plugins/registry.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginRoutes } from './routes-plugins'
import { MANIFEST_FILE } from '../plugins/paths'
import type { InternalApiDeps } from './types'

function writePlugin(root: string, name: string, manifest: unknown): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest))
  return dir
}

// process.execPath is absolute + always present on every platform → these
// plugins resolve ready, keeping tests hermetic and cross-platform (Windows
// has no /bin/sh). Mirrors plugins/registry.test.ts's `good()` fixture.
const good = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  kind: 'mcp',
  displayName: name,
  spawn: { command: process.execPath, args: ['${pluginDir}/main.py'] },
  ...extra,
})

describe('plugin discovery routes (hidden filtering)', () => {
  let base: string
  let stateDir: string
  let bundledDir: string
  let deps: InternalApiDeps
  const savedBundledEnv = process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
  const savedRegistryEnv = process.env.WECHAT_CC_PLUGIN_REGISTRY

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'routes-plugins-test-'))
    stateDir = join(base, 'state')
    bundledDir = join(base, 'bundled')
    mkdirSync(join(stateDir, 'plugins'), { recursive: true })
    mkdirSync(bundledDir, { recursive: true })
    // bundledPluginsDir() checks this env var first — lets the route resolve
    // our tmp dir instead of the real repo/compiled-bundle plugins dir.
    process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = bundledDir
    deps = { stateDir, daemonPid: 0 }
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
    if (savedBundledEnv === undefined) delete process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
    else process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = savedBundledEnv
    if (savedRegistryEnv === undefined) delete process.env.WECHAT_CC_PLUGIN_REGISTRY
    else process.env.WECHAT_CC_PLUGIN_REGISTRY = savedRegistryEnv
  })

  describe('GET /v1/plugins/list', () => {
    it('excludes a loaded hidden plugin; a non-hidden one is present', async () => {
      writePlugin(bundledDir, 'visible', good('visible'))
      writePlugin(bundledDir, 'secret', good('secret', { hidden: true }))
      const res = await pluginRoutes(deps)['GET /v1/plugins/list']!(new URLSearchParams(), undefined)
      expect(res.status).toBe(200)
      const body = res.body as { plugins: Array<{ name: string }> }
      const names = body.plugins.map(p => p.name)
      expect(names).toContain('visible')
      expect(names).not.toContain('secret')
    })
  })

  describe('GET /v1/plugins/registry', () => {
    it('excludes a hidden entry from the catalog; a non-hidden one is present', async () => {
      writePlugin(bundledDir, 'visible', good('visible'))
      writePlugin(bundledDir, 'secret', good('secret', { hidden: true }))
      const catalogPath = join(base, 'catalog.json')
      writeFileSync(catalogPath, JSON.stringify({
        plugins: [
          { name: 'visible', version: '1.0.0', source: { type: 'git', url: 'https://example.com/visible.git' } },
          { name: 'secret', version: '1.0.0', source: { type: 'git', url: 'https://example.com/secret.git' } },
        ],
      }))
      process.env.WECHAT_CC_PLUGIN_REGISTRY = catalogPath

      const res = await pluginRoutes(deps)['GET /v1/plugins/registry']!(new URLSearchParams(), undefined)
      expect(res.status).toBe(200)
      const body = res.body as { plugins: Array<{ name: string }>; error?: string }
      expect(body.error).toBeUndefined()
      const names = body.plugins.map(p => p.name)
      expect(names).toContain('visible')
      expect(names).not.toContain('secret')
    })
  })
})
