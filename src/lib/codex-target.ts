/**
 * 守护:Codex 这一次**实际**连到哪里(2026-10-03)。
 *
 * codex(0.153 起实测)**不认** `OPENAI_BASE_URL` / `OPENAI_API_KEY` 环境变量 —— 端点只按它自己的配置走:
 *
 *   model_provider(缺省 "openai")
 *     ├─ 内置 openai   → `openai_base_url`;没写 = 官方(api.openai.com,ChatGPT 登录是 chatgpt.com,都是官方)
 *     ├─ 内置 ollama / lmstudio → 本机(`CODEX_OSS_BASE_URL` 可改)
 *     └─ 自定义 id     → `model_providers.<id>.base_url`(+ wire_api)
 *
 * 配置的层(低 → 高):系统 `/etc/codex/config.toml` → 用户 `$CODEX_HOME/config.toml`(缺省 `~/.codex`)
 * → 项目 `.codex/config.toml`(信任过的项目才生效)→ `-c` 覆盖(daemon 传的)→ `managed_config.toml`。
 *
 * 守护过去按 OPENAI_BASE_URL 判 Codex:变量指到国内网关、config 还是默认 ⇒ 守护说「不用保护」,codex
 * 却直连 api.openai.com —— 主人点名要堵的直连漏洞。这里按 codex 同一套规则重新解析;**拿不准一律
 * unresolved ⇒ 按需要保护**:读不出 / 坏 TOML、model_provider 指到没定义的 id、自定义 provider 没写
 * base_url、重定义内置 id(codex 会拒绝起)、老式顶层 `profile = "…"`(0.153 报错)、项目层改了端点
 * 相关的键(是否生效取决于信任,daemon 判不了)、不认识的内置 provider(如 Bedrock)。
 *
 * 工作台的 app-server 会话起来以后直接问 codex 自己(`config/read`,见 codex-app-server.ts),结果交给
 * `codexTargetFromConfig` —— 那是最准的一份(包含 MDM / 云端托管层,这里读不到)。
 *
 * `[profiles.x]` 表不看:新版 profile 只能靠 `--profile`,daemon 从不传。
 * 只读 base URL / provider id,从不读、从不打印密钥。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { CallTarget } from './call-classifier'

export type CodexTargetResolution =
  | { baseUrl: string | null; providerId: string; wireApi?: string }
  | { unresolved: true; reason: string }

export interface ResolveCodexTargetOptions {
  /** 子进程会拿到的环境(CODEX_HOME / HOME / CODEX_OSS_BASE_URL);缺省 process.env。 */
  env?: NodeJS.ProcessEnv
  /** codex 子进程的 cwd(项目层 `.codex/config.toml` 从这里往上找)。 */
  cwd?: string | null
  /** daemon 传给 codex 的 `-c` 覆盖:嵌套对象(SDK config 形状)或点号键(`model_providers.x.base_url`)。 */
  overrides?: Record<string, unknown> | null
  /** 测试注入:系统层目录(缺省 /etc/codex;Windows 不读)。 */
  systemDir?: string | null
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const BUILTIN = new Set(['openai', 'ollama', 'lmstudio', 'amazon-bedrock', 'bedrock'])
/** 改了就可能换端点的键(项目层出现这些 ⇒ 拿不准)。 */
const ENDPOINT_KEYS = ['model_provider', 'model_providers', 'openai_base_url', 'profile']
const unresolved = (reason: string): CodexTargetResolution => ({ unresolved: true, reason })

/** 纯函数:有效配置(config/read 的 `config`,或合并好的 TOML)→ 端点。 */
export function codexTargetFromConfig(config: unknown, env: NodeJS.ProcessEnv = process.env): CodexTargetResolution {
  if (!isObj(config)) return unresolved('codex 配置读不出来')
  if (config.profile != null) return unresolved('老式顶层 profile(codex 0.153 不再支持)')
  const mp = config.model_provider ?? 'openai'
  if (typeof mp !== 'string' || !mp.trim()) return unresolved('model_provider 不是字符串')
  const id = mp.trim()
  const providers = config.model_providers ?? {}
  if (!isObj(providers)) return unresolved('model_providers 形状不对')
  // codex 拒绝自定义里出现内置 id(「Built-in providers cannot be overridden」)⇒ 起不来,但别猜。
  if (Object.keys(providers).some(k => BUILTIN.has(k))) return unresolved('model_providers 重定义了内置 provider')
  const custom = providers[id]
  if (custom !== undefined) {
    if (!isObj(custom)) return unresolved(`model_providers.${id} 形状不对`)
    const base = custom.base_url
    if (typeof base !== 'string' || !base.trim()) return unresolved(`model_providers.${id} 没写 base_url`)
    return { baseUrl: base.trim(), providerId: id, ...(typeof custom.wire_api === 'string' ? { wireApi: custom.wire_api } : {}) }
  }
  if (id === 'openai') {
    const b = config.openai_base_url
    if (b == null || b === '') return { baseUrl: null, providerId: 'openai' }
    if (typeof b !== 'string') return unresolved('openai_base_url 不是字符串')
    return { baseUrl: b.trim() || null, providerId: 'openai' }
  }
  if (id === 'ollama' || id === 'lmstudio') {
    const oss = env.CODEX_OSS_BASE_URL?.trim()
    const port = env.CODEX_OSS_PORT?.trim()
    return { baseUrl: oss || `http://localhost:${port || (id === 'ollama' ? '11434' : '1234')}/v1`, providerId: id }
  }
  return unresolved(`不认识的 model_provider「${id}」`)
}

