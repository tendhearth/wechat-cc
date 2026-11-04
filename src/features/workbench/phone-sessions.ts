/**
 * 手机令牌(设备)读电脑上的原生会话的那一份(P3c-4,设计稿 2026-11-05-p3-one-route-family「按范围不按路径的差别」)。
 *
 * 以前写在手机处理器里(features/phone/mobile-reads.ts 的 `/m/api/sessions`、`/m/api/session`);P3c-4 起
 * `GET /v1/workbench/sessions`、`GET /v1/workbench/session` 是这份数据唯一的处理器,手机令牌从面板那一口进来也走它 ——
 * 处理器看 caller,是手机令牌就走这里。规矩原样搬来:
 *   - 行里项目只给目录名(`project`),**不给**完整路径 `cwd`、原生 id;标题至多 200 字;带执行者正式名字(`displayName`);
 *   - 列表一页 30 条、读一页 20 条(调用方定不了 `limit`),**不认** `cwd` 过滤(手机不知道也不该探电脑上的路径);
 *   - 每条正文至多 4000 字;装不下这一帧(caller.frameBudget)就把每段上限减半再拼,绝不 413 整页;
 *   - 单飞 + 短缓存(cacheSessions,裁定 8)、10 秒预算(读最近一页 8 秒):隧道约 15 秒没流量就断,超了如实回 503。
 * 回包带 `ok: true`(同 P3c-2 的 `/v1/cli/sessions` 手机那一份),别名原样转手,一帧的字节数和并之前一样。
 */
import { basename } from 'node:path'
import { framedTooLargeFor } from '../../domain/matters/phone-scope'
import type { NativeHistoryItem, NativeHistoryListInput, NativeHistoryPage, NativeHistoryPreview, NativeHistoryReadInput } from '../../adapters/workbench/native-history'
import type { RouteResult } from '../../daemon/internal-api/types'

export const PHONE_SESSIONS_BUDGET_MS = 10_000
export const PHONE_SESSION_RECENT_BUDGET_MS = 8_000
export const PHONE_SESSIONS_PAGE = 30
export const PHONE_SESSION_PAGE = 20
export const PHONE_SESSION_TEXT_MAX = 4000
/** 原生会话读的结果缓存至多留这么多键(软上限,超了先清过期、再挤最旧)。 */
export const SESSIONS_DONE_MAX = 64

export interface PhoneSessionsSource {
  list(provider: 'claude' | 'codex', input: NativeHistoryListInput): Promise<NativeHistoryPage>
  read(key: string, input: NativeHistoryReadInput): Promise<NativeHistoryPreview>
  readRecent?(key: string, input: { limit: number }): Promise<NativeHistoryPreview>
}
export interface PhoneSessionsDeps {
  /** 单飞 + 短缓存过的读法(cacheSessions)。缺 ⇒ 手机令牌 503 sessions_not_wired(绝不退回桌面那一份)。 */
  sessions?: PhoneSessionsSource
  /** 执行者 id → 正式名字(收敛清单 ⑥)。缺省 ⇒ 行里不带 displayName,App 退回 id。 */
  executorName?: (id: string) => string
  /** 测试用:预算(缺省 10 秒)。 */
  budgetMs?: number
}

/**
 * 裁定 8:原生会话读单飞 + 短缓存。10 s 预算只是不再等,底层扫描仍在跑;
 * 同键再来的请求加入同一次扫描(不叠新的),总在途数有上限(超了立刻 busy ⇒ 503)。失败不缓存。
 */
export function cacheSessions(inner: PhoneSessionsSource, o: { ttlMs?: number; maxInflight?: number; now?: () => number } = {}): PhoneSessionsSource {
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

/** 工作台服务 → 手机令牌读原生会话用的那一份(单飞 + 短缓存;从头读与读最近一页各走各的读法)。workbench 模块 init 时建一次。 */
export function phoneSessionsOf(w: { listNativeHistory: PhoneSessionsSource['list']; readNativeHistory: PhoneSessionsSource['read']; readRecentNativeHistory: NonNullable<PhoneSessionsSource['readRecent']> }): PhoneSessionsSource {
  return cacheSessions({ list: (p, i) => w.listNativeHistory(p, i), read: (k, i) => w.readNativeHistory(k, i), readRecent: (k, i) => w.readRecentNativeHistory(k, i) })
}

const row = (i: NativeHistoryItem, max = 200) => ({ key: i.key, provider: i.providerId, title: i.title.slice(0, max), project: i.cwd ? basename(i.cwd).slice(0, max) : null, updatedAt: i.updatedAt, active: i.observedState === 'active' })

/**
 * 旧中继一帧 512 KiB(终审 M1):body 由 build(max) 生成,太大就把每段正文的上限减半再生成(不删条目、不动 cursor),
 * 绝不 413 整页。max 降到 64 仍超(条目本身就多到离谱)也照发 —— 那是中继的事,不是吞掉整页。没有帧预算(不该发生:手机令牌只从面板进来)⇒ 不裁。
 */
function fitted(build: (max: number) => object, max: number, budget: number | undefined): object {
  let body = build(max)
  if (budget === undefined) return body
  while (max > 64 && framedTooLargeFor(JSON.stringify(body), budget)) { max = Math.floor(max / 2); body = build(max) }
  return body
}
async function withBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  let h: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([p, new Promise<never>((_, rej) => { h = setTimeout(() => rej(new Error('budget_exceeded')), ms) })]) }
  finally { if (h) clearTimeout(h) }
}
/** 参数不对:桌面那一列的码,原始码经 cause 带给别名(别名换回手机的 `invalid`)。 */
const invalid = (): RouteResult => ({ status: 400, body: { error: 'invalid_request' }, cause: 'invalid_request' })
/**
 * 读失败:不支持 ⇒ 422(桌面那一列)、游标 / 键不对 ⇒ 400,别的(超预算、在途满了、扫描抛了)⇒ 503 unavailable —— 读,
 * 不是 500。原始码只放进 cause(码形状的才放,消息原文不出去)。
 */
