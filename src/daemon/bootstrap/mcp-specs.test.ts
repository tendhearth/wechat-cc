import { describe, it, expect, vi, afterEach } from 'vitest'
import { wechatStdioMcpSpec, delegateStdioMcpSpec, buildOpenaiMcpSpecs } from './mcp-specs'
import * as runtimeInfo from '../../lib/runtime-info'

const deps = {
  baseUrl: 'http://127.0.0.1:54321',
  tokenFilePath: '/some/abs/path/internal-token',
}

describe('wechatStdioMcpSpec', () => {
  afterEach(() => vi.restoreAllMocks())

  it('source mode → args is the absolute path to src/mcp-servers/wechat/main.ts', () => {
    vi.spyOn(runtimeInfo, 'isCompiledBundle').mockReturnValue(false)
    const spec = wechatStdioMcpSpec(deps)
    expect(spec.args).toHaveLength(1)
    expect(spec.args[0]).toMatch(/[/\\]src[/\\]mcp-servers[/\\]wechat[/\\]main\.ts$/)
    expect(spec.command).toBe(process.execPath)
  })

  it('compiled mode → args is ["mcp-server", "wechat"] (Bug v0.5.4 → v0.5.5 fix)', () => {
    vi.spyOn(runtimeInfo, 'isCompiledBundle').mockReturnValue(true)
    const spec = wechatStdioMcpSpec(deps)
    expect(spec.args).toEqual(['mcp-server', 'wechat'])
    expect(spec.command).toBe(process.execPath)
  })

  it('passes participantTag through env when provided', () => {
    const spec = wechatStdioMcpSpec(deps, 'claude')
    expect(spec.env.WECHAT_PARTICIPANT_TAG).toBe('claude')
  })

  it('omits participantTag from env when not provided', () => {
    const spec = wechatStdioMcpSpec(deps)
    expect(spec.env.WECHAT_PARTICIPANT_TAG).toBeUndefined()
  })

  it('always sets WECHAT_INTERNAL_API + WECHAT_INTERNAL_TOKEN_FILE', () => {
    const spec = wechatStdioMcpSpec(deps)
    expect(spec.env.WECHAT_INTERNAL_API).toBe(deps.baseUrl)
    expect(spec.env.WECHAT_INTERNAL_TOKEN_FILE).toBe(deps.tokenFilePath)
  })
})

describe('delegateStdioMcpSpec', () => {
  afterEach(() => vi.restoreAllMocks())

  it('source mode → args is the absolute path to src/mcp-servers/delegate/main.ts', () => {
    vi.spyOn(runtimeInfo, 'isCompiledBundle').mockReturnValue(false)
    const spec = delegateStdioMcpSpec(deps, 'codex')
    expect(spec.args).toHaveLength(1)
    expect(spec.args[0]).toMatch(/[/\\]src[/\\]mcp-servers[/\\]delegate[/\\]main\.ts$/)
  })

  it('compiled mode → args is ["mcp-server", "delegate"]', () => {
    vi.spyOn(runtimeInfo, 'isCompiledBundle').mockReturnValue(true)
    const spec = delegateStdioMcpSpec(deps, 'codex')
    expect(spec.args).toEqual(['mcp-server', 'delegate'])
  })

  it('sets WECHAT_DELEGATE_PEER from the peer arg', () => {
    expect(delegateStdioMcpSpec(deps, 'codex').env.WECHAT_DELEGATE_PEER).toBe('codex')
    expect(delegateStdioMcpSpec(deps, 'claude').env.WECHAT_DELEGATE_PEER).toBe('claude')
  })
})

// Security regression guard for commit 9a75393's openai `makeMcpBridge`
// closure, which hand-rolled the per-spec env merge and spread sessionEnv
// (WECHAT_SESSION_TOKEN) into every plugin MCP spec — letting third-party
// plugin code impersonate the agent against the loopback internal-api.
// buildOpenaiMcpSpecs is the extracted, gated replacement; assert directly
// that only wechat/delegate ever receive the token.
describe('buildOpenaiMcpSpecs', () => {
  const wechatSpec: import('./mcp-specs').McpStdioSpec = {
    command: 'bun', args: ['wechat/main.ts'], env: { WECHAT_INTERNAL_API: 'http://x' },
  }
  const delegateSpec: import('./mcp-specs').McpStdioSpec = {
    command: 'bun', args: ['delegate/main.ts'], env: { WECHAT_DELEGATE_PEER: 'openai' },
  }
  const pluginSpec: import('./mcp-specs').McpStdioSpec = {
    command: 'node', args: ['plugin/main.js'], env: { SOME_PLUGIN_VAR: '1' },
  }
  const sessionEnv = { WECHAT_SESSION_TOKEN: 'super-secret-token', WECHAT_SESSION_TIER: 'admin' }

  it('injects sessionEnv (incl. WECHAT_SESSION_TOKEN) into wechat and delegate specs only', () => {
    const specs = buildOpenaiMcpSpecs(
      { wechat: wechatSpec, delegate: delegateSpec, pluginMcp: { myPlugin: pluginSpec } },
      sessionEnv,
    )
    expect(specs.wechat!.env.WECHAT_SESSION_TOKEN).toBe('super-secret-token')
    expect(specs.delegate!.env.WECHAT_SESSION_TOKEN).toBe('super-secret-token')
  })

  it('does NOT leak WECHAT_SESSION_TOKEN into plugin MCP specs', () => {
    const specs = buildOpenaiMcpSpecs(
      { wechat: wechatSpec, delegate: delegateSpec, pluginMcp: { myPlugin: pluginSpec } },
      sessionEnv,
    )
    expect(specs.myPlugin!.env.WECHAT_SESSION_TOKEN).toBeUndefined()
    expect(specs.myPlugin!.env.WECHAT_SESSION_TIER).toBeUndefined()
    expect(specs.myPlugin!.env).toEqual({ SOME_PLUGIN_VAR: '1' })
  })

  it('omits wechat/delegate keys entirely when their specs are null', () => {
    const specs = buildOpenaiMcpSpecs({ wechat: null, delegate: null, pluginMcp: { myPlugin: pluginSpec } }, sessionEnv)
    expect(specs.wechat).toBeUndefined()
    expect(specs.delegate).toBeUndefined()
    expect(specs.myPlugin!.env.WECHAT_SESSION_TOKEN).toBeUndefined()
  })
})
