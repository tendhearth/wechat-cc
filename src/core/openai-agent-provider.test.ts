import { describe, it, expect } from 'vitest'
import { OPENAI_CAPABILITIES, mapDeltaToEvent } from './openai-agent-provider'

describe('openai capabilities + mapping', () => {
  it('declares perToolCallback true, empty sandbox, no resume', () => {
    expect(OPENAI_CAPABILITIES.perToolCallback).toBe(true)
    expect(OPENAI_CAPABILITIES.sandboxLevels.size).toBe(0)
    expect(OPENAI_CAPABILITIES.supportsResume).toBe(false)
  })

  it('maps a text delta to a text event', () => {
    expect(mapDeltaToEvent({ kind: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' })
  })

  it('maps a tool_call delta to a tool_call event with wechat server for MCP tools', () => {
    expect(mapDeltaToEvent({ kind: 'tool_call', id: 'c1', name: 'reply', input: {} }))
      .toMatchObject({ kind: 'tool_call', tool: 'reply', server: 'wechat' })
  })

  it('maps a tool_call delta for a non-wechat tool without a server field', () => {
    const ev = mapDeltaToEvent({ kind: 'tool_call', id: 'c2', name: 'some_other_tool', input: {} })
    expect(ev).toEqual({ kind: 'tool_call', tool: 'some_other_tool' })
  })
})
