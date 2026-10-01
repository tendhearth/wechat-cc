import { createHash } from 'node:crypto'
import { b64uDecode, b64uEncode, derivePushKey, PushPlaintext, sealPush, type PushKindT, type SealedPush } from '@wechat-cc/protocol'
import { RELAY_PLACEHOLDER_BODY } from '../src/push/banner'

/** 合成的开发令牌:dev + sha256(seed) 前 48 位 hex。不是任何真设备的令牌(真令牌是 d + 48 位 hex),可以打印。 */
export function devToken(seed: string): string {
  return 'dev' + createHash('sha256').update(seed).digest('hex').slice(0, 48)
}

export type SimMode = 'ok' | 'stale' | 'tamper' | 'wrong-key'

/** 与 apps/relay/src/push-apns.ts 发给 APNs 的载荷同形:占位 alert + mutable-content + wcc 密文。 */
export function buildSimPush(o: { token: string; mode: SimMode; kind: PushKindT; taskId?: string; requestId?: string; body: string; now: number }): {
  aps: { alert: { title: string; body: string }; 'mutable-content': 1; sound: 'default' }
  wcc: SealedPush
} {
  const ts = o.mode === 'stale' ? o.now - 61 * 60_000 : o.now
  const payload = PushPlaintext.parse({ ts, kind: o.kind, title: 'CC', body: o.body, ...(o.taskId ? { taskId: o.taskId } : {}), ...(o.requestId ? { requestId: o.requestId } : {}) })
  const key = derivePushKey(o.mode === 'wrong-key' ? `${o.token}x` : o.token)
  let wcc = sealPush(key, payload)
  if (o.mode === 'tamper') {
    const b = b64uDecode(wcc.ct)
    b[0] = b[0]! ^ 0x01
    wcc = { ...wcc, ct: b64uEncode(b) }
  }
  return { aps: { alert: { title: 'CC', body: RELAY_PLACEHOLDER_BODY }, 'mutable-content': 1, sound: 'default' }, wcc }
}
