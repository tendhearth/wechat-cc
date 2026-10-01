import { PHONE_API_SCHEMAS, type ProtocolClient } from '@wechat-cc/protocol'
import type { ParsedLink } from './link'
import { transportErrorCode } from './errors'

export type PairingRecord = { v: 1; daemonId: string; relayHost: string; relayUrl: string; deviceToken: string; deviceId: string; pairedAt: number }
export type PairErrorCode = 'expired' | 'device_limit' | 'offline' | 'too_old' | 'unknown'
export class PairError extends Error {
  constructor(public code: PairErrorCode) { super(code) }
}

/** phase:链接令牌阶段的 auth_failed = 码过期 / 已被电脑换新,绝不是「已撤销」;设备令牌阶段刚发的令牌被拒属于异常 ⇒ unknown。 */
function asPairError(e: unknown, phase: 'link' | 'device'): PairError {
  if (e instanceof PairError) return e
  // 只有协议客户端的传输错误(snake_case 错误码)才走 transportErrorCode;SyntaxError 等其它异常 ⇒ unknown
  if (!(e instanceof Error) || !/^[a-z][a-z_]*$/.test(e.message)) return new PairError('unknown')
  const c = transportErrorCode(e)
  if (c === 'revoked') return new PairError(phase === 'link' ? 'expired' : 'unknown')
  if (c === 'offline' || c === 'timeout') return new PairError('offline')
  return new PairError('unknown')
}
const JSON_HEADERS = { 'content-type': 'application/json' }

/**
 * spec §6:链接令牌(10 分钟内有效;电脑发了新码,旧码即作废)建连 ⇒ POST /set/api/pair 拿长期设备令牌 ⇒ 换设备令牌重连,
 * 确认协商出 v2(订阅要 v2)并拿到本机设备 id ⇒ 给本机起名(失败不要紧)。两条连接用完都关。
 * 不存任何东西 —— 存钥匙串是调用方(会话)的事,失败的配对不留痕。
 */
export async function pairWithLink(
  link: ParsedLink,
  deps: { connect(url: string, token: string): ProtocolClient; label: string; now?: () => number },
): Promise<PairingRecord> {
  const now = deps.now ?? (() => Date.now())
  let deviceToken: string
  const linkClient = deps.connect(link.relayUrl, link.linkToken)
  try {
    const res = await linkClient.request({ method: 'POST', path: '/set/api/pair', body: '{}', headers: JSON_HEADERS })
    if (res.status === 401) throw new PairError('expired')
    const p = PHONE_API_SCHEMAS['POST /set/api/pair']!.safeParse(res.json())
    if (!p.success) throw new PairError('unknown')
    const data = p.data as { ok: true; device_token: string } | { ok: false; error: 'device_limit' | 'link_only' }
    // link_only(plan 7a D1)只在拿设备令牌来配时出现 —— 这里用的是链接令牌,真碰到就是没想到的情况。
    if (!data.ok) throw new PairError(data.error === 'device_limit' ? 'device_limit' : 'unknown')
    deviceToken = data.device_token
  } catch (e) {
    throw asPairError(e, 'link')
  } finally {
    linkClient.close()
  }

  const dev = deps.connect(link.relayUrl, deviceToken)
  try {
    const res = await dev.request({ method: 'GET', path: '/set/api/state' })
    if (dev.version() !== 2) throw new PairError('too_old')
    const s = PHONE_API_SCHEMAS['GET /set/api/state']!.safeParse(res.json())
    if (!s.success) throw new PairError('unknown')
    const state = s.data as { ok: boolean; remote?: { devices: Array<{ id: string; current: boolean }> } }
    const me = state.ok ? state.remote?.devices.find(x => x.current) : undefined
    if (!me) throw new PairError('unknown')
    try {
      await dev.request({ method: 'POST', path: '/set/api/apply', body: JSON.stringify({ op: 'label_device', id: me.id, label: deps.label }), headers: JSON_HEADERS })
    } catch { /* 名字只是锦上添花 */ }
    return { v: 1, daemonId: link.daemonId, relayHost: link.relayHost, relayUrl: link.relayUrl, deviceToken, deviceId: me.id, pairedAt: now() }
  } catch (e) {
    // 设备令牌已发出却没配成 —— 尽力把这个设备位还给电脑(否则白占一个设备位);失败吞掉,不记令牌
    try {
      await dev.request({ method: 'POST', path: '/set/api/apply', body: JSON.stringify({ op: 'unpair_self' }), headers: JSON_HEADERS })
    } catch { /* best-effort */ }
    throw asPairError(e, 'device')
  } finally {
    dev.close()
  }
}

/**
 * 重新配对后退掉旧设备位(spec §8、D5):用**旧令牌**连旧电脑(旧记录里的中继地址,换了电脑也是去旧的那台),
 * POST unpair_self(daemon 只撤调用者自己,并注销那台的推送登记)。证明就是那次加密握手(只有持有旧令牌的人握得上),
 * 令牌从不进正文。没有旧记录 / 同一枚令牌 / 同一台电脑上同一个设备位 ⇒ skipped(绝不去撤新位);
 * 任何失败(旧令牌早已失效、电脑不在线、回 ok:false)⇒ failed —— 只试一次、从不抛,调用方不等它。连接用完即关。
 */
export async function retirePrevious(
  prev: PairingRecord | null,
  next: PairingRecord,
  deps: { connect(url: string, token: string): ProtocolClient },
): Promise<'retired' | 'skipped' | 'failed'> {
  if (!prev || prev.deviceToken === next.deviceToken) return 'skipped'
  if (prev.daemonId === next.daemonId && prev.deviceId === next.deviceId) return 'skipped'
  let old: ProtocolClient | null = null
  try {
    old = deps.connect(prev.relayUrl, prev.deviceToken)
    const res = await old.request({ method: 'POST', path: '/set/api/apply', body: JSON.stringify({ op: 'unpair_self' }), headers: JSON_HEADERS })
    const body = res.status === 200 ? (res.json() as { ok?: unknown } | null) : null
    return body !== null && typeof body === 'object' && body.ok === true ? 'retired' : 'failed'
  } catch {
    return 'failed'
  } finally {
    try { old?.close() } catch { /* 关不掉也不要紧 */ }
  }
}
