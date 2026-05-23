import { describe, it, expect } from 'vitest'
import { mapCursorToolName, tierProfileToCursorSdkOpts } from './cursor-agent-provider'
import { TIER_PROFILES } from './user-tier'

describe('tierProfileToCursorSdkOpts', () => {
  it('admin → sandbox disabled', () => {
    const out = tierProfileToCursorSdkOpts(TIER_PROFILES.admin)
    expect(out.sandboxOptions.enabled).toBe(false)
  })

  it('trusted → sandbox enabled', () => {
    const out = tierProfileToCursorSdkOpts(TIER_PROFILES.trusted)
    expect(out.sandboxOptions.enabled).toBe(true)
  })

  it('guest → sandbox enabled (lossier than codex read-only; documented)', () => {
    const out = tierProfileToCursorSdkOpts(TIER_PROFILES.guest)
    expect(out.sandboxOptions.enabled).toBe(true)
  })
})

describe('mapCursorToolName', () => {
  const mcpServers = new Set(['wechat', 'delegate'])

  it('parses Anthropic-style mcp__<server>__<tool>', () => {
    expect(mapCursorToolName('mcp__wechat__reply', mcpServers)).toEqual({
      server: 'wechat', tool: 'reply',
    })
  })

  it('parses double-underscore <server>__<tool>', () => {
    expect(mapCursorToolName('wechat__reply', mcpServers)).toEqual({
      server: 'wechat', tool: 'reply',
    })
  })

  it('parses colon-separated <server>:<tool>', () => {
    expect(mapCursorToolName('wechat:reply', mcpServers)).toEqual({
      server: 'wechat', tool: 'reply',
    })
  })

  it('parses slash-separated <server>/<tool>', () => {
    expect(mapCursorToolName('wechat/reply', mcpServers)).toEqual({
      server: 'wechat', tool: 'reply',
    })
  })

  it('unknown server falls back to no-server (built-in)', () => {
    expect(mapCursorToolName('Read', mcpServers)).toEqual({ tool: 'Read' })
  })

  it('mcp__-prefix with unknown server falls back', () => {
    expect(mapCursorToolName('mcp__unknown__foo', mcpServers)).toEqual({
      tool: 'mcp__unknown__foo',
    })
  })

  it('handles tool name with multiple separators (greedy split on first match)', () => {
    expect(mapCursorToolName('wechat__memory__read', mcpServers)).toEqual({
      server: 'wechat', tool: 'memory__read',
    })
  })
})
