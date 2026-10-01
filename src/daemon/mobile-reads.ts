import { basename } from 'node:path'
import { redactConnections, type ConnectionsSnapshot } from './connections'
import type { NativeHistoryItem, NativeHistoryListInput, NativeHistoryPage, NativeHistoryPreview, NativeHistoryReadInput } from '../core/workbench/native-history'

/**
 * mobile-reads.ts — 手机只读路由(spec 2026-10-01 §3):CC 的连接、电脑上的原生会话。
 * 路由字面量被 scripts/phone-routes.guard.test.ts 扫描。纵深防御:连接经 redactConnections,
 * 手机口径永远没有插件目录与未就绪原因(设备/链接令牌本身也是 admin 档)。
 */
export const PHONE_SESSIONS_BUDGET_MS = 10_000
export const PHONE_SESSIONS_PAGE = 30
export const PHONE_SESSION_PAGE = 20
export const PHONE_SESSION_TEXT_MAX = 4000
export interface MobileSessionsDeps {
  list(provider: 'claude' | 'codex', input: NativeHistoryListInput): Promise<NativeHistoryPage>
  read(key: string, input: NativeHistoryReadInput): Promise<NativeHistoryPreview>
}
export interface MobileReadsDeps { connections?: () => ConnectionsSnapshot; sessions?: MobileSessionsDeps }
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const row = (i: NativeHistoryItem) => ({ key: i.key, provider: i.providerId, title: i.title.slice(0, 200), project: i.cwd ? basename(i.cwd) : null, updatedAt: i.updatedAt, active: i.observedState === 'active' })
async function withBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  let h: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([p, new Promise<never>((_, rej) => { h = setTimeout(() => rej(new Error('budget_exceeded')), ms) })]) }
  finally { if (h) clearTimeout(h) }
}
const sessionError = (e: unknown) => {
  const m = e instanceof Error ? e.message : ''
  if (m === 'native_history_unsupported') return json({ ok: false, error: 'unsupported' }, 404)
  if (['invalid_cursor', 'invalid_native_history_key', 'invalid_request'].includes(m)) return json({ ok: false, error: 'invalid' }, 400)
  return json({ ok: false, error: 'unavailable' }, 503)
}
const cursorOf = (url: URL): string | undefined | null => {
  const all = url.searchParams.getAll('cursor')
  if (all.length > 1) return null
  const c = all[0]
  if (c === undefined) return undefined
  return c && c.length <= 2048 ? c : null
}

/**
 * 裁定 8:原生会话读单飞 + 短缓存。10 s 预算只是不再等,底层扫描仍在跑;
 * 同键再来的请求加入同一次扫描(不叠新的),总在途数有上限(超了立刻 busy ⇒ 503)。失败不缓存。
 */
export function cacheSessions(inner: MobileSessionsDeps, o: { ttlMs?: number; maxInflight?: number; now?: () => number } = {}): MobileSessionsDeps {
  const ttl = o.ttlMs ?? 15_000, maxInflight = o.maxInflight ?? 4, now = o.now ?? Date.now
  const inflight = new Map<string, Promise<unknown>>()
  const done = new Map<string, { at: number; v: unknown }>()
  const run = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = done.get(key)
    if (hit && now() - hit.at < ttl) return Promise.resolve(hit.v as T)
    const cur = inflight.get(key)
    if (cur) return cur as Promise<T>
    if (inflight.size >= maxInflight) return Promise.reject(new Error('busy'))
    const p = (() => { try { return load() } catch (e) { return Promise.reject(e) } })().then(v => {
      done.set(key, { at: now(), v })
      if (done.size > 64) for (const [k, e] of done) if (now() - e.at >= ttl) done.delete(k)
      return v
    }).finally(() => { inflight.delete(key) })
    inflight.set(key, p)
    return p
  }
  return {
    list: (provider, input) => run(JSON.stringify(['l', provider, input.q, input.limit, input.cursor ?? null, input.cwd ?? null]), () => inner.list(provider, input)),
    read: (key, input) => run(JSON.stringify(['r', key, input.limit, input.cursor ?? null]), () => inner.read(key, input)),
  }
}

export async function mobileReadsRoute(deps: MobileReadsDeps, url: URL, req: Request, opts: { budgetMs?: number } = {}): Promise<Response | null> {
  if (url.pathname === '/m/api/connections') {
    if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.connections) return json({ ok: false, error: 'connections_not_wired' }, 503)
    // 裁定 7:内部失败一律 503(客户端当作离线/不可用),不是 500。
    try { return json({ ok: true, ...redactConnections(deps.connections()) }) }
    catch { return json({ ok: false, error: 'unavailable' }, 503) }
  }
  if (url.pathname === '/m/api/sessions') {
    if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.sessions) return json({ ok: false, error: 'sessions_not_wired' }, 503)
    const provider = url.searchParams.get('provider'), cursor = cursorOf(url)
    if ((provider !== 'claude' && provider !== 'codex') || url.searchParams.getAll('provider').length !== 1 || cursor === null) return json({ ok: false, error: 'invalid' }, 400)
    try {
      const page = await withBudget(deps.sessions.list(provider, { q: '', limit: PHONE_SESSIONS_PAGE, ...(cursor ? { cursor } : {}) }), opts.budgetMs ?? PHONE_SESSIONS_BUDGET_MS)
      return json({ ok: true, items: page.items.map(row), nextCursor: page.nextCursor })
    } catch (e) { return sessionError(e) }
  }
  if (url.pathname === '/m/api/session') {
    if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.sessions) return json({ ok: false, error: 'sessions_not_wired' }, 503)
    const key = url.searchParams.get('key'), cursor = cursorOf(url)
    if (!key || key.length > 2048 || url.searchParams.getAll('key').length !== 1 || cursor === null) return json({ ok: false, error: 'invalid' }, 400)
    try {
      const p = await withBudget(deps.sessions.read(key, { limit: PHONE_SESSION_PAGE, ...(cursor ? { cursor } : {}) }), opts.budgetMs ?? PHONE_SESSIONS_BUDGET_MS)
      return json({
        ok: true, session: row(p.session), nextCursor: p.nextCursor, managed: !!p.managedTaskId,
        messages: p.messages.map(m => ({ id: m.id, role: m.role, text: m.text.slice(0, PHONE_SESSION_TEXT_MAX), truncated: m.truncated || m.text.length > PHONE_SESSION_TEXT_MAX })),
      })
    } catch (e) { return sessionError(e) }
  }
  return null
}
