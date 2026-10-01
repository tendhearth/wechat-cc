import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from './test-temp'
import { readPluginsSourcePointer, readPluginsSourceRecord, registerPluginsSource } from './plugins-source'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wcc-plugins-source-')) })
afterEach(() => { removeTempDir(root) })

describe('registerPluginsSource (`wechat-cc plugin source <dir>`)', () => {
  it('refuses a dir without plugins and leaves the pointer alone', () => {
    mkdirSync(join(root, 'empty'))
    const r = registerPluginsSource(join(root, 'state'), join(root, 'empty'))
    expect(r.ok).toBe(false)
    expect(readPluginsSourcePointer(join(root, 'state'))).toBeNull()
  })
  it('accepts a real plugins dir, stores it absolute, and reports the plugin names', () => {
    mkdirSync(join(root, 'p', 'wxvault'), { recursive: true })
    writeFileSync(join(root, 'p', 'wxvault', 'wechat-cc.plugin.json'), '{}')
    const r = registerPluginsSource(join(root, 'state'), join(root, 'p', '..', 'p'))
    expect(r).toEqual({ ok: true, dir: join(root, 'p'), plugins: ['wxvault'] })
    expect(readPluginsSourcePointer(join(root, 'state'))).toBe(join(root, 'p'))
  })
})

describe('plugins source record (fix round 1: remember WHAT was registered)', () => {
  it('registration stores the plugin names found at that moment', () => {
    mkdirSync(join(root, 'p', 'wxvault'), { recursive: true })
    writeFileSync(join(root, 'p', 'wxvault', 'wechat-cc.plugin.json'), '{}')
    mkdirSync(join(root, 'p', 'wxsearch'), { recursive: true })
    writeFileSync(join(root, 'p', 'wxsearch', 'wechat-cc.plugin.json'), '{}')
    registerPluginsSource(join(root, 'state'), join(root, 'p'))
    expect(readPluginsSourceRecord(join(root, 'state'))).toEqual({ dir: join(root, 'p'), plugins: ['wxsearch', 'wxvault'] })
  })
  it('a legacy record without names reads as an empty list', () => {
    mkdirSync(join(root, 'state', 'plugins'), { recursive: true })
    writeFileSync(join(root, 'state', 'plugins', 'bundled-source.json'), JSON.stringify({ dir: '/x' }))
    expect(readPluginsSourceRecord(join(root, 'state'))).toEqual({ dir: '/x', plugins: [] })
  })
})
