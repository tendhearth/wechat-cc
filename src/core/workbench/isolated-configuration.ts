import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { isCompanionMcp } from './native-tools'

export interface IsolatedConfigurationInput { sourcePath: string; executionPath: string; providerId: string }
export interface IsolatedConfigurationOptions {
  /** The native subprocess environment. Fixtures supply an isolated HOME. */
  environment?: NodeJS.ProcessEnv
  /** Native system config roots; omitted uses platform defaults. */
  systemDirectories?: string[]
}
type Obj = Record<string, unknown>
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
function fail(): never { throw Object.assign(new Error('configuration_not_reproducible'), { code: 'configuration_not_reproducible' }) }
const privateEnv = /^(WECHAT_|HEARTH_|WXVAULT_|WXGRAPH_)/i
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
const ancestors = (path: string) => { const out: string[] = []; for (;;) { out.push(path); const up = dirname(path); if (up === path) return out; path = up } }
const stringMap = (v: unknown) => object(v) && Object.values(v).every(x => typeof x === 'string')
const stringList = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string')
const only = (v: Obj, keys: string[]) => { if (Object.keys(v).some(k => !keys.includes(k))) fail() }
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (object(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/** Read-only admission, deliberately narrower than the native parsers:
 * - Claude workbench loads project/local settings, while readNativeClaudeTools
 *   also reads global MCP and projects[cwd] authorizations.
 * - Codex project layers depend on cwd trust (codex-target.ts); only its native
 *   config/read could prove arbitrary layer equivalence. We never start it here.
 * - Cursor 2026.10.01 cursor-config/paths + mcp/project-paths store authorization
 *   under CURSOR_DATA_DIR/projects/<sanitized-root>, including ancestor trust.
 * Consequently any project/ancestor settings layer or applicable per-path state rejects,
 * even when copied byte-for-byte. Stdio commands can inspect cwd themselves;
 * copying their script cannot prove equivalence, so they also reject.
 * This is an admission fingerprint, not an execution-time lock or auth grant.
 */
export async function validateIsolatedConfiguration(input: IsolatedConfigurationInput, options: IsolatedConfigurationOptions = {}): Promise<string> {
  try { return await validate(input, options) } catch { return fail() }
}
async function validate(input: IsolatedConfigurationInput, options: IsolatedConfigurationOptions): Promise<string> {
  const env = { ...(options.environment ?? process.env) }
  if (![input.sourcePath, input.executionPath].every(isAbsolute)) fail()
  const source = await realpath(input.sourcePath), execution = await realpath(input.executionPath)
  if (source !== resolve(input.sourcePath) || execution !== resolve(input.executionPath) || source === execution) fail()
  if (!['claude', 'codex', 'cursor', 'openai'].includes(input.providerId)) fail()
  const observations = new Map<string, string>(), values: unknown[] = []
  let total = 0
  const stat = async (path: string) => {
    try { return await lstat(path, { bigint: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  const stamp = (s: Awaited<ReturnType<typeof stat>>) => s === null ? 'absent' : s.isDirectory()
    ? `${s.dev}:${s.ino}:${s.mode}` : `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.nlink}`
  const observe = async (path: string) => {
    const s = await stat(path), value = stamp(s), previous = observations.get(path)
    if (previous !== undefined && previous !== value) fail()
    if (s?.isSymbolicLink()) fail()
    observations.set(path, value)
    if (observations.size > 4096) fail()
    return s
  }
  const inspect = async (path: string) => {
    if (!isAbsolute(path)) fail()
    for (const dir of ancestors(dirname(path)).reverse()) { const s = await observe(dir); if (s && !s.isDirectory()) fail() }
    return observe(path)
  }
  const readText = async (path: string): Promise<string | null> => {
    const before = await inspect(path)
    if (!before) return null
    if (!before.isFile() || before.nlink !== 1n || before.size > 1_000_000n || (before.mode & 0o444n) === 0n) fail()
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (stamp(await fd.stat({ bigint: true })) !== stamp(before)) fail()
      // Bounded read, including when a concurrent writer grows the file.
      const bytes = Buffer.alloc(1_000_001)
      let count = 0
      while (count < bytes.length) { const r = await fd.read(bytes, count, bytes.length - count, count); if (!r.bytesRead) break; count += r.bytesRead }
      total += count
      if (count > 1_000_000 || total > 8_000_000 || stamp(await fd.stat({ bigint: true })) !== stamp(before)) fail()
      await observe(path)
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))
    } finally { await fd.close() }
  }
  const read = async (path: string): Promise<Obj | null> => {
    const text = await readText(path)
    if (text === null) return null
    const parsed: unknown = path.endsWith('.toml') ? parseToml(text) : JSON.parse(text)
    if (!object(parsed)) fail()
    return parsed
  }
  // Unlike identity-only ancestor probes, enumerated rule/project directories
  // must also retain their membership throughout admission.
  const listings = new Map<string, string>()
  const listingStamp = (s: NonNullable<Awaited<ReturnType<typeof stat>>>) => `${stamp(s)}:${s.mtimeNs}:${s.ctimeNs}`
  let entries = 0
  const list = async (path: string): Promise<string[] | null> => {
    const before = await inspect(path)
    if (!before) return null
    if (!before.isDirectory() || (before.mode & 0o555n) === 0n) fail()
    const expected = listingStamp(before), previous = listings.get(path)
    if (previous !== undefined && previous !== expected) fail()
    listings.set(path, expected)
    const out: string[] = []
    const dir = await opendir(path, { bufferSize: 32 })
    for await (const entry of dir) { if (++entries > 4096) fail(); out.push(entry.name) }
    const after = await observe(path)
    if (!after || listingStamp(after) !== expected) fail()
    return out.sort()
  }
  for (const path of [source, execution]) if (!(await inspect(path))?.isDirectory()) fail()
  if (input.providerId === 'openai') {
    // Its persisted API configHash and tool boundary are independently frozen
    // by api-task-provider; native files have no role in API tool availability.
    values.push('api-global-config-owned-by-provider')
  } else {
    const home = env.HOME || homedir()
    if (!isAbsolute(home)) fail()
    const sourceAncestors = ancestors(source), executionAncestors = ancestors(execution)
    const relevant = new Set([...sourceAncestors, ...executionAncestors])
    const reference = (v: unknown): void => {
      if (typeof v === 'string') {
        let s = v
        try { s = decodeURIComponent(s) } catch { /* Literal non-URL string. */ }
        s = s.replaceAll('\\', '/').toLowerCase()
        if (s.includes(source.replaceAll('\\', '/').toLowerCase()) || s.includes(execution.replaceAll('\\', '/').toLowerCase()) || /\$\{|\$\(|%[a-z_]+%/i.test(s)) fail()
      } else if (Array.isArray(v)) v.forEach(reference)
      else if (object(v)) Object.entries(v).forEach(([k, value]) => { reference(k); reference(value) })
    }
    const projects = (v: unknown) => {
      if (v === undefined) return
      if (!object(v)) fail()
      // Native authorization is keyed by exact cwd; ancestor records can also
      // apply. Reject aliases, relative keys and relevant records conservatively.
      for (const [path, record] of Object.entries(v)) {
        if (!isAbsolute(path) || !object(record)) fail()
        if (relevant.has(resolve(path))) fail()
        if (path.startsWith(source + sep) || path.startsWith(execution + sep)) fail()
      }
    }
    const remoteServers = (v: unknown, provider: string): Obj => {
      if (v === undefined) return {}
      if (!object(v)) fail()
      const out: Obj = {}
      for (const [name, server] of Object.entries(v)) {
        if (!object(server)) fail()
        if (isCompanionMcp(name, server)) continue
        if (!/^[A-Za-z0-9_-]+$/.test(name)) fail()
        // Cursor's global servers still use per-project approval state.
        if (provider === 'cursor' || server.command !== undefined) fail()
        only(server, provider === 'claude' ? ['type', 'url', 'headers', 'enabled', 'disabled'] : ['url', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'enabled', 'startup_timeout_sec', 'tool_timeout_sec', 'enabled_tools', 'disabled_tools'])
        if (typeof server.url !== 'string' || !['http:', 'https:'].includes(new URL(server.url).protocol)) fail()
        if (provider === 'claude' && !['http', 'sse'].includes(String(server.type))) fail()
        for (const k of ['headers', 'http_headers', 'env_http_headers']) if (server[k] !== undefined && !stringMap(server[k])) fail()
        for (const k of ['enabled_tools', 'disabled_tools']) if (server[k] !== undefined && !stringList(server[k])) fail()
        for (const k of ['enabled', 'disabled']) if (server[k] !== undefined && typeof server[k] !== 'boolean') fail()
        for (const k of ['startup_timeout_sec', 'tool_timeout_sec']) if (server[k] !== undefined && typeof server[k] !== 'number') fail()
        if (server.bearer_token_env_var !== undefined && typeof server.bearer_token_env_var !== 'string') fail()
        reference(server); out[name] = server
      }
      return out
    }
    const policy = (v: unknown) => {
      if (!Array.isArray(v)) fail()
      for (const entry of v) {
        if (!object(entry)) fail()
        only(entry, ['serverName', 'serverUrl', 'serverCommand'])
        if (Object.keys(entry).length !== 1 || (entry.serverCommand !== undefined ? !stringList(entry.serverCommand) || !(entry.serverCommand as string[]).length : !Object.values(entry).every(x => typeof x === 'string'))) fail()
      }
      reference(v)
    }
    const configRoot = input.providerId === 'claude' ? (env.CLAUDE_CONFIG_DIR || join(home, '.claude'))
      : input.providerId === 'codex' ? (env.CODEX_HOME || join(home, '.codex'))
        : (env.CURSOR_CONFIG_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'cursor') : join(home, '.cursor')))
    if (!isAbsolute(configRoot)) fail()
    const globalPaths = new Set<string>()
    const global = async (path: string) => { globalPaths.add(path); return await read(path) }
    const systemRoots = options.systemDirectories ?? (process.platform === 'win32' ? [] : input.providerId === 'codex' ? [process.platform === 'darwin' ? '/private/etc/codex' : '/etc/codex'] : input.providerId === 'claude' ? [process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code'] : [])
    if (input.providerId === 'claude') {
      const account = await global(env.CLAUDE_CONFIG_DIR ? join(configRoot, '.claude.json') : join(home, '.claude.json')) ?? {}
      projects(account.projects)
      if (object(account.projects)) for (const path of Object.keys(account.projects)) { const canonical = await realpath(path).catch(() => path); if (relevant.has(canonical)) fail() }
      values.push({ mcpServers: remoteServers(account.mcpServers, 'claude'), disabledMcpServers: account.disabledMcpServers })
      if (account.disabledMcpServers !== undefined && !stringList(account.disabledMcpServers)) fail()
      const settings = await global(join(configRoot, 'settings.json')) ?? {}
      // Other user settings are not loaded: workbenchClaudeOptions uses only
      // ['project','local']; the native tools reader consumes these fields.
      const effective: Obj = {}
      for (const name of ['allowedMcpServers', 'deniedMcpServers']) if (settings[name] !== undefined) { policy(settings[name]); effective[name] = settings[name] }
      for (const name of ['enabledMcpjsonServers', 'disabledMcpjsonServers']) if (settings[name] !== undefined) { if (!stringList(settings[name])) fail(); effective[name] = settings[name] }
      if (settings.enableAllProjectMcpServers !== undefined) { if (typeof settings.enableAllProjectMcpServers !== 'boolean') fail(); effective.enableAllProjectMcpServers = settings.enableAllProjectMcpServers }
      values.push(effective)
      for (const root of systemRoots) {
        for (const name of ['managed-settings.json', 'managed-mcp.json']) if (await global(join(root, name))) fail()
        if (await inspect(join(root, 'managed-settings.d'))) fail()
      }
    } else if (input.providerId === 'codex') {
      const codex = async (path: string) => {
        const value = await global(path); if (!value) return
        projects(value.projects)
        if (object(value.projects)) for (const path of Object.keys(value.projects)) { const canonical = await realpath(path).catch(() => path); if (relevant.has(canonical)) fail() }
        const { projects: _projects, mcp_servers, ...effective } = value
        only(effective, ['model', 'model_provider', 'model_providers', 'openai_base_url', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'web_search', 'disable_response_storage', 'preferred_auth_method', 'forced_login_method', 'hide_agent_reasoning', 'show_raw_agent_reasoning', 'check_for_update_on_startup', 'suppress_unstable_features_warning', 'features'])
        for (const [name, v] of Object.entries(effective)) {
          if (name === 'model_providers') {
            if (!object(v)) fail()
            for (const provider of Object.values(v)) {
              if (!object(provider)) fail()
              only(provider, ['name', 'base_url', 'wire_api', 'env_key', 'env_key_instructions', 'requires_openai_auth', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms', 'http_headers', 'env_http_headers', 'query_params'])
              for (const [key, setting] of Object.entries(provider)) {
                if (['http_headers', 'env_http_headers', 'query_params'].includes(key)) { if (!stringMap(setting)) fail() }
                else if (key === 'requires_openai_auth') { if (typeof setting !== 'boolean') fail() }
                else if (['request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms'].includes(key)) { if (!Number.isSafeInteger(setting) || (setting as number) < 0) fail() }
                else if (typeof setting !== 'string') fail()
              }
            }
          } else if (name === 'features') {
            if (!object(v)) fail()
            // These are forcibly disabled by workbenchFeatureConfig.
            only(v, ['plugins', 'apps', 'hooks']); if (!Object.values(v).every(x => typeof x === 'boolean')) fail()
          } else {
            const boolean = ['disable_response_storage', 'hide_agent_reasoning', 'show_raw_agent_reasoning', 'check_for_update_on_startup', 'suppress_unstable_features_warning'].includes(name)
            if (typeof v !== (boolean ? 'boolean' : 'string')) fail()
          }
        }
        reference(effective)
        values.push({ ...effective, mcp_servers: remoteServers(mcp_servers, 'codex') })
      }
      for (const root of systemRoots) await codex(join(root, 'config.toml'))
      await codex(join(configRoot, 'config.toml'))
      await codex(join(configRoot, 'managed_config.toml'))
      for (const root of systemRoots) {
        await codex(join(root, 'managed_config.toml'))
        // Managed requirements may contain external policies/trust constraints.
        if (await global(join(root, 'requirements.toml'))) fail()
      }
    } else {
      const config = await global(join(configRoot, 'cli-config.json')) ?? {}
      only(config, ['version', 'model', 'selectedModel', 'modelParameters', 'modelSelectionHistory', 'maxMode', 'hasChangedDefaultModel', 'editor', 'display', 'notifications', 'hints', 'permissions', 'network', 'approvalMode', 'autoAcceptWebSearch'])
      // Nested native model/UI forms contain values only; commands or path
      // selectors in permissions cannot be proven cwd-independent.
      if (config.permissions !== undefined) {
        if (!object(config.permissions)) fail()
        only(config.permissions, ['allow', 'deny'])
        if (Object.values(config.permissions).some(v => !Array.isArray(v) || v.length)) fail()
      }
      for (const [name, value] of Object.entries(config)) {
        if (name === 'permissions') continue
        if (name === 'version') { if (!Number.isSafeInteger(value)) fail() }
        else if (['notifications', 'hints', 'maxMode', 'hasChangedDefaultModel', 'autoAcceptWebSearch'].includes(name)) { if (typeof value !== 'boolean') fail() }
        else if (name === 'approvalMode') { if (!['allowlist', 'unrestricted', 'auto-review'].includes(String(value))) fail() }
        else if (name === 'modelSelectionHistory') { if (!stringList(value)) fail() }
        else if (name === 'selectedModel') {
          if (!object(value)) fail()
          only(value, ['modelId', 'parameters']); if (typeof value.modelId !== 'string') fail()
          if (value.parameters !== undefined) {
            if (!Array.isArray(value.parameters)) fail()
            for (const parameter of value.parameters) { if (!object(parameter)) fail(); only(parameter, ['id', 'value']); if (typeof parameter.id !== 'string' || typeof parameter.value !== 'string') fail() }
          }
        } else if (['editor', 'display', 'network'].includes(name)) {
          if (!object(value)) fail()
          only(value, name === 'editor' ? ['vimMode', 'defaultBehavior'] : name === 'network' ? ['useHttp1ForAgent'] : ['showLineNumbers', 'showThinkingBlocks', 'showStatusIndicators', 'showStatusLineRunningTime', 'mode'])
          for (const [key, scalar] of Object.entries(value)) if (typeof scalar !== (['mode', 'defaultBehavior'].includes(key) ? 'string' : 'boolean')) fail()
        } else fail() // Legacy protobuf model and arbitrary modelParameters need native resolution.
      }
      reference(config); values.push(config)
      const mcp = await global(join(home, '.cursor/mcp.json')) ?? {}
      only(mcp, ['mcpServers']); values.push(remoteServers(mcp.mcpServers, 'cursor'))
      const dataRoot = env.CURSOR_DATA_DIR || join(home, '.cursor')
      for (const dir of relevant) {
        const key = dir.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
        for (const name of ['.workspace-trusted', 'mcp-approvals.json', 'mcp-disabled.json']) if (await inspect(join(dataRoot, 'projects', key, name))) fail()
      }
    }
    const localNames = input.providerId === 'claude' ? ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']
      : input.providerId === 'codex' ? ['.codex/config.toml']
        : ['.cursor/cli.json', '.cursor/cli-config.json', '.cursor/mcp.json', '.cursor/permissions.json', '.cursor/hooks.json', '.workspace-trusted']
    for (const dir of relevant) for (const name of localNames) { const path = join(dir, name); if (!globalPaths.has(path) && await inspect(path)) fail() }
    // Native instructions are executable input to the agent even when Git
    // ignores them. Compare the file graph, not just settings JSON/TOML:
    // Cursor 2026.10.01 LocalCursorRulesService walks all cwd ancestors and
    // recursive .cursor/rules; Claude also loads descendant memories lazily.
    // Codex uses Git-root -> cwd AGENTS(.override).md plus CODEX_HOME memory.
    // Comparing the superset of candidate files is intentionally conservative
    // about fallback/override flags; an unproven candidate never disappears.
    const repositoryRoot = async (cwd: string) => {
      for (const dir of ancestors(cwd)) {
        const marker = await inspect(join(dir, '.git'))
        if (marker) {
          if (!marker.isDirectory() && (!marker.isFile() || marker.nlink !== 1n)) fail()
          return dir
        }
      }
      return cwd
    }
    const sourceRoot = await repositoryRoot(source), executionRoot = await repositoryRoot(execution)
    if (relative(sourceRoot, source) !== relative(executionRoot, execution)) fail()
    const names = input.providerId === 'codex' ? ['AGENTS.override.md', 'AGENTS.md']
      : input.providerId === 'claude' ? ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']
        : ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md']
    const ruleName = input.providerId === 'claude' ? '.claude/rules' : input.providerId === 'cursor' ? '.cursor/rules' : null
    const ruleExtension = input.providerId === 'claude' ? '.md' : '.mdc'
    type Instruction = { scope: string; name: string; sha256: string }
    const addInstruction = async (out: Instruction[], path: string, scope: string, name: string) => {
      const text = await readText(path)
      if (text === null) return
      reference(text)
      // Imports may depend on external files and per-cwd consent. Do not
      // emulate native import expansion or silently fingerprint only the stub.
      if (/(?:^|[\s([{"'])@[^\s]/m.test(text)) fail()
      for (const root of [sourceRoot, executionRoot]) if (text.includes(root)) fail()
      out.push({ scope, name, sha256: digest(text) })
    }
    const ruleTree = async (out: Instruction[], dir: string, scope: string, prefix: string, depth = 0): Promise<void> => {
      if (depth > 32) fail()
      const children = await list(dir)
      if (!children) return
      for (const name of children) {
        const path = join(dir, name), s = await observe(path)
        if (!s) fail()
        if (s.isDirectory()) await ruleTree(out, path, scope, `${prefix}/${name}`, depth + 1)
        else if (name.endsWith(ruleExtension)) await addInstruction(out, path, scope, `${prefix}/${name}`)
        else if (!s.isFile()) fail()
      }
    }
    const layer = async (out: Instruction[], dir: string, scope: string) => {
      for (const name of names) await addInstruction(out, join(dir, name), scope, name)
      if (ruleName) await ruleTree(out, join(dir, ruleName), scope, ruleName)
      // Cursor applies ignore rules using absolute paths and native defaults.
      // Until those selectors can be reproduced, never assume equal rule text
      // means equal applicability in the two directories.
      if (input.providerId === 'cursor') for (const name of ['.cursorignore', '.cursorindexingignore']) if (await inspect(join(dir, name))) fail()
    }
    const instructions = async (cwd: string, root: string): Promise<Instruction[]> => {
      const out: Instruction[] = []
      const dirs = ancestors(cwd)
      const scoped = input.providerId === 'codex' ? dirs.slice(0, dirs.indexOf(root) + 1) : dirs
      for (const dir of [...scoped].reverse()) {
        const rel = relative(root, dir)
        const inside = rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
        await layer(out, dir, inside ? `project:${rel}` : `ancestor:${dir}`)
      }
      if (input.providerId === 'cursor') await addInstruction(out, join(root, '.cursorrules'), 'project:', '.cursorrules')
      // Native descendants can become effective after a Read/Edit or nested
      // rule discovery. Scan directories only, never ordinary project content.
      // No Git-ignore shortcut: ignored native instructions caused this bug.
      const descendants = async (dir: string, depth: number): Promise<void> => {
        if (depth > 32) fail()
        for (const name of await list(dir) ?? []) {
          if (name === '.git') { if (dir !== root) fail(); continue }
          const path = join(dir, name), s = await observe(path)
          if (!s) fail()
          if (!s.isDirectory()) continue
          await layer(out, path, `project:${relative(root, path)}`)
          await descendants(path, depth + 1)
        }
      }
      await descendants(cwd, 0)
      return out
    }
    const sourceInstructions = await instructions(source, sourceRoot)
    const executionInstructions = await instructions(execution, executionRoot)
    if (stable(sourceInstructions) !== stable(executionInstructions)) fail()
    values.push({ instructions: sourceInstructions })
    const sharedInstructions: Instruction[] = []
    if (input.providerId === 'codex') {
      for (const name of names) await addInstruction(sharedInstructions, join(configRoot, name), 'user', name)
    } else if (input.providerId === 'claude') {
      for (const name of ['CLAUDE.md', 'AGENTS.md']) await addInstruction(sharedInstructions, join(configRoot, name), 'user', name)
      await ruleTree(sharedInstructions, join(configRoot, 'rules'), 'user', 'rules')
      for (const root of systemRoots) {
        // Preserve the conservative managed-constraint policy.
        for (const name of ['CLAUDE.md', 'AGENTS.md', 'rules']) if (await inspect(join(root, name))) fail()
      }
    }
    values.push({ sharedInstructions })
    const nativeEnvironment = Object.fromEntries(Object.entries(env).filter(([name]) => !privateEnv.test(name) && /^(ANTHROPIC_|CLAUDE_|CODEX_|CURSOR_|OPENAI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/.test(name)))
    reference(nativeEnvironment); values.push(nativeEnvironment)
  }
  // Includes absent paths and directory identities: newly introduced layers,
  // replaced parents, inode swaps and in-place changes invalidate admission.
  for (const [path, expected] of observations) if (stamp(await stat(path)) !== expected) fail()
  for (const [path, expected] of listings) { const s = await stat(path); if (!s || listingStamp(s) !== expected) fail() }
  return digest(stable({ version: 2, provider: input.providerId, values }))
}
