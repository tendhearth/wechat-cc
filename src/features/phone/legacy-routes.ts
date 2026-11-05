/**
 * legacy-routes.ts — 老 App / 网页还在读的 `/m/api/*` 旧路径,翻到 `/v1` 那一条(P3,设计稿
 * docs/superpowers/specs/2026-11-05-p3-one-route-family-design.md「定案 · 别名表一处」)。
 *
 * 表在 `packages/protocol/src/wire-compat.ts` 的 WIRE_ROUTE_ALIASES:一行 = 旧键、新键、转换名。这里是 daemon 里**唯一**认它的地方:
 * `handler: 'alias'` 的每一行在这里有一个转换(名字同表里的 `transform`,`scripts/wire-compat.guard.test.ts` 核对)。
 *
 * 一个转换只做四样,都只活在别名里、随别名一起退:
 *   - 手机的参数规矩与默认值(多一个键就拒、默认不含归档、不点名不给终端 / act、取 50 ……),先验完再翻;
 *   - `{ ok }` 信封;
 *   - 错误码换成 `workbench-errors.ts` 的 phone 那一列(处理器给的原始码经 `x-cc-cause` 回包头带过来,见 PanelDispatch);
 *   - 响应头照旧(有的带 `cache-control: no-store`、有的不带 —— 金样把头一起钉了,按路由保持)。
 * 数据怎么取、手机能看哪些(别人的聊天、链接令牌少读的、帧预算)都在 `/v1` 那一个处理器里按 caller 收,这里不再判。
 *
 * 令牌照旧是面板认的设备 / 链接令牌:别名走面板同一个分发(`deps.v1` = 内部 API 的 panelDispatch),分发那边再按
 * `/v1` 那一行的 `phone` 块判一遍 —— 别名键在令牌的 routeAllow 里(phone-routes.ts 自动带上),新键也在。
 *
 * P3d 起还有一种:**纯改名**(表里 `transform: null`)。手机独有的数据搬到新的 `/v1` 路径(只有 `phone` 块的那一行,`PanelV1Key`),
 * 处理器还在面板这一口(回包是 Response:PNG、表情原图、前缀键 —— 内部 API 的分发只认 JSON 和精确键)。别名只把路径换成新键的,
 * 交给面板表里新键那一个处理器,请求、ctx、回包都不碰(`rename`)。
 */
import {PHONE_SAY_MAX_CHARS,PHONE_TRANSCRIBE_MAX_BYTES,PHONE_TRANSCRIBE_MIMES,MATTER_KINDS,WIRE_ROUTE_ALIASES} from '@wechat-cc/protocol'
import {PANEL_CAUSE_HEADER,type PanelDispatch} from '../../daemon/internal-api/types'
import type {TokenInfo} from '../../daemon/internal-api/token-registry'
import {MAX_MOBILE_DETAIL_BYTES,mobileMatterDetailResponse} from './mobile-matter-response'
import {mobileMatterError,mobileSayInput} from './mobile-workbench'
import {phoneClientOf} from './phone-client'
import {lookupPhoneRoute,ownsMethod,type PhoneHandler,type PhoneRouteTable} from './phone-route-table'

export interface LegacyRoutesDeps<C extends Ctx = Ctx> {
  /** 内部 API 的面板分发(P3b)。没接(测试)⇒ 各别名回它原来「没接上」的那个码。 */
  v1?: PanelDispatch
  /**
   * 面板合成好的那张处理器表(P3d 纯改名用;取的时候才读 —— 这张别名表本身也在那张表里)。手机独有的新键(`PanelV1Key`,只有
   * `phone` 块的 `/v1` 行)处理器在面板这一口;纯改名的别名把路径换成新键,交给它,同一个请求、同一个 ctx,回包原样。
   */
  local?: () => PhoneRouteTable<C>
}
type Ctx = { caller: TokenInfo }

/** 面板自己的 json():不带 cache-control(列表、详情的错误、说一句的回包今天就是这样,金样钉着)。 */
const panelJson = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
/** mobile-chat / mobile-workbench 的 json():带 no-store。 */
const noStore = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const chatErr = (error: string, status: number) => noStore({ ok: false, error }, status)

