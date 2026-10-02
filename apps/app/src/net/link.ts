import { RELAY_ID_RE } from '@wechat-cc/protocol'

export type ParsedLink = { daemonId: string; linkToken: string; relayHost: string; relayUrl: string; lan: string | null }
export type LinkError = 'not_a_link' | 'remote_off' | 'bad_link'

const LEGACY_ID_RE = /^t[0-9a-f]{36}$/          // remote-relay-config.ts:'t' + 18 字节 hex
const LINK_TOKEN_RE = /^t[0-9a-f]{32}$/         // settings-panel.ts issueToken:'t' + 16 字节 hex
const PSET_RE = /^https:\/\/([a-z0-9.-]+(?::\d{1,5})?)\/pset\/?#(.*)$/i
const LAN_ONLY_RE = /^http:\/\/[^/\s]+\/set\?(?:.*&)?t=/i

/**
 * 解析桌面「连接手机」二维码里的链接(settings-panel.ts linkUrl() 的两种形状)。
 * 不用 URL 类:RN 的 URL 实现不全(hash / searchParams 在部分版本上直接抛)。
 * 中继规则与 selftest-phone.ts classifyLink 相同:r… ⇒ /v2/phone,t… ⇒ /tunnel/phone。
 * lan= 只记下,v1 不用(计划裁决 1)。
 */
export function parsePairLink(raw: string): { ok: true; link: ParsedLink } | { ok: false; error: LinkError } {
  const s = raw.trim()
  if (LAN_ONLY_RE.test(s)) return { ok: false, error: 'remote_off' }
  const m = PSET_RE.exec(s)
  if (!m) return { ok: false, error: 'not_a_link' }
  const host = m[1]!.toLowerCase()
  const params = new Map<string, string>()
  for (const part of m[2]!.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = eq < 0 ? part : part.slice(0, eq)
    const v = eq < 0 ? '' : part.slice(eq + 1)
    try { params.set(decodeURIComponent(k), decodeURIComponent(v)) } catch { return { ok: false, error: 'bad_link' } }
  }
  const id = params.get('id') ?? ''
  const token = params.get('t') ?? ''
  const path = RELAY_ID_RE.test(id) ? '/v2/phone' : LEGACY_ID_RE.test(id) ? '/tunnel/phone' : null
  if (!path || !LINK_TOKEN_RE.test(token)) return { ok: false, error: 'bad_link' }
  return { ok: true, link: {
    daemonId: id, linkToken: token, relayHost: host,
    relayUrl: `wss://${host}${path}?id=${encodeURIComponent(id)}`,
    lan: params.get('lan') || null,
  } }
}
