/**
 * 终端会话的路由(spec 2026-09-09-cli-hook-push-design §6.1;架构终态 A5 从 internal-api/routes-cli-events.ts 搬来):
 * hooks 报进来的事件、权限中继、登记处列表、CC 代主人说一句、接上 / 撤掉 hooks、「今天」一眼看完。
 * 由 terminal 模块自己挂(internalApi.mount;路由表标了 module: 'terminal')—— 模块还没挂上 / 不是 ok 时,
 * 模块门统一回 module_starting / module_degraded,处理器里不再写「没接线」的分支。
 *
 * 只做转交:压 / 撤 / 措辞全在 core/cli-events.ts 的 hub 里。body 已由 internal-api 按 schema.ts 的
 * CliEventRequest 校验过。
 *
 * 分级 trusted:`wechat-cc hook` 子命令读的是 internal-api-info.json 指向的 FILE
 * token(= trusted),与 `wechat-cc agent` 同源;admin 会让每一条 hook 都 403。
 */
import type { RouteHandler, RouteTable } from '../../daemon/internal-api/types'
import type { CliEvent, CliEventAction } from '../../app/cli-events'
import type { CliPermissionRelay, CliPermissionRequest } from '../../app/cli-permission-relay'
import type { CliSessionView } from '../../ports/cli-session'
import type { OverseerToday } from '../../domain/overseer-today'
import { workbenchErrorHttp } from '@wechat-cc/protocol'
import { TERMINAL_SAY_POLL_CAP_MS, type TerminalSay } from './terminal-say'
import type { TerminalHooksService } from './hooks'

/** 这几条路由要的(以前是 InternalApiDeps 的 cliEvents / cliPermissions / terminalSay / cliHooks / overseerToday)。 */
export interface TerminalRoutesDeps {
  /** 终端 claude / codex 会话的 hook 事件入口 + 登记处(v76)。 */
  cliEvents: {
    ingest(ev: CliEvent): CliEventAction | Promise<CliEventAction>
    /** 终端会话登记处:GET /v1/cli/sessions。 */
    list(opts?: { includeEnded?: boolean; limit?: number }): CliSessionView[]
    /**
     * GET /v1/cli/sessions?detail=1(CC 的 terminal_sessions,2026-10-24):每条补上开没开着窗口、此刻在做哪一步。
     * 要读记录尾巴,所以只在带 detail 时算;桌面「此刻」不带。缺席 ⇒ 不补。
     */
    detail?(sessionIds: string[]): Record<string, { live_window: boolean; now_step: string | null }>
  }
  /** 终端会话权限 → 微信 y/n(§6.3)。 */
  cliPermissions: Pick<CliPermissionRelay, 'open' | 'status' | 'wait'>
  /** CC 代主人对终端会话说一句、等它回话(terminal_say,2026-10-24);只给主人自己那条聊天的 admin 会话(isOwnerChat)。 */
  terminalSay: Pick<TerminalSay, 'say' | 'wait' | 'claim'> & { isOwnerChat(chatId: string): boolean }
  /** 接上 / 撤掉终端里的 Claude Code / Codex(2026-10-14)。只在主人点了确认时调,绝不自动装。 */
  cliHooks: Pick<TerminalHooksService, 'install' | 'uninstall'>
  /** 「今天」一眼看完(core/overseer-today.ts,2026-10-14):终端 + 一起做,过去 24 小时。只读,只在被问时算。 */
  overseerToday: () => OverseerToday
}

/** GET /v1/cli/sessions 默认给多少条。 */
export const CLI_SESSIONS_DEFAULT_LIMIT = 100

/** 一次 GET 最多等这么久再回;hook 那头自己循环。 */
export const CLI_PERMISSION_POLL_CAP_MS = 25_000