function readError(e: unknown): RouteResult {
  const m = e instanceof Error ? e.message : ''
  const cause = /^[a-z][a-z0-9_]{0,63}$/.test(m) ? { cause: m } : {}
  if (m === 'native_history_unsupported') return { status: 422, body: { error: m }, ...cause }
  if (m === 'invalid_cursor' || m === 'invalid_native_history_key' || m === 'invalid_request') return { status: 400, body: { error: m }, ...cause }
  return { status: 503, body: { error: 'unavailable' }, ...cause }
}
/** 只认这几个查询键,每个至多一次(面板分发已剥掉 d / t / _via)。 */
const onlyKeys = (q: URLSearchParams, keys: readonly string[]) => [...q.keys()].every(k => keys.includes(k)) && keys.every(k => q.getAll(k).length <= 1)
const cursorOf = (q: URLSearchParams): string | undefined | null => {
  const c = q.get('cursor')
  if (c === null) return undefined
  return c && c.length <= 2048 ? c : null
}

/** GET /v1/workbench/sessions,手机令牌:`providerId`(claude | codex)、可选 `q`(≤ 200 字)、`cursor`;一页 30。 */
export async function phoneSessionList(deps: PhoneSessionsDeps, q: URLSearchParams, frameBudget: number | undefined): Promise<RouteResult> {
  if (!onlyKeys(q, ['providerId', 'q', 'cursor'])) return invalid()
  const provider = q.get('providerId'), cursor = cursorOf(q), query = q.get('q') ?? ''
  if ((provider !== 'claude' && provider !== 'codex') || cursor === null || query.length > 200 || query.includes('\0')) return invalid()
  if (!deps.sessions) return { status: 503, body: { error: 'sessions_not_wired' }, cause: 'sessions_not_wired' }
  try {
    const page = await withBudget(deps.sessions.list(provider, { q: query.trim(), limit: PHONE_SESSIONS_PAGE, ...(cursor ? { cursor } : {}) }), deps.budgetMs ?? PHONE_SESSIONS_BUDGET_MS)
    const named = <R extends { provider: string }>(r: R) => deps.executorName ? { ...r, displayName: deps.executorName(r.provider) } : r
    const names = deps.executorName ? { names: { claude: deps.executorName('claude'), codex: deps.executorName('codex') } } : {}
    return { status: 200, body: fitted(max => ({ ok: true, items: page.items.map(i => named(row(i, max))), nextCursor: page.nextCursor, ...names }), 200, frameBudget) }
  } catch (e) { return readError(e) }
}

/** GET /v1/workbench/session,手机令牌:`key`、可选 `cursor`、`window`(start | recent;recent 不带 cursor);一页 20。 */
export async function phoneSessionRead(deps: PhoneSessionsDeps, q: URLSearchParams, frameBudget: number | undefined): Promise<RouteResult> {
  if (!onlyKeys(q, ['key', 'cursor', 'window'])) return invalid()
  const key = q.get('key'), cursor = cursorOf(q), window = q.get('window') ?? 'start'
  if (!key || key.length > 2048 || cursor === null || !['start', 'recent'].includes(window) || (window === 'recent' && cursor !== undefined)) return invalid()
  if (!deps.sessions) return { status: 503, body: { error: 'sessions_not_wired' }, cause: 'sessions_not_wired' }
  const sessions = deps.sessions
  // 读最近一页的读法没接 ⇒ 如实说不行,不退回从头读(那不是手机要的那一页)
  if (window === 'recent' && !sessions.readRecent) return { status: 503, body: { error: 'unavailable' }, cause: 'native_recent_unavailable' }
  try {
    const budget = deps.budgetMs ?? PHONE_SESSIONS_BUDGET_MS
    const p = await withBudget(window === 'recent' ? sessions.readRecent!(key, { limit: PHONE_SESSION_PAGE }) : sessions.read(key, { limit: PHONE_SESSION_PAGE, ...(cursor ? { cursor } : {}) }), Math.min(budget, window === 'recent' ? PHONE_SESSION_RECENT_BUDGET_MS : PHONE_SESSIONS_BUDGET_MS))
    const named = <R extends { provider: string }>(r: R) => deps.executorName ? { ...r, displayName: deps.executorName(r.provider) } : r
    return { status: 200, body: fitted(max => ({
      ok: true, session: named(row(p.session)), nextCursor: p.nextCursor, managed: !!p.managedTaskId, window,
      messages: p.messages.map(m => ({ id: m.id, role: m.role, text: m.text.slice(0, max), truncated: m.truncated || m.text.length > max })),
    }), PHONE_SESSION_TEXT_MAX, frameBudget) }
  } catch (e) { return readError(e) }
}
