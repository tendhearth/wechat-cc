import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateRegistry } from './ci-triage'

describe('ci-flakes.json', () => {
  const raw = JSON.parse(readFileSync(join(__dirname, 'ci-flakes.json'), 'utf8'))
  it('validates: unique ids, compilable regexes, note + since on every entry', () => {
    const v = validateRegistry(raw)
    expect(v.ok, v.ok ? '' : v.errors.join('\n')).toBe(true)
    if (v.ok) expect(v.registry.entries.map(e => e.id)).toContain('win-hook-timeout')
  })
  it('rejects a duplicate id and a bad regex', () => {
    const v = validateRegistry({ entries: [{ id: 'a', symptom: '(', note: 'n', since: '2026-01-01' }, { id: 'a', symptom: 'x', note: 'n', since: '2026-01-01' }] })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.errors.join(' ')).toMatch(/duplicate id a/)
    if (!v.ok) expect(v.errors.join(' ')).toMatch(/regex/)
  })
})
