import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { validateIsolatedConfiguration } from './isolated-configuration'

// Windows chmod only changes the read-only attribute; it cannot remove read
// access. Inject just the failing open syscall, keeping inspection and all
// source/execution/config files real on every platform.
const deniedOpen = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: ((...args: Parameters<typeof actual.open>) => {
    if (String(args[0]) === deniedOpen.path) return Promise.reject(Object.assign(new Error('EACCES fixture-secret'), { code: 'EACCES', path: deniedOpen.path }))
    return actual.open(...args)
  }) }
})

const roots: string[] = []
afterEach(async () => { deniedOpen.path = ''; await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
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
  it.each(['malformed', 'oversized', 'directory', 'symlink', 'hardlink'])('fails closed on %s global config without disclosing content', async kind => {
    const f = await fixture('codex'), path = join(f.home, '.codex/config.toml'); await mkdir(dirname(path), { recursive: true })
    if (kind === 'directory') await mkdir(path)
    else if (kind === 'symlink') { await f.put(join(f.root, 'target'), 'model="fixture-secret"'); await symlink(join(f.root, 'target'), path) }
    else if (kind === 'hardlink') { await f.put(join(f.root, 'target'), 'model="fixture-secret"'); await link(join(f.root, 'target'), path) }
    else { await f.put(path, kind === 'malformed' ? 'fixture-secret=[' : kind === 'oversized' ? '#'.repeat(1_000_001) : 'model="fixture-secret"') }
    await rejected(f.validate())
  })
  it.skipIf(process.platform === 'win32')('rejects global config with no POSIX read mode bits', async () => {
    const f = await fixture('codex'), path = join(f.home, '.codex/config.toml')
    await f.put(path, 'model="fixture-secret"'); await chmod(path, 0)
    try { await rejected(f.validate()) } finally { await chmod(path, 0o600) }
  })
  it('sanitizes a denied config open and leaves all real files unchanged', async () => {
    const f = await fixture('codex'), path = join(f.home, '.codex/config.toml')
    await f.put(path, 'model="fixture-secret"')
    const before = await readFile(path), directories = [f.sourcePath, f.executionPath, f.home, dirname(path)]
    const entries = await Promise.all(directories.map(dir => readdir(dir)))
    deniedOpen.path = path
    let error: unknown
    try { await f.validate() } catch (caught) { error = caught }
    expect(error instanceof Error && error.message === 'configuration_not_reproducible').toBe(true)
    expect((error as { code?: string })?.code).toBe('configuration_not_reproducible')
    expect(JSON.stringify(error).includes('fixture-secret')).toBe(false)
    expect(JSON.stringify(error).includes(path)).toBe(false)
    deniedOpen.path = ''
    expect((await readFile(path)).equals(before)).toBe(true)
    expect(await Promise.all(directories.map(dir => readdir(dir)))).toEqual(entries)
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


// Real files and fresh Git checkouts: omission must reject even when Git says
// clean; copying ordinary tracked rules must remain admissible.
describe('native instruction equivalence', () => {
  async function gitFixture() {
    const f = await fixture('cursor')
    const git = async (...args: string[]) => (await promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: f.sourcePath, env: { PATH: process.env.PATH, HOME: f.home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    })).stdout.trim()
    await git('init', '-q')
    await f.put(join(f.sourcePath, '.gitignore'), 'ignored/\nAGENTS.local.md\n')
    await f.put(join(f.sourcePath, 'file.txt'), 'base')
    return { ...f, git, checkout: async () => { await git('add', '.'); await git('commit', '-qm', 'base'); await git('worktree', 'add', '--detach', f.executionPath, 'HEAD') } }
  }
  it('rejects a clean Git source with ignored AGENTS.md missing in the linked worktree', async () => {
    const f = await gitFixture()
    await f.put(join(f.sourcePath, '.gitignore'), 'AGENTS.md\n')
    await f.checkout()
    await f.put(join(f.sourcePath, 'AGENTS.md'), 'Do not change protected files.')
    expect(await f.git('status', '--porcelain')).toBe('')
    await rejected(f.validate())
  })
  it('rejects source-only ancestor Cursor alwaysApply rules despite clean Git', async () => {
    const f = await gitFixture(); await f.checkout()
    await f.put(join(dirname(f.sourcePath), '.cursor/rules/policy.mdc'), '---\nalwaysApply: true\n---\nProtect files.')
    expect(await f.git('status', '--porcelain')).toBe('')
    await rejected(f.validate())
  })
  it('admits tracked copied AGENTS and nested Cursor rules and fingerprints content', async () => {
    const f = await gitFixture()
    await f.put(join(f.sourcePath, 'AGENTS.md'), 'Use the test runner.')
    await f.put(join(f.sourcePath, '.cursor/rules/team/policy.mdc'), '---\nalwaysApply: true\n---\nProtect files.')
    await f.checkout()
    const before = await f.validate()
    for (const dir of [f.sourcePath, f.executionPath]) await f.put(join(dir, '.cursor/rules/team/policy.mdc'), '---\nalwaysApply: true\n---\nRun tests.')
    expect(await f.validate()).not.toBe(before)
  })
  it.each([
    ['claude', 'AGENTS.md'], ['claude', 'CLAUDE.md'], ['claude', 'CLAUDE.local.md'], ['claude', '.claude/CLAUDE.md'], ['claude', '.claude/rules/team/policy.md'],
    ['codex', 'AGENTS.md'], ['codex', 'AGENTS.override.md'],
    ['cursor', 'AGENTS.md'], ['cursor', 'CLAUDE.md'], ['cursor', 'CLAUDE.local.md'], ['cursor', '.cursor/rules/team/policy.mdc'], ['cursor', '.cursorrules'],
  ])('rejects omitted %s instruction %s on either side', async (provider, name) => {
    for (const side of ['sourcePath', 'executionPath'] as const) {
      const f = await fixture(provider); await f.put(join(f[side], name), 'Protect files.'); await rejected(f.validate())
    }
  })
  it.each(['claude', 'codex', 'cursor'])('admits copied instructions and fingerprints changes for %s', async provider => {
    const f = await fixture(provider)
    for (const dir of [f.sourcePath, f.executionPath]) await f.put(join(dir, 'AGENTS.md'), 'Run tests.')
    const before = await f.validate()
    for (const dir of [f.sourcePath, f.executionPath]) await f.put(join(dir, 'AGENTS.md'), 'Run all tests.')
    expect(await f.validate()).not.toBe(before)
  })
  it.each(['claude', 'cursor'])('rejects equal content from different outside ancestors for %s', async provider => {
    const f = await fixture(provider)
    for (const dir of [dirname(f.sourcePath), dirname(f.executionPath)]) await f.put(join(dir, 'AGENTS.md'), 'Same text with different scope.')
    await rejected(f.validate())
  })
  it.each(['claude', 'cursor'])('fingerprints a genuinely shared ancestor for %s', async provider => {
    const f = await fixture(provider); await f.put(join(f.root, 'AGENTS.md'), 'Shared rules.')
    const before = await f.validate(); await f.put(join(f.root, 'AGENTS.md'), 'Changed shared rules.')
    expect(await f.validate()).not.toBe(before)
  })
  it('preserves Git-root to project-subdirectory hierarchy and rejects moved rules', async () => {
    const f = await gitFixture()
    await f.put(join(f.sourcePath, 'AGENTS.md'), 'Root rules.'); await f.put(join(f.sourcePath, 'app/AGENTS.md'), 'App rules.')
    await f.checkout()
    const validate = () => validateIsolatedConfiguration({ providerId: 'codex', sourcePath: join(f.sourcePath, 'app'), executionPath: join(f.executionPath, 'app') }, { environment: { HOME: f.home }, systemDirectories: [f.system] })
    expect(await validate()).toMatch(/^[a-f0-9]{64}$/)
    await rm(join(f.executionPath, 'AGENTS.md'))
    await f.put(join(f.executionPath, 'app/AGENTS.md'), 'Root rules.\nApp rules.')
    await rejected(validate())
  })
  it.each(['claude', 'cursor'])('rejects source-only nested instructions lazily loaded by %s', async provider => {
    const f = await fixture(provider); await f.put(join(f.sourcePath, 'nested/AGENTS.md'), 'Nested rules.'); await rejected(f.validate())
  })
  it.each(['claude', 'codex'])('fingerprints shared user instruction changes for %s', async provider => {
    const f = await fixture(provider), path = join(f.home, provider === 'claude' ? '.claude/CLAUDE.md' : '.codex/AGENTS.md')
    await f.put(path, 'Shared user rules.'); const before = await f.validate(); await f.put(path, 'Changed user rules.')
    expect(await f.validate()).not.toBe(before)
  })
  it('rejects unresolved Claude imports even when the importing instructions were copied', async () => {
    const f = await fixture()
    for (const dir of [f.sourcePath, f.executionPath]) await f.put(join(dir, 'CLAUDE.md'), 'See @../private.md')
    await rejected(f.validate())
  })
  it.each(['symlink', 'hardlink', 'oversized', 'directory', 'invalid-utf8'])('fails closed on %s instruction inputs', async kind => {
    const f = await fixture('cursor'), path = join(f.sourcePath, 'AGENTS.md')
    if (kind === 'directory') await mkdir(path)
    else if (kind === 'symlink' || kind === 'hardlink') { await f.put(join(f.root, 'target'), 'fixture-secret'); await (kind === 'symlink' ? symlink : link)(join(f.root, 'target'), path) }
    else if (kind === 'invalid-utf8') await writeFile(path, Buffer.from([0xff]))
    else await f.put(path, 'x'.repeat(1_000_001))
    await rejected(f.validate())
  })
  it('rejects linked rule directories', async () => {
    const f = await fixture('cursor'); await f.put(join(f.root, 'rules/policy.mdc'), 'fixture-secret')
    await mkdir(join(f.sourcePath, '.cursor')); await symlink(join(f.root, 'rules'), join(f.sourcePath, '.cursor/rules'))
    await rejected(f.validate())
  })
  it('rejects lazy instructions inside native metadata subdirectories too', async () => {
    const f = await fixture('claude'); await f.put(join(f.sourcePath, '.claude/notes/CLAUDE.md'), 'Nested rules.')
    await rejected(f.validate())
  })
  it('does not inspect instructions beyond the Codex Git-root boundary', async () => {
    const f = await gitFixture(); await f.checkout()
    await f.put(join(dirname(f.sourcePath), 'AGENTS.md'), 'Outside Git root.')
    const options = { environment: { HOME: f.home }, systemDirectories: [f.system] }
    expect(await validateIsolatedConfiguration({ sourcePath: f.sourcePath, executionPath: f.executionPath, providerId: 'codex' }, options)).toMatch(/^[a-f0-9]{64}$/)
  })
  it.each(['.cursorignore', '.cursorindexingignore'])('rejects unverifiable native rule selector %s even when copied', async name => {
    const f = await fixture('cursor')
    for (const dir of [f.sourcePath, f.executionPath]) await f.put(join(dir, name), '*.md')
    await rejected(f.validate())
  })
  it('rejects unsafe rule imports in copied nested rules', async () => {
    const f = await fixture('claude')
    for (const dir of [f.sourcePath, f.executionPath]) await f.put(join(dir, '.claude/rules/policy.md'), 'See @../private.md')
    await rejected(f.validate())
  })
  it('rejects managed instructions', async () => {
    const f = await fixture('claude'); await f.put(join(f.system, 'CLAUDE.md'), 'Managed policy.'); await rejected(f.validate())
  })
  it('bounds cumulative instruction bytes', async () => {
    const f = await fixture('cursor')
    for (let n = 0; n < 9; n++) await f.put(join(f.sourcePath, '.cursor/rules', `${n}.mdc`), 'x'.repeat(950_000))
    await rejected(f.validate())
  })
  it('bounds rule directory discovery depth', async () => {
    const f = await fixture('cursor')
    await f.put(join(f.sourcePath, '.cursor/rules', ...Array<string>(34).fill('nested'), 'policy.mdc'), 'Protect files.')
    await rejected(f.validate())
  })
  it('bounds directory enumeration without reading ordinary project contents', async () => {
    const f = await fixture('cursor')
    for (let n = 0; n < 4200; n++) await f.put(join(f.sourcePath, `file-${n}`), '')
    await rejected(f.validate())
  })
  it('rejects racing rule-directory membership changes', async () => {
    const f = await fixture('cursor')
    for (const dir of [f.sourcePath, f.executionPath]) await f.put(join(dir, '.cursor/rules/base.mdc'), 'Protect files.')
    let active = true
    const writer = (async () => { let n = 0; while (active) { await f.put(join(f.sourcePath, '.cursor/rules', `${n++}.mdc`), 'New rule.'); await new Promise(resolve => setImmediate(resolve)) } })()
    try { await rejected(f.validate()) } finally { active = false; await writer }
  })
  it('rejects racing instruction edits', async () => {
    const f = await fixture('claude')
    for (const dir of [f.sourcePath, f.executionPath]) await f.put(join(dir, 'CLAUDE.md'), 'Rules.')
    let active = true
    const writer = (async () => { let n = 0; while (active) { await f.put(join(f.sourcePath, 'CLAUDE.md'), `New rules ${n++}.`); await new Promise(resolve => setImmediate(resolve)) } })()
    try { await rejected(f.validate()) } finally { active = false; await writer }
  })

  it('rejects an unverified nested Git boundary even when instruction text matches', async () => {
    const f = await gitFixture()
    await f.put(join(f.sourcePath, 'nested/AGENTS.md'), 'Nested instructions.'); await f.checkout()
    await f.git('-C', join(f.sourcePath, 'nested'), 'init', '-q')
    await rejected(f.validate())
  })

})
