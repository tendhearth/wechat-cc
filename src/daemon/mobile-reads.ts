import { basename } from 'node:path'
import { redactConnections, type ConnectionsSnapshot } from './connections'
import { framedTooLarge } from './mobile-matter-response'
import type { NativeHistoryItem, NativeHistoryListInput, NativeHistoryPage, NativeHistoryPreview, NativeHistoryReadInput } from '../core/workbench/native-history'

/**
 * mobile-reads.ts — 手机只读路由(spec 2026-10-01 §3):CC 的连接、电脑上的原生会话。
 * 路由字面量被 scripts/phone-routes.guard.test.ts 扫描。纵深防御:连接经 redactConnections,
 * 手机口径永远没有插件目录与未就绪原因(设备/链接令牌本身也是 admin 档)。
 */
export const PHONE_SESSIONS_BUDGET_MS = 10_000
export const PHONE_SESSION_RECENT_BUDGET_MS = 8_000
export const PHONE_SESSIONS_PAGE = 30
export const PHONE_SESSION_PAGE = 20
export const PHONE_SESSION_TEXT_MAX = 4000
/** 原生会话读的结果缓存至多留这么多键(软上限,超了先清过期、再挤最旧)。 */
export const SESSIONS_DONE_MAX = 64
export interface MobileSessionsDeps {
  list(provider: 'claude' | 'codex', input: NativeHistoryListInput): Promise<NativeHistoryPage>
  read(key: string, input: NativeHistoryReadInput): Promise<NativeHistoryPreview>
  readRecent?(key: string, input: { limit: number }): Promise<NativeHistoryPreview>
}
export interface MobileReadsDeps { connections?: () => ConnectionsSnapshot; sessions?: MobileSessionsDeps }
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const row = (i: NativeHistoryItem, max = 200) => ({ key: i.key, provider: i.providerId, title: i.title.slice(0, max), project: i.cwd ? basename(i.cwd).slice(0, max) : null, updatedAt: i.updatedAt, active: i.observedState === 'active' })
/**
 * 旧中继一帧 512 KiB(终审 M1):body 由 build(max) 生成,太大就把每段正文的上限减半再生成(不删条目、不动 cursor),
 * 绝不 413 整页。max 降到 64 仍超(条目本身就多到离谱)也照发 —— 那是中继的事,不是吞掉整页。
 */
function fitted(build: (max: number) => object, max: number): Response {
  let body = JSON.stringify(build(max))
  while (max > 64 && framedTooLarge(body)) { max = Math.floor(max / 2); body = JSON.stringify(build(max)) }
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
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
      done.delete(key); done.set(key, { at: now(), v })   // 先删再放:Map 按插入序,最旧的在前
      if (done.size > SESSIONS_DONE_MAX) {
        for (const [k, e] of done) if (now() - e.at >= ttl) done.delete(k)
        // 软上限:TTL 内也可能一下来很多不同的键(翻页 / 换会话),还超就从最旧的挤
        for (const k of done.keys()) { if (done.size <= SESSIONS_DONE_MAX) break; done.delete(k) }
      }
      return v
    }).finally(() => { inflight.delete(key) })
    inflight.set(key, p)
    return p
  }
  return {
    list: (provider, input) => run(JSON.stringify(['l', provider, input.q, input.limit, input.cursor ?? null, input.cwd ?? null]), () => inner.list(provider, input)),
    read: (key, input) => run(JSON.stringify(['r', key, input.limit, input.cursor ?? null]), () => inner.read(key, input)),
    ...(inner.readRecent ? { readRecent: (key: string, input: { limit: number }) => run(JSON.stringify(['recent', key, input.limit]), () => inner.readRecent!(key, input)) } : {}),
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
    const provider = url.searchParams.get('provider'), cursor = cursorOf(url), queries = url.searchParams.getAll('q'), query = queries[0] ?? ''
    if ((provider !== 'claude' && provider !== 'codex') || url.searchParams.getAll('provider').length !== 1 || cursor === null || queries.length > 1 || query.length > 200 || query.includes('\0')) return json({ ok: false, error: 'invalid' }, 400)
    try {
      const page = await withBudget(deps.sessions.list(provider, { q: query.trim(), limit: PHONE_SESSIONS_PAGE, ...(cursor ? { cursor } : {}) }), opts.budgetMs ?? PHONE_SESSIONS_BUDGET_MS)
      return fitted(max => ({ ok: true, items: page.items.map(i => row(i, max)), nextCursor: page.nextCursor }), 200)
    } catch (e) { return sessionError(e) }
  }
  if (url.pathname === '/m/api/session') {
    if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.sessions) return json({ ok: false, error: 'sessions_not_wired' }, 503)
    const key = url.searchParams.get('key'), cursor = cursorOf(url), windows = url.searchParams.getAll('window'), window = windows[0] ?? 'start'
    if (!key || key.length > 2048 || url.searchParams.getAll('key').length !== 1 || cursor === null || windows.length > 1 || !['start', 'recent'].includes(window) || (window === 'recent' && cursor !== undefined)) return json({ ok: false, error: 'invalid' }, 400)
    if (window === 'recent' && !deps.sessions.readRecent) return json({ ok: false, error: 'unavailable' }, 503)
    try {
      const p = await withBudget(window === 'recent' ? deps.sessions.readRecent!(key, { limit: PHONE_SESSION_PAGE }) : deps.sessions.read(key, { limit: PHONE_SESSION_PAGE, ...(cursor ? { cursor } : {}) }), Math.min(opts.budgetMs ?? PHONE_SESSIONS_BUDGET_MS, window === 'recent' ? PHONE_SESSION_RECENT_BUDGET_MS : PHONE_SESSIONS_BUDGET_MS))
      return fitted(max => ({
        ok: true, session: row(p.session), nextCursor: p.nextCursor, managed: !!p.managedTaskId, window,
        messages: p.messages.map(m => ({ id: m.id, role: m.role, text: m.text.slice(0, max), truncated: m.truncated || m.text.length > max })),
      }), PHONE_SESSION_TEXT_MAX)
    } catch (e) { return sessionError(e) }
  }
  return null
}
