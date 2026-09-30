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

export type Connection = { state: 'online' | 'offline' | 'revoked'; lastSyncedAt: number | null }
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
  answer(p: { id: string; runId: string; requestId: string; answers: Record<string, unknown> | null }): Promise<void>
  say(id: string, text: string): Promise<void>
  entryOptions(): Promise<EntryOptionsT>
  create(p: { text: string; projectPath?: string; providerId?: string }): Promise<{ matterId: string }>
}

/** code: 'stale' | 'offline' | 'revoked' | 'timeout' | 'unknown' */
export class BackendError extends Error {
  constructor(public code: string) { super(code) }
}
