/**
 * 伙伴 / 定时这几拍共用的依赖(从 tick-bodies.ts 原样搬出,第三批 3a 顺带项:按生产者拆文件)。
 */
import type { Db } from '../../lib/db'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import type { Access } from '../../lib/access'
import type { PermissionMode } from '../../domain/capability-matrix'
import type { ReplyDeliveryPort } from '../../domain/turn-reply'
import { shouldSpeak } from '../companion/calibration'
import type { CareLedger } from '../companion/care-ledger'
import { connectHearth } from '../companion/hearth-client'
import { buildHearthPlan } from '../companion/hearth-plan'
import type { CheapEval } from '../../ports/agent-provider'
import { type AvoidTopic } from '../../domain/companion-topics'

export interface TickDeps {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  /** 项目登记:伙伴那一拍在哪个文件夹起会话(现在选中的那个,没有就 _default)。 */
  projects: Pick<import('../projects').Projects, 'load'>
  /** Curated sticker library — enables the daily sticker-artist step in
   *  introspectTick. Absent ⇒ the step never runs (tests, minimal embeds). */
  stickers?: import('../stickers').StickerLib
  /** CC 画的你 —— 自动刷新小像(portrait-artist)。缺省 ⇒ 不自动刷新。 */
  generatePortrait?: (adminChatId: string) => Promise<{ ok: boolean; error?: string }>
  boot: Bootstrap
  /**
   * Task 11 — companion ticks aren't user-initiated, but the session
   * they acquire is still keyed by `chatId` (the configured
   * `default_chat_id`). Resolving the tier of that chat lets us reuse
   * the same per-chat session isolation as user-initiated dispatch.
   * Typically resolves to admin (operator's own chatId); a non-admin
   * `default_chat_id` is a misconfiguration the tick surfaces via log.
   */
  loadAccess: () => Access
  /**
   * Daemon-wide permission mode. When 'dangerously', the companion tick
   * promotes the resolved tier to admin so the operator's `--dangerously`
   * intent applies to background ticks as well as user-initiated dispatch.
   */
  permissionMode: PermissionMode
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /**
   * Task 6 — per-chat proactive-care preferences (care level) plus the set
   * of chat ids that have ever set a preference. pushTick sweeps
   * `[default_chat_id, ...chatPrefs.list()]` instead of only the owner's
   * chat. Typed as a structural subset of ChatPrefsStore so tests can fake
   * it without a full store.
   */
  chatPrefs: { get(chatId: string): { care?: 'off' | 'low' | 'high'; hunt?: boolean; visit?: boolean; avoid?: AvoidTopic[]; quiet?: import('../../domain/quiet-hours').QuietWindow }; list(): string[] }
  /**
   * 打猎战利品(2026-09-03)。`outboundTaps` 旁听打猎那一拍发出去的文本,
   * `huntStore` 把它拆成条目落库。两者都可选:没接就是旧行为(发了不记)。
   */
  outboundTaps?: { tap(chatId: string): { close(): string[] } }
  /** 「CC 做过的事」补记(B9):只记发生了什么 + 状态,不记正文;只记主人那条对话。缺省 ⇒ 不记。 */
  activityLog?: { append(e: { kind: 'proactive' | 'job'; status: string; ref?: string }): void }
  huntStore?: {
    recordHunt(a: { chatId: string; text: string; nowIso?: string }): number
    recordVisit?(a: { chatId: string; text: string; peerLabel: string; nowIso?: string }): string | null
    /** 日程判断用(spec 2026-09-05-companion-plan):包袱里最近几条 + 没看的数量。main.ts 传的是完整 Journal。 */
    list?(limit?: number): readonly { kind: string; title: string; ts: string }[]
    summary?(seenUntil: string | null): { unread: number; latest: { kind: string; title: string; ts: string } | null }
  }
  /**
   * 日程判断的便宜模型(spec 2026-09-05-companion-plan)。测试注入;缺省
   * `boot.registry.getCheapEval()`。没有 → 回退到固定顺序 hunt → visit → gap。
   */
  planEval?: CheapEval
  /**
   * Task 6 — the calibration gate's learning signal (last claimed proactive
   * send + no-reply streak per chat). shouldSpeak() reads it; pushTick
   * claims it BEFORE dispatch, mirroring the agenda at-most-once contract.
   */
  careLedger: CareLedger
  /**
   * 连接健康。degraded 时主动外发全部停手 —— 这是保护账号的措施:
   * 往断掉的链路上反复重试是触发风控的形状(memory: no-retry-storm-when-disconnected)。
   * 可选:省略即永不暂停(测试与 e2e 用)。
   */
  health?: { shouldSuspend(dep: 'wechat'): boolean }
  /**
   * CC 主动找你的第二条路(2026-10-18,daemon/companion/proactive-channel.ts):微信不能用 / 发失败时
   * 落到 App。缺省 ⇒ 只有微信(即改造前)。微信 degraded 时,这一拍只在 App 收得到、且当轮走 daemon
   * 交付(文字由 daemon 送,才改得了道)时才照跑;否则同以前,在模型之前就停手。
   */
  proactive?: import('../companion/proactive-channel').ProactiveOutbound
  /** CC 主动开口唯一的门(第三批 3a,wiring/wire-speech.ts)。没接 ⇒ 已迁过来的那几条路不开口(不退回直接发)。 */
  speech?: import('../speech/policy').SpeechPolicy
  /**
   * Testing seams for the optional hearth push (memory-infra Phase 1, HI W3).
   * Production omits these — distillAndPushOwnerKnowledge falls back to the
   * real `connectHearth`/`buildHearthPlan`. Tests inject fakes so the push
   * path (submit → apply-for-owner) can be exercised without a real hearth
   * MCP server. See distillAndPushOwnerKnowledge below.
   */
  hearthConnect?: typeof connectHearth
  hearthBuildPlan?: typeof buildHearthPlan
  /**
   * Optional CC Atelier mount. Kept absent by default until a hosted brush is
   * provisioned; when present it runs after the normal introspection work and
   * must remain throw-safe so art can never starve memory maintenance.
   */
  runAtelierTick?: (opts?: { nowIso?: string }) => Promise<void>
  /**
   * 回复交付(spec 2026-10-03 §4.10「伙伴主动推送」):推送也是一轮 —— 最后的话就是推送,不想发写
   * `NO_REPLY`(静默 ⇒ 撤回登记)。只有这一条路(D3),所以必填。
   */
  replyDelivery: ReplyDeliveryPort
}
