import type { ReplyAttribution } from '@wechat-cc/protocol'

/** Only the daemon's attribution on this reply identifies its speaker. */
export function replyProvider(role: string, reply: Partial<ReplyAttribution>): string | null {
  return role === 'cc' && reply.speaker === 'agent' && typeof reply.provider === 'string' && reply.provider.trim()
    ? reply.provider : null
}
