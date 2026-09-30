import type { z } from 'zod'
import type {
  Matter, MatterDetail, ApprovalExplanation, ProgressSummary, PhoneChangesTurn, EntryOptions,
} from '@wechat-cc/protocol'
import type { Lang } from '../i18n'

export type MatterT = z.infer<typeof Matter>
export type MatterDetailT = z.infer<typeof MatterDetail>
export type ApprovalExplanationT = z.infer<typeof ApprovalExplanation>
export type ProgressSummaryT = z.infer<typeof ProgressSummary>
export type PhoneChangesTurnT = z.infer<typeof PhoneChangesTurn>
export type EntryOptionsT = z.infer<typeof EntryOptions>
export type { HomeTopicT, ApprovalItemT, AgentsTopicT, MatterTopicT } from '@wechat-cc/protocol'

export type ConnState = 'connecting' | 'online' | 'offline' | 'revoked'
/** epoch:每次握手成功 +1。store 看它前进就重新验证全部查询(首次连上、重连、回到前台)。 */
export type Connection = { state: ConnState; lastSyncedAt: number | null; epoch: number }
/** BackendError.code 的全集(映射见 src/net/errors.ts)。 */
export type BackendCode = 'stale' | 'offline' | 'revoked' | 'timeout' | 'not_found' | 'invalid' | 'unknown'
export type Unsubscribe = () => void

export interface Backend {
  readonly mode: 'demo' | 'live'
  connection(): Connection
  onConnection(cb: (c: Connection) => void): Unsubscribe
  subscribe<T>(topic: 'home' | 'approvals' | 'agents' | `matter/${string}`, cb: (data: T) => void): Unsubscribe
  matters(): Promise<MatterT[]>
  matter(id: string): Promise<MatterDetailT>
  insight(id: string, lang: Lang): Promise<{ explanations: Record<string, ApprovalExplanationT>; progress: ProgressSummaryT | null }>
  changes(id: string): Promise<PhoneChangesTurnT | null>
  decide(p: { id: string; runId: string; requestId: string; decision: 'allow' | 'deny' }): Promise<void>
  /** answers 形状与 daemon validateUserInputAnswers 一致:每题一个 string[](单选 1 个;多选 1–8 个、不重复;每条 ≤ 4000 字)。null = 不回答。 */
  answer(p: { id: string; runId: string; requestId: string; answers: Record<string, string[]> | null }): Promise<void>
  say(id: string, text: string): Promise<void>
  entryOptions(): Promise<EntryOptionsT>
  create(p: { text: string; projectPath?: string; providerId?: string }): Promise<{ matterId: string }>
}

/** code 见 BackendCode;store 把 timeout 映射成「不确定」。 */
export class BackendError extends Error {
  constructor(public code: string) { super(code) }
}
