/**
 * LLM memory routes(记忆功能自己挂,路由表标 module: 'memory';原来是 internal-api/routes-memory.ts) (spec 2026-07-23-daemon-owns-llm-memory-ops).
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
import type { RouteTable } from '../../daemon/internal-api/types'
import type { MemoryEditRequestT, MemoryViewRequestT } from '../../daemon/internal-api/schema'
import { workbenchErrorHttp } from '@wechat-cc/protocol'
import { safeSvg } from '../../lib/svg-sanitize'
import { readJsonFile } from '../../lib/read-json-file'
import type { MemoryLlmOps } from './llm-ops'
import type { MemoryNightlyRuntime } from './nightly-runtime'

/**
 * 这几条要的东西。LLM 记忆操作要 bootstrap 的执行者登记、每晚整理要 wired 里 CC 开口那道门 —— 都比路由挂上来晚,
 * 所以是现取的:还没有 ⇒ null ⇒ 照旧 503 memory_not_wired / memory_nightly_not_wired(搬家前是 internal-api 的晚绑定)。
 */
/** 恢复之后给主人看的那句(主人 10-26 第 3 条:说清楚随之删掉的笔记行不会回来)。手机、桌面同一句。 */
export const RESTORE_NOTE = '已经放回记忆里了。当初随这条一起从笔记里删掉的那几行不会回来。'

export interface MemoryRoutesDeps {
  stateDir: string
  memoryLlm: () => MemoryLlmOps | null
  memoryNightly: () => Pick<MemoryNightlyRuntime, 'runNow' | 'view' | 'edit' | 'retractions' | 'restore'> | null
  /** 请求里没写 chat_id ⇒ access.json 里唯一的 admin。 */
  resolveAdminChatId?: () => string | null
}

/** 码与 HTTP 状态都在 packages/protocol/src/workbench-errors.ts 那一张表里。 */
function noOwner(err: unknown): { status: number; body: { ok: false; code: string; error: string } } {
  const code = err instanceof Error && err.message === 'no_owner' ? 'memory_no_owner' : 'memory_edit_failed'
  // error 同码:桌面经宿主代理调,宿主把非 2xx 变成失败时只留 error 这个字段(架构终态 F6)。
  return { status: workbenchErrorHttp(code, 'desktop').status, body: { ok: false, code, error: code } }
}

export function memoryRoutes(deps: MemoryRoutesDeps): RouteTable {
  const resolveChat = (body: unknown): string | null => {
    const cid = (body as { chat_id?: unknown })?.chat_id
    if (typeof cid === 'string' && cid) return cid
    return deps.resolveAdminChatId?.() ?? null
  }
  return {
    'POST /v1/memory/synthesize': async (_q, body) => {
      const llm = deps.memoryLlm()
      if (!llm) return { status: 503, body: { error: 'memory_not_wired' } }
      const chatId = resolveChat(body)
      if (!chatId) return { status: 400, body: { error: 'no_admin_chat_id' } }
      return { status: 200, body: { ok: true, ...(await llm.synthesize(chatId)) } }
    },
    'POST /v1/memory/profile/generate': async (_q, body) => {
      const llm = deps.memoryLlm()
      if (!llm) return { status: 503, body: { error: 'memory_not_wired' } }
      const chatId = resolveChat(body)
      if (!chatId) return { status: 400, body: { error: 'no_admin_chat_id' } }
      return { status: 200, body: { ok: true, ...(await llm.generateProfile(chatId)) } }
    },
    // 每晚记忆整理的立即运行(CLI `memory nightly --now`)。忽略时间点,仍走指纹 / 校验 / 修订检查。
    'POST /v1/memory/nightly/run': async () => {
      const nightly = deps.memoryNightly()
      if (!nightly) return { status: 503, body: { error: 'memory_nightly_not_wired' } }
      return { status: 200, body: { ok: true, result: await nightly.runNow() } }
    },
    // 记忆编辑(设计稿 2026-10-23 记忆改了就算数):只认主人的记忆(nightly 那一份),body 由 schema 预校验。
    // 业务上的拒绝(memory_changed / bulk / stale_key / too_large)是 200 + ok:false,桌面照码处理;没有主人 ⇒ 409。
    'POST /v1/memory/view': async (_q, body) => {
      const nightly = deps.memoryNightly()
      if (!nightly) return { status: 503, body: { error: 'memory_nightly_not_wired' } }
      try { return { status: 200, body: { ok: true, ...nightly.view((body as MemoryViewRequestT).path) } } }
      catch (err) { return noOwner(err) }
    },
    'POST /v1/memory/edit': async (_q, body) => {
      const nightly = deps.memoryNightly()
      if (!nightly) return { status: 503, body: { error: 'memory_nightly_not_wired' } }
      try { return { status: 200, body: await nightly.edit(body as MemoryEditRequestT) } }
      catch (err) { return noOwner(err) }
    },
    // 收回的话(架构终态 G6,主人 10-26 第 2 / 3 条):记忆页上 corrections.md 换成这张列表,每条能恢复。
    'GET /v1/memory/retractions': async () => {
      const nightly = deps.memoryNightly()
      if (!nightly) return { status: 503, body: { error: 'memory_nightly_not_wired' } }
      return { status: 200, body: { ok: true, items: nightly.retractions() } }
    },
    'POST /v1/memory/retractions/restore': async (_q, body) => {
      const nightly = deps.memoryNightly()
      if (!nightly) return { status: 503, body: { error: 'memory_nightly_not_wired' } }
      const res = await nightly.restore((body as { key: string }).key)
      if (!res) return { status: workbenchErrorHttp('memory_retraction_not_found', 'desktop').status, body: { ok: false, code: 'memory_retraction_not_found' } }
      return { status: 200, body: { ok: true, restored: res.restored, note: RESTORE_NOTE } }
    },
    // CC 手绘小像 (2026-08-25) — draw the owner from profile material.
    'POST /v1/memory/portrait/generate': async (_q, body) => {
      const llm = deps.memoryLlm()
      if (!llm) return { status: 503, body: { error: 'memory_not_wired' } }
      const chatId = resolveChat(body)
      if (!chatId) return { status: 400, body: { error: 'no_admin_chat_id' } }
      const r = await llm.generatePortrait(chatId)
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
