/**
 * conversation-coordinator —— 只转出。实现在 `./coordinator/`(架构终态第 5 条 / 阶段 D):
 * plan.ts(一轮一次定完)→ runner.ts(一位一轮的机器)→ solo / parallel / chatroom(只编排)。
 * 外部一律照旧从这里 import。
 */
export { createConversationCoordinator, turnPolicy } from './coordinator'
export { authFailNotice, providerFailureReason, spawnFailedNotice, turnErrorNotice } from './coordinator/failures'
export { LONG_TURN_PROGRESS } from './coordinator/runner'
export type { ConversationCoordinator, ConversationCoordinatorDeps, TurnPolicy, TurnRecord } from './coordinator/types'
