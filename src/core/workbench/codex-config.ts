import { spawn } from 'node:child_process'

export const workbenchFeatureConfig = { features: { plugins: false, apps: false, hooks: false } }
const shellEnvironmentKeys = ['PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'USER']

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

export function workbenchCodexEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source }
  // Provider auth and proxies remain available to the Codex server itself.
  // Daemon credentials/pointers have no role in a workbench subprocess.
  for (const name of Object.keys(env)) if (/^(WECHAT_|HEARTH_|WXVAULT_|WXGRAPH_)/i.test(name)) delete env[name]
  return env
}

/** Read configuration names only, in the selected project; never launch MCPs. */
export async function discoverWorkbenchCodexConfig(binary: string, cwd: string) {
  return new Promise<ReturnType<typeof workbenchCodexConfig>>((resolve, reject) => {
    const child = spawn(binary, [...workbenchCodexArgs(workbenchFeatureConfig), 'mcp', 'list', '--json'], {
      cwd, env: workbenchCodexEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = '', settled = false
    const fail = () => {
      if (settled) return
      settled = true; clearTimeout(timer)
      child.kill('SIGKILL')
      reject(new Error('无法核实 Codex 的工具配置；暂不启动任务。'))
    }
    const timer = setTimeout(fail, 15_000)
    child.stdin.end()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 1_000_000) fail() })
    child.stderr.resume() // Drain diagnostics without exposing configuration/auth details.
    child.on('error', fail)
    child.on('close', code => {
      if (settled) return
      if (code !== 0) { fail(); return }
      try {
        const config = workbenchCodexConfig(JSON.parse(output))
        settled = true; clearTimeout(timer); resolve(config)
      } catch { fail() }
    })
  })
}
