/**
 * first-use-probe — 「先真跑一句再信」的 provider 包装。
 *
 * 为 codex 而生(2026-09-09 实测):SDK 0.144.4 驱动用户的 CLI 0.153.4 照样
 * 收到 agent_message,而内置的 0.144.4 二进制被 OpenAI 服务端以「这个模型
 * 需要更新的 Codex」400 拒掉。也就是说**版本号判不出能不能用,只有真跑
 * 一句才知道**;而且要跑就得用用户那个更新的 CLI。于是:
 *
 *  - 开机**不**外呼(主人纪律:网络不稳时的无人值守外呼是风控形状);
 *  - 第一次真要用到(spawn / cheapEval)时探一句「只回复 ok」,通了缓存,
 *    daemon 生命周期内不再探;
 *  - 探测失败 → 这次调用抛带人话的错。瞬时故障从 30 秒起退避,其他
 *    失败等十分钟。退避结束后由下一次使用触发,没有后台计时器。
 *
 * 并发:多个调用同时撞上首次使用,共用同一个 in-flight promise,只探一次。
 */
import type { AgentProvider, AgentProject, AgentSession, SpawnContext } from '../ports/agent-provider'
import { classifyProviderError } from '../domain/provider-quota'
import { outdatedClientSignal } from '../domain/cli-upgrade/outdated-signal'
import { looksLikeAuthFailure } from '../lib/auth-failure'
import { isConnectFailure, isTimeoutFailure } from '../lib/net-errors'
import { codeForHttpStatus, isAuthErrorCode, providerErrorCodeOf } from '../lib/provider-error-code'

export type ProbeFailure = { kind: 'transient' | 'auth' | 'incompatible'; reason: string }
export type ProbeResult = ({ ok: true } | ({ ok: false } & ProbeFailure)) & { detail: string; ms: number }
export type ProbeStatus =
  | { state: 'untested' | 'probing' }
  | { state: 'ok'; detail: string; at: number }
  | ({ state: 'failed'; detail: string; at: number; retryAt: number } & ProbeFailure)

const RETRY_AFTER_MS = 10 * 60_000
const FIRST_TRANSIENT_RETRY_MS = 30_000
const INCOMPATIBLE: ProbeFailure = { kind: 'incompatible', reason: '探测失败' }
const EMPTY_REPLY = '探测拿到了空回复(协议不合的典型症状)'

function classifyProbeError(error: unknown, detail: string): ProbeFailure {
  // HTTP 状态可能留在抛出物上，也可能只剩 CLI 转述。只从状态字段或错误前缀取数字。
  const envelope = error !== null && typeof error === 'object'
    ? error as { status?: unknown; statusCode?: unknown; httpStatusCode?: unknown; code?: unknown }
    : undefined
  const status = Number(envelope?.status ?? envelope?.statusCode ?? envelope?.httpStatusCode ??
    /(?:^\s*|\b(?:API Error:|unexpected status|HTTP(?: error:| status:?|\/\d(?:\.\d)?)?|status code:?)\s+|"status"\s*:\s*)([45]\d\d)\b/i.exec(detail)?.[1])
  const httpCode = codeForHttpStatus(status, detail)
  const code = providerErrorCodeOf(error)
  const timeout = isTimeoutFailure(detail) || isTimeoutFailure(envelope?.code) || status === 408
  const transient = (reason: string): ProbeFailure => ({ kind: 'transient', reason })
  const auth = (): ProbeFailure => ({ kind: 'auth', reason: `拒绝了凭证（${status === 401 || status === 403 ? status : '认证'}）` })

  if (httpCode === 'server_error' || code === 'server_error') return transient(`暂时忙不过来（${httpCode === 'server_error' ? status : '5xx'}）`)
  if (httpCode === 'rate_limited' || code === 'rate_limited') return transient(`暂时限流（${httpCode === 'rate_limited' ? status : 'rate_limit'}）`)
  if (isAuthErrorCode(httpCode)) return auth()
  if (timeout) return transient(`请求超时（${status === 408 ? status : 'timeout'}）`)
  if (code === 'network' || isConnectFailure(detail) || isConnectFailure(envelope?.code)) return transient('暂时连不上（网络）')
  if (classifyProviderError(detail) === 'rate_limit') return transient('暂时忙不过来（rate_limit）')
  if (isAuthErrorCode(code) || looksLikeAuthFailure(detail)) return auth()
  if (outdatedClientSignal('claude', detail) || outdatedClientSignal('codex', detail) ||
      /\b(?:model(?:[_ ]not[_ ]found|[_ ]not[_ ]supported|[^\n.]{0,120} (?:does not exist|is not supported|is unavailable))|unsupported model|(?:version|protocol) mismatch|incompatible (?:version|protocol))\b/i.test(detail)) return INCOMPATIBLE
  return transient('暂时没有回应（原因未明）')
}

