/**
 * failure-shapes — 只做一件事:**把 provider 失败时的真实形状记下来**。
 *
 * WHY:auth/网络的判定现在散在四处,而它们对同一段文本会给出不同答案:
 *   · core/auth-fail.ts        三套哨兵(assistant-text / sdk-error / claude 专用)
 *   · daemon/llm-health.ts     私有 AUTH_RE(宽集)
 *   · daemon/health/classify   FailureKind(顺序敏感)
 *   · core/provider-registry   只认 `auth_failed:` 前缀(最窄)
 *
 * 同根是 **provider 边界没产结构化 code**,下游只好各自去猜文案。要修它,
 * 得先知道每个 provider 真实失败长什么样 —— 而 owner 的红线明确写着
 * 「别拍脑袋,先真机采集」(claude 曾因宽集误报「登录过期」被收窄回双哨兵;
 * agy 的模糊报错已定为按瞬时处理)。
 *
 * **这个模块不改变任何分类行为**,只如实调用那四处、把分歧记下来。等真出现
 * 一次登录失效,我们会同时拿到:原始形状 + 四处判定的分歧 + 当时的 errorCode。
 *
 * 采集面**必须包含 one-shot eval**(cheapEval/strongEval/delegate),不能只有
 * 会话轮次 —— agy 今天只在 one-shot 那条路上跑,而那条路一条记录都不产:
 * turn_records 里 agy 是零行,不是埋点坏了,是它根本不走会话轮次。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { isAuthFail, isAuthFailError } from '../../core/auth-fail'
import { isAuthError } from '../../core/provider-registry'
import { LLM_HEALTH_AUTH_RE } from '../llm-health'
import { classifyFailure } from '../health/classify'

/** 采什么操作失败的 —— agy 只在 one_shot 这几档里跑。 */
export type FailureOp = 'turn' | 'cheap_eval' | 'strong_eval' | 'delegate'

export const FAILURE_SHAPES_FILE = 'failure-shapes.jsonl'
/** 只留最近这么多条 —— 这是给一次重构用的临时语料,不是永久日志。 */
export const MAX_SHAPES = 500
/** 存多少原文。够看形状,又不至于把长栈/凭证整段落库。 */
export const MESSAGE_KEEP = 200

/** 四处判定对同一段文本各自的回答 —— **分歧就是这次采集要找的东西**。 */
export interface ClassifierVerdicts {
  authFailAssistantText: boolean
  authFailSdkError: boolean
  authFailClaudeSentinel: boolean
  authFailError: boolean
  llmHealthAuthRe: boolean
  providerRegistryIsAuthError: boolean
  healthClassify: string
}

export interface FailureShape {
  ts: string
  provider: string
  op: FailureOp
  /** provider 自己给的结构化 code。**null 才是重点** —— 它意味着这一家
   *  在这个失败上什么结构都没产出,下游只能猜文案。 */
  errorCode: string | null
  messageHead: string
  messageLen: number
  /** 全文的哈希:同一种失败反复出现时能计数,又不用把全文落库。 */
  messageHash: string
  verdicts: ClassifierVerdicts
  /** 四处判定是否一致(全都说 auth 或全都说不是)。false = 值得看的样本。 */
  agreed: boolean
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer «redacted»'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-«redacted»'],
  [/\b(api[_-]?key|token|secret|password)["'\s:=]+[A-Za-z0-9._~+/=-]{8,}/gi, '$1=«redacted»'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '«hex»'],
  // 长串的兜底,但必须**同时含字母和数字**才算像 token。不加这个约束的话,
  // 任何长单词/重复字符都会被抹掉 —— 那会毁掉真正要看的错误形状,而采集的
  // 全部意义就是看形状。宁可漏擦一个奇怪的长词,不可把样本擦成空的。
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g, '«opaque»'],
]

/** 错误消息里带凭证是常有的事 —— 落库之前先擦掉。 */
export function redactSecrets(text: string): string {
  let out = text
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to)
  return out
}

/** 如实调用四处判定。**不做任何合并/裁决** —— 分歧本身就是要采的数据。 */
export function classifyAll(message: string, errorCode: string | null): ClassifierVerdicts {
  const asError = new Error(errorCode ? `${errorCode}: ${message}` : message)
  return {
    authFailAssistantText: isAuthFail('assistant-text', message),
    authFailSdkError: isAuthFail('sdk-error', message),
    authFailClaudeSentinel: isAuthFail('claude-sentinel', message),
    authFailError: isAuthFailError(asError),
    llmHealthAuthRe: LLM_HEALTH_AUTH_RE.test(message),
    providerRegistryIsAuthError: isAuthError(asError),
    healthClassify: classifyFailure(asError).kind,
  }
}

function verdictsAgree(v: ClassifierVerdicts): boolean {
  const bools = [
    v.authFailAssistantText, v.authFailSdkError, v.authFailClaudeSentinel,
    v.authFailError, v.llmHealthAuthRe, v.providerRegistryIsAuthError,
  ]
  const anyAuth = bools.some(Boolean)
  const allAuth = bools.every(Boolean)
  const classifySaysAuth = v.healthClassify === 'llm_auth'
  return (allAuth && classifySaysAuth) || (!anyAuth && !classifySaysAuth)
}

export function buildFailureShape(input: {
  provider: string; op: FailureOp; errorCode?: string | null; message: string; now?: Date
}): FailureShape {
  const raw = input.message ?? ''
  const redacted = redactSecrets(raw)
  const verdicts = classifyAll(raw, input.errorCode ?? null)
  return {
    ts: (input.now ?? new Date()).toISOString(),
    provider: input.provider,
    op: input.op,
    errorCode: input.errorCode ?? null,
    messageHead: redacted.slice(0, MESSAGE_KEEP),
    messageLen: raw.length,
    messageHash: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    verdicts,
    agreed: verdictsAgree(verdicts),
  }
}

/**
 * 追加一条,并把文件裁到 MAX_SHAPES。**绝不抛** —— 采集失败不能影响它正在
 * 观察的那条路径(这一整轮修的就是「出错时把主路径也带塌」这类问题)。
 */
export function recordFailureShape(stateDir: string, input: Parameters<typeof buildFailureShape>[0]): void {
  try {
    const path = join(stateDir, FAILURE_SHAPES_FILE)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(buildFailureShape(input)) + '\n', { mode: 0o600 })
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    if (lines.length > MAX_SHAPES) {
      writeFileSync(path, lines.slice(-MAX_SHAPES).join('\n') + '\n', { mode: 0o600 })
    }
  } catch { /* 采集永远不许影响主路径 */ }
}
