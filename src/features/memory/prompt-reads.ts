/**
 * 每次起会话时现读的记忆素材(人格、画像、长期记忆、主人原话、今天的草稿、知识):手改了文件,不用重启就生效。
 * 原来是 daemon-modules.ts 里 promptReads 的一半(另一半现在在 daemon/bootstrap/module.ts);记忆搬进功能目录时跟过来(架构终态 A5),bootstrap 经 `needs: ['memory']` 拿。
 */
import { join } from 'node:path'
import { renderOwnerForPrompt } from '../../lib/memory-owner'
import type { MemoryWriter } from './memory-export'
import { CORE_MEMORY_MAX_CHARS, KNOWLEDGE_MEMORY_MAX_CHARS } from '../../domain/prompt-builder'
import { makeMemoryFS, type MemoryFS } from '../../adapters/store/memory-fs'
import { loadCompanionConfig } from '../../lib/companion-config'
import { renderForPrompt } from './curated-doc'
import { readDraftForPrompt } from './today-draft'

export interface MemoryPromptReads {
  personaFor(c: string): { content?: string; cultivate?: boolean }
  coreMemoryFor(c: string): string
  curatedMemoryFor(c: string): string
  ownerMemoryFor(c: string): string
  todayDraftFor(c: string): string
  knowledgeMemoryFor(c: string): string
}

/** `facts`:memory.md / owner.md 从主库的表读(架构终态 G6;没搬进表的对话由它照旧读文件)。 */
export function makeMemoryPromptReads(d: { stateDir: string; memory: MemoryFS; facts: Pick<MemoryWriter, 'memoryDoc' | 'ownerDoc'> }): MemoryPromptReads {
  const { stateDir } = d
  // 只读人格 / 画像 / 知识这几份(不碰总览、不写源)⇒ 不要围栏
  const memoryOf = (c: string) => makeMemoryFS({ rootDir: join(stateDir, 'memory', c), fences: null })
  return {
    // persona design §2 — owner chat's persona.md, read fresh per spawn; cultivate only in the owner's own chat.
    personaFor: (c: string) => {
      const ownerChat = loadCompanionConfig(stateDir).default_chat_id
      if (!ownerChat) return {}
      // ownerChat feeds a filesystem join below, so accept only chatId-shaped values.
      if (ownerChat.includes('..') || ownerChat.includes('/') || ownerChat.includes('\\')) return {}
      return { content: memoryOf(ownerChat).read('persona.md') ?? undefined, cultivate: c === ownerChat }
    },
    // core-memory-injection design §2 — THIS chat's OWN profile.md excerpt, capped.
    coreMemoryFor: (c: string) => {
      const profile = memoryOf(c).read('profile.md') ?? ''
      return profile.length > CORE_MEMORY_MAX_CHARS ? profile.slice(0, CORE_MEMORY_MAX_CHARS) : profile
    },
    // 每晚整理的长期记忆(2026-09-25):有 memory.md 就注入它(去尾注),prompt-builder 据此不再注入 profile.md。
    curatedMemoryFor: (c: string) => {
      const doc = d.facts.memoryDoc(c)
      return doc ? renderForPrompt(doc) : ''
    },
    // 主人原话(记忆编辑设计稿 2026-10-23 §1):只在主人自己的对话里注入,访客 / trusted 的对话读不到。
    ownerMemoryFor: (c: string) => {
      if (c !== loadCompanionConfig(stateDir).default_chat_id) return ''
      return renderOwnerForPrompt(d.facts.ownerDoc(c))
    },
    // 今天的草稿(同日失忆修复,2026-10-01):CC 白天写进 profile.md 的新行,随 memory.md 一起注入。
    todayDraftFor: (c: string) => { try { return readDraftForPrompt(d.memory, c) } catch { return '' } },
    // knowledge-distillation §2 — THIS chat's daemon-distilled knowledge.md, capped.
    knowledgeMemoryFor: (c: string) => {
      const k = memoryOf(c).read('knowledge.md') ?? ''
      return k.length > KNOWLEDGE_MEMORY_MAX_CHARS ? k.slice(0, KNOWLEDGE_MEMORY_MAX_CHARS) : k
    },
  }
}
