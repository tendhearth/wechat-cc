/**
 * spec §6「按 IP 限制连接尝试」的落点:Workers Rate Limiting 绑定 `IP_LIMIT`,按 `CF-Connecting-IP`
 * 计数(wrangler.toml:60 次 / 10 秒),只管 `/v2/`。区域 tendhearth.com 是 Free 计划,WAF 限速规则只有
 * 一条、已给更新源 dl.tendhearth.com 用掉,所以放进 Worker 里做(docs/maintainer/relay.md §3)。
 *
 * - 没绑(本地 / 测试)或拿不到客户端 IP ⇒ 不限;绑定自己出错 ⇒ 放行(限速挂了不能把中继也拖垮)。
 * - **不记 IP、不记 `?id=`**(spec §7):只打一个不带任何标识的计数。
 * - 计数按 Cloudflare 机房本地、最终一致,不是精确账本 —— 挡扫 id / 狂开连接足够了。
 */
import { count } from './metrics'

/** 与 wrangler.toml 里 `simple.period` 一致:超限后最多再等一个窗口。 */
export const IP_LIMIT_RETRY_AFTER_S = 10

export async function ipLimited(req: Request, env: Env): Promise<Response | null> {
  const lim = env.IP_LIMIT
  const ip = req.headers.get('cf-connecting-ip')
  if (!lim || !ip) return null
  let ok: boolean
  try { ok = (await lim.limit({ key: ip })).success } catch { return null }
  if (ok) return null
  count(env, 'ip_rate_limited')
  return Response.json({ error: 'rate_limited' }, {
    status: 429,
    headers: { 'retry-after': String(IP_LIMIT_RETRY_AFTER_S), 'cache-control': 'no-store' },
  })
}
