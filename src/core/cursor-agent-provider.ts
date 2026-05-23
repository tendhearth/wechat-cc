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

/**
 * Parse Cursor's tool name into { server?, tool } for AgentEvent.
 *
 * Cursor SDK docs say "tool call schema is not stable" — the exact
 * format of SDKToolUseMessage.name is unspecified. Handle multiple
 * plausible formats; fall back to no-server if no known MCP server
 * name appears as a prefix.
 *
 * First successful tool call from Cursor logs the observed format so
 * the implementer notices if it diverges (see cursor provider's
 * dispatch loop).
 */
export function mapCursorToolName(
  rawName: string,
  mcpServerNames: ReadonlySet<string>,
): { server?: string; tool: string } {
  // Anthropic-style: mcp__<server>__<tool>
  const m = /^mcp__([^_]+)__(.+)$/.exec(rawName)
  if (m && mcpServerNames.has(m[1]!)) return { server: m[1], tool: m[2]! }
  // Alternate separator forms
  for (const sep of ['__', ':', '/']) {
    const i = rawName.indexOf(sep)
    if (i > 0 && mcpServerNames.has(rawName.slice(0, i))) {
      return { server: rawName.slice(0, i), tool: rawName.slice(i + sep.length) }
    }
  }
  // Built-in tool or unrecognized — no server
  return { tool: rawName }
}
