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

export function cliEventRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/cli/event': async (_q, body) => {
      if (!deps.cliEvents) return { status: 503, body: { error: 'cli_events_not_wired' } }
      const action = deps.cliEvents.ingest(body as CliEvent)
      return { status: 200, body: { ok: true, action } }
    },
  }
}
