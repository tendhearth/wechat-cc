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

// 3e 记忆第 2 步(整合者定):过期分两种。主人删改 ⇒ retracted(藏);只是多了东西 ⇒ added(贴标签照常用)。
describe('derived memory: why it went stale', () => {
  it('added vs retracted, and a retraction sticks until that artefact is regenerated', async () => {
    const { derivedMemoryStatus } = await import('./memory-derived-state')
    const root = temp()
    expect(derivedMemoryStatus(root, 'overview')).toBe('fresh')
    invalidateDerivedMemory(root, 'added')
    expect(derivedMemoryStatus(root, 'overview')).toBe('added')
    invalidateDerivedMemory(root, 'retracted')
    expect(derivedMemoryStatus(root, 'overview')).toBe('retracted')
    // 后面再来一次 added 不能把 retracted 冲掉
    invalidateDerivedMemory(root, 'added')
    expect(derivedMemoryStatus(root, 'overview')).toBe('retracted')
    // 重新生成 overview ⇒ overview 回到 fresh;profile 没重新生成,照旧 retracted
    const rev = beginDerivedGeneration(root)
    expect(commitDerivedMemory(root, 'overview', rev, () => {})).toBe(true)
    expect(derivedMemoryStatus(root, 'overview')).toBe('fresh')
    expect(derivedMemoryStatus(root, 'profile')).toBe('retracted')
    // 生成以后只是多了东西 ⇒ added
    invalidateDerivedMemory(root, 'added')
    expect(derivedMemoryStatus(root, 'overview')).toBe('added')
  })
  it('no reason given ⇒ retracted (fail toward hiding); a legacy stale state without reasons reads as retracted', async () => {
    const { derivedMemoryStatus } = await import('./memory-derived-state')
    const a = temp()
    invalidateDerivedMemory(a)
    expect(derivedMemoryStatus(a, 'overview')).toBe('retracted')
    const b = temp()
    writeFileSync(join(b, '.derived-state.json'), JSON.stringify({ version: 1, revision: 'r2', overview: 'r1', profile: 'r1' }))
    expect(derivedMemoryStatus(b, 'overview')).toBe('retracted')
    invalidateDerivedMemory(b, 'added')
    expect(derivedMemoryStatus(b, 'overview')).toBe('retracted')
  })
})