/** `-c a.b.c=v` 点号键 / 嵌套对象,深合并到 base 上(覆盖压过 base)。 */
function applyOverrides(base: Obj, overrides: Obj): Obj {
  const out: Obj = structuredClone(base)
  const setPath = (path: string[], value: unknown) => {
    let cur = out
    for (const seg of path.slice(0, -1)) {
      if (!isObj(cur[seg])) cur[seg] = {}
      cur = cur[seg] as Obj
    }
    cur[path[path.length - 1]!] = value
  }
  const walk = (prefix: string[], value: unknown) => {
    if (isObj(value)) { for (const [k, v] of Object.entries(value)) walk([...prefix, ...k.split('.')], v); return }
    setPath(prefix, value)
  }
  walk([], overrides)
  return out
}

function mergeDeep(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? mergeDeep(out[k] as Obj, v) : v
  return out
}

// 每次调用都读(codex 每一轮也是新读的),按 (path, mtime, size) 缓存解析结果。
const cache = new Map<string, { key: string; value: Obj | 'bad' }>()
/** null = 不存在;'bad' = 存在但读不出 / 坏 TOML。 */
function readLayer(path: string): Obj | null | 'bad' {
  let st
  try { st = statSync(path) } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'ENOENT' || (e as NodeJS.ErrnoException)?.code === 'ENOTDIR' ? null : 'bad' }
  if (!st.isFile()) return 'bad'
  const key = `${st.mtimeMs}:${st.size}`
  const hit = cache.get(path)
  if (hit && hit.key === key) return hit.value
  let value: Obj | 'bad'
  try { value = parseToml(readFileSync(path, 'utf8')) as Obj } catch { value = 'bad' }
  cache.set(path, { key, value })
  return value
}

export function codexHomeOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.codex')
}

/** 按 codex 自己的规则读配置层,算出这一次会连的端点。拿不准 ⇒ unresolved。 */
export function resolveCodexTarget(opts: ResolveCodexTargetOptions = {}): CodexTargetResolution {
  const env = opts.env ?? process.env
  const home = codexHomeOf(env)
  const userPath = resolvePath(home, 'config.toml')
  const systemDir = opts.systemDir === undefined ? (process.platform === 'win32' ? null : '/etc/codex') : opts.systemDir
  let merged: Obj = {}
  const layer = (path: string): string | null => {
    const v = readLayer(path)
    if (v === 'bad') return `读不出 ${path}`
    if (v) merged = mergeDeep(merged, v)
    return null
  }
  let err: string | null = null
  if (systemDir && (err = layer(join(systemDir, 'config.toml')))) return unresolved(err)
  if ((err = layer(userPath))) return unresolved(err)
  // 项目层:是否生效取决于主人有没有信任这个项目 —— daemon 判不了,碰了端点相关的键就按拿不准。
  if (opts.cwd) {
    let dir = resolvePath(opts.cwd)
    for (;;) {
      const p = join(dir, '.codex', 'config.toml')
      if (p !== userPath) {
        const v = readLayer(p)
        if (v === 'bad') return unresolved(`读不出项目层 ${p}`)
        if (v && ENDPOINT_KEYS.some(k => k in v)) return unresolved(`项目层 ${p} 改了端点相关的配置`)
      }
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  if (opts.overrides && Object.keys(opts.overrides).length) merged = applyOverrides(merged, opts.overrides)
  for (const p of [join(home, 'managed_config.toml'), ...(systemDir ? [join(systemDir, 'managed_config.toml')] : [])]) {
    if ((err = layer(p))) return unresolved(err)
  }
  return codexTargetFromConfig(merged, env)
}

/** 解析结果 → 守护的 CallTarget(带 exact:不再让 daemon 按此刻的环境变量补)。 */
export function codexTargetToCall(r: CodexTargetResolution, model: string | null | undefined, extra: Partial<CallTarget> = {}): CallTarget {
  if ('unresolved' in r) return { provider: 'codex', model: model ?? null, unresolved: true, ...extra }
  return { provider: 'codex', model: model ?? null, baseUrl: r.baseUrl, exact: true, ...extra }
}

export function codexCallTarget(base: { model?: string | null; purpose?: CallTarget['purpose'] }, opts: ResolveCodexTargetOptions = {}): CallTarget {
  let r: CodexTargetResolution
  try { r = resolveCodexTarget(opts) } catch { r = unresolved('解析 codex 配置出错') }
  return codexTargetToCall(r, base.model, base.purpose ? { purpose: base.purpose } : {})
}
