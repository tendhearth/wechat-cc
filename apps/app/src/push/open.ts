import { setPendingLink, systemPairLink } from '../net/system-link'
import { pushOpenHref } from './route'
import { targetFromParams } from './target'

// 点通知 / 深链的纯逻辑(PushRouter 与 app/+native-intent 用)。不 import react / expo。

type Os = 'ios' | 'android'
const obj = (x: unknown): Record<string, unknown> | null => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null)

/**
 * 系统交给 app 的深链(安卓的点通知、任何别的 app 发的 tendhearth://…)在进路由之前洗一遍(Review Focus 5):
 * push-open ⇒ 用 URLSearchParams 解析(安卓 Kotlin 把空格编成 +),字段过 targetFromParams,重新拼成规范的 /push-open;
 * 洗完没有 taskId(伪造、畸形、解码失败)⇒ 直接回此刻,中转页一个请求都不发。
 * dev-push-key 只在开发构建可达。配对链接 ⇒ 原链接进暂存格、去 /pair?from=link;这个构建不认的 …/pset ⇒ 此刻;
 * 外面来的 /pair ⇒ 去掉查询串的 /pair。其余路径原样放行。
 */
let pairSeq = 0
export function rewriteSystemPath(path: string, dev: boolean, stash: (raw: string) => void = setPendingLink): string {
  // 配对链接(plan 7a):原链接进暂存格(令牌不进路由参数),去配对页;序号让 app 已在配对页时也能重新触发。
  const pair = systemPairLink(path, dev)
  if (pair !== null) { stash(pair); pairSeq += 1; return `/pair?from=link&n=${pairSeq}` }
  const rest = path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/+/, '')
  const q = rest.indexOf('?')
  // 路由比较忽略大小写与结尾斜杠(路由器匹配也宽松,别让 Dev-Push-Key/ 绕过)。
  const route = (q < 0 ? rest : rest.slice(0, q)).split('#')[0]!.replace(/\/+$/, '').toLowerCase()
  if (route === 'dev-push-key') return dev ? path : '/'
  const last = route.slice(route.lastIndexOf('/') + 1)
  // 长得像配对链接、但这个构建不认(发布构建的自定义 scheme / staging、别的主机)⇒ 回此刻:带令牌锚点的原链接不进路由匹配。
  if (last === 'pset') return '/'
  // 外面来的 /pair 深链一律去掉查询串:from=link / n 只能由上面的 /pset 改写带上,别人不能拿它把确认卡换成「没带全」。
  if (last === 'pair') return '/pair'
  if (route !== 'push-open') return path
  const query = q < 0 ? '' : rest.slice(q + 1).split('#')[0]!
  let target
  try {
    const sp = new URLSearchParams(query)
    target = targetFromParams({ kind: sp.get('kind') ?? undefined, taskId: sp.get('taskId') ?? undefined, requestId: sp.get('requestId') ?? undefined })
  } catch {
    return '/'
  }
  return target?.taskId ? pushOpenHref(target) : '/'
}

/** expo-notifications 的 Notification.date:iOS 是秒,安卓是毫秒(Task 7 核对)⇒ 毫秒。 */
export function notificationTimeMs(date: number, os: Os): number {
  if (!Number.isFinite(date)) return 0
  return Math.round(os === 'ios' ? date * 1000 : date)
}

function parts(n: unknown): { id: string; date: number; sources: (Record<string, unknown> | null)[] } {
  const o = obj(n)
  const req = obj(o?.request)
  return {
    id: typeof req?.identifier === 'string' ? req.identifier : '',
    date: typeof o?.date === 'number' ? o.date : Number.NaN,
    sources: [obj(obj(req?.content)?.data), obj(obj(req?.trigger)?.payload)],
  }
}

/** 点击去重键(裁决 C5):identifier + 送达毫秒。collapse-id = taskId,同一件事的新通知 identifier 相同、时刻不同。 */
export function tapKey(n: unknown, os: Os): string {
  const p = parts(n)
  return `${p.id}:${notificationTimeMs(p.date, os)}`
}

/**
 * 前台横幅去重键:有 wcc 密文 ⇒ 按密文(中继重发 / 扩展把重复静默交来的,都是同一份密文;扩展不告诉 app 它是重复);
 * 没有 ⇒ 退回 identifier + 时刻。
 */
export function bannerKey(n: unknown, os: Os): string {
  for (const s of parts(n).sources) {
    let w = s?.wcc
    if (typeof w === 'string') { try { w = JSON.parse(w) } catch { continue } }
    const ct = obj(w)?.ct
    if (typeof ct === 'string' && ct !== '') return `ct:${ct}`
  }
  return `id:${tapKey(n, os)}`
}

/** 本次运行里同一个键只算一次;最多记 cap 个,超出挤掉最早记下的。 */
export function makeSeenOnce(cap = 64): { first(key: string): boolean } {
  const seen = new Set<string>()
  return {
    first(key) {
      if (seen.has(key)) return false
      seen.add(key)
      if (seen.size > cap) seen.delete(seen.values().next().value as string)
      return true
    },
  }
}
