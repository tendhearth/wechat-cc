import type { PushPlatformT, SealedPush } from '@wechat-cc/protocol'
import { sendApns, type PushOutcome } from './push-apns'
import { sendFcm } from './push-fcm'

export type { PushOutcome }

export async function sendPush(
  env: Env, reg: { platform: PushPlatformT; token: string }, sealed: SealedPush, collapseId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<PushOutcome> {
  const now = Date.now()
  if (reg.platform === 'fcm') {
    if (!env.FCM_SERVICE_ACCOUNT) return { ok: false, code: 'not_configured', invalid: false }
    return sendFcm({
      serviceAccount: env.FCM_SERVICE_ACCOUNT, host: env.FCM_HOST ?? 'https://fcm.googleapis.com',
      tokenUrl: env.FCM_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
      token: reg.token, sealed, ...(collapseId ? { collapseId } : {}), now, fetch: fetchImpl,
    })
  }
  if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) return { ok: false, code: 'not_configured', invalid: false }
  const host = reg.platform === 'apns_sandbox' ? (env.APNS_SANDBOX_HOST ?? 'https://api.sandbox.push.apple.com') : (env.APNS_HOST ?? 'https://api.push.apple.com')
  return sendApns({
    keyP8: env.APNS_KEY_P8, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC, host,
    token: reg.token, sealed, ...(collapseId ? { collapseId } : {}), now, fetch: fetchImpl,
  })
}
