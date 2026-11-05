/**
 * phone-routes.ts — 手机「CC 记得你」两条(2026-09-25 / 2026-10-06;P3d-3 从 `features/phone/settings-panel.ts` 搬回记忆这个功能):
 * 读整理好的那份(`GET /v1/memory/curated`)、逐条纠错(`POST /v1/memory/correct`)。表经 index.ts 导出,组装的地方
 * (`wiring/wire-settings-panel.ts`)交给面板的 `featureRoutes` —— 面板不 import 别的功能。
 *
 * 键是手机独有的 `/v1` 行(只有 phone 块,处理器在面板这一口);老 App 的 `/m/api/memory`、`/m/api/memory/correct` 是
 * legacy-routes.ts 的纯改名别名。回包照搬之前在面板里的样子:不带 cache-control(面板的 json()),错误码一字不变。
 */
import { ownsMethod, type PhoneRouteTable } from '../../lib/phone-route-table'
import type { CuratedView, MemoryVerdict } from './nightly-runtime'

export interface MemoryPhoneRoutesDeps {
  /** 整理好的那份(memory/nightly-runtime 的 curatedView)。没接 ⇒ 503。 */
  curated?: () => CuratedView
  /** 主人逐条纠错:不对 / 过时 / 删掉。没接 ⇒ 503。 */
  correct?: (id: string, verdict: MemoryVerdict) => Promise<{ text: string }>
}

/** 面板的 json():不带 cache-control(搬之前就是这样)。 */
const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

export function memoryPhoneRoutes(deps: MemoryPhoneRoutesDeps): PhoneRouteTable {
  return {
    'GET /v1/memory/curated': async () => {
      if (!deps.curated) return json({ ok: false, error: 'memory_not_wired' }, 503)
      // 经隧道时 handleRequest 抛出不会回包,手机会一直等 —— 这里兜住,让页面走「暂时读不到」。
      try { return json({ ok: true, ...deps.curated() }) } catch { return json({ ok: false, error: 'unavailable' }, 500) }
    },
    // 「CC 记得你」逐条纠错(步骤 A,2026-10-06):正文恰好 id + verdict;id 是 memory.md 每条尾注里的那串 hex。
    'POST /v1/memory/correct': ownsMethod(async (_url: URL, req: Request) => {
      if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
      if (!deps.correct) return json({ ok: false, error: 'memory_not_wired' }, 503)
      let b: unknown
      try { b = await req.json() } catch { return json({ ok: false, error: 'invalid' }, 400) }
      const o = b as { id?: unknown; verdict?: unknown } | null
      if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(k => k !== 'id' && k !== 'verdict')
        || typeof o.id !== 'string' || !/^[a-f0-9]{2,32}$/.test(o.id) || (o.verdict !== 'wrong' && o.verdict !== 'outdated' && o.verdict !== 'delete')) return json({ ok: false, error: 'invalid' }, 400)
      try { await deps.correct(o.id, o.verdict); return json({ ok: true }) } catch (e) {
        const m = e instanceof Error ? e.message : ''
        return m === 'memory_entry_not_found' || m === 'memory_not_found' ? json({ ok: false, error: 'not_found' }, 404) : json({ ok: false, error: 'unavailable' }, 500)
      }
    }),
  }
}
