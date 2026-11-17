import type { ReplyAttribution } from '@wechat-cc/protocol'
import type { MatterTurn } from '../../ports/matters'

/** Project an exact bound turn only; no lookup by current executor, participant order or native model name. */
export function turnReplyAttribution(turn: MatterTurn, speaker?: ReplyAttribution['speaker']): Partial<ReplyAttribution> {
  return {
    ...(speaker ? { speaker } : {}),
    ...(turn.executor && turn.executor !== 'cc' ? { provider: turn.executor } : {}),
    ...(turn.model ? { model: turn.model } : {}),
    matterId: turn.matterId, turnId: turn.id,
    ...(turn.runId ? { agentId: turn.runId } : {}),
  }
}
