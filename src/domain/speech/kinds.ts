/**
 * CC 会主动说的每一种话,只在这里声明一次(第三批 3a,设计稿 docs/superpowers/specs/2026-10-21-speech-policy-design.md)。
 *
 * **origin 跟着种类走,调用方不能自己传** —— 没有哪条路能把自己说成 requested 来绕过闸。
 * 归类的准绳(整合者评审 #507):看这一句的**内容**是不是主人点名要的,不看开关是谁开的。
 *  - blocking   有事卡着等主人拍板(权限 y/n、有人想跟 CC 说话、配对)。iOS 的 time-sensitive / critical。
 *  - requested  内容、时间都是主人点名的(提醒、「每天 9 点看邮箱」)。
 *  - report     主人交办的事有了结果,CC 来回话(内容 CC 定、起因是主人)。
 *  - initiative CC 自己挑内容(早报的开关是主人开的,但内容是 CC 挑的 ⇒ 算这一类)。
 * 加一种新的话 = 这里加一行,先按上面那条准绳归类。
 */
export type SpeechOrigin = 'blocking' | 'requested' | 'report' | 'initiative'

export const SPEECH_KINDS = {
  // 执行者等主人批准,也包括「CC 有问题问你」(执行者卡着等回答)—— 工作台通知 / App 推送都用这一种。
  permission_ask: { origin: 'blocking', label: '等你批准', expiring: true },
  // 自改:拍板卡等主人回 y / n(码会过期,不进待说队列,见 daemon/self-change-glue.ts);进展是回报
  self_change_ask: { origin: 'blocking', label: '自改要你拍板', expiring: true },
  self_change_progress: { origin: 'report', label: '自改进展' },
  guest_request: { origin: 'blocking', label: '有人想跟 CC 说话' },
  // 配对的结果(「连上了 ✓」「配对码过期了」):主人自己说了「配对」、正等着这一句 ⇒ requested,不是等他拍板的 blocking
  // (core/pairing.ts 的 notify;10-22 收尾时更正)
  pairing: { origin: 'requested', label: '配对' },
  reminder: { origin: 'requested', label: '提醒' },
  job: { origin: 'requested', label: '定时任务' },
  // 主人点名「换一家来审」:内容(审哪件、谁来审)是主人点的,而且只触发一次、后面没有队列 —— 归 report 的话免打扰里
  // 一推后就丢了(整合者评审 #524 讨论)。所以归 requested。
  review: { origin: 'requested', label: '换一家来审' },
  matter_report: { origin: 'report', label: '一件事的回报' },
  review_missed: { origin: 'report', label: '定时审阅错过了' },
  upgrade_notice: { origin: 'report', label: '升级完成' },
  // 只发一次的系统通知:被推后 ⇒ 门的「待说」队列接住,之后补说(defer 不是不送)。
  job_notice: { origin: 'report', label: '定时被暂停' },
  boot_notice: { origin: 'report', label: '开机有几样没起来' },
  outbound_health: { origin: 'report', label: '外发出了问题' },
  // 终端会话的汇总(做完了 / 等你批准,带 y/n 码):hub 自己有压一段、撤回、桌面通知和 App 推送这一套;
  // 汇总里可能带会过期的码 ⇒ 标 expiring,不进待说队列(daemon/bootstrap/wire-cli-sessions.ts)。
  cli_session: { origin: 'report', label: '终端会话', expiring: true },
  rules_notice: { origin: 'report', label: '放行规则出了问题' },
  restart_notice: { origin: 'report', label: '重启了' },
  brief: { origin: 'initiative', label: '早报' },
  recap: { origin: 'initiative', label: '周报' },
  letter: { origin: 'initiative', label: '信' },
  // 主人当面说「给我写封信」:内容是主人点名要的 ⇒ 免打扰 / 别烦我都照写照寄。
  letter_asked: { origin: 'requested', label: '当面要的信' },
  companion: { origin: 'initiative', label: '伙伴' },
  guest_visit: { origin: 'initiative', label: '来访' },
  // 一次性:只在画好的那一刻触发一次,没有「下一拍」—— 被推后就等于这一句丢了(贴纸已经进库,照样会用到)。
  // 以后加别的一次性 initiative 照这条判:要么接受 defer 即丢,要么自己留个待发标记(整合者评审 #520)。
  sticker: { origin: 'initiative', label: '新贴纸' },
  // 社交(笔友 / 心愿 / 介绍 / 串门)。report / blocking 那几条被推后 ⇒ 门的「待说」队列接住、之后补说(speech/pending-notices.ts);
  // social_story(CC 自己的见闻)推后就是这一句不说,东西在背包 / 觅食台里(第三批 3a,整合者评审 #528)。
  social_ask: { origin: 'blocking', label: '有人想认识你' },        // 介绍:等主人回「同意 / 不了」
  social_result: { origin: 'report', label: '社交的结果' },          // 心愿的答复、介绍成没成、替主人回了谁
  social_mail: { origin: 'report', label: '笔友来信' },               // 信在信箱里留着
  // 别的 agent 经 A2A 给主人捎的一句([A2A:<id>] …):别人写给主人的,跟来信一样不吞;推后进待说队列(wire-a2a-server.ts)
  a2a_notify: { origin: 'report', label: '别的 agent 捎话' },           // 原文在 a2a 事件表里
  social_story: { origin: 'initiative', label: '串门见闻' },          // 串门回来讲、邻居、明信片
  memory_notice: { origin: 'initiative', label: '整理记忆' },
} as const satisfies Record<string, { origin: SpeechOrigin; label: string; expiring?: true }>

export type SpeechKind = keyof typeof SPEECH_KINDS

/**
 * 带会过期码的卡(y/n 码、权限卡):**不进待说队列**。真相在登记处,补说只会给出一个已经失效的码;
 * 没送到 ⇒ 条目照样在登记处,桌面 / 终端仍可拍板(整合者评审 #533)。
 */
export function isExpiring(kind: SpeechKind): boolean {
  return 'expiring' in SPEECH_KINDS[kind]
}

export function originOf(kind: SpeechKind): SpeechOrigin {
  return SPEECH_KINDS[kind].origin
}

/** 社交那几条通知的种类(wire-wish / wire-intro / wire-visit 的 notifyOwner 必填)。 */
export type SocialNotice = 'social_ask' | 'social_result' | 'social_story' | 'social_mail'
