/**
 * 笔友信箱 routes(spec 2026-07-22-penpal-mailbox-desktop),社交模块经 ./routes.ts 一起挂。
 * 社交没接上 ⇒ 路由层的模块门回 module_off(以前叫 penpal_not_wired),到不了这里。
 * Reads are the OWNER's local plaintext thread —
 * the ciphertext columns (sealed_ciphertext/nonce/tag) NEVER leave the
 * daemon (投影只挑明文字段,测试断言)。
 */
import type { RouteTable } from '../../daemon/internal-api/types'
import type { SocialService } from './wire-social'

export interface PenpalRoutesDeps {
  penpal: SocialService['penpal']
  /** 注册表里认识这个对端就给名字;不认识 / A2A 服务没起 ⇒ undefined(标签退回对端 id)。 */
  peerName: (agentId: string) => string | undefined
}

const PREVIEW_LEN = 60

export function penpalRoutes(deps: PenpalRoutesDeps): RouteTable {
  const p = deps.penpal
  return {
    'GET /v1/penpal/channels': async () => {
      const unread = new Map(p.letterStore.unreadCountByChannel().map(r => [r.channel_id, r.n]))
      const channels = p.channelStore.list()
        .filter(c => c.status === 'open')
        .map(c => {
          const last = p.letterStore.listForChannel(c.id)[0] ?? null
          const peerLabel = c.peer_agent_id
            ? (deps.peerName(c.peer_agent_id) ?? c.peer_agent_id)
            : `第${c.degree}度笔友`
          return {
            id: c.id,
            // 信道的标题曾经是那条心愿的 topic(seek 行)。心愿改写之后信道
            // 从配对来,没有对应的话题行 —— 桌面端拿 peer_label 就够了。
            title: '',
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
      const channelId = q.get('channel_id') ?? ''
      if (!channelId) return { status: 400, body: { error: 'missing_channel_id' } }
      if (!p.channelStore.get(channelId)) return { status: 404, body: { error: 'unknown_channel' } }
      // 只列真信(kind='letter'):伙伴之间的信封(串门等)不是主人的信箱内容。
      const letters = p.letterStore.listForChannel(channelId)
        .filter(l => (l.kind ?? 'letter') === 'letter')
        .map(l => ({ id: l.id, direction: l.direction, plaintext: l.plaintext, created_at: l.created_at, read_at: l.read_at }))
      return { status: 200, body: { letters } }
    },
    'POST /v1/penpal/letters': async (_q, body) => {
      const { channel_id, text } = (body ?? {}) as { channel_id?: unknown; text?: unknown }
      if (typeof channel_id !== 'string' || channel_id.length === 0) return { status: 400, body: { error: 'missing_channel_id' } }
      if (typeof text !== 'string' || text.length === 0) return { status: 400, body: { error: 'missing_text' } }
      return { status: 200, body: await p.sendLetter(channel_id, text) }
    },
    // 失败重试 = 重投同一封的原字节(同 nonce ⇒ 接收端 (channel_id,nonce)
    // 去重幂等)。重新 sendLetter 会封新 nonce,在“投到了但 ack 丢了”时
    // 重复投递 — 终审 2026-07-22 记录的洞,这条路由是它的修复面。
    'POST /v1/penpal/letters/resend': async (_q, body) => {
      const letterId = ((body ?? {}) as { letter_id?: unknown }).letter_id
      if (typeof letterId !== 'string' || letterId.length === 0) return { status: 400, body: { error: 'missing_letter_id' } }
      return { status: 200, body: await p.resendLetter(letterId) }
    },
    'POST /v1/penpal/letters/read': async (_q, body) => {
      const channelId = ((body ?? {}) as { channel_id?: unknown }).channel_id
      if (typeof channelId !== 'string' || channelId.length === 0) return { status: 400, body: { error: 'missing_channel_id' } }
      p.letterStore.markAllRead(channelId, new Date().toISOString())
      return { status: 200, body: { ok: true } }
    },
  }
}
