/**
 * `/v1/journal*` —— 伙伴日志(背包)的读写面(2026-09-03 起;以前写在 internal-api 的总表里)。
 *
 * 用户反馈:「虽然你的 cc 有自动打猎的功能,但是桌面端没有记录」。打猎
 * 每天在发,发完只剩微信聊天记录。这几个路由是桌面端「战利品」区块的
 * 后端,读 `journal`(v36 建为 hunt_catch,v40 改名);后来串门见闻、明信片、
 * 回忆也进了同一张表,所以这一面归日志,不归打猎。
 *
 * 分级 trusted:桌面端拿到的是 daemon 级 FILE token(= trusted,`daemon
 * api-info`),admin 会让每一次真实的桌面读 403 —— 觅食台的读路由 2026-07-22
 * 正是这么静默坏了一个多月。
 */
import { safeSvg } from '../../lib/svg-sanitize'
import { CATCH_STATUSES, type CatchStatus } from '../../adapters/store/journal-store'
import { readJournalSeen, writeJournalSeen } from '../../adapters/store/journal-seen'
import type { Journal } from '../../adapters/store/journal-store'
import type { RouteTable } from '../../daemon/internal-api/types'

export interface JournalRoutesDeps {
  stateDir: string
  journal: Journal
  /** 「看到哪了」水位存哪。缺省 ⇒ `<stateDir>/companion/journal-seen.json`(生产;测试可换成内存里的一份)。 */
  seen?: { read(): string | null; write(iso: string): void }
  /** 缺省 Date.now(测试钉时钟)。 */
  now?: () => number
}

export function journalRoutes(deps: JournalRoutesDeps): RouteTable {
  const seen = deps.seen ?? { read: () => readJournalSeen(deps.stateDir), write: (iso: string) => writeJournalSeen(deps.stateDir, iso) }
  const now = deps.now ?? Date.now
  return {
    'GET /v1/journal': async (q) => {
      const raw = Number(q.get('limit'))
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 500) : 200
      return { status: 200, body: { items: deps.journal.list(limit) } }
    },

    'GET /v1/journal/postcards': async (q) => {
      const rawLimit = Number(q.get('limit'))
      const rawOffset = Number(q.get('offset'))
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 100) : 24
      const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0
      const result = deps.journal.listPostcards({ limit, offset, favoritesOnly: q.get('favorites') === 'true' })
      return { status: 200, body: { ...result, items: result.items.map(row => ({ ...row, image_svg: row.image_svg ? safeSvg(row.image_svg) : null })) } }
    },

    'POST /v1/journal/favorite': async (_q, body) => {
      const { id, favorite } = (body ?? {}) as { id?: unknown; favorite?: unknown }
      if (typeof id !== 'string' || !id.trim()) return { status: 400, body: { error: 'missing_id' } }
      if (typeof favorite !== 'boolean') return { status: 400, body: { error: 'bad_favorite' } }
      return { status: 200, body: { ok: deps.journal.setFavorite(id, favorite) } }
    },

    'POST /v1/journal/status': async (_q, body) => {
      const { id, status } = (body ?? {}) as { id?: unknown; status?: unknown }
      if (typeof id !== 'string' || id === '') return { status: 400, body: { error: 'missing_id' } }
      if (typeof status !== 'string' || !CATCH_STATUSES.includes(status as CatchStatus)) {
        return { status: 400, body: { error: 'bad_status', allowed: CATCH_STATUSES } }
      }
      // 找不到 → ok:false 而不是 200 静默成功:界面才能说「这条已经没了」
      // 而不是显示一个改不动的状态。
      return { status: 200, body: { ok: deps.journal.setStatus(id, status as CatchStatus) } }
    },

    'POST /v1/journal/remove': async (_q, body) => {
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id === '') return { status: 400, body: { error: 'missing_id' } }
      return { status: 200, body: { ok: deps.journal.remove(id) } }
    },

    // 主人看到哪了(spec 2026-09-03-companion-presence §2.3):觅食台每次打开
    // 推一次;桌宠脚边的包袱在下一次轮询消失。不动 journal.status —— 那是「没试过」。
    // 不带 `until`(桌面)⇒ 推到现在。带 `until`(手机,P3c-3 并进来的原 /m/api/seen)⇒ 夹到 now(不许推到未来)、
    // 只往后推(桌面与手机两边推,谁靠后算谁;没推动就回现在的水位)。
    'POST /v1/journal/seen': async (_q, body) => {
      const until = body && typeof body === 'object' && !Array.isArray(body) ? (body as { until?: unknown }).until : undefined
      if (until === undefined) {
        const seenUntil = new Date(now()).toISOString()
        seen.write(seenUntil)
        return { status: 200, body: { ok: true, seen_until: seenUntil } }
      }
      const ms = typeof until === 'string' ? Date.parse(until) : NaN
      if (!Number.isFinite(ms)) return { status: 400, body: { error: 'invalid_until' } }
      const clamped = new Date(Math.min(ms, now())).toISOString()
      let cur: string | null = null
      try { cur = seen.read() } catch { /* 读不出 ⇒ 当没有水位,同并之前手机那条 */ }
      if (cur !== null && clamped <= cur) return { status: 200, body: { ok: true, seen_until: cur } }
      seen.write(clamped)
      return { status: 200, body: { ok: true, seen_until: clamped } }
    },
  }
}
