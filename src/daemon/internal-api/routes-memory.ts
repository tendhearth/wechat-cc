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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InternalApiDeps, RouteTable } from './types'
import type { MemoryEditRequestT, MemoryViewRequestT } from './schema'
import { safeSvg } from '../../lib/svg-sanitize'
import { readJsonFile } from '../../lib/read-json-file'

function noOwner(err: unknown): { status: 409 | 500; body: { ok: false; code: string } } {
  const m = err instanceof Error ? err.message : ''
  return m === 'no_owner' ? { status: 409, body: { ok: false, code: 'memory_no_owner' } } : { status: 500, body: { ok: false, code: 'memory_edit_failed' } }
}

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
    // 每晚记忆整理的立即运行(CLI `memory nightly --now`)。忽略时间点,仍走指纹 / 校验 / 修订检查。
    'POST /v1/memory/nightly/run': async () => {
      if (!deps.memoryNightly) return { status: 503, body: { error: 'memory_nightly_not_wired' } }
      return { status: 200, body: { ok: true, result: await deps.memoryNightly.runNow() } }
    },
    // 记忆编辑(设计稿 2026-10-23 记忆改了就算数):只认主人的记忆(nightly 那一份),body 由 schema 预校验。
    // 业务上的拒绝(memory_changed / bulk / stale_key / too_large)是 200 + ok:false,桌面照码处理;没有主人 ⇒ 409。
    'POST /v1/memory/view': async (_q, body) => {
      if (!deps.memoryNightly) return { status: 503, body: { error: 'memory_nightly_not_wired' } }
      try { return { status: 200, body: { ok: true, ...deps.memoryNightly.view((body as MemoryViewRequestT).path) } } }
      catch (err) { return noOwner(err) }
    },
    'POST /v1/memory/edit': async (_q, body) => {
      if (!deps.memoryNightly) return { status: 503, body: { error: 'memory_nightly_not_wired' } }
      try { return { status: 200, body: await deps.memoryNightly.edit(body as MemoryEditRequestT) } }
      catch (err) { return noOwner(err) }
    },
    // CC 手绘小像 (2026-08-25) — draw the owner from profile material.
    'POST /v1/memory/portrait/generate': async (_q, body) => {
      if (!deps.memoryLlm) return { status: 503, body: { error: 'memory_not_wired' } }
      const chatId = resolveChat(body)
      if (!chatId) return { status: 400, body: { error: 'no_admin_chat_id' } }
      const r = await deps.memoryLlm.generatePortrait(chatId)
      return { status: 200, body: r }
    },
    'GET /v1/memory/portrait': async (q) => {
      const chatId = q.get('chat_id') || deps.resolveAdminChatId?.() || null
      if (!chatId) return { status: 400, body: { error: 'no_admin_chat_id' } }
      if (chatId.includes('..') || chatId.includes('/') || chatId.includes('\\')) return { status: 400, body: { error: 'bad_chat_id' } }
      const dir = join(deps.stateDir, 'memory', chatId)
      const svgPath = join(dir, 'portrait.svg')
      if (!existsSync(svgPath)) return { status: 200, body: { ok: true, svg: null } }
      // Re-sanitize on read (defense in depth vs a hand-edited file) — a
      // failing file behaves exactly like no portrait.
      const svg = safeSvg(readFileSync(svgPath, 'utf8'))
      let generated_at: string | null = null
      try { generated_at = (readJsonFile(join(dir, 'portrait.json')) as { generated_at?: string }).generated_at ?? null } catch { /* meta optional */ }
      return { status: 200, body: { ok: true, svg, generated_at } }
    },
  }
}
