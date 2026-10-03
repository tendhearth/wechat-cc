/**
 * 调用分类 —— 「这一次调用要不要网络保护」(2026-10-02 主人拍板,守护 v2)。
 *
 * 守护不再按「是不是模型调用」一刀切,而是按**这一次调用真正连到哪里 + 用哪个模型**判:
 *
 *   默认需要保护:Anthropic(Claude API / Claude Code / Agent SDK 走官方端点)、OpenAI(API、
 *     Codex)、Google(Gemini、agy/Antigravity)、OpenRouter 这类海外模型聚合;Cursor **只有**
 *     选了明确的 Claude / GPT / o 系列 / Gemini 模型时才算。
 *   默认不需要保护:DeepSeek、Kimi 国内版(moonshot.cn)、通义/DashScope、智谱等国内平台;
 *     自建(localhost / 局域网 / 私网 IP / 主人自己的服务器);Cursor 的 auto 和它自家模型
 *     (composer-*);自定义网关(任何非官方 base URL,包括把 ANTHROPIC_BASE_URL 指到别处的
 *     Claude Code)—— 自定义网关默认不保护,guard.json 里一个开关可以把它们一并纳入。
 *   拿不准的端点(Kimi 国际版 api.moonshot.ai 等)按端点 host 判;未知的 Cursor 模型名默认保护。
 *
 * 覆盖写在 guard.json 的 `protect` / `trust` 两张表里(见 docs/reference/network-guard.md)。
 * 纯函数、零依赖:core(协调器 / registry / 工作台)和 daemon、CLI 都用同一份判定。
 */

export interface CallTarget {
  /** provider id(claude / codex / cursor / openai / gemini / agy),或 voice 这类非 provider 的出口。 */
  provider: string
  /** 这一次调用用的模型;undefined/null = provider 的默认(cursor 视为 auto)。 */
  model?: string | null
  /** 实际连的 base URL;undefined/null = provider 的官方默认端点。 */
  baseUrl?: string | null
  /**
   * 只影响 Cursor:列模型目录(catalog / usage)和起会话(setup:ACP session/new|load,不发模型请求)
   * 都不是一次模型回合,按 Cursor 自家处理。
   */
  purpose?: 'turn' | 'eval' | 'catalog' | 'usage' | 'voice' | 'setup'
  /**
   * 评审 #193 P1-1:执行者 / 会话报出来的**实际**目标(端点 + 模型都是它真正会用的)。
   * true ⇒ daemon 不再按此刻的配置补端点 / 默认模型 —— 配置后来改了,在用的执行者不会跟着改。
   */
  exact?: boolean
  /** 拿不准这一次实际连到哪里(执行者没报目标)⇒ 按需要保护(fail closed)。 */
  unresolved?: boolean
}

export interface ClassifyPolicy {
  /** 一定要保护的:host、`provider:模型` 通配、或裸 provider id。protect 压过 trust。 */
  protect?: readonly string[]
  /** 不需要保护的(覆盖默认)。 */
  trust?: readonly string[]
  /** 自定义网关(非官方、非国内、非自建的 base URL)是否也要保护。缺省 false。 */
  protectCustomGateways?: boolean
}

export type CallKind =
  | 'official'        // 海外官方端点(Anthropic / OpenAI / Google …)
  | 'aggregator'      // 海外模型聚合(OpenRouter …)
  | 'overseas_other'  // 拿不准、按 host 判成海外的(Kimi 国际版、dashscope-intl …)
  | 'cursor_overseas' // Cursor + 明确的 Claude / GPT / o / Gemini 模型
  | 'cursor_unknown'  // Cursor + 不认识的模型名(默认保护)
  | 'cursor_own'      // Cursor auto / composer-* 等自家模型
  | 'domestic'        // 国内平台
  | 'self_hosted'     // localhost / 局域网 / 私网 / tailnet
  | 'custom_gateway'  // 其它自定义 base URL
  | 'unknown_provider'
  | 'unresolved'      // 执行者没报出实际目标 —— 拿不准,按需要保护
  | 'override'

export interface CallClass {
  protected: boolean
  kind: CallKind
  /** 给人看的名字:「Claude」「OpenAI」「Cursor(claude-4.5-sonnet)」…… 拒绝文案里用它。 */
  label: string
  host: string | null
  /** 一句话为什么这么判。 */
  reason: string
}

/** 各 provider 不给 base URL 时连的官方端点。 */
const PROVIDER_DEFAULT_HOST: Record<string, { host: string; label: string }> = {
  claude: { host: 'api.anthropic.com', label: 'Claude' },
  codex: { host: 'api.openai.com', label: 'Codex(OpenAI)' },
  openai: { host: 'api.openai.com', label: 'OpenAI' },
  gemini: { host: 'generativelanguage.googleapis.com', label: 'Gemini' },
  agy: { host: 'cloudcode-pa.googleapis.com', label: 'Gemini(agy)' },
  cursor: { host: 'api2.cursor.sh', label: 'Cursor' },
}

