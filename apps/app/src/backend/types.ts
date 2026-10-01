import type { z } from 'zod'
import type {
  Matter, MatterDetail, ApprovalExplanation, ProgressSummary, PhoneChangesTurn, EntryOptions, DeviceRowT, PushPlatformT,
  ChatPage, ChatJob, ChatMessage, Connections, NativeSessionRow, NativeSessionPage, SessionContinue,
} from '@wechat-cc/protocol'
import type { Lang } from '../i18n'

export type SessionContinueT = z.infer<typeof SessionContinue>
export type MatterT = z.infer<typeof Matter>
export type MatterDetailT = z.infer<typeof MatterDetail>
export type ApprovalExplanationT = z.infer<typeof ApprovalExplanation>
export type ProgressSummaryT = z.infer<typeof ProgressSummary>
export type PhoneChangesTurnT = z.infer<typeof PhoneChangesTurn>
export type EntryOptionsT = z.infer<typeof EntryOptions>
export type ChatPageT = z.infer<typeof ChatPage>
export type ChatJobT = z.infer<typeof ChatJob>
export type ChatMessageT = z.infer<typeof ChatMessage>
export type ConnectionsT = z.infer<typeof Connections>
export type NativeSessionRowT = z.infer<typeof NativeSessionRow>
export type NativeSessionPageT = z.infer<typeof NativeSessionPage>
export type { HomeTopicT, ApprovalItemT, AgentsTopicT, MatterTopicT, DeviceRowT } from '@wechat-cc/protocol'

export type ConnState = 'connecting' | 'online' | 'offline' | 'revoked'
/** epoch:每次握手成功 +1。store 看它前进就重新验证全部查询(首次连上、重连、回到前台)。 */
export type Connection = { state: ConnState; lastSyncedAt: number | null; epoch: number }
/** BackendError.code 的全集(映射见 src/net/errors.ts)。 */
export type BackendCode = 'stale' | 'busy' | 'offline' | 'revoked' | 'timeout' | 'not_found' | 'invalid' | 'unavailable' | 'unknown'
  | 'session_busy' | 'folder_busy' | 'provider_missing' | 'folder_missing' | 'quota'
export type Unsubscribe = () => void

export interface Backend {
  readonly mode: 'demo' | 'live'
  connection(): Connection
  onConnection(cb: (c: Connection) => void): Unsubscribe
  subscribe<T>(topic: 'home' | 'approvals' | 'agents' | `matter/${string}`, cb: (data: T) => void): Unsubscribe
  matters(lang: Lang): Promise<MatterT[]>
  matter(id: string, lang: Lang): Promise<MatterDetailT>
  insight(id: string, lang: Lang): Promise<{ explanations: Record<string, ApprovalExplanationT>; progress: ProgressSummaryT | null }>
  changes(id: string): Promise<PhoneChangesTurnT | null>
  decide(p: { id: string; runId: string; requestId: string; decision: 'allow' | 'deny' }): Promise<void>
  /** answers 形状与 daemon validateUserInputAnswers 一致:每题一个 string[](单选 1 个;多选 1–8 个、不重复;每条 ≤ 4000 字)。null = 不回答。 */
  answer(p: { id: string; runId: string; requestId: string; answers: Record<string, string[]> | null }): Promise<void>
  /** requestId:同一份草稿、同样的正文重发用同一个(daemon 对工作台任务按它去重),正文改了才换。 */
  say(id: string, text: string, requestId: string): Promise<void>
  entryOptions(lang: Lang): Promise<EntryOptionsT>
  /** requestId:同一份草稿、同样的正文重发用同一个(daemon 据此去重、超时后查回执)。projectId 缺省 ⇒ 由 CC 安排(managed)。 */
  create(p: { requestId: string; text: string; projectId?: string; providerId?: string }): Promise<{ matterId: string }>
  devices(): Promise<DeviceRowT[]>
  renameDevice(label: string): Promise<void>
  /** 登记本机的 APNs / FCM token(POST /m/api/push/register)。daemon 没接推送(还没上 v2 中继)⇒ BackendError('unavailable')。 */
  registerPush(platform: PushPlatformT, token: string): Promise<void>
  /** 让电脑发一条测试通知(POST /m/api/push/test);code 是中继 / APNs / FCM 的结果码。 */
  testPush(): Promise<{ ok: boolean; code: string }>
  /** 主人那条对话一页(before = 上一页的 nextBefore)。没设主人 / 还没说过话 ⇒ BackendError('not_found')(页面当空对话,照样能说)。 */
  chat(p: { before?: string; limit?: number }): Promise<ChatPageT>
  /** 收下即回;回复经 matter/<matterId> 主题唤醒后再 chat() 拉。上一句还在等 ⇒ BackendError('busy')。
   *  requestId:只在上次失败 / 不确定时重发同一个;已知回复过的绝不重发(daemon 的去重表 50 条 / 1 小时就过期)。 */
  chatSay(text: string, requestId: string): Promise<ChatJobT>
  /** CC 的连接快照(手机版,没有 detail)。 */
  connections(): Promise<ConnectionsT>
  /** 电脑上的原生会话(只读);cursor = 上一页的 nextCursor。 */
  sessions(provider: 'claude' | 'codex', cursor?: string): Promise<{ items: NativeSessionRowT[]; nextCursor: string | null }>
  /** 一个原生会话的一页消息;读不了 ⇒ BackendError('not_found')。 */
  session(key: string, cursor?: string): Promise<NativeSessionPageT>
  /** 这个电脑上的会话能不能在手机上接着做(不缓存,每次问电脑)。读不了 ⇒ BackendError('not_found')。 */
  continuePreview(key: string): Promise<SessionContinueT>
  /** 接成一件事并返回它的 matterId;幂等。拒绝 ⇒ session_busy / folder_busy / provider_missing / folder_missing / quota。 */
  continueSession(key: string): Promise<{ matterId: string }>
  /** 解除本机配对(daemon 撤掉本机令牌)。失败抛 BackendError;调用方无论成败都清本地令牌。 */
  unpair(): Promise<void>
  /** 前台 true / 后台 false:false 关连接;true 立刻新握手、订阅全部重挂。演示后端空操作。 */
  setActive(active: boolean): void
  dispose(): void
}

/** code 见 BackendCode;store 把 timeout 映射成「不确定」。 */
export class BackendError extends Error {
  constructor(public code: string) { super(code) }
}
