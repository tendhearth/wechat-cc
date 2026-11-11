import type { TopicActivityT, TopicSessionT } from '../../packages/protocol/src/topic-bubbles'

export interface ProjectActivity { activity: TopicActivityT; sessions: TopicSessionT[] }
/** Runtime facts only. This source must not read a matter detail or acknowledge seen. */
export interface ProjectTaskActivity { phase: string; requestId: string | null; waitingFor: string | null; requestKind?: 'permission'|'question'; tool?: string | null }
export type ProjectTaskActivitySource = (id: string) => ProjectTaskActivity | null
