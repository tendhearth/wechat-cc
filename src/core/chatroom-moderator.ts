import type { ProviderId } from './conversation'

/**
 * v0.5.9 — chatroom is now a persistent session; history interleaves user
 * messages and speaker turns across the entire chatroom lifetime (until
 * mode changes away from chatroom). The conductor sees the full sequence
 * and uses it for context across beats.
 *
 * The LLM moderator (evaluateRound / MODERATOR_INSTRUCTIONS / ModeratorDecision
 * / ModeratorRoundInput / ModeratorEvalDeps) was removed in the Task 4 cleanup
 * when the three-beat conductor pipeline superseded the per-round routing loop.
 */
export type ChatroomEntry =
  | { role: 'user'; text: string }
  | { role: 'speaker'; speaker: ProviderId; text: string }
