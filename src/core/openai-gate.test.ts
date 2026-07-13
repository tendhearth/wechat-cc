import { describe, it, expect } from 'vitest'
import { gateTool } from './openai-gate'
import { TIER_PROFILES } from './user-tier'

// TIER_PROFILES is the real user-tier.ts export (Record<UserTier, TierProfile>).
// There is no `tierProfileFor` factory in the module — use the ready-made
// admin/guest profiles directly.
const guest = TIER_PROFILES.guest
const admin = TIER_PROFILES.admin
const trusted = TIER_PROFILES.trusted

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
    // `mcp__evilplugin__reply`. classifyToolUse special-cases `mcp__wechat__`
    // and `mcp__delegate__`; any OTHER mcp prefix is a third-party plugin →
    // classified as the admin-only `plugin_tool`. Verify against the REAL guest
    // TIER_PROFILES: `plugin_tool` is admin-only (∈ guest.deny), so the decision
    // must be 'deny', not the 'allow' a wechat `reply` would get.
    expect(guest.allow.has('plugin_tool')).toBe(false)
    expect(guest.deny.has('plugin_tool')).toBe(true)
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

  it('DENIES a plugin tool (wxvault) for a TRUSTED user, ALLOWS it for admin (fail-closed plugin gating)', () => {
    // wxvault reads the owner's private WeChat history. A trusted non-admin
    // must NOT reach it: mcp__wxvault__get_messages → plugin_tool → trusted.deny.
    // Only the owner (admin) can call it.
    expect(
      gateTool({ toolName: 'get_messages', mcpServer: 'wxvault', input: {}, tierProfile: trusted, permissionMode: 'strict' }),
    ).toBe('deny')
    expect(
      gateTool({ toolName: 'search_messages', mcpServer: 'wxvault', input: {}, tierProfile: trusted, permissionMode: 'strict' }),
    ).toBe('deny')
    expect(
      gateTool({ toolName: 'get_messages', mcpServer: 'wxvault', input: {}, tierProfile: admin, permissionMode: 'strict' }),
    ).toBe('allow')
  })
})
