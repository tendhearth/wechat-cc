/**
 * Rough token estimator for prompt-cost auditing (scripts/prompt-audit.ts).
 * Heuristic, not a tokenizer: CJK chars (incl. CJK punctuation) ≈ 1 token
 * each; everything else ≈ 3.8 chars/token. Good to ±20% — enough to rank
 * prompt sections by cost, not enough for billing math.
 */
const CJK_RE = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/u

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 3.8)
}
