import { describe, it, expect } from 'vitest'
import { MEMORY_ARTIFACTS, memoryArtifactKind } from '../../lib/memory-artifacts'
import { MEMORY_FILENAME } from './curated-doc'
import { CORRECTIONS_FILENAME, MEMORY_LOG_FILE } from './nightly'
import { TODAY_DRAFT_FILENAME } from './today-draft'
import { SOURCES_FILE } from './sources'
import { OVERVIEW_FILENAME, PROFILE_FILENAME } from '../../lib/memory-synthesis'

// 第三批 3e 第 1 步:记忆目录里每样东西归了类。daemon 里各处定义的文件名常量必须都在清单里、类别是设计稿盘点的那一类 ——
// 新加一个记忆文件不归类就红。
describe('memory artifacts manifest', () => {
  it('every filename constant the code defines is classified, as the design inventory says', () => {
    expect(memoryArtifactKind(MEMORY_FILENAME)).toBe('source')
    expect(memoryArtifactKind(CORRECTIONS_FILENAME)).toBe('source')
    expect(memoryArtifactKind(OVERVIEW_FILENAME)).toBe('derived')
    expect(memoryArtifactKind(PROFILE_FILENAME)).toBe('derived')
    expect(memoryArtifactKind(TODAY_DRAFT_FILENAME)).toBe('queue')
    expect(memoryArtifactKind(MEMORY_LOG_FILE)).toBe('ledger')
    expect(memoryArtifactKind(SOURCES_FILE)).toBe('ledger')
    for (const name of [MEMORY_FILENAME, CORRECTIONS_FILENAME, OVERVIEW_FILENAME, PROFILE_FILENAME, TODAY_DRAFT_FILENAME, MEMORY_LOG_FILE, SOURCES_FILE]) {
      expect(MEMORY_ARTIFACTS[name], name).toBeDefined()
    }
  })
  it('unknown files default to source (protect, never overwrite); tombstones and dot files are ledger', () => {
    expect(memoryArtifactKind('notes/trip-2026.md')).toBe('source')
    expect(memoryArtifactKind('whatever.md')).toBe('source')
    expect(memoryArtifactKind('profile.md.deleted-2026-10-22T00:00:00Z')).toBe('ledger')
    expect(memoryArtifactKind('._overview.md.123.abc.tmp')).toBe('ledger')
    expect(memoryArtifactKind('./_overview.md')).toBe('derived')
  })
  it('derived artifacts are exactly the four synthesized views plus knowledge.md', () => {
    expect(Object.entries(MEMORY_ARTIFACTS).filter(([, v]) => v.kind === 'derived').map(([k]) => k).sort())
      .toEqual(['_overview.md', '_profile.json', 'knowledge.md', 'portrait.json', 'portrait.svg'])
  })
})

describe('feedsSynthesis', () => {
  it('only sources feed synthesis, and corrections.md is held back (it quotes what the owner retracted)', async () => {
    const { feedsSynthesis } = await import('../../lib/memory-artifacts')
    for (const f of ['memory.md', 'profile.md', 'notes/a.md', 'persona.md']) expect(feedsSynthesis(f), f).toBe(true)
    for (const f of ['_overview.md', '_profile.json', 'knowledge.md', 'today-draft.md', 'corrections.md', 'owner.md', 'memory-log.jsonl']) expect(feedsSynthesis(f), f).toBe(false)
  })
})
