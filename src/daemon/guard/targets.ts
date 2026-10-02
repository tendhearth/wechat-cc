/**
 * 守护 v2:把「provider id + 可能缺省的模型」补成一次调用**真正连到的地方**,好让分类器判。
 *
 *   claude → ANTHROPIC_BASE_URL(daemon.env 或 ~/.claude/settings.json 灌进来的;没设 = 官方)
 *   codex  → OPENAI_BASE_URL(没设 = 官方)
 *   openai → agent-config.openaiBaseUrl(openai-compatible:DeepSeek / Kimi / 自建网关都走它)
 *   cursor → 没给模型就用 agent-config.cursorModel,再没有就是 auto
 *   agy / gemini → 官方(Google)
 *
 * 只读配置,从不打印密钥:这里只碰 base URL 和模型名。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadAgentConfig, modelForProvider, type AgentConfig } from '../../lib/agent-config'
import { classifyCall, type CallTarget } from '../../lib/call-classifier'
import { findOnPath } from '../../lib/util'
import { loadGuardConfig } from './store'

export interface ProviderInUse {
  id: string
  model?: string | null
  baseUrl?: string | null
  /** configured = 已注册 provider 的配置模型;session = 某个在用会话钉的模型。 */
  via?: 'configured' | 'session'
}

export function makeResolveTarget(agentConfig: () => AgentConfig | null, env: NodeJS.ProcessEnv = process.env): (t: CallTarget) => CallTarget {
  return (t) => {
    let cfg: AgentConfig | null = null
    try { cfg = agentConfig() } catch { cfg = null }
    const out: CallTarget = { ...t }
    if (out.baseUrl === undefined || out.baseUrl === null) {
      if (t.provider === 'claude') out.baseUrl = env.ANTHROPIC_BASE_URL || null
      else if (t.provider === 'codex') out.baseUrl = env.OPENAI_BASE_URL || null
      else if (t.provider === 'openai') out.baseUrl = cfg?.openaiBaseUrl || null
    }
    if (t.provider === 'cursor' && (out.model === undefined || out.model === null || out.model === '') && t.purpose !== 'catalog') {
      out.model = cfg?.cursorModel || 'auto'
    }
    return out
  }
}

/** 已注册 provider 各自配置的模型(health / guard status 用)。 */
export function configuredProviders(cfg: AgentConfig | null, registered: readonly string[]): ProviderInUse[] {
  return registered.map(id => ({ id, model: cfg ? (modelForProvider(cfg, id) ?? null) : null, via: 'configured' as const }))
}

/**
 * CLI 进程拿不到 daemon 的 process.env:按 daemon 同样的来源补出两个 base URL(只读名字和值里的
 * URL,不碰密钥)。真实环境变量优先,其次 daemon.env,再次 ~/.claude/settings.json 的 env。
 */
export function guardEnvFor(stateDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keys = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'] as const
  const out: NodeJS.ProcessEnv = {}
  for (const k of keys) if (base[k]) out[k] = base[k]
  const fromFile = (path: string, pick: (raw: string) => Record<string, unknown>) => {
    try {
      if (!existsSync(path)) return
      const vals = pick(readFileSync(path, 'utf8'))
      for (const k of keys) if (!out[k] && typeof vals[k] === 'string' && vals[k]) out[k] = vals[k] as string
    } catch { /* 读不出来就当没设 */ }
  }
  fromFile(join(stateDir, 'daemon.env'), (raw) => {
    const r: Record<string, string> = {}
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m) r[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
    }
    return r
  })
  fromFile(join(homedir(), '.claude', 'settings.json'), (raw) => {
    const env = (JSON.parse(raw) as { env?: Record<string, unknown> }).env
    return env && typeof env === 'object' ? env : {}
  })
  return out
}

/** 已注册 provider 的配置模型 + 在用会话钉的模型,按 (id, model) 去重。 */
export function providersInUse(cfg: AgentConfig | null, registered: readonly string[], sessions: ReadonlyArray<{ id: string; model: string | null }>): ProviderInUse[] {
  const out = configuredProviders(cfg, registered)
  const seen = new Set(out.map(p => `${p.id}\u0000${p.model ?? ''}`))
  for (const s of sessions) {
    if (!s.model) continue
    const k = `${s.id}\u0000${s.model}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ id: s.id, model: s.model, via: 'session' })
  }
  return out
}

/**
 * `wechat-cc guard status` 用:CLI 进程不知道 daemon 实际注册了谁,按配置推一份(claude / codex
 * 总在;cursor 看 cursor-agent / CURSOR_API_KEY;openai 要 base URL + 模型;agy 看二进制;gemini 看模型),
 * 每家按 daemon 同一套规则分类。只读配置,不发任何流量。
 */
export function classifyConfiguredForCli(stateDir: string, opts: { onPath?: (bin: string) => string | null } = {}): Array<{ id: string; model: string | null; host: string | null; protected: boolean; kind: string; label: string; reason: string }> {
  let cfg: AgentConfig | null = null
  try { cfg = loadAgentConfig(stateDir) } catch { cfg = null }
  const onPath = opts.onPath ?? findOnPath
  const env = guardEnvFor(stateDir)
  const registered = ['claude', 'codex']
  if (cfg?.cursorAgentBin || onPath('cursor-agent') || process.env.CURSOR_API_KEY) registered.push('cursor')
  if (cfg?.openaiBaseUrl && cfg.openaiModel) registered.push('openai')
  if (cfg?.agyBin || onPath('agy')) registered.push('agy')
  if (cfg?.geminiModel) registered.push('gemini')
  const g = loadGuardConfig(stateDir)
  const resolve = makeResolveTarget(() => cfg, env)
  return configuredProviders(cfg, registered).map(p => {
    const c = classifyCall(resolve({ provider: p.id, model: p.model ?? null, purpose: 'turn' }), { protect: g.protect, trust: g.trust, protectCustomGateways: g.protect_custom_gateways })
    return { id: p.id, model: p.model ?? null, host: c.host, protected: c.protected, kind: c.kind, label: c.label, reason: c.reason }
  })
}
