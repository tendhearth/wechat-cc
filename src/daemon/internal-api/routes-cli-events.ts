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
  }
}
