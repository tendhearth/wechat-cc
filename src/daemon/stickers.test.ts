import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeStickerLib } from './stickers'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'stickers-'))
}

describe('stickers', () => {
  it('save() copies the file, writes the index, and returns the entry', () => {
    const dir = tmp()
    try {
      const src = join(dir, 'happy.png')
      writeFileSync(src, 'x')
      const lib = makeStickerLib(dir)
      const entry = lib.save(src, ['开心', 'happy'])
      expect(entry).toEqual({ file: 'happy.png', tags: ['开心', 'happy'] })
      expect(existsSync(join(dir, 'stickers', 'happy.png'))).toBe(true)
      const indexRaw = readFileSync(join(dir, 'stickers', 'stickers.json'), 'utf8')
      expect(indexRaw).toContain('happy.png')
      expect(indexRaw).toContain('开心')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('save() rejects unsupported extensions', () => {
    const dir = tmp()
    try {
      const src = join(dir, 'notes.txt')
      writeFileSync(src, 'x')
      const lib = makeStickerLib(dir)
      expect(() => lib.save(src, ['tag'])).toThrow('invalid_extension')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('save() rejects empty tags', () => {
    const dir = tmp()
    try {
      const src = join(dir, 'a.png')
      writeFileSync(src, 'x')
      const lib = makeStickerLib(dir)
      expect(() => lib.save(src, [])).toThrow('empty_tags')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('save() twice with the same basename renames on collision, keeping both files listed', () => {
    const dir = tmp()
    try {
      const src1 = join(dir, 'src1', 'dup.png')
      const src2 = join(dir, 'src2', 'dup.png')
      mkdirSync(join(dir, 'src1'), { recursive: true })
      mkdirSync(join(dir, 'src2'), { recursive: true })
      writeFileSync(src1, 'x')
      writeFileSync(src2, 'y')
      const lib = makeStickerLib(dir)
      const e1 = lib.save(src1, ['a'])
      const e2 = lib.save(src2, ['b'])
      expect(e1.file).toBe('dup.png')
      expect(e2.file).toBe('dup-1.png')
      expect(existsSync(join(dir, 'stickers', 'dup.png'))).toBe(true)
      expect(existsSync(join(dir, 'stickers', 'dup-1.png'))).toBe(true)
      const files = lib.list().map((e) => e.file).sort()
      expect(files).toEqual(['dup-1.png', 'dup.png'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('resolve() picks deterministically among matches using the injected random', () => {
    const dir = tmp()
    try {
      const a = join(dir, 'a.png')
      const b = join(dir, 'b.png')
      writeFileSync(a, 'x')
      writeFileSync(b, 'y')
      let r = 0
      const lib = makeStickerLib(dir, { random: () => r })
      lib.save(b, ['smile'])
      lib.save(a, ['smile'])
      r = 0
      expect(lib.resolve('smile')).toBe(join(dir, 'stickers', 'a.png'))
      r = 0.99
      expect(lib.resolve('smile')).toBe(join(dir, 'stickers', 'b.png'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('resolve() trims whitespace and is case-insensitive', () => {
    const dir = tmp()
    try {
      const src = join(dir, 'kaixin.png')
      writeFileSync(src, 'x')
      const lib = makeStickerLib(dir, { random: () => 0 })
      lib.save(src, ['开心'])
      expect(lib.resolve(' 开心 ')).toBe(join(dir, 'stickers', 'kaixin.png'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('resolve() returns null for an unknown tag', () => {
    const dir = tmp()
    try {
      const src = join(dir, 'kaixin.png')
      writeFileSync(src, 'x')
      const lib = makeStickerLib(dir)
      lib.save(src, ['开心'])
      expect(lib.resolve('sad')).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('resolve() and list() skip entries whose file is missing on disk', () => {
    const dir = tmp()
    try {
      const src = join(dir, 'gone.png')
      writeFileSync(src, 'x')
      const lib = makeStickerLib(dir)
      lib.save(src, ['bye'])
      unlinkSync(join(dir, 'stickers', 'gone.png'))
      expect(lib.resolve('bye')).toBeNull()
      expect(lib.list()).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('save() rejects a tag containing a newline', () => {
    const dir = tmp()
    try {
      const src = join(dir, 'a.png')
      writeFileSync(src, 'x')
      const lib = makeStickerLib(dir)
      expect(() => lib.save(src, ['line1\nline2'])).toThrow('invalid_tag')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('save() rejects a tag longer than 20 chars', () => {
    const dir = tmp()
    try {
      const src = join(dir, 'a.png')
      writeFileSync(src, 'x')
      const lib = makeStickerLib(dir)
      expect(() => lib.save(src, ['a'.repeat(21)])).toThrow('invalid_tag')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('save() rejects a tag containing a backtick', () => {
    const dir = tmp()
    try {
      const src = join(dir, 'a.png')
      writeFileSync(src, 'x')
      const lib = makeStickerLib(dir)
      expect(() => lib.save(src, ['`rm -rf`'])).toThrow('invalid_tag')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('save() trims and collapses internal whitespace in tags', () => {
    const dir = tmp()
    try {
      const src = join(dir, 'a.png')
      writeFileSync(src, 'x')
      const lib = makeStickerLib(dir)
      const entry = lib.save(src, [' 开 心 '])
      expect(entry.tags).toEqual(['开 心'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('save() dedupes normalized tags', () => {
    const dir = tmp()
    try {
      const src = join(dir, 'a.png')
      writeFileSync(src, 'x')
      const lib = makeStickerLib(dir)
      const entry = lib.save(src, ['happy', ' happy ', 'happy'])
      expect(entry.tags).toEqual(['happy'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('allTags() returns unique, sorted tags across entries', () => {
    const dir = tmp()
    try {
      const a = join(dir, 'a.png')
      const b = join(dir, 'b.png')
      writeFileSync(a, 'x')
      writeFileSync(b, 'y')
      const lib = makeStickerLib(dir)
      lib.save(a, ['zebra', 'apple'])
      lib.save(b, ['apple', 'mango'])
      expect(lib.allTags()).toEqual(['apple', 'mango', 'zebra'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
