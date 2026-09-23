import { spawn } from 'node:child_process'
import { isCompanionMcp } from './native-tools'
import { workbenchSubprocessEnv } from './subprocess-env'

export const workbenchFeatureConfig = { features: { plugins: false, apps: false, hooks: false } }
const shellEnvironmentKeys = ['PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'USER']
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const serverName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
const configFailure = () => new Error('无法核实 Codex 的工具配置；暂不启动任务。')

/** An empty MCP table merges with inherited config; disable every discovered name. */
export function workbenchCodexConfig(servers: unknown) {
  if (!Array.isArray(servers) || servers.some(server => !server || typeof server.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(server.name))) {
    throw new Error('无法核实 Codex 的工具配置；暂不启动任务。')
  }
  return {
    ...workbenchFeatureConfig,
    approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write',
    sandbox_workspace_write: { network_access: false, writable_roots: [], exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
    // include_only is applied after inherited `set` overrides in Codex, so a
    // user-configured credential cannot reappear in model-run shell commands.
    shell_environment_policy: { inherit: 'core', ignore_default_excludes: false, experimental_use_profile: false, include_only: [...shellEnvironmentKeys] },
    web_search: 'disabled',
    mcp_servers: Object.fromEntries(servers.map(server => [server.name, { enabled: false }])),
  }
}

/** Only overrides are returned: native credentials and tool allow/deny lists
 * remain in their original config layers. Discovery alone never enables MCP. */
export function workbenchCodexNativeConfig(discovered: unknown, effective: unknown) {
  const base = workbenchCodexConfig(discovered)
  if (!object(effective) || (effective.mcp_servers != null && !object(effective.mcp_servers))) throw configFailure()
  const native = effective.mcp_servers as Record<string, unknown> | undefined ?? {}
  const entries = discovered as { name: string; enabled?: boolean }[]
  if (entries.some(entry => entry.enabled != null && typeof entry.enabled !== 'boolean')) throw configFailure()
  const enabled = new Set(entries.filter(entry => entry.enabled === true).map(entry => entry.name))
  const servers: Record<string, { enabled: boolean; default_tools_approval_mode?: string; tools?: Record<string, { approval_mode: string }> }> = Object.assign(Object.create(null), base.mcp_servers)
  for (const [name, value] of Object.entries(native)) {
    if (!serverName(name) || !object(value)) throw configFailure()
    servers[name] = { enabled: false }
    if (!enabled.has(name) || isCompanionMcp(name, value) || (value.environment_id != null && value.environment_id !== 'local') || value.experimental_environment === 'remote') continue
    if (typeof value.command !== 'string' && typeof value.url !== 'string') continue
    if (value.tools != null && !object(value.tools)) throw configFailure()
    const overrides: Record<string, { approval_mode: string }> = Object.fromEntries(Object.entries(value.tools ?? {}).map(([tool, settings]) => {
      if (!tool || /[\u0000-\u001f\u007f]/.test(tool) || !object(settings)) throw configFailure()
      return [tool, { approval_mode: 'prompt' }]
    }))
    servers[name] = { enabled: true, default_tools_approval_mode: 'prompt', ...(Object.keys(overrides).length ? { tools: overrides } : {}) }
  }
  const search = effective.web_search ?? 'cached'
  if (!['disabled', 'cached', 'live'].includes(String(search))) throw configFailure()
  return { ...base, features: { ...base.features, tool_call_mcp_elicitation: true }, web_search: search as string, mcp_servers: servers }
}

/** CLI -c uses TOML values. All keys are fixed or validated MCP names. */
export function workbenchCodexArgs(config: Record<string, unknown>): string[] {
  const args: string[] = []
  const walk = (value: unknown, key: string) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, child] of Object.entries(value)) walk(child, key ? `${key}.${name}` : name)
    } else args.push('-c', `${key}=${JSON.stringify(value)}`)
  }
  walk(config, '')
  return args
}

/** Provider auth and proxies remain available to the Codex server itself.
 *  Daemon credentials/pointers have no role in a workbench subprocess (shared with the ACP executor). */
export function workbenchCodexEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return workbenchSubprocessEnv(source)
}

/** Read configuration names only, in the selected project; never launch MCPs. */
export async function discoverWorkbenchCodexConfig(binary: string, cwd: string, deadline = Date.now() + 15_000) {
  if (Date.now() >= deadline) throw configFailure()
  return new Promise<{ config: ReturnType<typeof workbenchCodexConfig>; servers: unknown }>((resolve, reject) => {
    const child = spawn(binary, [...workbenchCodexArgs(workbenchFeatureConfig), 'mcp', 'list', '--json'], {
      cwd, env: workbenchCodexEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    })
    let output = '', settled = false, closed = false
    const stop = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else if (!closed) child.kill('SIGKILL') } catch { /* Already reaped. */ }
    }
    const fail = () => {
      if (settled) return
      settled = true; clearTimeout(timer)
      stop()
      reject(new Error('无法核实 Codex 的工具配置；暂不启动任务。'))
    }
    const timer = setTimeout(fail, Math.max(0, deadline - Date.now()))
    child.stdin.end()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 1_000_000) fail() })
    child.stderr.resume() // Drain diagnostics without exposing configuration/auth details.
    child.on('error', fail)
    child.on('close', code => {
      closed = true
      if (settled) return
      if (code !== 0) { fail(); return }
      try {
        const parsed: unknown = JSON.parse(output), config = workbenchCodexConfig(parsed)
        // Transport credentials need not survive discovery. The native process
        // resolves its own config; CC retains only identity and enabled state.
        const servers = (parsed as { name: string; enabled?: boolean }[]).map(({ name, enabled }) => ({ name, enabled }))
        settled = true; clearTimeout(timer); stop(); resolve({ config, servers })
      } catch { fail() }
    })
  })
}
