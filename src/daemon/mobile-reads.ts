import { basename } from 'node:path'
import { redactConnections, type ConnectionsSnapshot } from './connections'
import { framedTooLarge } from './mobile-matter-response'
import type { CliSessionView } from '../core/cli-session-store'
import type { OverseerToday } from '../core/overseer-today'
import { PHONE_CLI_SAY_MAX, type CliPhoneActions } from './cli-phone-actions'
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
export interface MobileReadsDeps {
  connections?: () => ConnectionsSnapshot; sessions?: MobileSessionsDeps; cliSessions?: () => CliSessionView[]; cliActions?: CliPhoneActions
  /** 「今天」一眼看完(core/overseer-today.ts)。结构里只有目录名、没有完整路径,手机口径原样给。 */
  today?: () => OverseerToday
  /** 执行者 id → 正式名字(收敛清单 ⑥)。缺省 ⇒ 行里不带 displayName,App 退回 id。 */
  executorName?: (id: string) => string
}
/** 手机上终端会话列表最多给这么多条。 */
export const PHONE_CLI_SESSIONS_MAX = 50
/** 列表里最多给这么多条在跑的会话读「此刻那一步」。 */
export const PHONE_CLI_NOW_MAX = 8
/**
 * 手机口径的终端会话:与上面原生会话同一条规矩 —— 项目只给目录名,不给完整路径。
 * 其余字段同 GET /v1/cli/sessions(状态已折算 stale、等你批准的在前)。
 */
