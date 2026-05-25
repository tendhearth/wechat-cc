/**
 * bot-name — derive the bot's user-facing self-name. Two-stage:
 *
 *   1. If agent-config has bot_name set (admin chose one), use it.
 *   2. Otherwise derive from the active conversation mode
 *      (claude → cc, codex → codex, parallel/chatroom → cc + codex).
 *
 * The override is set via the daemon's first-scan onboarding flow or
 * the `/name` admin command. Pass the agentConfig REFERENCE around so
 * mutations (saveAgentConfig + in-place update) are visible to all
 * callers without a per-message file read.
 *
 * Keep this pure (no I/O, no registry) so it's trivially testable and
 * safe to call from anywhere in the request hot path.
 */
import type { Mode } from '../core/conversation'

/** Mode-derived fallback. Public for tests + the rare caller that
 *  genuinely wants the mode-only name (e.g. the "回到默认" reply in
 *  /name and the skip-word path in onboarding). */
export function botNameFromModeFallback(mode: Mode): string {
  const nameOf = (id: string): string => (id === 'claude' ? 'cc' : id)
  switch (mode.kind) {
    case 'solo':         return nameOf(mode.provider)
    case 'primary_tool': return nameOf(mode.primary)
    case 'parallel':
    case 'chatroom':     return 'cc + codex'
  }
}

/** Override (cfg.bot_name) wins; falls back to mode-derived name when
 *  the override is null / undefined / empty / whitespace. */
export function botName(mode: Mode, cfg: { bot_name?: string | null }): string {
  const override = cfg.bot_name?.trim()
  if (override) return override
  return botNameFromModeFallback(mode)
}
