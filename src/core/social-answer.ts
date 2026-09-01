import type { CheapEval } from './agent-provider'
import type { IntentCard, MatchReceipt } from './a2a-intent'
import type { IntentEvent } from './a2a-server'
import { gateOutbound } from './a2a-disclosure'

export interface AnswerDeps {
  judge: (card: IntentCard) => Promise<{ match: 'yes' | 'no'; blurb?: string }>
  policy: string
  cheapEval: CheapEval
  /** 闸门的超时上限(毫秒)。来自 `ProviderRegistry.getCheapEvalBudgetMs()`
   *  —— 实际会跑的 provider 有多慢由它说了算。缺省 ⇒ GATE_TIMEOUT_MS。 */
  gateTimeoutMs?: number
}

export function makeAnswerIntent(deps: AnswerDeps): (e: IntentEvent) => Promise<MatchReceipt> {
  return async (e) => {
    const id = e.card.intent_id
    const verdict = await deps.judge(e.card)
    if (verdict.match !== 'yes' || !verdict.blurb) return { intent_id: id, match: 'no' }
    const gated = await gateOutbound(verdict.blurb, { policy: deps.policy, cheapEval: deps.cheapEval, ...(deps.gateTimeoutMs !== undefined ? { timeoutMs: deps.gateTimeoutMs } : {}) })
    if (!gated.ok) return { intent_id: id, match: 'no' }   // never leak a partial — downgrade
    return { intent_id: id, match: 'yes', blurb: gated.redacted }
  }
}
