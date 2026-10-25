/**
 * 信的测试用的门(SpeechPolicy):照常放行;可以开关免打扰 / 别烦我 / 送不到。只给 letters/*.test.ts 用。
 */
import { makeSpeechPolicy, type SpeechPolicy } from '../../daemon/speech/policy'
import type { ProactiveOutbound } from '../../daemon/companion/proactive-channel'

export function lettersTestSpeech(o: { quiet?: () => boolean; careOff?: () => boolean; deliverable?: () => boolean } = {}): SpeechPolicy {
  const outbound: ProactiveOutbound = {
    appDeliverable: () => false, canDeliver: () => o.deliverable?.() ?? true, sendOnce: async () => ({ ok: true }),
    open: () => ({ sendText: async () => ({ msgId: 'm' }), channel: () => 'wechat', textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }),
  }
  return makeSpeechPolicy({ care: () => (o.careOff?.() ? 'off' : 'low'), quietEndsAt: (_c, now) => (o.quiet?.() ? now + 3600_000 : null), outbound, log: () => {} })
}