export function terminalRoutes(deps: TerminalRoutesDeps): RouteTable {
  const ownerSession = (caller: Parameters<RouteHandler>[2]): boolean =>
    caller?.origin === 'session' && caller.tier === 'admin' && !!caller.chatId && deps.terminalSay.isOwnerChat(caller.chatId)
  const sayError = (code: string) => { const h = workbenchErrorHttp(code, 'desktop'); return { status: h.status, body: { ok: false, error: h.error } } }
  return {
    'POST /v1/cli/event': async (_q, body) => {
      const action = await deps.cliEvents.ingest(body as CliEvent)
      return { status: 200, body: { ok: true, action } }
    },
    // 权限中继(§6.3):PermissionRequest hook 先 POST 登记(主人在场就直接回
    // owner_present,终端自己问),再 GET 轮询到 y/n 或过期。
    'POST /v1/cli/permission': async (_q, body) => {
      return { status: 200, body: await deps.cliPermissions.open(body as CliPermissionRequest) }
    },
    'GET /v1/cli/permission': async (q) => {
      const hash = q.get('hash') ?? ''
      const waitRaw = Number(q.get('wait_ms') ?? '0')
      const waitMs = Math.max(0, Math.min(Number.isFinite(waitRaw) ? waitRaw : 0, CLI_PERMISSION_POLL_CAP_MS))
      const status = waitMs > 0 ? await deps.cliPermissions.wait(hash, waitMs) : deps.cliPermissions.status(hash)
      return { status: 200, body: { hash, status } }
    },
    // 终端会话登记处(v76):主人在 CC 外面开的 claude / codex 会话,等你批准的在前,其余按最近事件
    // 倒序;running / waiting 超过 30 分钟没事件读成 idle(stale=true)。admin 档,operator 凭据。
    'GET /v1/cli/sessions': async (q) => {
      const limitRaw = Number(q.get('limit') ?? CLI_SESSIONS_DEFAULT_LIMIT)
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.trunc(limitRaw), 500)) : CLI_SESSIONS_DEFAULT_LIMIT
      const sessions = deps.cliEvents.list({ includeEnded: q.get('ended') === '1', limit })
      if (q.get('detail') !== '1' || !deps.cliEvents.detail) return { status: 200, body: { ok: true, sessions } }
      // detail=1(CC 的 terminal_sessions):补开没开着窗口、此刻在做哪一步。读不出来就不补,列表照回。
      let extra: Record<string, { live_window: boolean; now_step: string | null }> = {}
      try { extra = deps.cliEvents.detail(sessions.map(s => s.session_id)) } catch { extra = {} }
      return { status: 200, body: { ok: true, sessions: sessions.map(s => extra[s.session_id] ? { ...s, ...extra[s.session_id] } : s) } }
    },
    // CC 代主人对终端会话说一句(terminal_say,2026-10-24):送话走「@码」同一个 core,回一张票;GET 带票等回话。
    // 档位 admin(路由表),再加一道:只认主人自己那条聊天的会话令牌 —— admin 档的别的聊天、file / operator 令牌都不行。
    'POST /v1/cli/say': async (_q, body, caller) => {
      if (!ownerSession(caller)) return sayError('terminal_say_not_owner')
      const { code, text } = body as { code: string; text: string }
      const r = deps.terminalSay.say(code.toLowerCase(), text)
      if (!r.ok) return { status: sayError(r.error).status, body: r }
      return { status: 200, body: r }
    },
    'GET /v1/cli/say': async (q, _body, caller, ctx) => {
      if (!ownerSession(caller)) return sayError('terminal_say_not_owner')
      const waitRaw = Number(q.get('wait_ms') ?? '0')
      const waitMs = Math.max(0, Math.min(Number.isFinite(waitRaw) ? waitRaw : 0, TERMINAL_SAY_POLL_CAP_MS))
      // 请求断开(MCP 子进程死了)⇒ 立刻不算在等:这次轮询带不回去,Stop 要照常推、终局要告诉主人(评审 #662-2a)
      const ticket = q.get('ticket') ?? ''
      const v = await deps.terminalSay.wait(ticket, waitMs, ctx?.signal)
      if (!v) return sayError('terminal_say_ticket_unknown')
      // 终局只在回包真写出去之后才算被领走(写不出去 ⇒ terminal_say 自己兜底告诉主人,评审 #662 二轮 #1)
      if (v.final) ctx?.onSent(() => deps.terminalSay.claim(ticket))
      return { status: 200, body: { ok: true, ...v } }
    },
    // 接上 / 撤掉终端里的 Claude Code / Codex(2026-10-14)。主人在桌面上点了确认才会来;body 已按
    // CliHooksRequest 校验过。回每一家的结果 + 新的状态(桌面据此刷新「CC 现在怎么样」)。
    'POST /v1/cli/hooks/install': async (_q, body) => {
      const sources = (body as { sources?: Array<'claude' | 'codex' | 'cursor'> } | undefined)?.sources
      return { status: 200, body: deps.cliHooks.install(sources) }
    },
    'POST /v1/cli/hooks/uninstall': async (_q, body) => {
      const sources = (body as { sources?: Array<'claude' | 'codex' | 'cursor'> } | undefined)?.sources
      return { status: 200, body: deps.cliHooks.uninstall(sources) }
    },
    // 「今天」一眼看完(2026-10-14):终端 + 一起做,过去 24 小时;等你 / 做完 / 在跑 / 可能卡住。
    // 结构化数据,微信那段纯文本由调用方(CC 的 today_digest 工具)用 formatOverseerToday 排。admin 档。
    'GET /v1/overseer/today': async () => {
      try { return { status: 200, body: { ok: true, today: deps.overseerToday() } } }
      catch { return { status: 503, body: { error: 'unavailable' } } }
    },
  }
}
