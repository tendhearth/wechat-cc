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

describe('view_image', () => {
  it('小图原样载入,文字说尺寸,图在 images 里;缺文件 → 说明,images 空', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'view-image-'))
    try {
      const png = new Uint8Array(33); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); const dv = new DataView(png.buffer)
      dv.setUint32(8, 13); png.set([0x49, 0x48, 0x44, 0x52], 12); dv.setUint32(16, 64); dv.setUint32(20, 48)
      writeFileSync(join(dir, 'shot.png'), png)
      const tool = byName(dir, 'view_image')
      const rich = await tool.executeRich!({ path: 'shot.png' })
      expect(rich.text).toContain('64x48')
      expect(rich.images).toHaveLength(1)
      expect(rich.images[0]!.mediaType).toBe('image/png')
      expect(await tool.execute({ path: 'shot.png' })).toContain('Loaded image')
      const miss = await tool.executeRich!({ path: 'nope.png' })
      expect(miss.text).toContain('Could not load')
      expect(miss.images).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
