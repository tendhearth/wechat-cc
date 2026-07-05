import { describe, it, expect } from 'vitest'
import { parseCatalog, updateAvailable, fetchCatalog, type CatalogEntry } from './catalog'
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

  it('rejects malformed entries (no server-of-truth trust)', () => {
    expect(parseCatalog({}).ok).toBe(false)
    expect(parseCatalog({ plugins: [{ name: 'x' }] }).ok).toBe(false)                      // no version/source
    expect(parseCatalog({ plugins: [{ name: 'x', version: '1', source: { type: 'zip', url: 'u' } }] }).ok).toBe(false)
    expect(parseCatalog({ plugins: [{ name: 'bad name', version: '1', source: { type: 'git', url: 'u' } }] }).ok).toBe(false)
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
})
