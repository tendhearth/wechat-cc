import { openPush, PushKind, PushPlaintext, type PushKindT, type PushPlaintextT, type SealedPush } from '@wechat-cc/protocol'

// 点通知的目标(spec §7「点通知」)。来源不可信:安卓深链谁都能发,iOS 的 userInfo 来自扩展或(没解开时)中继转来的密文。
// 形状不对的字段一律丢:taskId 丢了就回此刻,requestId 丢了批准页自己出选择列表。

export type PushTarget = { kind: PushKindT; taskId?: string; requestId?: string }

const TASK = /^[a-f0-9]{8}$/
const REQ = /^[A-Za-z0-9_.:-]{1,128}$/
const obj = (x: unknown): Record<string, unknown> | null => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null)
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export function cleanTarget(raw: unknown): PushTarget | null {
  const o = obj(raw)
  if (!o) return null
  const kind = PushKind.safeParse(o.kind)
  if (!kind.success) return null
  const out: PushTarget = { kind: kind.data }
  if (typeof o.taskId === 'string' && TASK.test(o.taskId)) out.taskId = o.taskId
  if (typeof o.requestId === 'string' && REQ.test(o.requestId)) out.requestId = o.requestId
  return out
}

export function targetFromParams(p: Record<string, string | string[] | undefined>): PushTarget | null {
  return cleanTarget({ kind: one(p.kind), taskId: one(p.taskId), requestId: one(p.requestId) })
}

export function targetFromPlaintext(p: PushPlaintextT): PushTarget | null {
  return cleanTarget({ kind: p.kind, taskId: p.taskId, requestId: p.requestId })
}

/**
 * expo-notifications 的通知对象 → 目标。先找扩展写好的 `tendhearth` 路由(content.data 或 trigger.payload);
 * 扩展没解开(锁屏后首次解锁前、超时)⇒ 用兜底密钥在 app 里解 `wcc`,时间用通知送达时刻(点开时可能已过 1 小时)。
 */
export function targetFromNotification(n: unknown, fallback?: { key: Uint8Array; now: number }): PushTarget | null {
  const req = obj(obj(n)?.request)
  const sources = [obj(obj(req?.content)?.data), obj(obj(req?.trigger)?.payload)]
  for (const s of sources) {
    if (s?.tendhearth !== undefined) return cleanTarget(s.tendhearth)
  }
  if (!fallback) return null
  for (const s of sources) {
    let w = s?.wcc
    if (w === undefined) continue
    if (typeof w === 'string') { try { w = JSON.parse(w) } catch { continue } }
    try {
      const p = PushPlaintext.safeParse(openPush(fallback.key, w as SealedPush, fallback.now))
      if (p.success) return targetFromPlaintext(p.data)
    } catch { /* 错钥 / 篡改 / 过期:当没目标 */ }
  }
  return null
}
