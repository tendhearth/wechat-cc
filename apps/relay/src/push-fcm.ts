/**
 * FCM HTTP v1(spec §5):服务账号 RS256 JWT 换 OAuth access token(缓存到过期前 60 s),
 * 发 data message,加密块放 data.wcc;安卓 app 的消息服务解密后显示。
 */
import type { SealedPush } from '@wechat-cc/protocol'
import { pemToDer, type PushOutcome } from './push-apns'

const b64uText = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64u = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }

class OauthError extends Error {}

const tokenCache = new Map<string, { token: string; exp: number }>()

async function accessToken(sa: { client_email: string; private_key: string }, tokenUrl: string, nowMs: number, f: typeof fetch): Promise<string> {
  const hit = tokenCache.get(sa.client_email)
  if (hit && nowMs < hit.exp) return hit.token
  const iat = Math.floor(nowMs / 1000)
  const claims = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }
  const input = `${b64uText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64uText(JSON.stringify(claims))}`
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input)))
  const res = await f(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${input}.${b64u(sig)}`,
  })
  if (!res.ok) throw new OauthError()
  const j = await res.json() as { access_token: string; expires_in: number }
  tokenCache.set(sa.client_email, { token: j.access_token, exp: nowMs + (j.expires_in - 60) * 1000 })
  return j.access_token
}

export async function sendFcm(o: {
  serviceAccount: string; host: string; tokenUrl: string
  token: string; sealed: SealedPush; collapseId?: string; now: number; fetch: typeof fetch
}): Promise<PushOutcome> {
  let res: Response
  let email = ''
  try {
    const sa = JSON.parse(o.serviceAccount) as { project_id: string; client_email: string; private_key: string }
    email = sa.client_email
    const at = await accessToken(sa, o.tokenUrl, o.now, o.fetch)
    const android: Record<string, string> = { priority: 'HIGH', ttl: '3600s' }
    if (o.collapseId) android.collapse_key = o.collapseId
    res = await o.fetch(`${o.host}/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: o.token, data: { wcc: JSON.stringify(o.sealed) }, android } }),
    })
  } catch (e) {
    if (e instanceof OauthError) return { ok: false, code: 'oauth_failed', invalid: false }
    return { ok: false, code: 'network', invalid: false }
  }
  if (res.ok) return { ok: true, code: 'ok' }
  if (res.status === 401) tokenCache.delete(email)
  let code = `http_${res.status}`
  let unregistered = false
  try {
    const j = await res.json() as { error?: { status?: string; details?: Array<{ errorCode?: string }> } }
    code = j.error?.details?.find(d => d.errorCode)?.errorCode ?? j.error?.status ?? code
    unregistered = !!j.error?.details?.some(d => d.errorCode === 'UNREGISTERED')
  } catch { /* 没体 */ }
  return { ok: false, code, invalid: unregistered }
}
