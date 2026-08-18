import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { loadHearthApi, type HearthApi } from './hearth-adapter'

const api: HearthApi = {
  ingestFromChannel: async () => ({ ok: true, summary: 'ok', change_id: 'c1' }),
  listPending: () => ({ rendered: 'pending', items: [] }),
  showPending: () => ({ ok: true, rendered: 'show' }),
  applyForOwner: async () => ({ ok: true, rendered: 'applied' }),
  renderPlanMarkdown: () => ({ ok: true, title: 'Plan', markdown: '# Plan' }),
}

describe('hearth-adapter', () => {
  it('loads an explicitly configured HEARTH_MODULE without requiring package dependencies', async () => {
    const seen: string[] = []
    const result = await loadHearthApi({
      env: { HEARTH_MODULE: 'virtual-hearth' },
      cwd: '/tmp/wechat-cc',
      homeDir: '/tmp/home',
      importer: async (specifier) => {
        seen.push(specifier)
        return api
      },
    })

    expect(result.ok).toBe(true)
    expect(seen).toEqual(['virtual-hearth'])
  })

  it('discovers a local hearth repo through HEARTH_HOME src/index.ts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hearth-home-'))
    try {
      const src = join(root, 'src')
      mkdirSync(src)
      const index = join(src, 'index.ts')
      writeFileSync(index, 'export {}\n')
      const expectedSpecifier = pathToFileURL(index).href

      const result = await loadHearthApi({
        env: { HEARTH_HOME: root },
        cwd: '/tmp/wechat-cc',
        homeDir: '/tmp/home',
        importer: async (specifier) => {
          expect(specifier).toBe(expectedSpecifier)
          return api
        },
      })

      expect(result.ok).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports not_found when every candidate fails to import', async () => {
    const result = await loadHearthApi({
      env: {},
      cwd: '/tmp/wechat-cc',
      homeDir: '/tmp/home',
      importer: async () => {
        throw new Error('Cannot find package')
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('not_found')
      expect(result.checked).toContain('node_modules:hearth')
    }
  })

  it('reports invalid_export only when a loaded module lacks the hearth API', async () => {
    const result = await loadHearthApi({
      env: { HEARTH_MODULE: 'virtual-hearth' },
      cwd: '/tmp/wechat-cc',
      homeDir: '/tmp/home',
      importer: async () => ({ listPending: () => ({ rendered: '', items: [] }) }),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid_export')
      expect(result.error).toContain('did not export')
    }
  })
})

// Smoke test for the DEFAULT importer — the one path production ever takes.
//
// Every other test here passes `importer:`, so `defaultImporter`
// (`specifier => import(specifier)`) was never executed by the suite. That is
// the same gap that hid two shipped bugs on 2026-08-14: defaults that every
// test injected past. See src/lib/injectable-default-seams.test.ts.
//
// This drives a real dynamic import of a real file on disk, via HEARTH_MODULE.
describe('loadHearthApi with the default importer', () => {
  it('really imports a module from disk and accepts it when the exports are there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hearth-default-importer-'))
    const mod = join(dir, 'index.mjs')
    writeFileSync(mod, [
      'export const ingestFromChannel = () => {}',
      'export const listPending = () => {}',
      'export const showPending = () => {}',
      'export const applyForOwner = () => {}',
      'export const renderPlanMarkdown = () => {}',
    ].join('\n') + '\n')

    // No `importer:` — this is the point of the test.
    const res = await loadHearthApi({ env: { HEARTH_MODULE: mod } as NodeJS.ProcessEnv })

    expect(res.ok).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports invalid_export for a real module missing a required export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hearth-default-importer-bad-'))
    const mod = join(dir, 'index.mjs')
    writeFileSync(mod, 'export const ingestFromChannel = () => {}\n')

    const res = await loadHearthApi({ env: { HEARTH_MODULE: mod } as NodeJS.ProcessEnv })

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid_export')
    rmSync(dir, { recursive: true, force: true })
  })
})
