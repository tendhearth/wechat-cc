/**
 * Cursor SDK agent provider.
 *
 * Third registered provider alongside claude / codex. Uses
 * `@cursor/sdk` (loaded via dynamic import in bootstrap) and conforms
 * to the AgentProvider / AgentSession interface defined in
 * src/core/agent-provider.ts.
 *
 * Permission surface is the coarsest of the three providers — Cursor
 * has neither a per-tool callback (cf. Claude's canUseTool) nor a
 * granular sandbox shape (cf. Codex's read-only / workspace-write /
 * danger-full-access). `local.sandboxOptions: { enabled }` is the
 * entire permission surface. Tier mapping reflects that.
 *
 * See docs/superpowers/specs/2026-05-23-cursor-sdk-provider-design.md.
 */
import type { TierProfile } from './user-tier'

export interface CursorTierSdkOpts {
  sandboxOptions: { enabled: boolean }
}

/**
 * Translate daemon TierProfile → Cursor SDK options.
 *
 * Heuristic: a profile with no relay and no deny is admin-equivalent
 * (sandbox off). Any non-empty relay or deny → enable sandbox. Matches
 * the same size-based heuristic Codex uses.
 *
 * Guest gets the same sandbox as trusted — Cursor lacks a read-only
 * mode, so guest can write inside cwd. Documented in README as a
 * known limitation; operators with strict guest separation route
 * guests to Claude.
 */
export function tierProfileToCursorSdkOpts(tp: TierProfile): CursorTierSdkOpts {
  if (tp.relay.size === 0 && tp.deny.size === 0) {
    return { sandboxOptions: { enabled: false } }
  }
  return { sandboxOptions: { enabled: true } }
}
