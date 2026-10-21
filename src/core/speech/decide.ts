/**
 * 此刻 CC 能不能开口 —— 一个纯函数(第三批 3a,设计稿 2026-10-21-speech-policy-design)。
 * 九条主动开口的路以前各自判;这里是唯一一处。规则(设计稿那张表):
 *
 * |              | blocking | requested | report       | initiative                         |
 * | care off     | 照说     | 照说      | 照说         | drop care_off(内容算看过)        |
 * | 免打扰       | 照说     | 照说      | defer 到结束 | defer 到结束;定时触发的记 skipped:quiet |
 * | 每种的频率   | 不看     | 不看      | 不看         | 不过 ⇒ drop                        |
 * | 都送不到     | defer(不重试、不花模型)—— 四类一样;defer 只是不风暴,不是不送 |
 *
 * initiative 的先后:别烦我优先于一切 → 免打扰 → 频率 → 送不送得到。
 * 这里不读时钟、不读文件:care 档、免打扰、送不送得到都由调用方按当下算好传进来。
 */
import { originOf, type SpeechKind } from './kinds'

export type CareSetting = 'off' | 'low' | 'high'

export interface SpeechContext {
  /** 主人那条对话的主动关心档(没设过的主人 = low,见 daemon/companion/calibration careLevel)。 */
  care: CareSetting
  /** 此刻在免打扰时段里 ⇒ 时段结束的时刻;不在 ⇒ null。 */
  quiet: { endsIso: string } | null
  /** 微信能用,或 App 收得到(proactive-channel 的 canDeliver)。 */
  deliverable: boolean
  /** 这一种自己的频率 / 冷却(伙伴的 shouldSpeak、贴纸的 22 小时 …)。只对 initiative 生效。 */
  perKind?: { ok: true } | { ok: false; reason: string }
  /** 定时触发的(晨报、周报):赶上免打扰不往后推,当天记 skipped:quiet —— 运行器到点后只有 10 分钟窗口。 */
  scheduled?: boolean
}

export type SpeechDecision =
  | { allow: true }
  | { defer: true; until?: string; reason: string }
  | { drop: true; reason: string }

export function decideSpeech(kind: SpeechKind, ctx: SpeechContext): SpeechDecision {
  const origin = originOf(kind)
  if (origin === 'initiative') {
    if (ctx.care === 'off') return { drop: true, reason: 'care_off' }
    if (ctx.quiet) return ctx.scheduled ? { drop: true, reason: 'skipped:quiet' } : { defer: true, until: ctx.quiet.endsIso, reason: 'quiet_hours' }
    if (ctx.perKind && !ctx.perKind.ok) return { drop: true, reason: ctx.perKind.reason }
  } else if (origin === 'report' && ctx.quiet) {
    return { defer: true, until: ctx.quiet.endsIso, reason: 'quiet_hours' }
  }
  if (!ctx.deliverable) return { defer: true, reason: 'undeliverable' }
  return { allow: true }
}
