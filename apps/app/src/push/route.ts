import { BackendError } from '../backend/types'
import type { PushTarget } from './target'

export type PushRoute =
  | { kind: 'home' }
  | { kind: 'gone' }
  | { kind: 'approval'; id: string; request?: string }
  | { kind: 'matter'; id: string }

/**
 * 旧通知(spec §3):先按 taskId 拉一次最新详情。事情不在 ⇒ gone;拉不到(离线 / 超时)⇒ 照样去目标页,
 * 那页自己显示离线提示。批准页与进展页打开时还会再拉新(refreshOnMount),请求已处理 ⇒ 批准页显示「已处理」。
 */
export async function resolvePushRoute(t: PushTarget | null, fetchDetail: (id: string) => Promise<unknown>, timeoutMs = 5000): Promise<PushRoute> {
  if (!t || !t.taskId) return { kind: 'home' }
  const id = t.taskId
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      fetchDetail(id),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new BackendError('timeout')), timeoutMs) }),
    ])
  } catch (e) {
    if (e instanceof BackendError && e.code === 'not_found') return { kind: 'gone' }
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (t.kind === 'permission' || t.kind === 'question') return { kind: 'approval', id, ...(t.requestId ? { request: t.requestId } : {}) }
  return { kind: 'matter', id }
}

export function hrefFor(r: PushRoute): string {
  if (r.kind === 'approval') return `/approval/${encodeURIComponent(r.id)}${r.request ? `?request=${encodeURIComponent(r.request)}` : ''}`
  if (r.kind === 'matter') return `/matter/${encodeURIComponent(r.id)}`
  return '/'
}

export function pushOpenHref(t: PushTarget): string {
  const q = new URLSearchParams({ kind: t.kind })
  if (t.taskId) q.set('taskId', t.taskId)
  if (t.requestId) q.set('requestId', t.requestId)
  return `/push-open?${q.toString()}`
}
