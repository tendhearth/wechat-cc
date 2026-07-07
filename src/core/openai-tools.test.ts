import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinTools } from './openai-tools'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oa-tools-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const byName = (cwd: string, name: string) => builtinTools(cwd).find(t => t.spec.name === name)!

describe('builtin tools', () => {
  it('Write then Read round-trips a file', async () => {
    await byName(dir, 'Write').execute({ path: 'a.txt', content: 'hello' })
    const out = await byName(dir, 'Read').execute({ path: 'a.txt' })
    expect(out).toContain('hello')
  })

  it('Edit replaces an exact string', async () => {
    writeFileSync(join(dir, 'b.txt'), 'foo bar')
    await byName(dir, 'Edit').execute({ path: 'b.txt', old: 'foo', new: 'baz' })
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('baz bar')
  })

  it('Bash runs a command and returns stdout', async () => {
    const out = await byName(dir, 'Bash').execute({ command: 'echo hi' })
    expect(out).toContain('hi')
  })

  it('tags risk levels: Read safe, Write/Edit caution, Bash dangerous', () => {
    const risk = (n: string) => byName(dir, n).risk
    expect(risk('Read')).toBe('safe')
    expect(risk('Write')).toBe('caution')
    expect(risk('Bash')).toBe('dangerous')
  })
})
