import type { CheapEval } from './agent-provider'

/** 脱敏审查的 LLM 调用**兜底**上限:坏网/慢 provider 下不干等到它自己的超时
 *  (几十秒)。超时按「审查器不可用」处理(fail closed)——见 gateOutbound。
 *
 *  2026-09-01:这个常数曾经是唯一的上限,而它低于 agy 的下限(CLI 冷启动
 *  单次实测 10.3–14.3s),派心愿于是时灵时不灵地报 checker_unavailable。
 *  现在调用方应当传 `timeoutMs`(来自
 *  `ProviderRegistry.getCheapEvalBudgetMs()`),这里只是没人传时的默认。 */
export const GATE_TIMEOUT_MS = 12_000

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('gate_timeout')), ms) }),
    ])
  } finally {
    if (t) clearTimeout(t)
  }
}

const CHECKER_PROMPT = (policy: string, text: string) => `你是一个隐私披露审查器。判断下面这段"要发给一位已配对好友的 agent"的文本是否违反主人的披露策略。
铁律(高于策略,必须严格执行,这是本层唯一的第三方防护):绝不能提到除"我主人"和"收件方"以外的任何第三方(包括任何其他人的姓名、称呼、可识别的事);绝不含联系方式。
披露策略:
${policy}

待审文本:
"""${text}"""

只输出一行 JSON,无解释:{"violation": <true|false>, "redacted": "<把违规内容删干净后的安全文本;若无违规则原样返回>", "reasons": ["<简短原因>"]}`

/**
 * 这一串 violations 是「审查器自己没跑成」,还是「主人的话真的违规」?
 *
 * gateOutbound **从不抛** —— 超时、provider 挂了、回话不是 JSON,统统变成
 * `{ ok:false, violations:['checker_timeout' | 'checker_error: …' | …] }`。
 * 调用方要是只看 `ok`,就会把「模型没响应」当成「你这句话不能说」报给主人,
 * 甚至把违规原因栏填上一句 checker_timeout。两者的处置完全不同:真违规要
 * 告诉主人哪里不能说,审查器故障只能说「稍后再试」。
 */
export function isCheckerFailure(violations: readonly string[]): boolean {
  return violations.some(v =>
    v === 'checker_timeout' || v === 'checker_unparseable'
    || v === 'checker_malformed' || v === 'checker_malformed_schema'
    || v.startsWith('checker_error'))
}

export async function gateOutbound(
  text: string,
  opts: { policy: string; cheapEval: CheapEval; timeoutMs?: number },
): Promise<{ ok: boolean; redacted: string; violations: string[] }> {
  let raw: string
  try {
    raw = await withTimeout(opts.cheapEval(CHECKER_PROMPT(opts.policy, text)), opts.timeoutMs ?? GATE_TIMEOUT_MS)
  } catch (err) {
    // Fail CLOSED — a disclosure leak is worse than a dropped match.
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, redacted: '', violations: [msg === 'gate_timeout' ? 'checker_timeout' : 'checker_error: ' + msg] }
  }
  let parsedRaw: unknown
  try {
    const m = raw.match(/\{[\s\S]*\}/)   // tolerate stray prose around the JSON
    parsedRaw = JSON.parse(m ? m[0] : raw)
  } catch {
    return { ok: false, redacted: '', violations: ['checker_unparseable'] }
  }
  // Fail CLOSED — only a well-typed object with an explicit boolean `violation`
  // field counts as a usable checker response. Anything else (null, arrays,
  // primitives, missing/mistyped `violation`) is treated as a malformed check.
  if (typeof parsedRaw !== 'object' || parsedRaw === null || Array.isArray(parsedRaw)) {
    return { ok: false, redacted: '', violations: ['checker_malformed'] }
  }
  const parsed = parsedRaw as Record<string, unknown>
  if (typeof parsed.violation !== 'boolean') {
    return { ok: false, redacted: '', violations: ['checker_malformed_schema'] }
  }
  const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : []
  const redacted = typeof parsed.redacted === 'string' ? parsed.redacted : ''
  return parsed.violation
    ? { ok: false, redacted, violations: reasons.length ? reasons : ['policy_violation'] }
    : { ok: true, redacted: redacted || text, violations: [] }
}
