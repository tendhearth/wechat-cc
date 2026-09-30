/**
 * APNs 发送(spec §5):token-based(.p8,ES256 JWT),alert 推送 + mutable-content,加密块放 `wcc`,
 * 手机通知扩展本地解开后换成真正的标题正文。Cloudflare 边缘替 Worker 跟 Apple 说 HTTP/2(生产可用;
 * 本地 workerd 连不了,workerd#4841 —— 所以测试一律注入假 fetch)。
 */
import type { SealedPush } from '@wechat-cc/protocol'

export type PushOutcome = { ok: true; code: 'ok' } | { ok: false; code: string; invalid: boolean }

const b64u = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64uText = (s: string) => b64u(new TextEncoder().encode(s))

export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const jwtCache = new Map<string, { jwt: string; iat: number }>()
const JWT_TTL_S = 50 * 60   // Apple:20–60 分钟内复用同一枚

async function apnsJwt(keyP8: string, keyId: string, teamId: string, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000)
  const hit = jwtCache.get(keyId)
  if (hit && iat - hit.iat < JWT_TTL_S) return hit.jwt
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(keyP8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const signingInput = `${b64uText(JSON.stringify({ alg: 'ES256', kid: keyId }))}.${b64uText(JSON.stringify({ iss: teamId, iat }))}`
  // Web Crypto 的 ECDSA 签名本来就是 JWS 要的 r||s(IEEE P1363)格式,不用转 DER。
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput)))
  const jwt = `${signingInput}.${b64u(sig)}`
  jwtCache.set(keyId, { jwt, iat })
  return jwt
}

/** apns-collapse-id 最长 64 字节:按字符截到 UTF-8 ≤ 64。 */
function truncUtf8(str: string, max: number): string {
  const enc = new TextEncoder()
  let out = ''
  let n = 0
  for (const ch of str) {
    const l = enc.encode(ch).length
    if (n + l > max) break
    out += ch; n += l
  }
  return out
}

const INVALID_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'])

export async function sendApns(o: {
  keyP8: string; keyId: string; teamId: string; topic: string; host: string
  token: string; sealed: SealedPush; collapseId?: string; now: number; fetch: typeof fetch
}): Promise<PushOutcome> {
  let res: Response
  try {
    const jwt = await apnsJwt(o.keyP8, o.keyId, o.teamId, o.now)
    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      'apns-topic': o.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(o.now / 1000) + 3600),
      'content-type': 'application/json',
    }
    if (o.collapseId) headers['apns-collapse-id'] = truncUtf8(o.collapseId.replace(/[^\x20-\x7e]/g, '_'), 64)   // 头值必须是 ASCII
    const body = JSON.stringify({ aps: { alert: { title: 'CC', body: 'CC 有新动态' }, 'mutable-content': 1, sound: 'default' }, wcc: o.sealed })
    res = await o.fetch(`${o.host}/3/device/${o.token}`, { method: 'POST', headers, body })
  } catch {
    return { ok: false, code: 'network', invalid: false }
  }
  if (res.status === 200) return { ok: true, code: 'ok' }
  if (res.status === 403) jwtCache.delete(o.keyId)   // 令牌被拒:别再复用缓存的 JWT
  let reason = `http_${res.status}`
  try { const j = await res.json() as { reason?: unknown }; if (typeof j.reason === 'string') reason = j.reason } catch { /* 没体 */ }
  return { ok: false, code: reason, invalid: res.status === 410 || (res.status === 400 && INVALID_REASONS.has(reason)) }
}