/** 暂停期结束后,下一次使用才触发重探。 */
export function firstUseProbeNote(failure: ProbeFailure): string {
  return failure.kind === 'transient' ? `${failure.reason}，稍后使用时自动重试`
    : failure.kind === 'auth' ? `探测失败，${failure.reason}`
      : failure.reason
}

export interface FirstUseProbeOpts {
  /** 跑一句探测,返回模型文本;抛错或空串都算失败。 */
  probe: () => Promise<string>
  /** 探测结果的人话摘要,给 /mode 和日志。 */
  onResult?: (r: ProbeResult) => void
  /** 失败时抛给调用方的信息(会原样进用户提示)。 */
  failureMessage: (detail: string, failure: ProbeFailure) => string
  /** 认证或不兼容失败后多久允许重探(默认 10 分钟)。 */
  retryAfterMs?: number
  /** 'all'(默认):spawn 和 cheapEval/strongEval 都先过探测;'spawn':只拦聊天
   *  回合 —— 给默认 provider 用,后台评估(开机就可能跑)不因探测多一次外呼。 */
  gate?: 'spawn' | 'all'
  now?: () => number
}

export class FirstUseProbeError extends Error {}

export function withFirstUseProbe(inner: AgentProvider, opts: FirstUseProbeOpts): AgentProvider & { probeStatus(): ProbeStatus } {
  const now = opts.now ?? Date.now
  const retryAfter = opts.retryAfterMs ?? RETRY_AFTER_MS
  let status: ProbeStatus = { state: 'untested' }
  let inflight: Promise<void> | null = null
  let nextTransientDelay = FIRST_TRANSIENT_RETRY_MS

  const fail = (failure: ProbeFailure, detail: string, started: number): never => {
    const at = now()
    const delay = failure.kind === 'transient' ? nextTransientDelay : retryAfter
    nextTransientDelay = failure.kind === 'transient'
      ? Math.min(nextTransientDelay * 2, RETRY_AFTER_MS)
      : FIRST_TRANSIENT_RETRY_MS
    status = { state: 'failed', ...failure, detail, at, retryAt: at + delay }
    opts.onResult?.({ ok: false, ...failure, detail, ms: at - started })
    throw new FirstUseProbeError(opts.failureMessage(detail, failure))
  }

  const ensure = (): Promise<void> => {
    if (status.state === 'ok') return Promise.resolve()
    if (status.state === 'failed' && now() < status.retryAt) {
      return Promise.reject(new FirstUseProbeError(opts.failureMessage(status.detail, status)))
    }
    if (inflight) return inflight
    const started = now()
    status = { state: 'probing' }
    inflight = Promise.resolve().then(async () => {
      let text = ''
      try {
        text = (await opts.probe()).trim()
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        fail(classifyProbeError(err, detail), detail, started)
      }
      if (text === '') fail(INCOMPATIBLE, EMPTY_REPLY, started)
      nextTransientDelay = FIRST_TRANSIENT_RETRY_MS
      const at = now()
      const detail = text.slice(0, 40)
      status = { state: 'ok', detail, at }
      opts.onResult?.({ ok: true, detail, ms: at - started })
    }).finally(() => { inflight = null })
    return inflight
  }

  const wrapped: AgentProvider & { probeStatus(): ProbeStatus } = {
    ...inner,
    async spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      await ensure()
      return inner.spawn(project, ctx)
    },
    ...(inner.cheapEval && (opts.gate ?? 'all') === 'all' ? { cheapEval: async (prompt, options) => { if (!options?.singleAttempt) await ensure(); return inner.cheapEval!(prompt, options) } } : {}),
    ...(inner.strongEval && (opts.gate ?? 'all') === 'all' ? { strongEval: async (prompt: string) => { await ensure(); return inner.strongEval!(prompt) } } : {}),
    probeStatus: () => status,
  }
  return wrapped
}
