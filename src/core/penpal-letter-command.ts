/**
 * penpal-letter-command.ts — the WeChat 回信 (reply-letter) trigger. The
 * owner replies "回信 <channel> <text>" (channel = the penpal channel row id,
 * with an optional leading #; text = the free-form letter body, which may
 * itself contain spaces/newlines) to send an outbound letter on that
 * anonymous pen-pal channel. Mirrors reveal-command.ts's parse idiom.
 */
export function parseLetterCommand(text: string): { channel: string; text: string } | null {
  const m = text.trim().match(/^回信\s+#?(\S+)\s+([\s\S]+?)\s*$/)
  if (!m) return null
  return { channel: m[1]!, text: m[2]! }
}