/** 手机这一口等不过协议客户端的 15 秒:电脑这边 12 秒没转完就如实说「太慢」,不让手机误报「没送到」。 */
export const TRANSCRIBE_TIMEOUT_MS = 12_000
const B64 = /^[A-Za-z0-9+/]*={0,2}$/
const TRANSCRIBE_B64_MAX = Math.ceil(PHONE_TRANSCRIBE_MAX_BYTES / 3) * 4
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const errorOf = (body: unknown) => obj(body) && typeof body.error === 'string' ? body.error : 'internal'

/** 纯改名的行(transform 为 null):旧键 → 新键,只从别名表读,这里不另写一份。 */
const RENAMED: ReadonlyMap<string, string> = new Map(WIRE_ROUTE_ALIASES.filter(r => r.transform === null).map(r => [r.from, r.to]))

interface V1Out { status: number; body: unknown; cause: string | null }

export function legacyRoutes<C extends Ctx = Ctx>(deps: LegacyRoutesDeps<C>): PhoneRouteTable<C> {
  /** 翻到新键,走同一个分发(带同一个令牌、同一个帧预算 / 出生地;断开信号跟着原请求)。 */
  const v1 = async (req: Request, caller: TokenInfo, method: 'GET' | 'POST', path: string, query: Record<string, string>, body?: unknown): Promise<V1Out> => {
    const url = new URL(`http://panel.local${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    const inner = new Request(url, {
      method, signal: req.signal,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    })
    const res = await deps.v1!(inner, caller, { frameBudget: MAX_MOBILE_DETAIL_BYTES, client: phoneClientOf(req), cause: true })
    return { status: res.status, body: await res.json(), cause: res.headers.get(PANEL_CAUSE_HEADER) }
  }

  // ── GET /m/api/matters → GET /v1/matters ──────────────────────────────
  const phoneMatters: PhoneHandler<Ctx> = async (url, req, { caller }) => {
    if (!deps.v1) return panelJson({ ok: false, error: 'matters_not_wired' }, 503)
    const kind = url.searchParams.get('kind'), status = url.searchParams.get('status')
    if ((kind !== null && !(MATTER_KINDS as readonly string[]).includes(kind)) || (status !== null && status.split(',').some(s => !['open', 'replied', 'done', 'archived'].includes(s)))) return panelJson({ ok: false, error: 'invalid' }, 400)
    // 手机的默认:不带 status ⇒ 不含归档(真机 2026-09-30:前 50 条里 49 条是归档的自检任务);取 50;任务行带任务真正的状态(U5);
    // 不点名 kind ⇒ 终端会话那件(M4a,App 主页另有一排终端行)与 CC 自己做的事(act,M5,主人 10-31 定不混排)都不进来。
    const out = await v1(req, caller, 'GET', '/v1/matters', {
      ...(kind !== null ? { kind } : { exclude: 'terminal,act' }),
      status: status ?? 'open,replied,done', limit: '50', taskState: '1',
    })
    if (out.status === 200 && obj(out.body) && Array.isArray(out.body.matters)) {
      // 「已暂停(网络未受保护)」的标记老 App 没读过:照旧不给(一字不变)
      const matters = out.body.matters.map(m => { if (!obj(m)) return m; const { networkSuspended: _n, ...rest } = m; return rest })
      return panelJson({ ok: true, matters })
    }
    return errorOf(out.body) === 'matters_not_wired' ? panelJson({ ok: false, error: 'matters_not_wired' }, 503) : panelJson({ ok: false, error: 'unavailable' }, 500)
  }

  // ── GET /m/api/matter → GET /v1/matter ────────────────────────────────
  const phoneMatter: PhoneHandler<Ctx> = async (url, req, { caller }) => {
    if (!deps.v1) return panelJson({ ok: false, error: 'matters_not_wired' }, 503)
    const id = url.searchParams.get('id')
    if (!id || !/^[a-f0-9]{8}$/.test(id)) return panelJson({ ok: false, error: 'invalid' }, 400)
    const out = await v1(req, caller, 'GET', '/v1/matter', { id })
    // 帧预算 /v1 那边已按 caller 裁过;套上 { ok } 以后多出来的那几个字节再按同一套裁一次(从最早的旁白起),装不下 ⇒ 413
    if (out.status === 200) return mobileMatterDetailResponse(out.body)
    const code = errorOf(out.body)
    if (out.status === 413 && code === 'detail_too_large') return noStore({ ok: false, error: 'detail_too_large' }, 413)
    if (out.status === 404 && code === 'matter_not_found') return panelJson({ ok: false, error: 'matter_not_found' }, 404)
    if (out.status === 503 && code === 'matters_not_wired') return panelJson({ ok: false, error: 'matters_not_wired' }, 503)
    return panelJson({ ok: false, error: 'unavailable' }, 500)
  }

  // ── POST /m/api/matter/say → POST /v1/matter/say ──────────────────────
  const phoneMatterSay: PhoneHandler<Ctx> = async (_url, req, { caller }) => {
    if (!deps.v1) return panelJson({ ok: false, error: 'matters_not_wired' }, 503)
    let body: unknown
    try { body = await req.json() } catch { return panelJson({ ok: false, error: 'bad_json' }, 400) }
    const b = (body ?? {}) as Record<string, unknown>
    if (typeof b.id !== 'string' || !/^[a-f0-9]{8}$/.test(b.id) || typeof b.text !== 'string' || (!b.text.trim() && (!Array.isArray(b.attachmentIds) || !b.attachmentIds.length)) || b.text.length > PHONE_SAY_MAX_CHARS) return panelJson({ ok: false, error: 'invalid' }, 400)
    let input: ReturnType<typeof mobileSayInput>
    try { input = mobileSayInput(b) } catch (e) { return mobileMatterError(e) }
    const out = await v1(req, caller, 'POST', '/v1/matter/say', {}, { id: b.id, text: b.text, ...(input ?? {}) })
    if (out.status === 200) return panelJson({ ok: true, result: out.body })
    const code = out.cause ?? errorOf(out.body)
    if (out.status === 503 && code === 'matters_not_wired') return panelJson({ ok: false, error: 'matters_not_wired' }, 503)
    return mobileMatterError(Error(code))
  }

  // ── GET /m/api/chat/search → GET /v1/matter/owner-chat/search ─────────
  const phoneChatSearch: PhoneHandler<Ctx> = ownsMethod(async (url: URL, req: Request, { caller }: Ctx) => {
    if (req.method !== 'GET') return chatErr('method_not_allowed', 405)
    if (!deps.v1) return chatErr('chat_not_wired', 503)
    const q = url.searchParams.get('q') ?? ''
    if (url.searchParams.getAll('q').length !== 1 || !q.trim() || q.length > 200) return chatErr('invalid', 400)
    const out = await v1(req, caller, 'GET', '/v1/matter/owner-chat/search', { q, limit: '30' })
    if (out.status === 200 && obj(out.body) && Array.isArray(out.body.hits)) {
      // 手机那一份:谁说的(me / cc)、正文至多 600 字、时间、来源(没有 ⇒ null)
      const hits = out.body.hits.map(h => {
        const r = (obj(h) ? h : {}) as { id?: unknown; kind?: unknown; text?: unknown; createdAt?: unknown; source?: unknown }
        const text = typeof r.text === 'string' ? r.text : ''
        return { id: r.id, role: r.kind === 'user' ? 'me' : 'cc', text: text.length > 600 ? text.slice(0, 600) : text, truncated: text.length > 600, at: r.createdAt, source: r.source ?? null }
      })
      return noStore({ ok: true, hits })
    }
    const code = errorOf(out.body)
    if (out.status === 404) return chatErr('no_owner_chat', 404)
    if (out.status === 503 && code === 'matters_not_wired') return chatErr('chat_not_wired', 503)
    return chatErr('unavailable', 503)
  })

  // ── GET /m/api/chat/file → GET /v1/matter/owner-chat/file ─────────────
  const phoneChatFile: PhoneHandler<Ctx> = ownsMethod(async (url: URL, req: Request, { caller }: Ctx) => {
    if (req.method !== 'GET') return chatErr('method_not_allowed', 405)
    if (!deps.v1) return chatErr('chat_not_wired', 503)
    const id = url.searchParams.get('id'), rawIdx = url.searchParams.get('i'), rawOffset = url.searchParams.get('offset') ?? '0'
    if (!id || id.length > 200 || rawIdx === null || !/^\d{1,2}$/.test(rawIdx) || !/^\d{1,9}$/.test(rawOffset)) return chatErr('invalid', 400)
    const out = await v1(req, caller, 'GET', '/v1/matter/owner-chat/file', { id, i: rawIdx, offset: rawOffset })
    // 成功那一块本来就是 { ok: true, … }(fileChunkResponse,两边同一个)
    if (out.status >= 200 && out.status < 300 && obj(out.body)) return noStore(out.body, out.status)
    const code = errorOf(out.body)
    if (code === 'invalid_request') return chatErr('invalid', 400)
    if (out.status === 503) return chatErr(code === 'matters_not_wired' ? 'chat_not_wired' : code, 503)
    return chatErr(code, out.status)
  })

  // ── POST /m/api/chat/transcribe → POST /v1/companion/transcribe ───────
  // 录音与转出来的字都不进日志、不落盘。手机这一口等不过协议客户端的 15 秒:12 秒没转完就如实说「太慢」。
  const phoneChatTranscribe: PhoneHandler<Ctx> = async (_url, req, { caller }) => {
    if (!deps.v1) return chatErr('voice_not_wired', 503)
    // 先量长度再解析:局域网直连没有中继那一帧的上限
    let raw: string
    try { raw = await req.text() } catch { return chatErr('bad_json', 400) }
    if (raw.length > TRANSCRIBE_B64_MAX + 1024) return chatErr('audio_too_large', 413)
    let body: unknown
    try { body = JSON.parse(raw) } catch { return chatErr('bad_json', 400) }
    if (!obj(body)) return chatErr('invalid', 400)
    if (Object.keys(body).some(k => k !== 'mime' && k !== 'audioBase64')) return chatErr('invalid', 400)
    if (typeof body.mime !== 'string' || !(PHONE_TRANSCRIBE_MIMES as readonly string[]).includes(body.mime)) return chatErr('invalid', 400)
    if (typeof body.audioBase64 !== 'string' || !body.audioBase64 || body.audioBase64.length % 4 !== 0 || !B64.test(body.audioBase64)) return chatErr('invalid', 400)
    if (body.audioBase64.length > TRANSCRIBE_B64_MAX) return chatErr('audio_too_large', 413)
    const audio = Buffer.from(body.audioBase64, 'base64')
    if (!audio.length) return chatErr('invalid', 400)
    if (audio.length > PHONE_TRANSCRIBE_MAX_BYTES) return chatErr('audio_too_large', 413)
    let out: V1Out
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      out = await Promise.race([
        v1(req, caller, 'POST', '/v1/companion/transcribe', {}, { audio_b64: body.audioBase64, mime: body.mime }),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('stt_timeout')), TRANSCRIBE_TIMEOUT_MS) }),
      ])
    } catch { return chatErr('stt_timeout', 504) } finally { if (timer) clearTimeout(timer) }
    if (out.status === 200) {
      const text = obj(out.body) && typeof out.body.text === 'string' ? out.body.text.trim() : ''
      return text ? noStore({ ok: true, text: text.slice(0, PHONE_SAY_MAX_CHARS) }) : chatErr('no_speech', 422)
    }
    const code = errorOf(out.body)
    if (out.status === 422 && code === 'no_stt_config') return chatErr('stt_not_configured', 422)
    // 没接 / 语音模块此刻没起来(模块门的 module_*)⇒ 手机照旧说「没接」
    if (out.status === 503) return chatErr('voice_not_wired', 503)
    if (out.cause === 'network_unprotected') return chatErr('stt_blocked', 503)
    if (code === 'stt_timeout' || /timed out|timeout|aborted/i.test(code)) return chatErr('stt_timeout', 504)
    return chatErr('stt_failed', 502)
  }

  // ── P3c-2 终端与总览:三条只读,手机那一份由 /v1 处理器按 caller 收(cli/sessions 只给目录名、connections 去掉 detail)。
  // 别名只做:方法不对 405、`{ ok }` 信封、「没接上」码、内部失败一律 503 unavailable(裁定 7)、带 no-store(mobile-reads 的 json())。
  /** `notWired`:手机原来「没接上」的那个码;/v1 回同一个码、或模块门(module_*,模块此刻不是 ok / 还没挂上)⇒ 回它。 */
  const readAlias = (path: string, notWired: string, ok: (body: Record<string, unknown>) => object | null): PhoneHandler<Ctx> =>
    ownsMethod(async (_url: URL, req: Request, { caller }: Ctx) => {
      if (req.method !== 'GET') return chatErr('method_not_allowed', 405)
      if (!deps.v1) return chatErr(notWired, 503)
      const out = await v1(req, caller, 'GET', path, {})
      const body = out.status === 200 && obj(out.body) ? ok(out.body) : null
      if (body) return noStore({ ok: true, ...body })
      const code = errorOf(out.body)
      return chatErr(out.status === 503 && (code === notWired || code.startsWith('module_')) ? notWired : 'unavailable', 503)
    })

  // ── GET /m/api/cli/sessions → GET /v1/cli/sessions ────────────────────
  const phoneCliSessions = readAlias('/v1/cli/sessions', 'cli_sessions_not_wired', b => Array.isArray(b.sessions) ? { sessions: b.sessions } : null)
  // ── GET /m/api/today → GET /v1/overseer/today ─────────────────────────
  const phoneToday = readAlias('/v1/overseer/today', 'today_not_wired', b => 'today' in b ? { today: b.today } : null)
  // ── GET /m/api/connections → GET /v1/connections ──────────────────────
  // /v1 回的是裸快照(手机令牌已去掉 detail),手机那一份是 { ok: true, ...快照 }
  const phoneConnections = readAlias('/v1/connections', 'connections_not_wired', b => b)

  // ── P3c-3 记忆、待办、看到哪了:数据由 /v1 那一个处理器给(待办的手机令牌只认三个状态、不认 now —— routes-knowledge.ts)。
  // 别名只做:手机的参数规矩(多一个键就拒、先验再翻)、`{ ok }` 信封、手机那一列的码、不带 cache-control(settings-panel 的 json())。
  /** /v1 回的是「没接上」:处理器自己的 not_wired 码,或模块门(module_*:模块此刻不是 ok / 还没挂上)。 */
  const unwired = (out: V1Out, code: string) => out.status === 503 && (errorOf(out.body) === code || errorOf(out.body).startsWith('module_'))

  // ── GET /m/api/memory/retractions → GET /v1/memory/retractions ────────
  const phoneMemoryRetractions: PhoneHandler<Ctx> = async (_url, req, { caller }) => {
    if (!deps.v1) return panelJson({ ok: false, error: 'memory_not_wired' }, 503)
    const out = await v1(req, caller, 'GET', '/v1/memory/retractions', {})
    if (out.status === 200 && obj(out.body) && Array.isArray(out.body.items)) return panelJson({ ok: true, items: out.body.items })
    if (unwired(out, 'memory_nightly_not_wired')) return panelJson({ ok: false, error: 'memory_not_wired' }, 503)
    return panelJson({ ok: false, error: 'unavailable' }, 500)
  }

  // ── POST /m/api/memory/restore → POST /v1/memory/retractions/restore ──
  // 正文恰好 key;回应带 note(随之删掉的笔记行不会回来),手机原样显示。
  const phoneMemoryRestore: PhoneHandler<Ctx> = ownsMethod(async (_url: URL, req: Request, { caller }: Ctx) => {
    if (req.method !== 'POST') return panelJson({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.v1) return panelJson({ ok: false, error: 'memory_not_wired' }, 503)
    let b: unknown
    try { b = await req.json() } catch { return panelJson({ ok: false, error: 'invalid' }, 400) }
    if (!obj(b) || Object.keys(b).some(k => k !== 'key') || typeof b.key !== 'string' || !/^c:[^\s]{1,80}$/.test(b.key)) return panelJson({ ok: false, error: 'invalid' }, 400)
    const out = await v1(req, caller, 'POST', '/v1/memory/retractions/restore', {}, { key: b.key })
    if (out.status === 200 && obj(out.body)) return panelJson({ ok: true, restored: out.body.restored, note: out.body.note })
    if (out.status === 404) return panelJson({ ok: false, error: 'not_found' }, 404)
    if (unwired(out, 'memory_nightly_not_wired')) return panelJson({ ok: false, error: 'memory_not_wired' }, 503)
    return panelJson({ ok: false, error: 'unavailable' }, 500)
  })

  // ── POST /m/api/todo → POST /v1/knowledge/facts/set_fact_status ───────
  // 先验参数再看接没接(同并之前);改不到那一条(id 不在)手机照旧回 ok —— 并之前就不看结果。
  const phoneTodo: PhoneHandler<Ctx> = async (_url, req, { caller }) => {
    let body: unknown
    try { body = await req.json() } catch { return panelJson({ ok: false, error: 'bad_json' }, 400) }
    const b = (body ?? {}) as { id?: unknown; status?: unknown }
    if (typeof b.id !== 'number' || (b.status !== 'resolved' && b.status !== 'active' && b.status !== 'rejected')) return panelJson({ ok: false, error: 'invalid' }, 400)
    if (!deps.v1) return panelJson({ ok: false, error: 'todos_not_wired' }, 503)
    const out = await v1(req, caller, 'POST', '/v1/knowledge/facts/set_fact_status', {}, { id: b.id, status: b.status })
    if (out.status === 200) return panelJson({ ok: true })
    if (unwired(out, 'knowledge_not_wired')) return panelJson({ ok: false, error: 'todos_not_wired' }, 503)
    if (out.status === 400) return panelJson({ ok: false, error: 'invalid' }, 400)
    return panelJson({ ok: false, error: 'unavailable' }, 500)
  }

  // ── POST /m/api/seen → POST /v1/journal/seen ──────────────────────────
  // 手机一定带 until(没带 / 不是时间 ⇒ 400,不会变成「推到现在」);夹到 now、只往后推在 /v1 那边。
  const phoneSeen: PhoneHandler<Ctx> = async (_url, req, { caller }) => {
    if (!deps.v1) return panelJson({ ok: false, error: 'seen_not_wired' }, 503)
    let body: unknown
    try { body = await req.json() } catch { return panelJson({ ok: false, error: 'bad_json' }, 400) }
    const until = (body as { until?: unknown } | null)?.until
    if (typeof until !== 'string' || !Number.isFinite(Date.parse(until))) return panelJson({ ok: false, error: 'invalid_until' }, 400)
    const out = await v1(req, caller, 'POST', '/v1/journal/seen', {}, { until })
    if (out.status === 200 && obj(out.body) && typeof out.body.seen_until === 'string') return panelJson({ ok: true, seen_until: out.body.seen_until })
    if (unwired(out, 'seen_not_wired')) return panelJson({ ok: false, error: 'seen_not_wired' }, 503)
    if (out.status === 400 && errorOf(out.body) === 'invalid_until') return panelJson({ ok: false, error: 'invalid_until' }, 400)
    return panelJson({ ok: false, error: 'unavailable' }, 500)
  }

  // ── P3c-4 交办选项与会话:数据由 /v1 那一个处理器给(手机令牌按手机表面问、模型只认项目 id、只扔分块上传的那一份、
  // 原生会话回手机那一份 —— features/workbench/routes.ts、phone-sessions.ts)。
  // 别名只做:手机的参数规矩(先验再翻,同并之前)、`{ ok }` 信封、phone 那一列的码、带 no-store(mobile-workbench / mobile-reads 的 json())。
  /** 处理器抛的原始码(cause)按 phone 那一列换;没有 cause 的 503(模块门 workbench_not_wired / module_*)⇒ 手机原来「没接上」的那个码。 */
  const workbenchAliasError = (out: V1Out, notWired: string): Response => {
    if (out.cause) return mobileMatterError(Error(out.cause))
    const code = errorOf(out.body)
    return mobileMatterError(Error(out.status === 503 && (code === 'workbench_not_wired' || code.startsWith('module_')) ? notWired : code))
  }

  // ── GET /m/api/entry/options → GET /v1/workbench/entry-options ────────
  const phoneEntryOptions: PhoneHandler<Ctx> = ownsMethod(async (_url: URL, req: Request, { caller }: Ctx) => {
    if (req.method !== 'GET') return noStore({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.v1) return mobileMatterError(Error('entry_not_wired'))
    const out = await v1(req, caller, 'GET', '/v1/workbench/entry-options', {})
    if (out.status === 200 && obj(out.body)) return noStore({ ok: true, ...out.body })
    return workbenchAliasError(out, 'entry_not_wired')
  })

  // ── GET /m/api/entry/models → GET /v1/workbench/models ────────────────
  // 手机只给执行者 id 与项目目录 id(路径在电脑上解析);参数规矩先验(同并之前,t / d / _via 是令牌与隧道标记)。
  const phoneEntryModels: PhoneHandler<Ctx> = ownsMethod(async (url: URL, req: Request, { caller }: Ctx) => {
    if (req.method !== 'GET') return noStore({ ok: false, error: 'method_not_allowed' }, 405)
    const q = url.searchParams, providerId = q.get('providerId'), projectId = q.get('projectId')
    if (q.getAll('providerId').length !== 1 || q.getAll('projectId').length > 1 || [...q.keys()].some(k => !['providerId', 'projectId', 't', 'd', '_via'].includes(k)) || !providerId || !/^[a-z][a-z0-9._-]{0,63}$/.test(providerId) || (projectId !== null && !/^p-[A-Za-z0-9_-]{1,64}$/.test(projectId))) return mobileMatterError(Error('invalid_request'))
    if (!deps.v1) return mobileMatterError(Error('entry_not_wired'))
    const out = await v1(req, caller, 'GET', '/v1/workbench/models', { providerId, ...(projectId ? { projectId } : {}) })
    if (out.status === 200 && obj(out.body)) return noStore({ ok: true, catalog: out.body.catalog })
    return workbenchAliasError(out, 'entry_not_wired')
  })

  // ── POST /m/api/attachment/discard → POST /v1/workbench/discard-attachment
  // 正文原样交过去,由上传登记处验(恰好 id + draftId;不对 ⇒ invalid_upload_chunk,同并之前)。
  const phoneAttachmentDiscard: PhoneHandler<Ctx> = ownsMethod(async (_url: URL, req: Request, { caller }: Ctx) => {
    if (req.method !== 'POST') return noStore({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.v1) return mobileMatterError(Error('uploads_not_wired'))
    let body: unknown
    try { body = await req.json() } catch { return mobileMatterError(Error('invalid_upload_chunk')) }
    const out = await v1(req, caller, 'POST', '/v1/workbench/discard-attachment', {}, body)
    if (out.status === 200) return noStore({ ok: true })
    return workbenchAliasError(out, 'uploads_not_wired')
  })

  // ── GET /m/api/sessions、/m/api/session → GET /v1/workbench/sessions、/v1/workbench/session
  // 手机那一份(只给目录名、一页 30 / 20、按帧裁、单飞 + 预算)在 /v1 那边拼好,回包已带 ok: true,原样转手。
  /** 读的错误(并之前的 sessionError):不支持 404 unsupported、游标 / 键 / 参数不对 400 invalid、没接上 503 sessions_not_wired、别的 503 unavailable。 */
  const sessionAliasError = (out: V1Out): Response => {
    const code = out.cause ?? errorOf(out.body)
    if (code === 'native_history_unsupported') return noStore({ ok: false, error: 'unsupported' }, 404)
    if (['invalid_cursor', 'invalid_native_history_key', 'invalid_request'].includes(code)) return noStore({ ok: false, error: 'invalid' }, 400)
    if (code === 'sessions_not_wired' || (out.status === 503 && !out.cause && (code === 'workbench_not_wired' || code.startsWith('module_')))) return noStore({ ok: false, error: 'sessions_not_wired' }, 503)
    return noStore({ ok: false, error: 'unavailable' }, 503)
  }
  const sessionCursor = (url: URL): string | undefined | null => {
    const all = url.searchParams.getAll('cursor')
    if (all.length > 1) return null
    const c = all[0]
    if (c === undefined) return undefined
    return c && c.length <= 2048 ? c : null
  }
  const phoneSessions: PhoneHandler<Ctx> = ownsMethod(async (url: URL, req: Request, { caller }: Ctx) => {
    if (req.method !== 'GET') return noStore({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.v1) return noStore({ ok: false, error: 'sessions_not_wired' }, 503)
    const provider = url.searchParams.get('provider'), cursor = sessionCursor(url), queries = url.searchParams.getAll('q'), query = queries[0] ?? ''
    if ((provider !== 'claude' && provider !== 'codex') || url.searchParams.getAll('provider').length !== 1 || cursor === null || queries.length > 1 || query.length > 200 || query.includes('\0')) return noStore({ ok: false, error: 'invalid' }, 400)
    const out = await v1(req, caller, 'GET', '/v1/workbench/sessions', { providerId: provider, ...(queries.length ? { q: query } : {}), ...(cursor ? { cursor } : {}) })
    if (out.status === 200 && obj(out.body) && out.body.ok === true) return noStore(out.body)
    return sessionAliasError(out)
  })
  const phoneSession: PhoneHandler<Ctx> = ownsMethod(async (url: URL, req: Request, { caller }: Ctx) => {
    if (req.method !== 'GET') return noStore({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.v1) return noStore({ ok: false, error: 'sessions_not_wired' }, 503)
    const key = url.searchParams.get('key'), cursor = sessionCursor(url), windows = url.searchParams.getAll('window'), window = windows[0] ?? 'start'
    if (!key || key.length > 2048 || url.searchParams.getAll('key').length !== 1 || cursor === null || windows.length > 1 || !['start', 'recent'].includes(window) || (window === 'recent' && cursor !== undefined)) return noStore({ ok: false, error: 'invalid' }, 400)
    const out = await v1(req, caller, 'GET', '/v1/workbench/session', { key, ...(cursor ? { cursor } : {}), ...(windows.length ? { window } : {}) })
    if (out.status === 200 && obj(out.body) && out.body.ok === true) return noStore(out.body)
    return sessionAliasError(out)
  })

  // ── P3d 纯改名(wire-compat.ts 里 transform 为 null 的行):旧路径换成新键的路径(前缀键换前缀、后面原样),交给面板里新键那一个
  // 处理器 —— 同一个 Request(方法、正文、头、断开信号)、同一个 ctx(令牌、设备 id),回包一个字节不碰。查不到 ⇒ 面板同一个 404。
  // 一律 ownsMethod:方法不对也交过去,由新键那边照它自己的规矩回(它自己判方法就回它的 405,不判就落到这里的 404,同并之前)。
  const rename = (from: string): PhoneHandler<C> => {
    const to = RENAMED.get(from)
    if (!to) throw new Error(`legacy-routes: ${from} 不是 wire-compat.ts 里的纯改名行`)
    const fromPath = from.slice(from.indexOf(' ') + 1), toPath = to.slice(to.indexOf(' ') + 1)
    return ownsMethod(async (url: URL, req: Request, ctx: C) => {
      const next = new URL(url)
      next.pathname = toPath.endsWith('/') ? toPath + url.pathname.slice(fromPath.length) : toPath
      const h = deps.local ? lookupPhoneRoute(deps.local(), req.method, next.pathname) : null
      return h ? await h(next, req, ctx) : panelJson({ error: 'not_found' }, 404)
    })
  }

  return {
    // P3d-1 手机独有的(纯改名)
    'GET /m/api/state': rename('GET /m/api/state'),
    'GET /m/api/art/presence': rename('GET /m/api/art/presence'),
    'POST /m/api/push/register': rename('POST /m/api/push/register'),
    'POST /m/api/push/test': rename('POST /m/api/push/test'),
    'GET /m/api/matter/insight': rename('GET /m/api/matter/insight'),
    'GET /m/api/matter/input-receipt': rename('GET /m/api/matter/input-receipt'),
    'GET /m/api/home': rename('GET /m/api/home'),
    'GET /m/api/cli/activity': rename('GET /m/api/cli/activity'),
    'GET /m/api/activity': rename('GET /m/api/activity'),
    'GET /m/api/jobs': rename('GET /m/api/jobs'),
    'POST /m/api/jobs/action': rename('POST /m/api/jobs/action'),
    'GET /m/api/letters': rename('GET /m/api/letters'),
    'GET /m/api/letters/page': rename('GET /m/api/letters/page'),
    'GET /m/api/matters': phoneMatters,
    'GET /m/api/matter': phoneMatter,
    'POST /m/api/matter/say': phoneMatterSay,
    'GET /m/api/chat/search': phoneChatSearch,
    'GET /m/api/chat/file': phoneChatFile,
    'POST /m/api/chat/transcribe': phoneChatTranscribe,
    'GET /m/api/cli/sessions': phoneCliSessions,
    'GET /m/api/today': phoneToday,
    'GET /m/api/connections': phoneConnections,
    'GET /m/api/memory/retractions': phoneMemoryRetractions,
    'POST /m/api/memory/restore': phoneMemoryRestore,
    'POST /m/api/todo': phoneTodo,
    'POST /m/api/seen': phoneSeen,
    'GET /m/api/entry/options': phoneEntryOptions,
    'GET /m/api/entry/models': phoneEntryModels,
    'POST /m/api/attachment/discard': phoneAttachmentDiscard,
    'GET /m/api/sessions': phoneSessions,
    'GET /m/api/session': phoneSession,
  }
}
