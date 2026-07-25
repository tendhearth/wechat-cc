/**
 * reveal-command.ts — the WeChat 揭晓 (reveal) trigger. The operator replies
 * "揭晓 <id>" (id = the full echo/pledge id, `intent_id:peer_agent_id`, with an
 * optional leading #). Returns the id to reveal, or null when the text isn't a
 * reveal command. Bare "揭晓" (reply-to-a-notification) is deferred — it needs a
 * persisted last-beat context the async-spine data model doesn't carry.
 */
export function parseRevealCommand(text: string): { id: string } | null {
  const m = text.trim().match(/^揭晓\s+#?(\S+)\s*$/)
  if (!m) return null
  return { id: m[1]! }
}
