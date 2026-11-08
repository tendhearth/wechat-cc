/**
 * 一件事的状态 ⇒ 怎么说、画什么、上不上强调色、归哪一组(设计稿 2026-10-31 §4 U)。
 * 三端(App / 桌面 / 手机网页)只认这一张;页面里不再手写「waiting ⇒ shield」这类映射。
 * 状态词按 docs/reference/phone-wording.md:在做 / 等你决定 / 这一轮做完了 / 完成 / 没做成 / 停下了。
 * 纯数据,不 import 任何东西。
 */
export const STATUS_KEYS = ['working', 'waiting', 'replied', 'done', 'failed', 'stopped'] as const
export type StatusKey = (typeof STATUS_KEYS)[number]

/** 主页的三组:等你 → 在做 → 带回来的。 */
export type HomeGroupKey = 'waiting' | 'working' | 'back'

export type StatusIcon = 'shield' | 'done' | 'alert' | 'message' | 'pause'

export interface StatusSpec {
  /** 词条键。 */
  readonly word: `status.${StatusKey}`
  /** null ⇒ 不画图标(行里留同宽的空位)。 */
  readonly icon: StatusIcon | null
  /** 强调色只给「等你」。 */
  readonly tone: 'accent' | 'inkSoft'
  readonly group: HomeGroupKey
}

export const STATUS_TABLE: Readonly<Record<StatusKey, StatusSpec>> = {
  working: { word: 'status.working', icon: null, tone: 'inkSoft', group: 'working' },
  waiting: { word: 'status.waiting', icon: 'shield', tone: 'accent', group: 'waiting' },
  replied: { word: 'status.replied', icon: 'message', tone: 'inkSoft', group: 'back' },
  done: { word: 'status.done', icon: 'done', tone: 'inkSoft', group: 'back' },
  failed: { word: 'status.failed', icon: 'alert', tone: 'inkSoft', group: 'back' },
  stopped: { word: 'status.stopped', icon: 'pause', tone: 'inkSoft', group: 'back' },
}

/** 主页三组的顺序。 */
export const HOME_GROUP_ORDER: readonly HomeGroupKey[] = ['waiting', 'working', 'back']

/** 状态词(两种语言)。App 的词条 status.<key> 从这里取;桌面的生成物(scripts/gen-routes.ts)也从这里写。 */
export const STATUS_WORDS: Readonly<Record<'zh-Hans' | 'en', Readonly<Record<StatusKey, string>>>> = {
  'zh-Hans': { working: '在做', waiting: '等你决定', replied: '这一轮做完了', done: '完成', failed: '没做成', stopped: '停下了' },
  en: { working: 'Working', waiting: 'Waiting on you', replied: 'Done for this round', done: 'Done', failed: 'Didn’t finish', stopped: 'Stopped' },
}

/** 主页分组的名字(两种语言)。 */
export const HOME_GROUP_WORDS: Readonly<Record<'zh-Hans' | 'en', Readonly<Record<HomeGroupKey, string>>>> = {
  'zh-Hans': { waiting: '等你', working: '在做', back: '带回来的' },
  en: { waiting: 'Waiting on you', working: 'Working', back: 'Brought back' },
}

/**
 * 「在做」却这么久没动静 ⇒ 行里提示「可能卡住」(2026-11-03 主人:产品统一的缺口)。和微信日报里的「可能卡住」
 * (src/domain/overseer-today.ts 的 TODAY_QUIET_MS)是同一条线、同一个数。
 */
export const QUIET_AFTER_MS = 30 * 60_000

/** 行里的两句提示(两种语言):`quiet` 可能卡住;`pendingTotal` 一件事同时等你好几项 ⇒ 共 N 项({n} 是占位)。三端同一句。 */
export const ROW_HINT_WORDS: Readonly<Record<'zh-Hans' | 'en', Readonly<{ quiet: string; pendingTotal: string }>>> = {
  'zh-Hans': { quiet: '可能卡住', pendingTotal: '共 {n} 项' },
  en: { quiet: 'May be stuck', pendingTotal: '{n} in total' },
}

/** 任务的细分观察，不另造第二份任务状态表。连接/授权结果和操作生命周期不属于这里。 */
export const TASK_DETAIL_WORDS = {
  'zh-Hans': { queued: '等待中', cancelling: '正在停止', imported: '尚未执行', networkPaused: '已暂停(网络未受保护)', background: '后台执行中 · {n}', retained: '会话保留中' },
  en: { queued: 'Queued', cancelling: 'Stopping', imported: 'Not started', networkPaused: 'Paused (network unprotected)', background: 'Working in background · {n}', retained: 'Session retained' },
} as const
