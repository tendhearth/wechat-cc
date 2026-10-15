/**
 * routes-cli-events.ts — 终端 claude / codex 会话经 hooks 报进来的事件
 * (spec 2026-09-09-cli-hook-push-design §6.1)。
 *
 * 只做转交:压 / 撤 / 措辞全在 core/cli-events.ts 的 hub 里。body 已由 index.ts
 * 按 schema.ts 的 CliEventRequest 校验过。
 *
 * 分级 trusted:`wechat-cc hook` 子命令读的是 internal-api-info.json 指向的 FILE
 * token(= trusted),与 `wechat-cc agent` 同源;admin 会让每一条 hook 都 403。
 */
import type { InternalApiDeps, RouteTable } from './types'
import type { CliEvent } from '../../core/cli-events'
import type { CliPermissionRequest } from '../../core/cli-permission-relay'

/** GET /v1/cli/sessions 默认给多少条。 */
export const CLI_SESSIONS_DEFAULT_LIMIT = 100

/** 一次 GET 最多等这么久再回;hook 那头自己循环。 */
export const CLI_PERMISSION_POLL_CAP_MS = 25_000

export function cliEventRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/cli/event': async (_q, body) => {
      if (!deps.cliEvents) return { status: 503, body: { error: 'cli_events_not_wired' } }
      const action = await deps.cliEvents.ingest(body as CliEvent)
      return { status: 200, body: { ok: true, action } }
    },
    // 权限中继(§6.3):PermissionRequest hook 先 POST 登记(主人在场就直接回
    // owner_present,终端自己问),再 GET 轮询到 y/n 或过期。
    'POST /v1/cli/permission': async (_q, body) => {
      if (!deps.cliPermissions) return { status: 503, body: { error: 'cli_permissions_not_wired' } }
      return { status: 200, body: await deps.cliPermissions.open(body as CliPermissionRequest) }
    },
    'GET /v1/cli/permission': async (q) => {
      if (!deps.cliPermissions) return { status: 503, body: { error: 'cli_permissions_not_wired' } }
      const hash = q.get('hash') ?? ''
      const waitRaw = Number(q.get('wait_ms') ?? '0')
      const waitMs = Math.max(0, Math.min(Number.isFinite(waitRaw) ? waitRaw : 0, CLI_PERMISSION_POLL_CAP_MS))
      const status = waitMs > 0 ? await deps.cliPermissions.wait(hash, waitMs) : deps.cliPermissions.status(hash)
      return { status: 200, body: { hash, status } }
    },
    // 终端会话登记处(v76):主人在 CC 外面开的 claude / codex 会话,等你批准的在前,其余按最近事件
    // 倒序;running / waiting 超过 30 分钟没事件读成 idle(stale=true)。admin 档,operator 凭据。
    'GET /v1/cli/sessions': async (q) => {
      if (!deps.cliEvents?.list) return { status: 503, body: { error: 'cli_sessions_not_wired' } }
      const limitRaw = Number(q.get('limit') ?? CLI_SESSIONS_DEFAULT_LIMIT)
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.trunc(limitRaw), 500)) : CLI_SESSIONS_DEFAULT_LIMIT
      const sessions = deps.cliEvents.list({ includeEnded: q.get('ended') === '1', limit })
      return { status: 200, body: { ok: true, sessions } }
    },
    // 接上 / 撤掉终端里的 Claude Code / Codex(2026-10-14)。主人在桌面上点了确认才会来;body 已按
    // CliHooksRequest 校验过。回每一家的结果 + 新的状态(桌面据此刷新「CC 现在怎么样」)。
    'POST /v1/cli/hooks/install': async (_q, body) => {
      if (!deps.cliHooks) return { status: 503, body: { error: 'cli_hooks_not_wired' } }
      const sources = (body as { sources?: Array<'claude' | 'codex'> } | undefined)?.sources
      return { status: 200, body: deps.cliHooks.install(sources) }
    },
    'POST /v1/cli/hooks/uninstall': async (_q, body) => {
      if (!deps.cliHooks) return { status: 503, body: { error: 'cli_hooks_not_wired' } }
      const sources = (body as { sources?: Array<'claude' | 'codex'> } | undefined)?.sources
      return { status: 200, body: deps.cliHooks.uninstall(sources) }
    },
    // 「今天」一眼看完(2026-10-14):终端 + 一起做,过去 24 小时;等你 / 做完 / 在跑 / 可能卡住。
    // 结构化数据,微信那段纯文本由调用方(CC 的 today_digest 工具)用 formatOverseerToday 排。admin 档。
    'GET /v1/overseer/today': async () => {
      if (!deps.overseerToday) return { status: 503, body: { error: 'overseer_today_not_wired' } }
      try { return { status: 200, body: { ok: true, today: deps.overseerToday() } } }
      catch { return { status: 503, body: { error: 'unavailable' } } }
    },
  }
}
