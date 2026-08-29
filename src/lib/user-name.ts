/**
 * user-name.ts — deterministic display-name normalization for
 * POST /v1/user/set_name (2026-08-25, 「CC眼中的叫我大人」 bug).
 *
 * The agent asks 「喜欢被怎么称呼?」 and the human answers with a whole
 * phrase — 「叫我大人」「喊我阿强就行」 — which the model then passes to
 * `set_user_name` verbatim. The prompt now tells it to extract the name,
 * but prompts drift; this guard makes the common phrasings safe at the
 * route boundary regardless of what the model does.
 *
 * Conservative by design: the stripped remainder is accepted ONLY when it
 * looks like a bare name (1–16 chars, no sentence punctuation). Anything
 * else — empty remainder, a clause with commas, a long sentence — falls
 * back to the trimmed original, so a weird real name can never be mangled
 * into something we invented.
 */

const QUOTE_CHARS = /^[\s「」『』“”"'‘’]+|[\s「」『』“”"'‘’]+$/g
const NAME_PREFIX = /^(?:大家都|你可以|可以|以后|直接|都|就|请)*(?:叫我|喊我|称我|称呼我|管我叫|我叫|我是)/
const NAME_SUFFIX = /(?:就可以|就行|就好|好了|吧|呀|哦|啦)*[~～。！!？?，,\s]*$/
const REJECT_REMAINDER = /[，,。;；:：!！?？\s]/

export function normalizeUserName(raw: string): string {
  const original = raw.replace(QUOTE_CHARS, '')
  if (!NAME_PREFIX.test(original) && !NAME_SUFFIX.exec(original)?.[0]) return original
  const stripped = original.replace(NAME_PREFIX, '').replace(NAME_SUFFIX, '').replace(QUOTE_CHARS, '')
  if (stripped.length === 0 || stripped.length > 16) return original
  if (REJECT_REMAINDER.test(stripped)) return original
  return stripped
}
