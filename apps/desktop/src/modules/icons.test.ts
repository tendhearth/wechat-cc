import { isTaskCachePath } from '../../../../scripts/task-cache-paths'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { icon } from './icons.js'

const iconSources = (root: string) => readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(file => !isTaskCachePath(file) && /\.(?:html|js)$/.test(file))

describe('desktop icon references', () => {
  it('resolves every static data-hg-icon reference to an SVG', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const missing: string[] = []
    let references = 0
    for (const file of iconSources(root)) {
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

it('icon source discovery excludes cached HTML and JavaScript', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-icon-source-'))
  try {
    for (const file of ['ordinary.html', '.cc-tasks/task/cache/copy.js', 'node_modules/.cache/cc-tasks/task/copy.html']) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), '')
    }
    expect(iconSources(root)).toEqual(['ordinary.html'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
