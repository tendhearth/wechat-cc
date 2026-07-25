/**
 * internal-api LLM memory routes (spec 2026-07-23-daemon-owns-llm-memory-ops).
 * Mirrors routes-pair.ts / routes-social.ts: 503 when the daemon-owned
 * MemoryLlmOps (Task 1's makeMemoryLlmOps) isn't late-bound yet, else
 * delegate to it. Both routes are trusted (see route-tiers.ts) — the only
 * credential either the desktop app or the CLI ever hold locally.
 *
 * chat_id defaults to the access.json single admin (deps.resolveAdminChatId)
 * when the request body omits it, mirroring the WeChat `整理记忆` admin
 * command's own adminChatId resolution.
 */
import type { InternalApiDeps, RouteTable } from './types'

export function memoryRoutes(deps: InternalApiDeps): RouteTable {
  const resolveChat = (body: unknown): string | null => {
    const cid = (body as { chat_id?: unknown })?.chat_id
    if (typeof cid === 'string' && cid) return cid
    return deps.resolveAdminChatId?.() ?? null
  }
  return {
    'POST /v1/memory/synthesize': async (_q, body) => {
      if (!deps.memoryLlm) return { status: 503, body: { error: 'memory_not_wired' } }
      const chatId = resolveChat(body)
      if (!chatId) return { status: 400, body: { error: 'no_admin_chat_id' } }
      return { status: 200, body: { ok: true, ...(await deps.memoryLlm.synthesize(chatId)) } }
    },
    'POST /v1/memory/profile/generate': async (_q, body) => {
      if (!deps.memoryLlm) return { status: 503, body: { error: 'memory_not_wired' } }
      const chatId = resolveChat(body)
      if (!chatId) return { status: 400, body: { error: 'no_admin_chat_id' } }
      return { status: 200, body: { ok: true, ...(await deps.memoryLlm.generateProfile(chatId)) } }
    },
  }
}
