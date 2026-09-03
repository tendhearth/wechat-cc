/**
 * routes-hunt.ts — 打猎战利品的读写面(2026-09-03)。
 *
 * 用户反馈:「虽然你的 cc 有自动打猎的功能,但是桌面端没有记录」。打猎
 * 每天在发,发完只剩微信聊天记录。这三个路由是桌面端「战利品」区块的
 * 后端,读 v36 `hunt_catch`。
 *
 * 分级 trusted:桌面端拿到的是 daemon 级 FILE token(= trusted,`daemon
 * api-info`),admin 会让每一次真实的桌面读 403 —— 觅食台的读路由 2026-07-22
 * 正是这么静默坏了一个多月。
 */
import { CATCH_STATUSES, type CatchStatus } from '../../core/hunt-store'
import type { InternalApiDeps, RouteTable } from './types'

export function huntRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/hunt': async (q) => {
      if (!deps.hunt) return { status: 503, body: { error: 'hunt_not_wired' } }
      const raw = Number(q.get('limit'))
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 500) : 200
      return { status: 200, body: { items: deps.hunt.list(limit) } }
    },

    'POST /v1/hunt/status': async (_q, body) => {
      if (!deps.hunt) return { status: 503, body: { error: 'hunt_not_wired' } }
      const { id, status } = (body ?? {}) as { id?: unknown; status?: unknown }
      if (typeof id !== 'string' || id === '') return { status: 400, body: { error: 'missing_id' } }
      if (typeof status !== 'string' || !CATCH_STATUSES.includes(status as CatchStatus)) {
        return { status: 400, body: { error: 'bad_status', allowed: CATCH_STATUSES } }
      }
      // 找不到 → ok:false 而不是 200 静默成功:界面才能说「这条已经没了」
      // 而不是显示一个改不动的状态。
      return { status: 200, body: { ok: deps.hunt.setStatus(id, status as CatchStatus) } }
    },

    'POST /v1/hunt/remove': async (_q, body) => {
      if (!deps.hunt) return { status: 503, body: { error: 'hunt_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id === '') return { status: 400, body: { error: 'missing_id' } }
      return { status: 200, body: { ok: deps.hunt.remove(id) } }
    },
  }
}
