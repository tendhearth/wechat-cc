import { afterEach, describe, expect, it } from 'vitest'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { validateIsolatedConfiguration } from './isolated-configuration'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(providerId = 'claude') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cc-isolated-config-'))); roots.push(root)
  const sourcePath = join(root, 'source', 'project'), executionPath = join(root, 'copies', 'task'), home = join(root, 'home'), system = join(root, 'system')
  await Promise.all([sourcePath, executionPath, home, system].map(path => mkdir(path, { recursive: true })))
  const environment = { HOME: home }
  const put = async (path: string, value: unknown) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value)) }
  return { root, home, sourcePath, executionPath, system, put, validate: () => validateIsolatedConfiguration({ sourcePath, executionPath, providerId }, { environment, systemDirectories: [system] }) }
}
async function rejected(promise: Promise<string>) {
  let error: unknown
  try { await promise } catch (caught) { error = caught }
  // Never print source config, error cause, or raw credentials on a failure.
  expect(error instanceof Error && error.message === 'configuration_not_reproducible').toBe(true)
  expect((error as { code?: string } | undefined)?.code).toBe('configuration_not_reproducible')
}

describe('isolated native configuration admission', () => {
  it.each(['claude', 'codex', 'cursor', 'openai'])('admits defaults for %s without creating native config', async provider => {
    const f = await fixture(provider), before = await readdir(f.home)
    const first = await f.validate()
    expect(/^[a-f0-9]{64}$/.test(first)).toBe(true)
    expect(await f.validate()).toBe(first)
    expect(await readdir(f.home)).toEqual(before)
  })
  it('admits shared Codex model and custom endpoint and fingerprints changes', async () => {
    const f = await fixture('codex'), path = join(f.home, '.codex/config.toml')
    await f.put(path, 'model="qwen3"\nmodel_provider="local"\n[model_providers.local]\nname="Local"\nbase_url="http://127.0.0.1:1234/v1"\nwire_api="responses"\nenv_key="MODEL_TOKEN"\n')
    const first = await f.validate()
    await f.put(path, 'model="qwen4"\nmodel_provider="local"\n[model_providers.local]\nname="Local"\nbase_url="http://127.0.0.1:4321/v1"\nwire_api="responses"\nenv_key="MODEL_TOKEN"\n')
    expect(await f.validate()).not.toBe(first)
  })
  it('admits Claude global remote MCP and ignores excluded companion tools/private env', async () => {
    const f = await fixture(), path = join(f.home, '.claude.json')
    await f.put(path, { mcpServers: { remote: { type: 'http', url: 'https://tools.example/mcp', headers: { Authorization: 'Bearer fixture-secret' } }, wechat: { command: join(f.sourcePath, 'private') } } })
    await f.put(join(f.home, '.claude/settings.json'), { model: 'opus', env: { WECHAT_PRIVATE: f.sourcePath, ANTHROPIC_BASE_URL: 'https://model.example' } })
    const before = await readFile(path)
    expect(/^[a-f0-9]{64}$/.test(await f.validate())).toBe(true)
    expect((await readFile(path)).equals(before)).toBe(true)
  })
  it('admits shared Cursor selected model without creating project trust', async () => {
    const f = await fixture('cursor'), path = join(f.home, '.cursor/cli-config.json')
    await f.put(path, { version: 1, selectedModel: { modelId: 'composer-2', parameters: [] }, permissions: { allow: [], deny: [] }, network: { useHttp1ForAgent: true } })
    const before = await readFile(path)
    expect(/^[a-f0-9]{64}$/.test(await f.validate())).toBe(true)
    expect((await readFile(path)).equals(before)).toBe(true)
    expect(await readdir(join(f.home, '.cursor'))).toEqual(['cli-config.json'])
  })
  it('admits global Codex remote MCP with native header auth and retains no secret DTO', async () => {
    const f = await fixture('codex')
    await f.put(join(f.home, '.codex/config.toml'), '[mcp_servers.remote]\nurl="https://tools.example/mcp"\nbearer_token_env_var="MCP_TOKEN"\nenabled=true\n[mcp_servers.remote.http_headers]\nAuthorization="Bearer fixture-secret"')
    expect(/^[a-f0-9]{64}$/.test(await f.validate())).toBe(true)
  })
  it('API admission does not read or broaden native tools', async () => {
    const f = await fixture('openai')
    await f.put(join(f.sourcePath, '.claude/settings.local.json'), 'invalid')
    expect(/^[a-f0-9]{64}$/.test(await f.validate())).toBe(true)
  })
  it.each(['.claude/settings.local.json', '.claude/settings.json', '.mcp.json'])('rejects omitted source configuration %s', async name => {
    const f = await fixture(); await f.put(join(f.sourcePath, name), { model: 'fixture-secret' }); await rejected(f.validate())
  })
  it.each(['claude', 'codex', 'cursor'])('rejects ancestor configuration for %s, preserving a project subdirectory', async provider => {
    const f = await fixture(provider), name = provider === 'claude' ? '.claude/settings.json' : provider === 'codex' ? '.codex/config.toml' : '.cursor/cli.json'
    await f.put(join(dirname(f.sourcePath), name), provider === 'codex' ? 'model="different"' : { model: 'different' }); await rejected(f.validate())
  })
  it('rejects execution-only model/endpoint and policy settings', async () => {
    const f = await fixture('codex'); await f.put(join(f.executionPath, '.codex/config.toml'), 'model="other"\nopenai_base_url="https://other.example"\napproval_policy="never"'); await rejected(f.validate())
  })
  it('rejects identical tracked relative MCP rather than assuming script cwd equivalence', async () => {
    const f = await fixture()
    for (const path of [f.sourcePath, f.executionPath]) {
      await f.put(join(path, '.mcp.json'), { mcpServers: { local: { command: 'node', args: ['./server.js'] } } })
      await f.put(join(path, 'server.js'), 'process.cwd()')
    }
    await rejected(f.validate())
  })
  it.each(['command', 'cwd', 'env', 'args'])('rejects source references in global MCP %s', async key => {
    const f = await fixture(); await f.put(join(f.home, '.claude.json'), { mcpServers: { local: { command: 'node', [key]: key === 'env' ? { DATA: f.sourcePath } : key === 'args' ? [join(f.sourcePath, 'server.js')] : f.sourcePath } } }); await rejected(f.validate())
  })
  it('rejects Claude source-cwd MCP authorization even with equal settings', async () => {
    const f = await fixture(); await f.put(join(f.home, '.claude.json'), { projects: { [f.sourcePath]: { enabledMcpjsonServers: ['remote'] } } }); await rejected(f.validate())
  })
  it('rejects Codex source trust but tolerates unrelated project records', async () => {
    const f = await fixture('codex'), path = join(f.home, '.codex/config.toml')
    await f.put(path, '[projects."/unrelated"]\ntrust_level="trusted"'); expect(/^[a-f0-9]{64}$/.test(await f.validate())).toBe(true)
    await f.put(path, `[projects.${JSON.stringify(f.sourcePath)}]\ntrust_level="trusted"`); await rejected(f.validate())
  })
  it.each(['.workspace-trusted', 'mcp-approvals.json', 'mcp-disabled.json'])('rejects Cursor source native state %s', async name => {
    const f = await fixture('cursor'), key = f.sourcePath.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
    await f.put(join(f.home, '.cursor/projects', key, name), {}); await rejected(f.validate())
  })
  it.each(['malformed', 'oversized', 'directory', 'symlink', 'hardlink', 'unreadable'])('fails closed on %s global config without disclosing content', async kind => {
    const f = await fixture('codex'), path = join(f.home, '.codex/config.toml'); await mkdir(dirname(path), { recursive: true })
    if (kind === 'directory') await mkdir(path)
    else if (kind === 'symlink') { await f.put(join(f.root, 'target'), 'model="fixture-secret"'); await symlink(join(f.root, 'target'), path) }
    else if (kind === 'hardlink') { await f.put(join(f.root, 'target'), 'model="fixture-secret"'); await link(join(f.root, 'target'), path) }
    else { await f.put(path, kind === 'malformed' ? 'fixture-secret=[' : kind === 'oversized' ? '#'.repeat(1_000_001) : 'model="fixture-secret"'); if (kind === 'unreadable') await chmod(path, 0) }
    await rejected(f.validate())
  })
  it('rejects symlink config directories and unknown native settings', async () => {
    const f = await fixture('codex'); await f.put(join(f.root, 'linked/config.toml'), 'model="same"'); await symlink(join(f.root, 'linked'), join(f.home, '.codex')); await rejected(f.validate())
    const g = await fixture('codex'); await g.put(join(g.home, '.codex/config.toml'), 'experimental_loader="./secret-script"'); await rejected(g.validate())
  })
  it.each(['model=true', 'model_provider=42', 'openai_base_url=false'])('rejects invalid known Codex types: %s', async text => {
    const f = await fixture('codex'); await f.put(join(f.home, '.codex/config.toml'), text); await rejected(f.validate())
  })
  it('rejects unsupported managed Claude settings directory', async () => {
    const f = await fixture(); await mkdir(join(f.system, 'managed-settings.d')); await rejected(f.validate())
  })
  it('rejects an empty Claude MCP command policy that the native reader cannot load', async () => {
    const f = await fixture(); await f.put(join(f.home, '.claude/settings.json'), { allowedMcpServers: [{ serverCommand: [] }] }); await rejected(f.validate())
  })
  it.each(['base_url=true', 'requires_openai_auth="yes"', 'request_max_retries="three"'])('rejects malformed Codex model provider fields: %s', async setting => {
    const f = await fixture('codex'); await f.put(join(f.home, '.codex/config.toml'), `[model_providers.local]\n${setting}`); await rejected(f.validate())
  })
  it('rejects malformed Cursor known config fields', async () => {
    const f = await fixture('cursor'); await f.put(join(f.home, '.cursor/cli-config.json'), { version: {}, selectedModel: { command: './loader' } }); await rejected(f.validate())
  })
  it('rejects changes to a configuration while admission is reading the filesystem', async () => {
    const f = await fixture('codex'), path = join(f.home, '.codex/config.toml')
    await f.put(path, 'model="one"')
    let active = true
    const writer = (async () => { let i = 0; while (active) { await writeFile(path, `model="m${i++}"`); await new Promise(resolve => setImmediate(resolve)) } })()
    try { await rejected(f.validate()) } finally { active = false; await writer }
  })
})
