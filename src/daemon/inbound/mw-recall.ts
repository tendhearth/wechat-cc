/**
 * Auto-recall (2026-08 memory-upgrades) — inject top-K knowledge-kernel hits
 * into the inbound envelope so a live turn starts with relevant memory even
 * when the agent doesn't call knowledge_search/memory_read itself.
 *
 * Two lanes, tier-split: admin chats search the knowledge kernel (the
 * owner's whole WeChat archive — same private-data trust class as the
 * admin-only knowledge_search MCP tool); every other chat gets the
 * `recallFallback` lane, which searches only that chat's OWN
 * memory/<chatId>/*.md files (src/features/memory/recall.ts). A non-admin
 * chat must never receive kernel recall.
 *
 * Soft-fail by design: timeout, embedder error, or an empty result all mean
 * "no recall block this turn", never a failed turn. Runs BEFORE next() (the
 * dispatch below formats the envelope from ctx.msg), and only for messages
 * that will actually reach dispatch — every consuming middleware above
 * (access/admin/mode/onboarding/guard/…) returns without calling next().
 */
import type { Middleware } from './types'

export const RECALL_TIMEOUT_MS = 4000
export const RECALL_MIN_QUERY = 4

export interface RecallMwDeps {
  /** Admin lane: knowledge-kernel hybrid search. Undefined ⇔ kernel not wired. */
  recall?: (chatId: string, text: string) => Promise<string[]>
  /** Non-admin lane: the chat's OWN memory/<chatId>/*.md files (the same
   *  subtree memory_read grants it) — never the kernel. Undefined ⇔ off. */
  recallFallback?: (chatId: string, text: string) => Promise<string[]>
  isAdmin: (chatId: string) => boolean
  /**
   * 话题 T2:这一轮碰到的话题调出来的那几条(只在主人自己的对话里有,判断在它自己里面)。和上面的 recall 并行跑、
   * 同一个超时;缺席 / 没碰到 / 出错 ⇒ 不加 <topics>。
   */
  topics?: (chatId: string, text: string) => Promise<{ block: string; adopt?: (requestId: string, messageIds?: string[]) => void } | null>
  timeoutMs?: number
  log: (tag: string, line: string) => void
}

export function makeMwRecall(deps: RecallMwDeps): Middleware {
  const timeoutMs = deps.timeoutMs ?? RECALL_TIMEOUT_MS
  const withTimeout = async <T>(p: Promise<T>, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${what}_timeout`)), timeoutMs) })])
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
  return async (ctx, next) => {
    const { msg } = ctx
    const lane = deps.isAdmin(msg.chatId) ? deps.recall : deps.recallFallback
    const topics = deps.topics && msg.text.trim().length > 0
      ? withTimeout(deps.topics(msg.chatId, msg.text), 'topics').then(
        r => { if (r && r.block.trim()) { (msg as { topics?: string }).topics = r.block; r.adopt?.(ctx.requestId, ctx.messageId ? [ctx.messageId] : []) } },
        err => deps.log('TOPICS', `skip for ${msg.chatId}: ${err instanceof Error ? err.message : err}`))
      : null
    if (lane && msg.text.trim().length >= RECALL_MIN_QUERY) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const items = await Promise.race([
          lane(msg.chatId, msg.text),
          new Promise<string[]>((_, rej) => {
            timer = setTimeout(() => rej(new Error('recall_timeout')), timeoutMs)
          }),
        ])
        if (items.length > 0) (msg as { recall?: string[] }).recall = items
      } catch (err) {
        deps.log('RECALL', `skip for ${msg.chatId}: ${err instanceof Error ? err.message : err}`)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    if (topics) await topics
    await next()
  }
}
