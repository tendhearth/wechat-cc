/**
 * Shared nickname constraint — ONE source of truth for "is this a valid
 * nickname". Previously duplicated as onboarding.ts::NICKNAME_RE and
 * admin-commands.ts::BOTNAME_VALID_RE (with a "keep in sync" comment), and
 * missing entirely from mode-commands.ts::/name (which let any chat user
 * persist an unbounded / hostile nickname into per-chat state that later gets
 * interpolated into prompts — a state-bloat + prompt-injection vector).
 */

export const NICKNAME_MAX_LEN = 24
export const NICKNAME_MIN_LEN = 1

// Hyphen ESCAPED because inside a character class an unescaped `-` between two
// range endpoints would be read as a range. `一-鿿` is the CJK Unified
// Ideographs block; the rest is ASCII letters/digits/space/_/-.
export const NICKNAME_RE = /^[一-鿿_a-zA-Z0-9 \-]+$/

export type NicknameError = 'empty' | 'too_long' | 'bad_charset'

/** Validate a proposed (already-trimmed) nickname. Returns null if valid, else
 *  the reason — callers map it to their own user-facing message. */
export function validateNickname(s: string): NicknameError | null {
  if (s.length < NICKNAME_MIN_LEN) return 'empty'
  if (s.length > NICKNAME_MAX_LEN) return 'too_long'
  if (!NICKNAME_RE.test(s)) return 'bad_charset'
  return null
}
