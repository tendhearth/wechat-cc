/**
 * social-judge — the answering-side judge seam.
 *
 * `makeJudge` builds the system/user prompts for judging a peer's 心愿
 * (a topic, optionally a city) against the owner's own derived facts, then
 * defensively parses whatever `runTurn` returns into `{ match, blurb? }`.
 * The ACTUAL agent spawn (which model, which MCP tools, what session
 * lifecycle) is kept behind the injected `runTurn` seam so this module is
 * unit-testable with no live model — the real `runTurn` is the provider
 * registry's own cheapEval, wired in daemon/bootstrap/wire-social.ts.
 *
 * 输入刻意只有 `{ topic, city? }`(2026-09-04):判官读的从来只有这两项,
 * 早先喂给它的是一整张 IntentCard,那条掮客管道退役后连类型一起收窄了。
 *
 * The caller (wire-wish.ts) wraps the verdict this returns in `gateOutbound`
 * before anything crosses the wire — this module's ONLY job is producing a
 * best-effort verdict, never enforcing disclosure itself.
 */

/** 判官要的全部输入 —— 一个话题,可选一个城市。 */
export interface JudgeInput {
  topic: string
  city?: string
}

export interface JudgeDeps {
  /**
   * Run one agent turn with the given system + user prompt and return the
   * assistant's final text. Real impl (wire-social.ts) is the provider
   * registry's own cheapEval — no child session, no MCP tools; the owner's
   * derived facts reach the judge through `ground` below instead. Test impl
   * is a plain fake.
   */
  runTurn: (systemPrompt: string, userPrompt: string) => Promise<string>
  /** Free-text disclosure policy, echoed into the system prompt so the
   *  judge composes an already policy-aware blurb (defence-in-depth #1 —
   *  #2 is the mandatory `gateOutbound` pass in wire-wish.ts). */
  policy: string
  /**
   * Optional in-process grounding fetch: pre-fetched owner facts relevant to
   * this card, appended to the user prompt so the judge reasons over
   * already-retrieved text instead of calling tools itself. Absent =
   * ungrounded (empty text), preserving existing callers/tests. Failures are
   * swallowed to an empty string — grounding is best-effort, never a reason
   * to crash or block the (fail-closed) judge.
   */
  ground?: (card: JudgeInput) => Promise<string>
}

export interface JudgeVerdict {
  match: 'yes' | 'no'
  blurb?: string
}

function systemPrompt(policy: string): string {
  return `你替主人判断是否匹配好友的心愿；根据以下提供的主人资料判断是否匹配；只输出 {"match":"yes|no","blurb":"..."}；遵守披露策略：${policy}；绝不含门牌/第三方`
}

function userPrompt(card: JudgeInput): string {
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

export function makeJudge(deps: JudgeDeps): (card: JudgeInput) => Promise<JudgeVerdict> {
  const sys = systemPrompt(deps.policy)
  return async (card: JudgeInput): Promise<JudgeVerdict> => {
    const grounding = deps.ground
      ? await Promise.resolve().then(() => deps.ground!(card)).catch(() => '')
      : ''
    let raw: string
    try {
      raw = await deps.runTurn(sys, userPrompt(card) + (grounding ? '\n\n' + grounding : ''))
    } catch {
      // runTurn threw (model down, spawn failed, …) — fail to a silent no,
      // never surface the error as a match.
      return { match: 'no' }
    }
    return parseVerdict(raw)
  }
}
