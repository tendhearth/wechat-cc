import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beginDerivedGeneration, commitDerivedMemory, invalidateDerivedMemory, isDerivedMemoryStale, readDerivedRevision } from './memory-derived-state'

const dirs: string[] = []
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'memory-derived-')); dirs.push(p); return p }
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }) })

describe('derived memory freshness', () => {
  it('invalidates each derivative without modifying source artifacts; refreshing one leaves the other stale', () => {
    const root = temp()
    writeFileSync(join(root, '_overview.md'), 'old overview')
    expect(isDerivedMemoryStale(root, 'overview')).toBe(false)
    const initial = readDerivedRevision(root)
    invalidateDerivedMemory(root)
    const revision = readDerivedRevision(root)
    expect(revision).not.toBe(initial)
    expect(readFileSync(join(root, '_overview.md'), 'utf8')).toBe('old overview')
    expect(isDerivedMemoryStale(root, 'overview')).toBe(true)
    expect(isDerivedMemoryStale(root, 'profile')).toBe(true)
    expect(commitDerivedMemory(root, 'overview', revision, () => writeFileSync(join(root, '_overview.md'), 'new overview'))).toBe(true)
    expect(isDerivedMemoryStale(root, 'overview')).toBe(false)
    expect(isDerivedMemoryStale(root, 'profile')).toBe(true)
  })

  it('does not publish a generation that raced with a correction', () => {
    const root = temp()
    const revision = readDerivedRevision(root)
    invalidateDerivedMemory(root)
    let wrote = false
    expect(commitDerivedMemory(root, 'profile', revision, () => { wrote = true })).toBe(false)
    expect(wrote).toBe(false)
    expect(isDerivedMemoryStale(root, 'profile')).toBe(true)
  })

  it('fails closed when metadata is corrupt and recovers through a new invalidation', () => {
    const root = temp()
    invalidateDerivedMemory(root)
    const meta = readdirSync(root).find(name => name.startsWith('.') && !name.endsWith('.md'))!
    writeFileSync(join(root, meta), '{ broken')
    expect(isDerivedMemoryStale(root, 'profile')).toBe(true)
    expect(isDerivedMemoryStale(root, 'overview')).toBe(true)
    expect(commitDerivedMemory(root, 'profile', readDerivedRevision(root), () => { throw new Error('must not write') })).toBe(false)
    invalidateDerivedMemory(root)
    expect(commitDerivedMemory(root, 'profile', readDerivedRevision(root), () => {})).toBe(true)
  })

  it('repairs a corrupt generation fence without making either preserved artifact fresh', () => {
    const root = temp()
    invalidateDerivedMemory(root)
    const meta = readdirSync(root).find(name => name.startsWith('.'))!
    writeFileSync(join(root, meta), '{ broken')
    const revision = beginDerivedGeneration(root)
    expect(revision).not.toBe('corrupt')
    expect(isDerivedMemoryStale(root, 'overview')).toBe(true)
    expect(isDerivedMemoryStale(root, 'profile')).toBe(true)
    expect(commitDerivedMemory(root, 'profile', revision, () => writeFileSync(join(root, '_profile.json'), '{"summary":"fresh"}'))).toBe(true)
    expect(isDerivedMemoryStale(root, 'profile')).toBe(false)
    expect(isDerivedMemoryStale(root, 'overview')).toBe(true)
  })
})
