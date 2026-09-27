import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { icon } from './icons.js'

describe('desktop icon references', () => {
  it('resolves every static data-hg-icon reference to an SVG', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const missing: string[] = []
    let references = 0
    for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!/\.(?:html|js)$/.test(file)) continue
      const source = readFileSync(`${root}/${file}`, 'utf8')
      for (const [, name] of source.matchAll(/data-hg-icon=["']([a-z0-9-]+)["']/g)) {
        references += 1
        if (!icon(name).startsWith('<svg ')) missing.push(`${file}: ${name}`)
      }
    }
    expect(references).toBeGreaterThan(0)
    expect(missing).toEqual([])
  })

  it('hides decorative icons and gives labeled icons an accessible name', () => {
    expect(icon('star')).toContain('aria-hidden="true"')
    const labeled = icon('star', { label: '里程碑 "达成"' })
    expect(labeled).toContain('role="img"')
    expect(labeled).toContain('aria-label="里程碑 &quot;达成&quot;"')
    expect(labeled).not.toContain('aria-hidden')
  })
})
