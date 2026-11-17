/** CC owns this login. Never discover, read or copy credentials from the owner's Grok home. */
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { writeFileAtomic } from './json-file'
import { EXECUTOR_FACTS } from './executor-facts'

export function grokHome(stateDir: string): string {
  if (!stateDir || !isAbsolute(stateDir)) throw new Error('Grok 需要 CC 的专属 HOME：未提供绝对状态目录。')
  return join(stateDir, 'executors', 'grok', 'home')
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
// umask 077 first: grok creates .grok itself, and CC only trusts a 0700 home.
export const grokLoginCommand = (stateDir: string, shell: 'posix' | 'powershell' = 'posix', binary?: string): string => {
  const home = grokHome(stateDir)
  if (shell === 'powershell') {
    const h = "'" + home.replaceAll("'", "''") + "'"
    const bin = binary ? "& '" + binary.replaceAll("'", "''") + "'" : 'grok'
    return `Get-ChildItem Env:GROK_* | Remove-Item; Remove-Item Env:XAI_API_KEY,Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; $env:HOME = ${h}; $env:USERPROFILE = $env:HOME; New-Item -ItemType Directory -Force -Path $env:HOME | Out-Null; ${bin} login`
  }
  const h = quote(home)
  const bin = binary ? quote(binary) : 'grok'
  return `umask 077 && mkdir -p ${h} && (unset GROK_HOME GROK_AUTH_PATH GROK_AUTH GROK_CONFIG GROK_API_KEY XAI_API_KEY CLAUDE_CONFIG_DIR; HOME=${h} ${bin} login)`
}
const loginRequired = (stateDir: string) => `Grok 还没在 CC 里登录。请在电脑上运行：${grokLoginCommand(stateDir)}`

/** Only stat the dedicated auth file; its contents and token validity belong to the official CLI. */
export function grokHomeProblem(stateDir?: string): string | undefined {
  if (!stateDir || !isAbsolute(stateDir)) return 'Grok 需要 CC 的专属 HOME：未提供绝对状态目录。'
  try {
    const home = grokHome(stateDir)
    for (const path of [join(stateDir, 'executors'), join(stateDir, 'executors/grok'), home, join(home, '.grok')]) {
      const st = lstatSync(path)
      if (!st.isDirectory() || st.isSymbolicLink() || (process.platform !== 'win32' && (st.mode & 0o777) !== 0o700)) return loginRequired(stateDir)
    }
    if (!lstatSync(join(home, '.grok/auth.json')).isFile()) return loginRequired(stateDir)
    return undefined
  } catch { return loginRequired(stateDir) }
}

// 1.0.77 bundled user guide: 09-plugins (session-start auto-update),
// 05-configuration (telemetry/trace/external OTEL), 26-config-reference (diagnostics).
const CONFIG = `# Managed by CC; project configuration follows project trust.
plugin_auto_update = false

[features]
telemetry = false
cursor_marketplace = false

[diagnostics]
error_reporting = false

[telemetry]
mixpanel_enabled = false
trace_upload = false
otel_enabled = false
`

/** Base must already have the caller's normal subprocess credential filtering applied. */
export function grokSubprocessEnv(stateDir: string | undefined, base: NodeJS.ProcessEnv, requireLogin = false): NodeJS.ProcessEnv {
  if (!stateDir) throw new Error('Grok 需要 CC 的专属 HOME：未提供状态目录。')
  const home = grokHome(stateDir)
  for (const path of [join(stateDir, 'executors'), join(stateDir, 'executors/grok'), home, join(home, '.grok'), join(home, '.config'), join(home, '.cache'), join(home, '.local'), join(home, '.local/share'), join(home, '.local/state'), join(home, '.run'), join(home, 'tmp')]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const st = lstatSync(path)
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Grok 专属 HOME 不能使用符号链接。')
    chmodSync(path, 0o700)
  }
  const config = join(home, '.grok/config.toml')
  try { if (!lstatSync(config).isFile()) throw new Error('Grok 专属配置必须是普通文件。') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // Multiple sessions/probes share this home. Never expose a truncated config to another process.
  writeFileAtomic(config, CONFIG, { mode: 0o600 })
  if (requireLogin) {
    const problem = grokHomeProblem(stateDir)
    if (problem) throw new Error(problem)
  }
  const env = { ...base }
  // These can override HOME or reintroduce another account/configuration source.
  // No provider keys are added; proxy/PATH and normal executor filtering stay with the caller.
  for (const name of Object.keys(env)) if (/^GROK_/i.test(name) || /^(CLAUDE_CONFIG_DIR|XAI_API_KEY)$/i.test(name)) delete env[name]
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), XDG_RUNTIME_DIR: join(home, '.run'), TMPDIR: join(home, 'tmp'), TMP: join(home, 'tmp'), TEMP: join(home, 'tmp') }
}

/** Phones cannot run the login; they only point the owner at the desktop card. */
export const GROK_PHONE_LOGIN_HINT = `${EXECUTOR_FACTS.grok.names.name} 还没在 CC 里登录。到电脑上点一下接入。`
