/**
 * social-judge — the answering-side judge seam (agent-social M1, T7b-core).
 *
 * `makeJudge` builds the system/user prompts for judging a peer's "seek"
 * Intent Card against the owner's own derived facts, then defensively
 * parses whatever `runTurn` returns into `{ match, blurb? }`. The ACTUAL
 * agent spawn (which model, which MCP tools, what session lifecycle) is
 * kept behind the injected `runTurn` seam so this module is unit-testable
 * with no live model — the real `runTurn` (a one-shot plugin-grounded
 * openai-style spawn, or a cheapEval fallback) is constructed in
 * daemon/bootstrap/index.ts.
 *
 * `social-answer.ts`'s `makeAnswerIntent` wraps the verdict this returns in
 * `gateOutbound` before anything crosses the wire — this module's ONLY job
 * is producing a best-effort verdict, never enforcing disclosure itself.
 */
import type { IntentCard } from './a2a-intent'

export interface JudgeDeps {
  /**
   * Run one agent turn with the given system + user prompt and return the
   * assistant's final text. Real impl (bootstrap) spawns a one-shot session
   * with ONLY the plugin MCP tools (no wechat/delegate) so the judge can
   * read the owner's derived facts (wxfacts/wxperson/…) without being able
   * to send-as-owner or recurse. Test impl is a plain fake.
   */
  runTurn: (systemPrompt: string, userPrompt: string) => Promise<string>
  /** Free-text disclosure policy, echoed into the system prompt so the
   *  judge composes an already policy-aware blurb (defence-in-depth #1 —
   *  #2 is the mandatory `gateOutbound` pass in social-answer.ts). */
  policy: string
}

export interface JudgeVerdict {
  match: 'yes' | 'no'
  blurb?: string
}

function systemPrompt(policy: string): string {
  return `你替主人判断是否匹配好友的 seek 意图；用 wx* 工具读主人资料；只输出 {"match":"yes|no","blurb":"..."}；遵守披露策略：${policy}；绝不含门牌/第三方`
}

function userPrompt(card: IntentCard): string {
  return `话题：${card.topic}${card.city ? `\n城市：${card.city}` : ''}`
}

/**
 * Defensively parse the judge turn's final text into a verdict. Tolerates
 * stray prose around the JSON (models routinely wrap JSON in a sentence or
 * code fence). Any parse failure, a missing/invalid `match` field, or the
 * `runTurn` call itself throwing — all fail to `{ match: 'no' }`. A
 * false-negative (missed match) is a low-cost silent no-op (Invariant 3);
 * treating "I couldn't parse this" as a match would be the wrong default.
 */
function parseVerdict(raw: string): JudgeVerdict {
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(m ? m[0] : raw) as { match?: unknown; blurb?: unknown }
    if (parsed.match === 'yes') {
      return typeof parsed.blurb === 'string' && parsed.blurb.length > 0
        ? { match: 'yes', blurb: parsed.blurb }
        : { match: 'yes' }
    }
    return { match: 'no' }
  } catch {
    return { match: 'no' }
  }
}

export function makeJudge(deps: JudgeDeps): (card: IntentCard) => Promise<JudgeVerdict> {
  const sys = systemPrompt(deps.policy)
  return async (card: IntentCard): Promise<JudgeVerdict> => {
    let raw: string
    try {
      raw = await deps.runTurn(sys, userPrompt(card))
    } catch {
      // runTurn threw (model down, spawn failed, …) — fail to a silent no,
      // never surface the error as a match.
      return { match: 'no' }
    }
    return parseVerdict(raw)
  }
}