/** 海外官方端点(后缀匹配)→ 名字。 */
const OFFICIAL_HOSTS: Array<[string, string]> = [
  ['anthropic.com', 'Claude'], ['claude.ai', 'Claude'],
  ['openai.com', 'OpenAI'], ['chatgpt.com', 'OpenAI'],
  ['googleapis.com', 'Gemini'], ['google.com', 'Google'],
  ['x.ai', 'xAI'], ['mistral.ai', 'Mistral'], ['groq.com', 'Groq'], ['cohere.com', 'Cohere'], ['cohere.ai', 'Cohere'],
  ['perplexity.ai', 'Perplexity'],
]
/** 海外模型聚合。 */
const AGGREGATOR_HOSTS: Array<[string, string]> = [
  ['openrouter.ai', 'OpenRouter'], ['together.xyz', 'Together'], ['together.ai', 'Together'],
  ['fireworks.ai', 'Fireworks'], ['deepinfra.com', 'DeepInfra'], ['poe.com', 'Poe'],
]
/** 拿不准、按 host 判成海外的(默认保护,trust 可放开)。 */
const OVERSEAS_OTHER_HOSTS: Array<[string, string]> = [
  ['api.moonshot.ai', 'Kimi 国际版'], ['moonshot.ai', 'Kimi 国际版'],
  ['dashscope-intl.aliyuncs.com', '通义国际版'],
  ['api.deepseek.ai', 'DeepSeek(海外域名)'],
]
/** 国内平台(默认不保护)。 */
const DOMESTIC_HOSTS: Array<[string, string]> = [
  ['deepseek.com', 'DeepSeek'], ['moonshot.cn', 'Kimi'], ['aliyuncs.com', '通义/DashScope'],
  ['bigmodel.cn', '智谱'], ['volces.com', '火山方舟'], ['volcengine.com', '火山引擎'], ['siliconflow.cn', '硅基流动'],
  ['baidubce.com', '百度千帆'], ['minimax.chat', 'MiniMax'], ['minimaxi.com', 'MiniMax'],
  ['lingyiwanwu.com', '零一万物'], ['tencentcloudapi.com', '腾讯混元'], ['baichuan-ai.com', '百川'],
  ['stepfun.com', '阶跃星辰'], ['xf-yun.com', '讯飞星火'], ['sensenova.cn', '商汤'], ['modelscope.cn', '魔搭'],
]

function suffixMatch(host: string, table: Array<[string, string]>): string | null {
  for (const [suffix, label] of table) if (host === suffix || host.endsWith(`.${suffix}`)) return label
  return null
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null
  const s = url.trim()
  if (!s) return null
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`)
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
    return h || null
  } catch { return null }
}

/** localhost / 回环 / 私网 / 链路本地 / CGNAT(tailnet)/ .local .lan .internal / 不带点的主机名。 */
export function isSelfHostedHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal') || h.endsWith('.home.arpa') || h.endsWith('.ts.net')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0
  }
  if (h.includes(':')) return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)
  return !h.includes('.')
}

// Cursor 模型名:自家的不保护;明确的海外模型保护;其余(不认识)保护。
const CURSOR_OWN = [/^auto$/, /^default$/, /^composer(\b|[-.\d])/, /^cursor(\b|[-.])/]
const CURSOR_OVERSEAS = [/claude/, /sonnet/, /opus/, /haiku/, /^gpt/, /^o\d/, /gemini/, /codex/, /^chatgpt/]

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`, 'i')
}

/**
 * 覆盖条目的三种写法:
 *   - `provider:模型通配`(含冒号且不含 `://`):`cursor:composer-*`、`openai:*`、`cursor:kimi-k2`
 *   - host(含点,可带 `*.` 前缀或整个 URL):`api.moonshot.ai`、`*.example.com`、`https://gw.example.com/v1`
 *   - 裸 provider id(不含点也不含冒号):`codex`、`agy`
 */
export function matchesOverride(pattern: string, t: CallTarget, host: string | null): boolean {
  const p = pattern.trim()
  if (!p) return false
  if (p.includes(':') && !p.includes('://')) {
    const i = p.indexOf(':')
    const prov = p.slice(0, i), modelGlob = p.slice(i + 1) || '*'
    if (!globToRegExp(prov).test(t.provider)) return false
    const model = (t.model ?? '').trim()
    return modelGlob === '*' || (model !== '' && globToRegExp(modelGlob).test(model))
  }
  if (!p.includes('.') && !p.includes('://')) return p.toLowerCase() === t.provider.toLowerCase()
  if (!host) return false
  const ph = hostOf(p.replace(/^\*\./, '')) ?? ''
  if (!ph) return false
  return host === ph || host.endsWith(`.${ph}`)
}

