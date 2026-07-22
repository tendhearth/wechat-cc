/**
 * internal-api 笔友信箱 routes(spec 2026-07-22-penpal-mailbox-desktop)。
 * Mirrors routes-social.ts:503 penpal_not_wired until wire-social exposes
 * the correspondent+stores. Reads are the OWNER's local plaintext thread —
 * the ciphertext columns (sealed_ciphertext/nonce/tag) NEVER leave the
 * daemon (投影只挑明文字段,测试断言)。
 */
import type { InternalApiDeps, RouteTable } from './types'

const PREVIEW_LEN = 60

export function penpalRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/penpal/channels': async () => {
      const p = deps.social?.penpal
      if (!p) return { status: 503, body: { error: 'penpal_not_wired' } }
      const unread = new Map(p.letterStore.unreadCountByChannel().map(r => [r.channel_id, r.n]))
      const channels = p.channelStore.list()
        .filter(c => c.status === 'open')
        .map(c => {
          const last = p.letterStore.listForChannel(c.id)[0] ?? null
          const seek = deps.social?.seekStore.get(c.seek_id) ?? null
          const peerLabel = c.peer_agent_id
            ? (deps.a2a?.registry.get(c.peer_agent_id)?.name ?? c.peer_agent_id)
            : `第${c.degree}度笔友`
          return {
            id: c.id,
            title: seek?.topic ?? '',
            peer_label: peerLabel,
            degree: c.degree,
            unread: unread.get(c.id) ?? 0,
            last_preview: last ? last.plaintext.slice(0, PREVIEW_LEN) : null,
            last_at: last ? last.created_at : null,
          }
        })
      return { status: 200, body: { channels } }
    },
    'GET /v1/penpal/letters': async (q) => {
      const p = deps.social?.penpal
      if (!p) return { status: 503, body: { error: 'penpal_not_wired' } }
      const channelId = q.get('channel_id') ?? ''
      if (!channelId) return { status: 400, body: { error: 'missing_channel_id' } }
      if (!p.channelStore.get(channelId)) return { status: 404, body: { error: 'unknown_channel' } }
      const letters = p.letterStore.listForChannel(channelId)
        .map(l => ({ id: l.id, direction: l.direction, plaintext: l.plaintext, created_at: l.created_at, read_at: l.read_at }))
      return { status: 200, body: { letters } }
    },
    'POST /v1/penpal/letters': async (_q, body) => {
      const p = deps.social?.penpal
      if (!p) return { status: 503, body: { error: 'penpal_not_wired' } }
      const { channel_id, text } = (body ?? {}) as { channel_id?: unknown; text?: unknown }
      if (typeof channel_id !== 'string' || channel_id.length === 0) return { status: 400, body: { error: 'missing_channel_id' } }
      if (typeof text !== 'string' || text.length === 0) return { status: 400, body: { error: 'missing_text' } }
      return { status: 200, body: await p.sendLetter(channel_id, text) }
    },
    'POST /v1/penpal/letters/read': async (_q, body) => {
      const p = deps.social?.penpal
      if (!p) return { status: 503, body: { error: 'penpal_not_wired' } }
      const channelId = ((body ?? {}) as { channel_id?: unknown }).channel_id
      if (typeof channelId !== 'string' || channelId.length === 0) return { status: 400, body: { error: 'missing_channel_id' } }
      p.letterStore.markAllRead(channelId, new Date().toISOString())
      return { status: 200, body: { ok: true } }
    },
  }
}
