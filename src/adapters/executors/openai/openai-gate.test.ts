import { describe, it, expect, vi } from 'vitest'
import { gateTool } from './openai-gate'
import { TIER_PROFILES } from '../../../domain/user-tier'

// TIER_PROFILES is the real user-tier.ts export (Record<UserTier, TierProfile>).
// There is no `tierProfileFor` factory in the module — use the ready-made
// admin/guest profiles directly.
const guest = TIER_PROFILES.guest
const admin = TIER_PROFILES.admin
const trusted = TIER_PROFILES.trusted

describe('gateTool', () => {
  it.each(['matter_handoff', 'model_set', 'session_release', 'daemon_restart'])('asks the owner for %s, matching Claude; non-admins remain denied', async toolName => {
    const askUser = vi.fn(async () => 'allow' as const)
    for (const [tierProfile, decision] of [[admin, 'allow'], [trusted, 'deny'], [guest, 'deny']] as const) {
      const result = await gateTool({ toolName, mcpServer: 'wechat', input: { id: 'a85aec02' }, tierProfile, permissionMode: 'strict', chatId: 'initiator', approval: { askUser, adminFor: () => 'owner' } })
      expect(result.decision).toBe(decision)
    }
    expect(askUser).toHaveBeenCalledOnce()
    expect(askUser).toHaveBeenCalledWith('owner', expect.stringContaining(toolName), expect.stringMatching(/^[a-z0-9]{5}$/), 600_000)
  })

  it.each(['deny', 'timeout', 'undelivered', 'no-admin', 'throw', 'cancelled'] as const)('approval failure stays denied: %s', async outcome => {
    const abort = new AbortController()
    const askUser = vi.fn(async () => {
      if (outcome === 'throw') throw Error('offline')
      if (outcome === 'cancelled') abort.abort()
      return outcome === 'cancelled' || outcome === 'no-admin' ? 'allow' as const : outcome
    })
    const result = await gateTool({ toolName: 'matter_handoff', mcpServer: 'wechat', input: {}, tierProfile: admin, permissionMode: 'strict', chatId: 'initiator', signal: abort.signal, approval: { askUser, adminFor: () => outcome === 'no-admin' ? null : 'owner' } })
    expect(result.decision).toBe('deny')
    expect(askUser).toHaveBeenCalledTimes(outcome === 'no-admin' ? 0 : 1)
  })

  it.each([
    { toolName: 'memory_delete', mcpServer: 'wechat', input: {}, tierProfile: admin },
    { toolName: 'memory_delete', mcpServer: 'wechat', input: {}, tierProfile: trusted },
    { toolName: 'Bash', input: { command: 'rm ./__offline_sentinel__' }, tierProfile: admin },
    { toolName: 'Bash', input: { command: 'rm ./__offline_sentinel__' }, tierProfile: trusted },
    { toolName: 'a2a_send', mcpServer: 'wechat', input: {}, tierProfile: trusted },
  ])('other relay kinds also use owner approval: $toolName/$tierProfile.name', async call => {
    const askUser = vi.fn(async () => 'allow' as const)
    expect((await gateTool({ ...call, permissionMode: 'strict', chatId: 'c', approval: { askUser, adminFor: () => 'owner' } })).decision).toBe('allow')
    expect(askUser).toHaveBeenCalledOnce()
  })
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

  it('denies a relay-classified tool when no approval channel is provided', async () => {
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