function cursorModelClass(model: string | null | undefined, purpose: CallTarget['purpose']): CallClass {
  const host = PROVIDER_DEFAULT_HOST.cursor!.host
  // cursor-agent 的 ACP 模型 id 带参数后缀:`default[]`(= Auto)、`claude-opus-5[thinking=true,…]`。
  const m = (model ?? '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
  if (purpose === 'catalog' || purpose === 'usage' || purpose === 'setup') return { protected: false, kind: 'cursor_own', label: 'Cursor', host, reason: '列模型目录不选模型,按 Cursor 自家处理' }
  if (!m || CURSOR_OWN.some(r => r.test(m))) return { protected: false, kind: 'cursor_own', label: `Cursor(${m || 'auto'})`, host, reason: 'Cursor auto / 自家模型' }
  if (CURSOR_OVERSEAS.some(r => r.test(m))) return { protected: true, kind: 'cursor_overseas', label: `Cursor(${model})`, host, reason: 'Cursor 上选了 Claude / GPT / o 系列 / Gemini 模型' }
  return { protected: true, kind: 'cursor_unknown', label: `Cursor(${model})`, host, reason: '不认识的 Cursor 模型名,默认保护(guard.json trust 可放开)' }
}

function hostClass(host: string, providerLabel: string, policy: ClassifyPolicy): CallClass {
  let label: string | null
  if ((label = suffixMatch(host, OVERSEAS_OTHER_HOSTS))) return { protected: true, kind: 'overseas_other', label, host, reason: '海外端点(按 host 判)' }
  if ((label = suffixMatch(host, OFFICIAL_HOSTS))) return { protected: true, kind: 'official', label, host, reason: '海外官方端点' }
  if ((label = suffixMatch(host, AGGREGATOR_HOSTS))) return { protected: true, kind: 'aggregator', label, host, reason: '海外模型聚合' }
  if ((label = suffixMatch(host, DOMESTIC_HOSTS))) return { protected: false, kind: 'domestic', label, host, reason: '国内平台' }
  if (isSelfHostedHost(host)) return { protected: false, kind: 'self_hosted', label: `${providerLabel}(${host})`, host, reason: '本机 / 局域网 / 私网' }
  const on = policy.protectCustomGateways === true
  return { protected: on, kind: 'custom_gateway', label: `${providerLabel}(${host})`, host, reason: on ? '自定义网关(guard.json 开了 protect_custom_gateways)' : '自定义网关,默认不保护' }
}

export function classifyCall(t: CallTarget, policy: ClassifyPolicy = {}): CallClass {
  const provider = (t.provider || '').trim()
  const def = PROVIDER_DEFAULT_HOST[provider]
  const providerLabel = def?.label ?? provider ?? '?'
  const explicitHost = hostOf(t.baseUrl)
  let base: CallClass
  if (t.unresolved) {
    // 评审 #193 P1-1:执行者没报出这一次实际连到哪里 —— 不拿此刻的配置去猜,按需要保护。
    base = { protected: true, kind: 'unresolved', label: providerLabel, host: null, reason: '拿不准这一次实际连到哪里,按需要保护' }
  } else if (explicitHost) {
    // 显式 base URL 指回官方端点,还是官方(ANTHROPIC_BASE_URL=https://api.anthropic.com)。
    base = hostClass(explicitHost, providerLabel, policy)
    if (base.kind === 'official' && def && (explicitHost === def.host || explicitHost.endsWith(`.${def.host}`))) base = { ...base, label: providerLabel }
  } else if (provider === 'cursor') {
    base = cursorModelClass(t.model, t.purpose)
  } else if (def) {
    base = { protected: true, kind: 'official', label: providerLabel, host: def.host, reason: '官方端点' }
  } else {
    // 不认识的 provider、又没给端点:拿不准就保护(fail safe)。
    base = { protected: true, kind: 'unknown_provider', label: provider || '未知接口', host: null, reason: '不认识的接口,默认保护' }
  }
  const host = base.host
  if (policy.protect?.some(p => matchesOverride(p, t, host))) {
    return base.protected ? base : { ...base, protected: true, kind: 'override', reason: 'guard.json protect 覆盖' }
  }
  if (policy.trust?.some(p => matchesOverride(p, t, host))) {
    return base.protected ? { ...base, protected: false, kind: 'override', reason: 'guard.json trust 覆盖' } : base
  }
  return base
}
