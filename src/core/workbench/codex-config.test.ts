import { expect, it } from 'vitest'
import { workbenchCodexConfig, workbenchCodexArgs, workbenchCodexEnv, workbenchCodexNativeConfig } from './codex-config'

it('overrides inherited approval, sandbox, network, features and every discovered MCP', () => {
  const config = workbenchCodexConfig([{ name: 'personal', enabled: true, env: { SECRET: 'private' } }])
  expect(config).toMatchObject({
    features: { plugins: false, apps: false, hooks: false },
    approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write',
    sandbox_workspace_write: { network_access: false, writable_roots: [], exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
    shell_environment_policy: { inherit: 'core', ignore_default_excludes: false, experimental_use_profile: false, include_only: ['PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'USER'] },
    web_search: 'disabled', mcp_servers: { personal: { enabled: false } },
  })
  const args = workbenchCodexArgs(config)
  expect(args).toContain('mcp_servers.personal.enabled=false')
  expect(args).toContain('approval_policy="on-request"')
  expect(args).toContain('sandbox_workspace_write.writable_roots=[]')
  expect(args).toContain('shell_environment_policy.inherit="core"')
  expect(JSON.stringify({ config, args })).not.toContain('private')
})

it('retains enabled external MCPs with mandatory one-shot approval while preserving native restrictions', () => {
  const config = workbenchCodexNativeConfig([{ name: 'github', enabled: true }, { name: 'off', enabled: false }], {
    web_search: 'live', mcp_servers: {
      github: { command: '/tools/github', env: { TOKEN: 'private' }, tools: { create_issue: { approval_mode: 'approve' }, 'read.issue': { output_token_limit: 100 } }, enabled_tools: ['create_issue'], disabled_tools: ['delete_issue'] },
      off: { command: '/tools/off' },
    },
  })
  expect(config).toMatchObject({
    features: { tool_call_mcp_elicitation: true }, web_search: 'live',
    approval_policy: 'on-request', sandbox_mode: 'workspace-write',
    mcp_servers: { github: { enabled: true, default_tools_approval_mode: 'prompt', tools: { create_issue: { approval_mode: 'prompt' }, 'read.issue': { approval_mode: 'prompt' } } }, off: { enabled: false } },
  })
  // Credentials and native tool allow/deny lists stay in native config, not copied into CC overrides.
  expect(JSON.stringify(config)).not.toContain('private')
  expect(config.mcp_servers.github).not.toHaveProperty('enabled_tools')
  expect(config.mcp_servers.github).not.toHaveProperty('disabled_tools')
})

it.each([undefined, null, 'cached', 'disabled'])('uses cached search by default and respects configured safe mode %s', mode => {
  expect(workbenchCodexNativeConfig([], { web_search: mode }).web_search).toBe(mode ?? 'cached')
})

it.each([
  ['wechat', { command: '/tools/server' }],
  ['delegate', { command: '/tools/server' }],
  ['wxvault', { command: '/tools/server' }],
  ['renamed', { command: '/usr/bin/bun', args: ['/project/src/daemon/mcp-servers/wechat/main.ts'] }],
  ['renamed', { command: '/tools/wechat-cc-cli', args: ['mcp-server', 'delegate'] }],
  ['renamed', { command: '/tools/external', env: { WECHAT_INTERNAL_API: 'http://127.0.0.1:9999' } }],
  ['renamed', { url: 'https://tools.example/mcp', bearer_token_env_var: 'WECHAT_SESSION_TOKEN' }],
  ['renamed', { command: '/tools/external', env: { TOKEN_FILE: '/user/.claude/channels/wechat/internal-token' } }],
  ['renamed', { command: '/tools/external', env_vars: [{ name: 'WECHAT_SESSION_TOKEN', source: 'local' }] }],
])('does not start companion integration %s even under another transport name', (name, native) => {
  const config = workbenchCodexNativeConfig([{ name, enabled: true }], { mcp_servers: { [name]: native } })
  expect(config.mcp_servers[name]).toEqual({ enabled: false })
})

it('disables undiscovered and remote tools and fails closed on malformed tool approval config', () => {
  expect(workbenchCodexNativeConfig([], { mcp_servers: { new_server: { command: '/tool' } } }).mcp_servers).toEqual({ new_server: { enabled: false } })
  expect(workbenchCodexNativeConfig([{ name: 'remote', enabled: true }], { mcp_servers: { remote: { command: '/tool', environment_id: 'remote' } } }).mcp_servers.remote).toEqual({ enabled: false })
  for (const native of [{ tools: [] }, { tools: { unsafe: null } }]) {
    expect(() => workbenchCodexNativeConfig([{ name: 'external', enabled: true }], { mcp_servers: { external: { command: '/tool', ...native } } })).toThrow()
  }
})

it('keeps special server names as own data keys without modifying the registry prototype', () => {
  const config = workbenchCodexNativeConfig([], JSON.parse('{"mcp_servers":{"__proto__":{"command":"/tool"},"constructor":{"command":"/tool"}}}'))
  expect(Object.hasOwn(config.mcp_servers, '__proto__')).toBe(true)
  expect(Object.hasOwn(config.mcp_servers, 'constructor')).toBe(true)
  expect(config.mcp_servers['__proto__']).toEqual({ enabled: false })
})

it('removes daemon-private environment while keeping Codex provider authentication and transport environment', () => {
  const source = {
    PATH: '/bin', HOME: '/user', CODEX_HOME: '/codex-home', OPENAI_API_KEY: 'codex-key',
    CODEX_API_KEY: 'codex-key', OPENAI_BASE_URL: 'https://provider.example', HTTPS_PROXY: 'http://proxy.example',
    WECHAT_INTERNAL_TOKEN_FILE: '/private/token', HEARTH_VAULT: '/private/vault', WXVAULT_TOKEN: 'private',
    WECHAT_OPENAI_API_KEY: 'private', WECHAT_SESSION_TOKEN: 'private', WECHAT_SESSION_TIER: 'owner',
    GOOGLE_API_KEY: 'configured-codex-provider-key',
  }
  const expected = {
    PATH: '/bin', HOME: '/user', CODEX_HOME: '/codex-home', OPENAI_API_KEY: 'codex-key',
    CODEX_API_KEY: 'codex-key', OPENAI_BASE_URL: 'https://provider.example', HTTPS_PROXY: 'http://proxy.example',
    GOOGLE_API_KEY: 'configured-codex-provider-key',
  }
  const actual = workbenchCodexEnv(source)
  // A regression must never print the ambient credential values in a diff.
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
  for (const [key, value] of Object.entries(expected)) expect(actual[key] === value).toBe(true)
  expect(source.WECHAT_INTERNAL_TOKEN_FILE).toBe('/private/token')
})

it('fails closed on unrecognized MCP discovery instead of silently starting with inherited tools', () => {
  for (const value of [null, {}, [{}], [{ name: '' }], [{ name: 'unsafe.name' }]]) {
    expect(() => workbenchCodexConfig(value)).toThrow()
  }
  expect(workbenchCodexConfig([]).mcp_servers).toEqual({})
})
