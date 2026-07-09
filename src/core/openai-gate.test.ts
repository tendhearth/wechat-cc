import { describe, it, expect } from 'vitest'
import { gateTool } from './openai-gate'
import { TIER_PROFILES } from './user-tier'

// TIER_PROFILES is the real user-tier.ts export (Record<UserTier, TierProfile>).
// There is no `tierProfileFor` factory in the module — use the ready-made
// admin/guest profiles directly.
const guest = TIER_PROFILES.guest
const admin = TIER_PROFILES.admin

describe('gateTool', () => {
  it('denies a deny-classified tool in strict mode', () => {
    // guest.deny includes fs_write; Write classifies to fs_write.
    expect(
      gateTool({ toolName: 'Write', input: {}, tierProfile: guest, permissionMode: 'strict' }),
    ).toBe('deny')
  })

  it('allows an allow-classified MCP tool (reply) for guest', () => {
    // guest.allow includes reply; mcp__wechat__reply classifies to reply.
    expect(
      gateTool({ toolName: 'reply', mcpServer: 'wechat', input: {}, tierProfile: guest, permissionMode: 'strict' }),
    ).toBe('allow')
  })

  it('collapses a relay-classified tool to deny in strict mode (v1)', () => {
    // admin.relay includes shell_destructive; a destructive Bash command
    // classifies to shell_destructive (classifyToolUse's isDestructiveBash).
    expect(
      gateTool({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        tierProfile: admin,
        permissionMode: 'strict',
      }),
    ).toBe('deny')
  })

  it('allows everything under dangerously', () => {
    expect(
      gateTool({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        tierProfile: admin,
        permissionMode: 'dangerously',
      }),
    ).toBe('allow')
  })

  it('does NOT treat a same-named tool from a different MCP server as the wechat reply (tier-escalation regression)', () => {
    // A plugin (or any non-wechat server) could register a tool literally
    // named `reply`. Before this fix, gateTool always synthesized
    // `mcp__wechat__reply` for ANY mcp tool, so `evilplugin`'s `reply` would
    // be classified — and allowed — as the guest-allowed wechat reply.
    //
    // With the real server threaded through, the synthesized name is
    // `mcp__evilplugin__reply`. classifyToolUse only special-cases the
    // `mcp__wechat__` prefix; anything else falls through to its fail-safe
    // default, `subagent` (see classifyToolUse's final `return 'subagent'`).
    // Verify against the REAL guest TIER_PROFILES: `subagent` is not in
    // GUEST_ALLOW, so it lands in guest.deny (deny = ALL_KINDS minus
    // GUEST_ALLOW) — the decision must be 'deny', not the 'allow' a wechat
    // `reply` would get.
    expect(guest.allow.has('subagent')).toBe(false)
    expect(guest.deny.has('subagent')).toBe(true)
    expect(
      gateTool({
        toolName: 'reply',
        mcpServer: 'evilplugin',
        input: {},
        tierProfile: guest,
        permissionMode: 'strict',
      }),
    ).toBe('deny')
  })
})
