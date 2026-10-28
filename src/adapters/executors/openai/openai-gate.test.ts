import { describe, it, expect } from 'vitest'
import { gateTool } from './openai-gate'
import { TIER_PROFILES } from '../../../domain/user-tier'

// TIER_PROFILES is the real user-tier.ts export (Record<UserTier, TierProfile>).
// There is no `tierProfileFor` factory in the module — use the ready-made
// admin/guest profiles directly.
const guest = TIER_PROFILES.guest
const admin = TIER_PROFILES.admin
const trusted = TIER_PROFILES.trusted

describe('gateTool', () => {
  it('denies a deny-classified tool in strict mode', async () => {
    // guest.deny includes fs_write; Write classifies to fs_write.
    await expect(
      gateTool({ toolName: 'Write', input: {}, tierProfile: guest, permissionMode: 'strict', chatId: 'c' }),
    ).resolves.toEqual({ decision: 'deny' })
  })

  it('allows an allow-classified MCP tool (reply) for guest', async () => {
    // guest.allow includes reply; mcp__wechat__reply classifies to reply.
    await expect(
      gateTool({ toolName: 'reply', mcpServer: 'wechat', input: {}, tierProfile: guest, permissionMode: 'strict', chatId: 'c' }),
    ).resolves.toEqual({ decision: 'allow' })
  })

  it('collapses a relay-classified tool to deny in strict mode (v1)', async () => {
    // admin.relay includes shell_destructive; a destructive Bash command
    // classifies to shell_destructive (classifyToolUse's isDestructiveBash).
    await expect(
      gateTool({
        toolName: 'Bash',
        input: { command: 'rm -rf ./__openai_gate_test_sentinel__' }, // 只做分类;字面量也不写真破坏性命令
        tierProfile: admin,
        permissionMode: 'strict',
        chatId: 'c',
      }),
    ).resolves.toEqual({ decision: 'deny' })
  })

  it('allows everything under dangerously', async () => {
    await expect(
      gateTool({
        toolName: 'Bash',
        input: { command: 'rm -rf ./__openai_gate_test_sentinel__' }, // 只做分类;字面量也不写真破坏性命令
        tierProfile: admin,
        permissionMode: 'dangerously',
        chatId: 'c',
      }),
    ).resolves.toEqual({ decision: 'allow' })
  })

  it('does NOT treat a same-named tool from a different MCP server as the wechat reply (tier-escalation regression)', async () => {
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
    await expect(
      gateTool({
        toolName: 'reply',
        mcpServer: 'evilplugin',
        input: {},
        tierProfile: guest,
        permissionMode: 'strict',
        chatId: 'c',
      }),
    ).resolves.toEqual({ decision: 'deny' })
  })

  it('DENIES a plugin tool (wxvault) for a TRUSTED user, ALLOWS it for admin (fail-closed plugin gating)', async () => {
    // wxvault reads the owner's private WeChat history. A trusted non-admin
    // must NOT reach it: mcp__wxvault__get_messages → plugin_tool → trusted.deny.
    // Only the owner (admin) can call it.
    await expect(
      gateTool({ toolName: 'get_messages', mcpServer: 'wxvault', input: {}, tierProfile: trusted, permissionMode: 'strict', chatId: 'c' }),
    ).resolves.toEqual({ decision: 'deny' })
    await expect(
      gateTool({ toolName: 'search_messages', mcpServer: 'wxvault', input: {}, tierProfile: trusted, permissionMode: 'strict', chatId: 'c' }),
    ).resolves.toEqual({ decision: 'deny' })
    await expect(
      gateTool({ toolName: 'get_messages', mcpServer: 'wxvault', input: {}, tierProfile: admin, permissionMode: 'strict', chatId: 'c' }),
    ).resolves.toEqual({ decision: 'allow' })
  })
})
