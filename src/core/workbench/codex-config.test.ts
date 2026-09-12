import { expect, it } from 'vitest'
import { workbenchCodexConfig, workbenchCodexArgs, workbenchCodexEnv } from './codex-config'

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
