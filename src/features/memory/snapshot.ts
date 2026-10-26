import { existsSync } from 'node:fs'
import type { MemoryWriter } from './memory-export'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { makeMemoryFS } from '../../adapters/store/memory-fs'

/**
 * Concatenate all .md files in a chat's memory dir into a single string.
 * Used by introspect (writes observations) AND summarizer (writes session
 * summaries) — both want the user's stated preferences + Claude's prior
 * notes as context. Same source of truth: when the user tells Claude in
 * chat "总结请像朋友说话", Claude writes that to memory; both downstream
 * SDK paths read it and adapt without any prompt code change here.
 *
 * Returns '' when the dir doesn't exist (new chat) or has no .md files.
 */
// The synthesized overview (written by memory-synthesis.ts). Kept as a local
// literal to avoid pulling that CLI module into the hot daemon snapshot path.
const OVERVIEW_FILENAME = '_overview.md'

/**
 * `facts`:memory.md / owner.md 的内容从主库的表来(架构终态 G6,经导出器);null = 没有表可问(只测文件层的单测),这两份跳过。
 */
export async function buildMemorySnapshot(stateDir: string, chatId: string, facts: Pick<MemoryWriter, 'memoryMd' | 'ownerMd'> | null): Promise<string> {
  if (!chatId || chatId.includes('..') || /[\\/\0]/.test(chatId)) return ''
  const dir = join(stateDir, 'memory', chatId)
  if (!existsSync(dir)) return ''
  const entries = await readdir(dir, { withFileTypes: true })
  const names = entries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name)
  // Deterministic order, with the synthesized overview leading: it's the
  // distilled "big picture" the downstream SDK should read before the raw
  // notes. (readdir order is platform-dependent, so sort for stable prompts.)
  names.sort((a, b) => {
    if (a === OVERVIEW_FILENAME) return b === OVERVIEW_FILENAME ? 0 : -1
    if (b === OVERVIEW_FILENAME) return 1
    return a.localeCompare(b)
  })
  const out: string[] = []
  const memory = makeMemoryFS({ rootDir: dir })
  for (const name of names) {
    try {
      // No async gap between freshness check and returning the snapshot.
      const content = name === 'memory.md' ? facts?.memoryMd(chatId) ?? null
        : name === 'owner.md' ? (facts?.ownerMd(chatId) || null)
        : memory.read(name)
      if (content === null) continue
      out.push(`# ${name}\n${content}`)
    } catch { /* skip unreadable */ }
  }
  return out.join('\n\n')
}
