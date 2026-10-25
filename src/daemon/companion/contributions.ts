/**
 * 「陪伴候选」贡献点(架构终态第 2 条 / A5):各功能把自己能做的事交上来,陪伴的定时只挑、只按登记的顺序走,
 * 不再叫得出打猎 / 串门 / 贴纸 / 画室的名字。一个功能拿掉 = 登记表里少一行(wiring/tick-bodies.ts)。
 *
 * 放在 daemon/companion:陪伴引擎(wiring/tick-push、tick-introspect)和以后的 src/features/<名> 都能 import;
 * core 不许依赖 daemon,所以这里只引 core 的类型。只有类型,没有逻辑。
 */
import type { CareLevel, CareLedgerEntry, PlanAction, PlanContext } from '../../core/companion-plan'
import type { AvoidTopic } from '../../core/companion-topics'
import type { CheapEval } from '../../core/agent-provider'

/** 主动找主人那一拍里,某一个对话此刻的处境(已经过了 care off / 免打扰 / 到期 agenda 那几道)。 */
export interface CompanionTickCtx {
  chatId: string
  /** 主人那条对话(companion default_chat_id)。 */
  isOwnerChat: boolean
  nowIso: string
  /** 这条对话的 care 档(到这里时不会是 off)。 */
  level: CareLevel
  prefs: { hunt?: boolean; visit?: boolean; avoid?: AvoidTopic[] }
  ledger: CareLedgerEntry
  lastInboundAtIso?: string
}

/**
 * 主动找主人那一拍的一个候选。`id` 仍是日程判断认得的那几个动作:判断的 prompt 和回退顺序在 core/companion-plan,
 * 换成任意字符串就改了主人每天收到的东西,这一步不动。
 */
export interface CompanionAction {
  id: Exclude<PlanAction, 'none'>
  /**
   * 这一拍按哪一档去问 shouldSpeak(冷却 / care 档 / 无回复暂停全在 calibration,这里不判);
   * null ⇒ 这一拍根本不考虑我 —— 不进候选,也不进「被拒的」。
   */
  speakLevel(ctx: CompanionTickCtx): CareLevel | null
  /** 要经微信送到才算做成。false ⇒ 微信断了 / 会话在忙也照样能做(串门走笔友信道,不是一条微信)。 */
  needsWechat: boolean
  /**
   * 给日程判断看的(可选,只读,自己 catch,永不抛):判断前每个登记的候选都问一遍,不管这一拍是不是候选。
   * `targets` = 模型可以点名的去处(constrainPlan 只放行这里面的 id);`context` = 处境里归我管的那一格。
   */
  planInfo?(ctx: CompanionTickCtx): { targets?: Array<{ id: string; label: string }>; context?: Partial<Pick<PlanContext, 'journal' | 'social'>> }
  /**
   * 做。true = 真做成了;false = 送的那一步被跳过(两道闸之间状态变了);'refused' = 网络守护拒了,什么都没做、不进台账。
   * `target` 只在模型点名了 targets 里的某一项时才有。
   */
  run(ctx: CompanionTickCtx, target?: string): Promise<boolean | 'refused'>
}

/** 每天一次的自省那一拍,固定维护(反思 / 线索 / 总览 / 备份)之后依次跑的一步。 */
export interface IntrospectStepCtx {
  nowIso: string
  /** nowIso 的日期部分。 */
  today: string
  /** 这一拍解析到的便宜模型(到这里一定有)。 */
  sdkEval: CheapEval
  /** <stateDir>/memory */
  memoryRoot: string
}

export interface IntrospectStep {
  id: string
  /** 自己门控(没接线 / 关着就直接返回)。抛了只记一行 `<logTag> <failLabel> failed: …`,不拖累后面的步。 */
  run(ctx: IntrospectStepCtx): Promise<void>
  logTag: string
  failLabel: string
}
