import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNativeClaudeTools } from './claude-native-config'
import {removeTempDir} from '../../lib/test-temp'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeTempDir(root) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cc-claude-config-')); roots.push(root)
  const project = join(root, 'project'); mkdirSync(join(project, '.claude'), { recursive: true })
  mkdirSync(join(root, '.claude'))
  const json = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data))
  return { root, project, json, env: { HOME: root } }
}
it('retains enabled native MCPs with local > project > user precedence without touching config', () => {
  const f = fixture(), config = join(f.root, '.claude.json')
  f.json(config, { mcpServers: { catalog: { command: 'global' }, shared: { type: 'http', url: 'https://tools.example/mcp', headers: { Authorization: 'secret' } } }, projects: {
    [f.project]: { mcpServers: { catalog: { command: 'local' } }, enabledMcpjsonServers: ['catalog', 'project_tool'] },
  } })
  f.json(join(f.project, '.mcp.json'), { mcpServers: { catalog: { command: 'project' }, project_tool: { command: 'project-tool' }, unapproved: { command: 'not-approved' } } })
  const before = readFileSync(config, 'utf8'), result = readNativeClaudeTools(f.project, f.env)
  expect(result.servers.catalog).toEqual({ command: 'local' })
  expect(result.servers.project_tool).toEqual({ command: 'project-tool' })
  expect(result.servers.shared).toMatchObject({ type: 'http', url: 'https://tools.example/mcp' })
  expect((result.servers.shared as { headers: Record<string, string> }).headers.Authorization === 'secret').toBe(true)
  expect(result.servers).not.toHaveProperty('unapproved')
  expect(result.omitted).toContain('unapproved')
  expect(readFileSync(config, 'utf8')).toBe(before)
})
it('honors rejected tools and excludes companion aliases before startup', () => {
  const f = fixture()
  f.json(join(f.root, '.claude.json'), { mcpServers: {
    wechat: { command: 'anything' }, delegate: { command: 'anything' },
    renamed: { command: 'bun', args: ['/opt/wechat-cc/src/mcp/index.ts'] },
    credentialAlias: { command: 'bun', env: { WECHAT_SESSION_TOKEN: 'secret' } },
    enabled: { command: 'node', args: ['catalog.js'] }, disabled: { command: 'node' },
  }, projects: { [f.project]: { disabledMcpServers: ['disabled'] } } })
  expect(Object.keys(readNativeClaudeTools(f.project, f.env).servers)).toEqual(['enabled'])
})
it('honors project settings approvals and local rejection', () => {
  const f = fixture()
  f.json(join(f.project, '.mcp.json'), { mcpServers: { a: { command: 'a' }, b: { command: 'b' } } })
  f.json(join(f.project, '.claude/settings.json'), { enableAllProjectMcpServers: true })
  f.json(join(f.project, '.claude/settings.local.json'), { disabledMcpjsonServers: ['b'] })
  expect(Object.keys(readNativeClaudeTools(f.project, f.env).servers)).toEqual(['a'])
})
it('honors explicit native disabled flags and a relocated Claude configuration directory', () => {
  const f = fixture(), configDir = join(f.root, 'native-config'); mkdirSync(configDir)
  f.json(join(configDir, '.claude.json'), { mcpServers:{ off:{command:'off',enabled:false}, on:{command:'on'} } })
  expect(Object.keys(readNativeClaudeTools(f.project, {...f.env,CLAUDE_CONFIG_DIR:configDir}).servers)).toEqual(['on'])
})
it('reports malformed configuration without its contents or credentials', () => {
  const f = fixture()
  writeFileSync(join(f.root, '.claude.json'), '{ invalid secret_token_value')
  expect(() => readNativeClaudeTools(f.project, f.env)).toThrow('Claude 的本机工具配置无法读取')
})
it('omits unsupported or malformed server entries instead of launching them', () => {
  const f = fixture()
  f.json(join(f.root, '.claude.json'), { mcpServers: { 'bad.name': { command: 'x' }, injected: { type: 'sdk', name: 'x' }, invalid: { command: 'x', args: [2] }, valid_name: { type: 'sse', url: 'https://tools.example/sse' } } })
  const result = readNativeClaudeTools(f.project, f.env)
  expect(Object.keys(result.servers)).toEqual(['valid_name'])
  expect(result.omitted).toHaveLength(3)
})
it('preserves a server named __proto__ as data, never as the registry prototype', () => {
  const f=fixture()
  writeFileSync(join(f.root,'.claude.json'), '{"mcpServers":{"__proto__":{"command":"fixture-server"}}}')
  const servers=readNativeClaudeTools(f.project,f.env).servers
  expect(Object.keys(servers)).toContain('__proto__')
  expect(Object.getPrototypeOf(servers)).toBe(null)
})
it('treats an explicitly empty native allowlist as deny-all', () => {
  const f = fixture()
  f.json(join(f.root, '.claude.json'), { mcpServers: { local: { command: 'node' }, remote: { type: 'http', url: 'https://tools.example/mcp' } } })
  f.json(join(f.root, '.claude/settings.json'), { allowedMcpServers: [] })
  const result = readNativeClaudeTools(f.project, f.env)
  expect(Object.keys(result.servers)).toEqual([])
  expect(result.omitted).toEqual(['local', 'remote'])
})
it('allows exact native server names without expanding name wildcards', () => {
  const f = fixture()
  f.json(join(f.root, '.claude.json'), { mcpServers: { catalog: { command: 'node' }, catalog_other: { command: 'node' }, remote: { type: 'http', url: 'https://tools.example/mcp' } } })
  f.json(join(f.root, '.claude/settings.json'), { allowedMcpServers: [{ serverName: 'catalog' }, { serverName: 'catalog_*' }, { serverName: 'remote' }] })
  expect(Object.keys(readNativeClaudeTools(f.project, f.env).servers)).toEqual(['catalog', 'remote'])
})
it('requires exact commands when a native command allowlist is present even for allowed names', () => {
  const f = fixture()
  f.json(join(f.root, '.claude.json'), { mcpServers: {
    approved: { command: 'npx', args: ['-y', 'approved-package'] },
    same_name: { command: 'npx', args: ['approved-package'] },
    extra: { command: 'npx', args: ['-y', 'approved-package', '--extra'] },
    reordered: { command: 'npx', args: ['approved-package', '-y'] },
    remote: { type: 'http', url: 'https://tools.example/mcp' },
  } })
  f.json(join(f.root, '.claude/settings.json'), { allowedMcpServers: [{ serverName: 'same_name' }, { serverName: 'remote' }, { serverCommand: ['npx', '-y', 'approved-package'] }] })
  expect(Object.keys(readNativeClaudeTools(f.project, f.env).servers)).toEqual(['approved', 'remote'])
})
it('blocks exact native commands regardless of the user-assigned server name', () => {
  const f = fixture()
  f.json(join(f.root, '.claude.json'), { mcpServers: {
    renamed: { command: 'npx', args: ['-y', 'blocked-package'] },
    different: { command: 'npx', args: ['blocked-package'] },
    bare: { command: 'blocked' },
    args: { command: 'blocked', args: ['extra'] },
  } })
  f.json(join(f.root, '.claude/settings.json'), { deniedMcpServers: [{ serverCommand: ['npx', '-y', 'blocked-package'] }, { serverCommand: ['blocked'] }] })
  expect(Object.keys(readNativeClaudeTools(f.project, f.env).servers)).toEqual(['different', 'args'])
})
it('requires URL allowlist matches for remote servers even when their names are allowed', () => {
  const f = fixture()
  f.json(join(f.root, '.claude.json'), { mcpServers: {
    approved: { type: 'http', url: 'https://mcp.example.com/api/v1' },
    other_path: { type: 'sse', url: 'https://mcp.example.com/other' },
    other_host: { type: 'http', url: 'https://mcp.other.com/api/v1' },
    local: { command: 'node' },
  } })
  f.json(join(f.root, '.claude/settings.json'), { allowedMcpServers: [{ serverName: 'other_host' }, { serverName: 'local' }, { serverUrl: 'https://*.example.com/api/*' }] })
  expect(Object.keys(readNativeClaudeTools(f.project, f.env).servers)).toEqual(['approved', 'local'])
})
it('matches URL wildcards with native DNS casing and trailing-dot rules while preserving path casing', () => {
  const f = fixture()
  f.json(join(f.root, '.claude.json'), { mcpServers: {
    normalized: { type: 'http', url: 'https://MCP.EXAMPLE.COM./Api/v1' },
    lower_path: { type: 'sse', url: 'http://mcp.example.com/api/v1' },
    different_domain: { type: 'http', url: 'https://mcpXexample.com/Api/v1' },
  } })
  f.json(join(f.root, '.claude/settings.json'), { deniedMcpServers: [{ serverUrl: '*://Mcp.Example.com/Api/*' }] })
  expect(Object.keys(readNativeClaudeTools(f.project, f.env).servers)).toEqual(['lower_path', 'different_domain'])
})
it('applies denials before allows across user, project and local settings', () => {
  const f = fixture()
  f.json(join(f.root, '.claude.json'), { mcpServers: {
    name_blocked: { command: 'node' },
    command_blocked: { command: 'blocked' },
    url_blocked: { type: 'http', url: 'https://blocked.example/mcp' },
    allowed: { command: 'node' },
  } })
  f.json(join(f.root, '.claude/settings.json'), { allowedMcpServers: [{ serverCommand: ['node'] }, { serverCommand: ['blocked'] }, { serverUrl: 'https://*.example/*' }], deniedMcpServers: [{ serverName: 'name_blocked' }] })
  f.json(join(f.project, '.claude/settings.json'), { deniedMcpServers: [{ serverCommand: ['blocked'] }] })
  f.json(join(f.project, '.claude/settings.local.json'), { deniedMcpServers: [{ serverUrl: 'https://blocked.example/*' }] })
  expect(Object.keys(readNativeClaudeTools(f.project, f.env).servers)).toEqual(['allowed'])
})
it('merges native allowlists across layers without replacing earlier entries or treating an empty layer as a reset', () => {
  const f = fixture()
  f.json(join(f.root, '.claude.json'), { mcpServers: { user: { command: 'user' }, project: { command: 'project' }, unknown: { command: 'unknown' } } })
  f.json(join(f.root, '.claude/settings.json'), { allowedMcpServers: [{ serverName: 'user' }] })
  f.json(join(f.project, '.claude/settings.json'), { allowedMcpServers: [{ serverName: 'project' }] })
  f.json(join(f.project, '.claude/settings.local.json'), { allowedMcpServers: [] })
  expect(Object.keys(readNativeClaudeTools(f.project, f.env).servers)).toEqual(['user', 'project'])
})
it('returns the validated merged native policy for forwarding at flag scope without user settings extras', () => {
  const f = fixture()
  f.json(join(f.root, '.claude/settings.json'), {
    allowedMcpServers: [{ serverName: 'user' }], deniedMcpServers: [{ serverCommand: ['blocked', '--arg'] }],
    permissions: { allow: ['Bash(*)'] }, env: { PRIVATE_TOKEN: 'do-not-return' },
  })
  f.json(join(f.project, '.claude/settings.json'), { allowedMcpServers: [{ serverName: 'project' }], deniedMcpServers: [{ serverUrl: 'https://blocked.example/*' }] })
  f.json(join(f.project, '.claude/settings.local.json'), { allowedMcpServers: [], deniedMcpServers: [{ serverName: 'blocked' }] })
  expect(readNativeClaudeTools(f.project, f.env).nativeMcpPolicy).toEqual({
    allowedMcpServers: [{ serverName: 'user' }, { serverName: 'project' }],
    deniedMcpServers: [{ serverCommand: ['blocked', '--arg'] }, { serverUrl: 'https://blocked.example/*' }, { serverName: 'blocked' }],
  })
})
it('preserves absent versus explicitly empty allowlists in forwarded native policy', () => {
  const f = fixture()
  expect(readNativeClaudeTools(f.project, f.env).nativeMcpPolicy).toEqual({ deniedMcpServers: [] })
  f.json(join(f.root, '.claude/settings.json'), { allowedMcpServers: [] })
  expect(readNativeClaudeTools(f.project, f.env).nativeMcpPolicy).toMatchObject({ allowedMcpServers: [] })
})
it.each([
  { deniedMcpServers: [{ serverCommand: [] }] },
  { deniedMcpServers: [{ serverName: 'tool', serverUrl: 'https://blocked.example/*' }] },
  { allowedMcpServers: null },
])('rejects malformed native MCP policies before returning a startup registry: %j', (policy) => {
  const f = fixture()
  f.json(join(f.root, '.claude.json'), { mcpServers: { tool: { command: 'node' } } })
  f.json(join(f.root, '.claude/settings.json'), policy)
  expect(() => readNativeClaudeTools(f.project, f.env)).toThrow('Claude 的本机工具策略无法读取')
})
it('reports fixed omission reasons without tool configuration values and clears superseded omissions', () => {
  const f = fixture()
  f.json(join(f.root, '.claude.json'), { mcpServers: {
    disabled: { command: 'disabled', enabled: false },
    policy: { command: 'denied-command' },
    wechat: { command: 'private-command' },
    unsupported: { type: 'unknown', token: 'private-token' },
    inherited: { command: 'global-command' },
  } })
  f.json(join(f.project, '.mcp.json'), { mcpServers: { unapproved: { command: 'private-command' }, inherited: { command: 'unapproved-command' } } })
  f.json(join(f.root, '.claude/settings.json'), { deniedMcpServers: [{ serverName: 'policy' }] })
  const result = readNativeClaudeTools(f.project, f.env)
  expect(result.omissionReasons).toEqual({ unapproved: '尚未在 Claude 中批准', disabled: '已停用', policy: '策略限制', wechat: '陪伴隔离', unsupported: '不支持的配置' })
  expect(Object.keys(result.omissionReasons!).sort()).toEqual([...result.omitted].sort())
  expect(Object.getPrototypeOf(result.omissionReasons)).toBe(null)
  expect(result.servers).toHaveProperty('inherited')
})
it('collects only private settings environment key names across layers without returning their values', () => {
  const f = fixture()
  f.json(join(f.root, '.claude/settings.json'), { env: { WECHAT_TOKEN: 'private-token', PUBLIC_TOKEN: 'public', HEARTH_DIR: '/private' } })
  f.json(join(f.project, '.claude/settings.json'), { env: { WECHAT_TOKEN: 'overridden', WXVAULT_DIR: '/private-vault' } })
  f.json(join(f.project, '.claude/settings.local.json'), { env: { wxgraph_key: 'private-graph', UNRELATED: 'value' } })
  const result = readNativeClaudeTools(f.project, f.env)
  expect(result.privateEnvironmentKeys).toEqual(['WECHAT_TOKEN', 'HEARTH_DIR', 'WXVAULT_DIR', 'wxgraph_key'])
  expect(JSON.stringify(result)).not.toContain('private-token')
  expect(JSON.stringify(result)).not.toContain('/private-vault')
})