export function phoneCliSession(v: CliSessionView, pendingHash?: (sessionId: string) => string | null) {
  // 等批准的那一项带上码:只有中继真开了码(主人不在、问到了微信)才能在手机上拍;
  // 主人在场时留给终端自己问,没有码 ⇒ actionable:false,手机只显示「在终端里等你」。
  let hash: string | null = null
  if (v.pending && pendingHash) { try { hash = pendingHash(v.session_id) } catch { hash = null } }
  return {
    session_id: v.session_id, code: v.code, source: v.source, status: v.status, stale: v.stale,
    project: v.project, machine: v.machine, last_summary: v.last_summary,
    last_event_at: v.last_event_at, last_prompt_at: v.last_prompt_at, created_at: v.created_at,
    pending: v.pending ? { ...v.pending, hash, actionable: hash !== null } : null,
  }
}
/** 同 CliEventRequest:1–200 字的串;再挡掉控制字符。 */
const SESSION_ID_RE = /^[^\u0000-\u001f]{1,200}$/
const HASH_RE = /^[a-z0-9]{5}$/
async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  try { const b = await req.json(); return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : null } catch { return null }
}
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
  if (url.pathname === '/m/api/cli/sessions') {
    if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.cliSessions) return json({ ok: false, error: 'cli_sessions_not_wired' }, 503)
    const ph = deps.cliActions ? (id: string) => deps.cliActions!.pendingHash(id) : undefined
    try {
      // 在跑的会话带上此刻那一步(列表一眼看到谁在做什么);最多前 PHONE_CLI_NOW_MAX 条,读不到就不带。
      let budget = PHONE_CLI_NOW_MAX
      // 开在电脑窗口里的 Claude 会话(2026-10-18):手机上在跑时也能接着说(话送进那个窗口)。
      const live = deps.cliActions?.liveWindows?.() ?? new Set<string>()
      const sessions = deps.cliSessions().slice(0, PHONE_CLI_SESSIONS_MAX).map(v => {
        const plain = phoneCliSession(v, ph)
        const base = deps.executorName ? { ...plain, displayName: deps.executorName(v.source) } : plain
        const lw = v.source === 'claude' && live.has(v.session_id) ? { ...base, live_window: true } : base
        let said: ReturnType<NonNullable<CliPhoneActions['lastSay']>> = null
        try { said = deps.cliActions?.lastSay?.(v.session_id) ?? null } catch { said = null }
        const row = said ? { ...lw, last_say: said } : lw
        if (v.status !== 'running' || v.stale || budget <= 0 || !deps.cliActions?.currentStep) return row
        budget--
        let now: ReturnType<CliPhoneActions['currentStep']> = null
        try { now = deps.cliActions.currentStep(v.session_id) } catch { now = null }
        return now ? { ...row, now } : row
      })
      return json({ ok: true, sessions })
    }
    catch { return json({ ok: false, error: 'unavailable' }, 503) }
  }
  // 看着它跑(2026-10-17):一条终端会话最近几步。手机展开那一行时每几秒拉一次;只读,和「看 码」同一份记录。
  if (url.pathname === '/m/api/cli/activity') {
    if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.cliActions) return json({ ok: false, error: 'cli_actions_not_wired' }, 503)
    const id = url.searchParams.get('session_id')
    if (!id || !SESSION_ID_RE.test(id) || url.searchParams.getAll('session_id').length > 1) return json({ ok: false, error: 'invalid' }, 400)
    try {
      const r = deps.cliActions.activity(id)
      if (!r.ok) return json({ ok: false, error: r.error }, r.error === 'not_found' ? 404 : 409)
      // 旧中继一帧 512 KiB:每步文字上限减半直到放得下(不删步)。
      const cut = (t: string, max: number) => (t.length > max ? t.slice(0, max - 1) + '…' : t)
      return fitted(max => ({ ok: true, items: r.items.map(i => ({ ...i, text: cut(i.text, max), ...(i.detail ? { detail: cut(i.detail, max * 3) } : {}) })) }), 600)
    } catch { return json({ ok: false, error: 'unavailable' }, 503) }
  }
  // 「今天」(2026-10-14):终端 + 一起做,过去 24 小时 —— 与微信「日报」同一份数据。
  if (url.pathname === '/m/api/today') {
    if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.today) return json({ ok: false, error: 'today_not_wired' }, 503)
    try { return json({ ok: true, today: deps.today() }) }
    catch { return json({ ok: false, error: 'unavailable' }, 503) }
  }
  // 拍板终端会话等批准的那一项 —— 与微信「y/n 码」同一条路(cli-phone-actions.ts)。
  if (url.pathname === '/m/api/cli/permission') {
    if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.cliActions) return json({ ok: false, error: 'cli_actions_not_wired' }, 503)
    const b = await bodyOf(req)
    const hash = b?.['hash'], sessionId = b?.['session_id'], decision = b?.['decision']
    if (!b || (decision !== 'allow' && decision !== 'deny')
      || (hash !== undefined && (typeof hash !== 'string' || !HASH_RE.test(hash)))
      || (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)))
      || (hash === undefined && sessionId === undefined)) return json({ ok: false, error: 'invalid' }, 400)
    try {
      const r = deps.cliActions.permission({ ...(typeof hash === 'string' ? { hash } : {}), ...(typeof sessionId === 'string' ? { session_id: sessionId } : {}) }, decision)
      if (r.ok) return json({ ok: true })
      return json({ ok: false, error: r.error }, r.error === 'not_found' ? 404 : 409)
    } catch { return json({ ok: false, error: 'unavailable' }, 503) }
  }
  // 对终端会话接着说一句 —— 与微信「@码」同一个 core;收下即回,结果成为这条会话的下一句。
  if (url.pathname === '/m/api/cli/say') {
    if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.cliActions) return json({ ok: false, error: 'cli_actions_not_wired' }, 503)
    const b = await bodyOf(req)
    const sessionId = b?.['session_id'], text = typeof b?.['text'] === 'string' ? (b['text'] as string).trim() : ''
    if (!b || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId) || !text || text.length > PHONE_CLI_SAY_MAX || text.includes('\0')) return json({ ok: false, error: 'invalid' }, 400)
    try {
      const r = deps.cliActions.say(sessionId, text)
      if (r.ok) return json({ ok: true, accepted: true, ...(r.say_id ? { say_id: r.say_id } : {}) })
      return json({ ok: false, error: r.error }, r.error === 'not_found' ? 404 : 409)
    } catch { return json({ ok: false, error: 'unavailable' }, 503) }
  }
  /** 行里带上执行者正式名字(收敛清单 ⑥);没接名字 ⇒ 原样(App 退回 id)。 */
  const named = <R extends { provider: string }>(r: R): R & { displayName?: string } => deps.executorName ? { ...r, displayName: deps.executorName(r.provider) } : r
  if (url.pathname === '/m/api/sessions') {
    if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.sessions) return json({ ok: false, error: 'sessions_not_wired' }, 503)
    const provider = url.searchParams.get('provider'), cursor = cursorOf(url), queries = url.searchParams.getAll('q'), query = queries[0] ?? ''
    if ((provider !== 'claude' && provider !== 'codex') || url.searchParams.getAll('provider').length !== 1 || cursor === null || queries.length > 1 || query.length > 200 || query.includes('\0')) return json({ ok: false, error: 'invalid' }, 400)
    try {
      const page = await withBudget(deps.sessions.list(provider, { q: query.trim(), limit: PHONE_SESSIONS_PAGE, ...(cursor ? { cursor } : {}) }), opts.budgetMs ?? PHONE_SESSIONS_BUDGET_MS)
      const names = deps.executorName ? { names: { claude: deps.executorName('claude'), codex: deps.executorName('codex') } } : {}
      return fitted(max => ({ ok: true, items: page.items.map(i => named(row(i, max))), nextCursor: page.nextCursor, ...names }), 200)
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
        ok: true, session: named(row(p.session)), nextCursor: p.nextCursor, managed: !!p.managedTaskId, window,
        messages: p.messages.map(m => ({ id: m.id, role: m.role, text: m.text.slice(0, max), truncated: m.truncated || m.text.length > max })),
      }), PHONE_SESSION_TEXT_MAX)
    } catch (e) { return sessionError(e) }
  }
  return null
}
