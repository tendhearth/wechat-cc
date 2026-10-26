import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeMemoryFS, MemoryPathError } from './memory-fs'
import { invalidateDerivedMemory } from '../../lib/memory-derived-state'

describe('MemoryFS', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'memfs-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const make = () => makeMemoryFS({ rootDir: root, layout: 'all-chats' })

  it('hides stale overview from reads and listings for both global and per-chat memory roots', () => {
    const fs = make()
    fs.write('c1/_overview.md', 'stale judgment')
    fs.write('c1/profile.md', 'canonical profile')
    invalidateDerivedMemory(join(root, 'c1'))
    expect(fs.read('c1/_overview.md')).toBeNull()
    expect(fs.list()).toEqual(['c1/profile.md'])
    const chatFs = makeMemoryFS({ rootDir: join(root, 'c1') })
    expect(chatFs.read('_overview.md')).toBeNull()
    expect(chatFs.list()).toEqual(['profile.md'])
    expect(existsSync(join(root, 'c1', '_overview.md'))).toBe(true)
    symlinkSync(join(root, 'c1', '_overview.md'), join(root, 'c1', 'overview-alias.md'))
    expect(chatFs.read('overview-alias.md')).toBeNull()
  })

  // 3e 记忆第 2 步(整合者定):只是多了东西 ⇒ 照常给、开头贴一句;主人删改过 ⇒ 藏(总览会进串门人设,带到别人的 CC)。
  it('an overview that is only incomplete (added) is served with a label; one after an owner retraction stays hidden', () => {
    const fs = make()
    fs.write('c1/_overview.md', 'owner likes hiking')
    invalidateDerivedMemory(join(root, 'c1'), 'added')
    const got = fs.read('c1/_overview.md')
    expect(got).toContain('owner likes hiking')
    expect(got).toMatch(/^> \(这份整体理解是 \d{4}-\d{2}-\d{2} 整理的,之后记忆又有变化,可能不全。\)\n\nowner likes hiking$/)
    expect(fs.list()).toContain('c1/_overview.md')
    invalidateDerivedMemory(join(root, 'c1'), 'retracted')
    expect(fs.read('c1/_overview.md')).toBeNull()
    expect(fs.list()).not.toContain('c1/_overview.md')
  })
  it('the stale label is stripped when an overview is written back, so it never becomes body text or stacks up', () => {
    const fs = make()
    fs.write('c1/_overview.md', 'owner likes hiking')
    invalidateDerivedMemory(join(root, 'c1'), 'added')
    const labelled = fs.read('c1/_overview.md')!
    fs.write('c1/_overview.md', labelled + '\nand cooking')
    fs.write('c1/_overview.md', fs.read('c1/_overview.md')!)
    expect(readFileSync(join(root, 'c1', '_overview.md'), 'utf8')).toBe('owner likes hiking\nand cooking')
  })
  it('writing a source invalidates that chat: CC notes are "added", anything else defaults to "retracted"; writing a derived file does not', async () => {
    const { derivedMemoryStatus } = await import('../../lib/memory-derived-state')
    const fs = make()
    fs.write('c1/_overview.md', 'v1')
    expect(derivedMemoryStatus(join(root, 'c1'), 'overview')).toBe('fresh')
    fs.write('c1/profile.md', 'note', { reason: 'added' })
    expect(derivedMemoryStatus(join(root, 'c1'), 'overview')).toBe('added')
    fs.write('c1/notes/trip.md', 'edited by owner')
    expect(derivedMemoryStatus(join(root, 'c1'), 'overview')).toBe('retracted')
    // 别的对话不受影响
    fs.write('c2/_overview.md', 'other')
    expect(derivedMemoryStatus(join(root, 'c2'), 'overview')).toBe('fresh')
    // per-chat 根下写也找得到同一层
    const chatFs = makeMemoryFS({ rootDir: join(root, 'c2') })
    chatFs.write('profile.md', 'x', { reason: 'added' })
    expect(derivedMemoryStatus(join(root, 'c2'), 'overview')).toBe('added')
  })

  it('owner.md 是主人原话:CC 写不了、删不了(不分大小写、绕路径也不行);notes/owner.md 是普通笔记照写', () => {
    const fs = make()
    for (const p of ['c1/owner.md', 'c1/Owner.MD', 'c1/x/../owner.md', './c1/owner.md']) {
      expect(() => fs.write(p, '- 我说的'), p).toThrow(MemoryPathError)
    }
    expect(() => fs.delete('c1/owner.md')).toThrow(MemoryPathError)
    expect(() => fs.softDelete('c1/owner.md')).toThrow(MemoryPathError)
    expect(existsSync(join(root, 'c1', 'owner.md'))).toBe(false)
    fs.write('c1/notes/owner.md', '一份叫 owner 的笔记')
    expect(fs.read('c1/notes/owner.md')).toBe('一份叫 owner 的笔记')
    const chatFs = makeMemoryFS({ rootDir: join(root, 'c2') })
    expect(() => chatFs.write('owner.md', 'x')).toThrow(MemoryPathError)
  })

  it('write then read roundtrips content', () => {
    const fs = make()
    fs.write('profile.md', '# Hi\nuser is 顾时瑞')
    expect(fs.read('profile.md')).toBe('# Hi\nuser is 顾时瑞')
  })

  it('read returns null for missing files', () => {
    const fs = make()
    expect(fs.read('nope.md')).toBeNull()
  })

  it('list returns all .md files recursively', () => {
    const fs = make()
    fs.write('profile.md', 'a')
    fs.write('patterns/push-timing.md', 'b')
    fs.write('patterns/tone.md', 'c')
    fs.write('notes/2026-04/day1.md', 'd')
    expect(fs.list()).toEqual([
      'notes/2026-04/day1.md',
      'patterns/push-timing.md',
      'patterns/tone.md',
      'profile.md',
    ])
  })

  it('list with subdir restricts scope', () => {
    const fs = make()
    fs.write('profile.md', 'a')
    fs.write('patterns/x.md', 'b')
    fs.write('patterns/y.md', 'c')
    expect(fs.list('patterns')).toEqual(['patterns/x.md', 'patterns/y.md'])
  })

  it('list skips hidden files + tmp artifacts', () => {
    const fs = make()
    fs.write('ok.md', 'a')
    // Simulate leftover tmp + hidden:
    writeFileSync(join(root, '.hidden.md'), 'x')
    writeFileSync(join(root, 'ok.md.tmp-123-456'), 'x')
    expect(fs.list()).toEqual(['ok.md'])
  })

  it('write creates parent dirs automatically', () => {
    const fs = make()
    fs.write('deeply/nested/path/thing.md', 'hi')
    expect(fs.read('deeply/nested/path/thing.md')).toBe('hi')
  })

  it('write is atomic (no partial file on crash)', () => {
    // Can't easily simulate crash, but verify tmp isn't visible after success
    const fs = make()
    fs.write('a.md', 'content')
    const allEntries = require('node:fs').readdirSync(root)
    // no .tmp- files left over
    expect(allEntries.filter((e: string) => e.includes('.tmp-'))).toEqual([])
  })

  it('delete removes file; idempotent for missing', () => {
    const fs = make()
    fs.write('a.md', 'x')
    fs.delete('a.md')
    expect(fs.read('a.md')).toBeNull()
    // idempotent
    expect(() => fs.delete('a.md')).not.toThrow()
  })

  describe('sandboxing', () => {
    it('rejects ..', () => {
      const fs = make()
      expect(() => fs.read('../outside.md')).toThrow(MemoryPathError)
      expect(() => fs.write('../outside.md', 'x')).toThrow(MemoryPathError)
      expect(() => fs.read('../../etc/passwd.md')).toThrow(MemoryPathError)
    })

    it('rejects absolute paths', () => {
      const fs = make()
      expect(() => fs.read('/etc/passwd.md')).toThrow(MemoryPathError)
      expect(() => fs.write('/tmp/evil.md', 'x')).toThrow(MemoryPathError)
    })

    it('rejects Windows-style absolute', () => {
      const fs = make()
      expect(() => fs.read('C:\\windows\\file.md')).toThrow(MemoryPathError)
      expect(() => fs.read('C:/users/a.md')).toThrow(MemoryPathError)
    })

    it('rejects null byte in path', () => {
      const fs = make()
      expect(() => fs.read('foo\0.md')).toThrow(MemoryPathError)
    })

    it('rejects paths longer than 500 chars', () => {
      const fs = make()
      expect(() => fs.read('a/'.repeat(300) + 'foo.md')).toThrow(MemoryPathError)
    })

    it('rejects empty path', () => {
      const fs = make()
      expect(() => fs.read('')).toThrow(MemoryPathError)
    })

    it('symlinks inside root pointing INSIDE root still work (normal use)', () => {
      // Sanity: agent organising memory with a symlink between two
      // sandbox subdirs is fine — neither read/write/delete should
      // reject because both endpoints resolve to within real root.
      mkdirSync(join(root, 'real'), { recursive: true })
      symlinkSync(join(root, 'real'), join(root, 'link'))
      const fs = make()
      fs.write('link/x.md', 'hi')
      expect(fs.read('real/x.md')).toBe('hi')
    })

    it('rejects symlink ESCAPE — write/read/delete through a symlink pointing outside root (PR memfs realpath)', () => {
      // Threat: agent with Bash (or pre-existing daemon footprint)
      // plants a symlink inside memory/ pointing to /etc or similar.
      // Lexical check passes (the path stays inside root after `resolve`),
      // so the pre-PR impl silently let the write through. Now realpath
      // check catches it.
      const escape = mkdtempSync(join(tmpdir(), 'memfs-escape-target-'))
      try {
        symlinkSync(escape, join(root, 'leak'))
        const fs = make()
        expect(() => fs.write('leak/pwned.md', 'attacker payload')).toThrow(MemoryPathError)
        // Plant a file via the bypass to test read/delete rejection.
        writeFileSync(join(escape, 'pwned.md'), 'planted from outside', 'utf8')
        expect(() => fs.read('leak/pwned.md')).toThrow(MemoryPathError)
        expect(() => fs.delete('leak/pwned.md')).toThrow(MemoryPathError)
      } finally {
        rmSync(escape, { recursive: true, force: true })
      }
    })

    it('rejects symlink escape — individual .md file IS the symlink', () => {
      // Tighter variant: the .md path itself is a symlink to outside.
      const escape = mkdtempSync(join(tmpdir(), 'memfs-escape-file-'))
      const outside = join(escape, 'secret.txt')
      writeFileSync(outside, 'secret content', 'utf8')
      try {
        symlinkSync(outside, join(root, 'leak.md'))
        const fs = make()
        expect(() => fs.read('leak.md')).toThrow(MemoryPathError)
      } finally {
        rmSync(escape, { recursive: true, force: true })
      }
    })

    it('list() does not surface symlinks (escape candidates filtered out)', () => {
      // Even if a symlink-escape is planted, list() shouldn't emit its
      // path — agent would only get errors on subsequent read. Skipping
      // at list time keeps the surface clean.
      const escape = mkdtempSync(join(tmpdir(), 'memfs-escape-list-'))
      writeFileSync(join(escape, 'a.md'), '#', 'utf8')
      try {
        symlinkSync(join(escape, 'a.md'), join(root, 'leak.md'))
        const fs = make()
        fs.write('real.md', 'hi')
        const files = fs.list()
        expect(files).toContain('real.md')
        expect(files).not.toContain('leak.md')
      } finally {
        rmSync(escape, { recursive: true, force: true })
      }
    })
  })

  describe('extensions', () => {
    it('rejects non-.md by default', () => {
      const fs = make()
      expect(() => fs.read('a.json')).toThrow(/extension not allowed/)
      expect(() => fs.write('a.json', '{}')).toThrow(/extension not allowed/)
      expect(() => fs.read('a')).toThrow(/extension not allowed/)
    })

    it('respects custom allowedExt', () => {
      const fs = makeMemoryFS({ rootDir: root, allowedExt: ['.md', '.txt'] })
      fs.write('a.txt', 'ok')
      expect(fs.read('a.txt')).toBe('ok')
    })
  })

  describe('size limit', () => {
    it('rejects writes larger than maxFileBytes', () => {
      const fs = makeMemoryFS({ rootDir: root, maxFileBytes: 100 })
      const big = 'x'.repeat(200)
      expect(() => fs.write('big.md', big)).toThrow(/too large/)
    })

    it('default limit is 100KB', () => {
      const fs = make()
      // Just under cap
      fs.write('ok.md', 'x'.repeat(99_000))
      expect(fs.read('ok.md')!.length).toBe(99_000)
      // Over cap
      expect(() => fs.write('too.md', 'x'.repeat(101_000))).toThrow(/too large/)
    })
  })

  it('content must be a string', () => {
    const fs = make()
    expect(() => fs.write('a.md', null as unknown as string)).toThrow(MemoryPathError)
    expect(() => fs.write('a.md', 123 as unknown as string)).toThrow(MemoryPathError)
  })

  it('rootDir is auto-created if missing', () => {
    const newRoot = join(root, 'fresh-dir')
    expect(existsSync(newRoot)).toBe(false)
    const fs = makeMemoryFS({ rootDir: newRoot })
    fs.write('a.md', 'x')
    expect(existsSync(newRoot)).toBe(true)
  })

  describe('softDelete', () => {
    it('renames file to .deleted-<iso> sibling in place', () => {
      const fs = make()
      fs.write('profile.md', 'hello')
      const tombstone = fs.softDelete('profile.md')
      // Original gone
      expect(fs.read('profile.md')).toBeNull()
      // Tombstone path is returned, POSIX-relative, with .deleted- + ISO-ish stamp
      expect(tombstone).toMatch(/^profile\.md\.deleted-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/)
      // Content recoverable on disk
      const onDisk = require('node:fs').readdirSync(root) as string[]
      expect(onDisk.some(n => n.startsWith('profile.md.deleted-'))).toBe(true)
    })

    it('returns null when target does not exist', () => {
      const fs = make()
      expect(fs.softDelete('nope.md')).toBeNull()
    })

    it('rejects symlink escape (inherits realpath sandbox check)', () => {
      const escape = mkdtempSync(join(tmpdir(), 'memfs-softdel-escape-'))
      try {
        // Plant a target outside, then symlink to it from inside root
        writeFileSync(join(escape, 'pwned.md'), 'attacker payload', 'utf8')
        symlinkSync(join(escape, 'pwned.md'), join(root, 'leak.md'))
        const fs = make()
        expect(() => fs.softDelete('leak.md')).toThrow(MemoryPathError)
      } finally {
        rmSync(escape, { recursive: true, force: true })
      }
    })

    it('list() skips .deleted-* tombstones', () => {
      const fs = make()
      fs.write('a.md', 'alive')
      fs.write('b.md', 'doomed')
      fs.softDelete('b.md')
      expect(fs.list()).toEqual(['a.md'])
    })

    it('is idempotent — second call on the now-missing path returns null', () => {
      const fs = make()
      fs.write('once.md', 'x')
      const first = fs.softDelete('once.md')
      expect(first).not.toBeNull()
      const second = fs.softDelete('once.md')
      expect(second).toBeNull()
    })
  })
})
