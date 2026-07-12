import type { CheapEval } from './agent-provider'

const CHECKER_PROMPT = (policy: string, text: string) => `你是一个隐私披露审查器。判断下面这段"要发给一位已配对好友的 agent"的文本是否违反主人的披露策略。
铁律(高于策略):绝不能提到除"我主人"和"收件方"以外的任何第三方(其他人的名字/事);绝不含联系方式。
披露策略:
${policy}

待审文本:
"""${text}"""

只输出一行 JSON,无解释:{"violation": <true|false>, "redacted": "<把违规内容删干净后的安全文本;若无违规则原样返回>", "reasons": ["<简短原因>"]}`

export async function gateOutbound(
  text: string,
  opts: { policy: string; peerNames: string[]; cheapEval: CheapEval },
): Promise<{ ok: boolean; redacted: string; violations: string[] }> {
  let raw: string
  try {
    raw = await opts.cheapEval(CHECKER_PROMPT(opts.policy, text))
  } catch (err) {
    // Fail CLOSED — a disclosure leak is worse than a dropped match.
    return { ok: false, redacted: '', violations: ['checker_error: ' + (err instanceof Error ? err.message : String(err))] }
  }
  let parsed: { violation?: unknown; redacted?: unknown; reasons?: unknown }
  try {
    const m = raw.match(/\{[\s\S]*\}/)   // tolerate stray prose around the JSON
    parsed = JSON.parse(m ? m[0] : raw)
  } catch {
    return { ok: false, redacted: '', violations: ['checker_unparseable'] }
  }
  const violation = parsed.violation === true
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : []
  const redacted = typeof parsed.redacted === 'string' ? parsed.redacted : ''
  return violation
    ? { ok: false, redacted, violations: reasons.length ? reasons : ['policy_violation'] }
    : { ok: true, redacted: redacted || text, violations: [] }
}
