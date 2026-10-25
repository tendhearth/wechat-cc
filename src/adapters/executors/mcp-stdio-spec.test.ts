import { describe, it, expect } from 'vitest'
import { childEnvFor, type McpStdioSpec } from './mcp-stdio-spec'

describe('childEnvFor', () => {
  const spec: McpStdioSpec = { command: 'bun', args: ['x'], env: { FROM_SPEC: 's', SHARED: 'spec' } }

  it('inherits process.env, then spec.env, then mcpEnv — later wins', () => {
    process.env.MCP_SPEC_TEST_VAR = 'host'
    try {
      const env = childEnvFor(spec, { SHARED: 'mcp', WECHAT_SESSION_TOKEN: 'tok' })
      expect(env.MCP_SPEC_TEST_VAR).toBe('host')      // 宿主继承(PATH/HOME 同理)
      expect(env.FROM_SPEC).toBe('s')
      expect(env.SHARED).toBe('mcp')                  // mcpEnv > spec.env
      expect(env.WECHAT_SESSION_TOKEN).toBe('tok')
      expect(env.PATH).toBeDefined()
    } finally { delete process.env.MCP_SPEC_TEST_VAR }
  })

  it('omits non-string process.env entries and tolerates absent optionals', () => {
    const env = childEnvFor({ command: 'x' })
    for (const v of Object.values(env)) expect(typeof v).toBe('string')
  })
})
