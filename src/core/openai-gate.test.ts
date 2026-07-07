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
      gateTool({ toolName: 'Write', isMcp: false, input: {}, tierProfile: guest, permissionMode: 'strict' }),
    ).toBe('deny')
  })

  it('allows an allow-classified MCP tool (reply) for guest', () => {
    // guest.allow includes reply; mcp__wechat__reply classifies to reply.
    expect(
      gateTool({ toolName: 'reply', isMcp: true, input: {}, tierProfile: guest, permissionMode: 'strict' }),
    ).toBe('allow')
  })

  it('collapses a relay-classified tool to deny in strict mode (v1)', () => {
    // admin.relay includes shell_destructive; a destructive Bash command
    // classifies to shell_destructive (classifyToolUse's isDestructiveBash).
    expect(
      gateTool({
        toolName: 'Bash',
        isMcp: false,
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
        isMcp: false,
        input: { command: 'rm -rf /' },
        tierProfile: admin,
        permissionMode: 'dangerously',
      }),
    ).toBe('allow')
  })
})
