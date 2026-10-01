import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from './test-temp'
import { readPluginsSourcePointer, registerPluginsSource } from './plugins-source'

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
