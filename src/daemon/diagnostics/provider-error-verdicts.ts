/**
 * provider-error-verdicts — 把一条**真实的** provider 失败样本喂给今天所有的
 * 判定处,如实记下每一处怎么说。只做记录,不做裁决,不被运行时调用。
 *
 * WHY:arch backlog #4(错误通道结构化)第 1 步。方向已定 —— 每个 provider
 * 边界产出结构化错误码,下游不再正则错误文本 —— 但动手之前,要先知道
 * 每家**真实**失败长什么样、今天的判定对它们各说什么。样本在
 * `__fixtures__/provider-errors/*.json`(真机日志采集 + 沙箱诱发),
 * 结论在 docs/reference/provider-error-shapes.md。
 *
 * 判定处与 failure-shapes.ts 的 classifyAll 是同一组,外加三处它没覆盖的:
 *   · isAuthFailError 带上真实 HTTP status(classifyAll 只拿 message 造 Error,
 *     看不到 status —— 而 openai 兼容那条路今天**正是**靠 status 判 auth 的)
 *   · lib/auth-failure 的 classifyProviderFailure(三档闭集;今天没有调用方)
 *   · core/provider-quota 的额度/限流判定与 Cursor 的「整条回复就是催升级」
 */
import { isAuthFail, isAuthFailError } from '../../core/auth-fail'
import { classifyProviderError, isQuotaRefusalText } from '../../core/provider-quota'
import { isAuthError } from '../../core/provider-registry'
import { classifyProviderFailure, looksLikeAuthFailure, type ProviderFailureKind } from '../../lib/auth-failure'
import { isConnectFailure } from '../../lib/net-errors'
import { classifyFailure, type FailureKind } from '../health/classify'

/** 这条样本**实际上**是什么失败 —— 人工按来龙去脉标注,不是任何判定器的输出。 */
export type FailureTruth =
  | 'auth'            // 凭证无效/缺失:只有主人能修
  | 'auth_ambiguous'  // 文案里 auth 与超时/网络搅在一起(agy 那句);owner 红线:按瞬时
  | 'network'         // 连不上 / TLS / DNS / 连接被掐
  | 'timeout'         // 请求或回合超时
  | 'server'          // 对端 5xx / 网关挂了
  | 'quota'           // 额度耗尽
  | 'model_unsupported' // 选的模型这个账号/这个 CLI 版本用不了
  | 'unknown'         // 信息已经丢光(空文本、只剩 "exited with code 1")
  | 'not_provider'    // daemon 自己的错误(看门狗、步数预算),混在同一条通道里

export interface ProviderErrorSample {
  id: string
  provider: 'claude' | 'codex' | 'cursor' | 'agy' | 'openai' | 'gemini'
  truth: FailureTruth
  /** harvested = 真机历史(日志/库表);induced = 沙箱诱发,走 daemon 同一份 provider 代码。 */
  source: 'harvested' | 'induced'
  /** 哪条路上冒出来的:一次性评估 / 会话轮次 / ACP 建会话 / 工作台。 */
  path: 'cheap_eval' | 'session' | 'acp_setup' | 'workbench' | 'sdk_raw'
  /** 下游拿到它的形态:抛出的 Error / AgentEvent.error / 当成正文的 text 事件 / ACP 错误对象。 */
  channel: 'thrown' | 'error_event' | 'text_event' | 'acp_error' | 'sdk_message'
  /** provider 层今天**已经**附上的结构化码(AgentEvent.code 等);null = 什么结构都没有。 */
  errorCode: string | null
  /** 抛出物上的 HTTP status / ACP code(有就记)。isAuthFailError 会看它。 */
  status?: number
  /** 原文(已脱敏:请求 id / cf-ray / 会话 id / 聊天 id / 密钥尾巴都换成占位符)。 */
  message: string
  /** provider 层**丢掉了**的结构化信号(SDK 原本给了,我们没传下去)。 */
  droppedStructure?: Record<string, unknown>
  note?: string
  /** 今天各判定处对它的回答 —— 测试钉住的就是这一块。 */
  current: CurrentVerdicts
}

export interface CurrentVerdicts {
  /** core/auth-fail:claude 专属双哨兵 */
  claudeSentinel: boolean
  /** core/auth-fail:窄集(跑在正文上;assertNotAuthFailed 用) */
  assistantText: boolean
  /** core/auth-fail:宽集(跑在 SDK 错误上;turn-emitter / ACP 用) */
  sdkError: boolean
  /** core/auth-fail:isAuthFailError(status === 401 或宽集) */
  authFailError: boolean
  /** lib/auth-failure:码 + 厂商散文(llm-health 的 AUTH_RE 就是它) */
  llmHealthAuth: boolean
  /** core/provider-registry:只认 `auth_failed` 码(决定冷却时长) */
  registryAuthCode: boolean
  /** daemon/health/classify:决定要不要通知主人 */
  healthKind: FailureKind
  /** lib/auth-failure:三档闭集(今天无调用方;isTransient 借 health/classify 的网络判定) */
  providerFailure: ProviderFailureKind
  /** core/provider-quota:额度 / 限流 */
  quota: 'quota' | 'rate_limit' | null
  /** core/provider-quota:Cursor「整条回复就是催升级」 */
  quotaRefusalText: boolean
  /** lib/net-errors:连不上 */
  connectFailure: boolean
}

/** 下游看到的文本:带码的路径会把码拼在前面(与 failure-shapes.classifyAll 同一约定)。 */
function seenText(errorCode: string | null, message: string): string {
  return errorCode ? `${errorCode}: ${message}` : message
}

export function currentVerdicts(sample: Pick<ProviderErrorSample, 'errorCode' | 'message' | 'status'>): CurrentVerdicts {
  const { errorCode, message, status } = sample
  const text = seenText(errorCode, message)
  const asError = Object.assign(new Error(text), status !== undefined ? { statusCode: status } : {})
  const isTransient = (t: string) => classifyFailure(new Error(t)).kind === 'network'
  return {
    claudeSentinel: isAuthFail('claude-sentinel', message),
    assistantText: isAuthFail('assistant-text', message),
    sdkError: isAuthFail('sdk-error', message),
    authFailError: isAuthFailError(asError),
    llmHealthAuth: looksLikeAuthFailure(message),
    registryAuthCode: isAuthError(asError),
    healthKind: classifyFailure(asError).kind,
    providerFailure: classifyProviderFailure(errorCode, message, isTransient),
    quota: classifyProviderError(message),
    quotaRefusalText: isQuotaRefusalText(message),
    connectFailure: isConnectFailure(message),
  }
}

/**
 * 按 owner 已定的规则,这条样本**应该**被判成什么(只给文档的「错判」一栏用)。
 * 刻意只表达两条红线 + 一条通则,不是第 2 步的设计:
 *   · claude 只在双哨兵上报「登录过期」
 *   · 歧义(像 auth 又像瞬时)一律按瞬时
 */
export function expectedHealthKind(truth: FailureTruth): FailureKind | 'not_llm_auth' {
  switch (truth) {
    case 'auth': return 'llm_auth'
    case 'auth_ambiguous': case 'network': case 'timeout': return 'network'
    default: return 'not_llm_auth'
  }
}
