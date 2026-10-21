/**
 * CC 会主动说的每一种话,只在这里声明一次(第三批 3a,设计稿 docs/superpowers/specs/2026-10-21-speech-policy-design.md)。
 *
 * **origin 跟着种类走,调用方不能自己传** —— 没有哪条路能把自己说成 requested 来绕过闸。
 * 归类的准绳(9d 评审 #507):看这一句的**内容**是不是主人点名要的,不看开关是谁开的。
 *  - blocking   有事卡着等主人拍板(权限 y/n、有人想跟 CC 说话、配对)。iOS 的 time-sensitive / critical。
 *  - requested  内容、时间都是主人点名的(提醒、「每天 9 点看邮箱」)。
 *  - report     主人交办的事有了结果,CC 来回话(内容 CC 定、起因是主人)。
 *  - initiative CC 自己挑内容(晨报的开关是主人开的,但内容是 CC 挑的 ⇒ 算这一类)。
 * 加一种新的话 = 这里加一行,先按上面那条准绳归类。
 */
export type SpeechOrigin = 'blocking' | 'requested' | 'report' | 'initiative'

export const SPEECH_KINDS = {
  permission_ask: { origin: 'blocking', label: '等你批准' },
  guest_request: { origin: 'blocking', label: '有人想跟 CC 说话' },
  pairing: { origin: 'blocking', label: '配对' },
  reminder: { origin: 'requested', label: '提醒' },
  job: { origin: 'requested', label: '定时任务' },
  matter_report: { origin: 'report', label: '一件事的回报' },
  review_missed: { origin: 'report', label: '定时审阅错过了' },
  upgrade_notice: { origin: 'report', label: '升级完成' },
  outbound_health: { origin: 'report', label: '外发出了问题' },
  restart_notice: { origin: 'report', label: '重启了' },
  brief: { origin: 'initiative', label: '晨报' },
  recap: { origin: 'initiative', label: '周报' },
  letter: { origin: 'initiative', label: '信' },
  companion: { origin: 'initiative', label: '伙伴' },
  guest_visit: { origin: 'initiative', label: '来访' },
  sticker: { origin: 'initiative', label: '新贴纸' },
  memory_notice: { origin: 'initiative', label: '整理记忆' },
} as const satisfies Record<string, { origin: SpeechOrigin; label: string }>

export type SpeechKind = keyof typeof SPEECH_KINDS

export function originOf(kind: SpeechKind): SpeechOrigin {
  return SPEECH_KINDS[kind].origin
}
