import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseCatalog, updateAvailable, fetchCatalog, upgradePlugin, type CatalogEntry } from './catalog'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  name: 'wxvault', version: '1.0.0',
  source: { type: 'git', url: 'https://github.com/x/wxvault', ref: 'v1.0.0' },
  ...over,
})

describe('plugin catalog', () => {
  it('parses a valid registry and keeps pointers only', () => {
    const r = parseCatalog({ plugins: [{
      name: 'wxvault', version: '1.0.0',
      source: { type: 'git', url: 'https://github.com/x/wxvault', ref: 'v1.0.0' },
      displayName: '微信历史', author: 'you',
    }] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.catalog.plugins[0]!.name).toBe('wxvault')
      expect(r.catalog.plugins[0]!.source.ref).toBe('v1.0.0')
    }
  })

  it('hard-fails only on structural problems (not one bad entry)', () => {
    expect(parseCatalog({}).ok).toBe(false)                 // no plugins array = structural
    expect(parseCatalog({ plugins: 'nope' }).ok).toBe(false)
  })

  it('skips bad entries but keeps the good ones — one typo cannot down the market', () => {
    const r = parseCatalog({ plugins: [
      { name: 'good', version: '1.0.0', source: { type: 'git', url: 'https://x/good' } },
      { name: 'x' },                                                   // no version/source
      { name: 'zipsrc', version: '1', source: { type: 'zip', url: 'u' } },
      { name: 'bad name', version: '1', source: { type: 'git', url: 'u' } },
    ] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.catalog.plugins.map(p => p.name)).toEqual(['good'])   // only the valid one survives
      expect(r.skipped.length).toBe(3)
    }
  })

  it('updateAvailable is true only for a strictly newer catalog version', () => {
    expect(updateAvailable('1.0.0', entry({ version: '1.1.0' }))).toBe(true)
    expect(updateAvailable('1.1.0', entry({ version: '1.1.0' }))).toBe(false)
    expect(updateAvailable('2.0.0', entry({ version: '1.1.0' }))).toBe(false)
    expect(updateAvailable(undefined, entry({ version: '9.9.9' }))).toBe(false)   // not installed → no update badge
  })

  it('fetchCatalog reads a local file path (registry can be a file for testing)', async () => {
    const sample = join(import.meta.dirname, '..', '..', '..', 'docs', 'registry.example.json')
    const cat = await fetchCatalog(sample)
    expect(cat.plugins.find(p => p.name === 'wxvault')?.version).toBe('1.0.0')
  })

  describe('upgradePlugin guards (no git run)', () => {
    let stateDir: string
    beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'cat-upg-')) })
    afterEach(() => { try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* best effort */ } })

    const pluginDir = (name: string) => join(stateDir, 'plugins', name)

    it('refuses when not installed', () => {
      expect(upgradePlugin(entry(), stateDir)).toEqual({ ok: false, reason: '"wxvault" is not installed' })
    })

    it('refuses a symlinked/manual dir (no .git)', () => {
      const d = pluginDir('wxvault'); mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'wechat-cc.plugin.json'), JSON.stringify({ name: 'wxvault', version: '1.0.0' }))
      const r = upgradePlugin(entry({ version: '2.0.0' }), stateDir)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('not a git checkout')
    })

    it('no-ops (upgraded:false) when already at/above the catalog version', () => {
      const d = pluginDir('wxvault'); mkdirSync(join(d, '.git'), { recursive: true })
      writeFileSync(join(d, 'wechat-cc.plugin.json'), JSON.stringify({ name: 'wxvault', version: '1.0.0' }))
      expect(upgradePlugin(entry({ version: '1.0.0' }), stateDir)).toEqual({ ok: true, upgraded: false, from: '1.0.0', to: '1.0.0' })
    })
  })
})
