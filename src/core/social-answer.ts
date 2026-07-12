import type { CheapEval } from './agent-provider'
import type { IntentCard, MatchReceipt } from './a2a-intent'
import type { IntentEvent } from './a2a-server'
import { gateOutbound } from './a2a-disclosure'

export interface AnswerDeps {
  judge: (card: IntentCard) => Promise<{ match: 'yes' | 'no'; blurb?: string }>
  policy: string
  cheapEval: CheapEval
  peerNames?: string[]
}

export function makeAnswerIntent(deps: AnswerDeps): (e: IntentEvent) => Promise<MatchReceipt> {
  return async (e) => {
    const id = e.card.intent_id
    const verdict = await deps.judge(e.card)
    if (verdict.match !== 'yes' || !verdict.blurb) return { intent_id: id, match: 'no' }
    const gated = await gateOutbound(verdict.blurb, { policy: deps.policy, peerNames: deps.peerNames ?? [], cheapEval: deps.cheapEval })
    if (!gated.ok) return { intent_id: id, match: 'no' }   // never leak a partial — downgrade
    return { intent_id: id, match: 'yes', blurb: gated.redacted }
  }
}
