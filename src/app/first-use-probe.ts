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
 *    组合没变就沿用上次结果;真实回合也可以确认或撤销这个结果;
 *  - 探测失败 → 这次调用抛带人话的错。瞬时故障从 30 秒起退避,其他
 *    失败等十分钟。退避结束后由下一次使用触发,没有后台计时器。
 *
 * 并发:多个调用同时撞上首次使用,共用同一个 in-flight promise,只探一次。
 */
import type { AgentEvent, AgentProvider, AgentProject, AgentSession, SpawnContext } from '../ports/agent-provider'
import { classifyProviderError } from '../domain/provider-quota'
import { outdatedClientSignal } from '../domain/cli-upgrade/outdated-signal'
import { looksLikeAuthFailure } from '../lib/auth-failure'
import { isConnectFailure, isTimeoutFailure } from '../lib/net-errors'
import { codeForHttpStatus, isAuthErrorCode, isProviderErrorCode, providerErrorCodeOf } from '../lib/provider-error-code'
import { isNetworkUnprotectedError } from '../lib/network-gate'

export const UNKNOWN_PROBE_FIELD = '未知'

export interface ProbeCombination {
  cliVersion: string
  sdkVersion: string
  model: string
}

export interface ProbeRecord extends ProbeCombination {
  at: number
}

export interface ProbeHistory {
  read(): ProbeRecord | undefined
  save(record: ProbeRecord): void
  clear(): void
}

function sameProbeCombination(a: ProbeCombination | undefined, b: ProbeCombination | undefined): boolean {
  return a?.cliVersion === b?.cliVersion && a?.sdkVersion === b?.sdkVersion && a?.model === b?.model
}

export type ProbeFailure = { kind: 'transient' | 'auth' | 'incompatible'; reason: string }
export type ProbeResult = ({ ok: true } | ({ ok: false } & ProbeFailure)) & { detail: string; ms: number }
export type ProbeStatus =
  | { state: 'untested' | 'probing' }
  | { state: 'ok'; source: 'probe' | 'history'; detail: string; at: number }
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
  const code = providerErrorCodeOf(error) ?? (isProviderErrorCode(envelope?.code) ? envelope.code : undefined)
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
function firstUseProbeNote(failure: ProbeFailure): string {
  return failure.kind === 'transient' ? `${failure.reason}，稍后使用时自动重试`
    : failure.kind === 'auth' ? `探测失败，${failure.reason}`
      : failure.reason
}

export function probeStatusNote(status: ProbeStatus): string {
  if (status.state === 'failed') return firstUseProbeNote(status)
  if (status.state === 'ok') {
    if (status.source === 'history') return `沿用上次的结果（${new Date(status.at).toLocaleString('zh-CN', { hour12: false })}）`
    return '刚探测过 ✓'
  }
  return status.state === 'probing' ? '正在探测' : '待探测'
}

export interface FirstUseProbeOpts {
  /** 跑一句探测,返回模型文本;抛错或空串都算失败。 */
  probe: (model?: string) => Promise<string>
  /** Omit for callers without a daemon-owned cache. */
  cache?: { combination: () => ProbeCombination; history: ProbeHistory }
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

  let combination: ProbeCombination | undefined
  let generation = 0
  let savedThisRun = false
  const cache = opts.cache

  const reset = (next: ProbeCombination | undefined) => {
    combination = next
    status = { state: 'untested' }
    nextTransientDelay = FIRST_TRANSIENT_RETRY_MS
    savedThisRun = false
    inflight = null
    generation++
  }
  const remember = (at: number) => {
    if (!cache || !combination || savedThisRun) return
    cache.history.save({ ...combination, at })
    savedThisRun = true
  }

  const ensure = (current = cache?.combination()): Promise<void> => {
    if (!sameProbeCombination(current, combination)) reset(current)
    if (status.state === 'ok') return Promise.resolve()
    if (status.state === 'failed' && now() < status.retryAt) {
      return Promise.reject(new FirstUseProbeError(opts.failureMessage(status.detail, status)))
    }
    if (inflight) return inflight
    const previous = cache?.history.read()
    if (previous && sameProbeCombination(current, previous)) {
      status = { state: 'ok', source: 'history', at: previous.at, detail: '沿用上次的结果' }
      return Promise.resolve()
    }
    const started = now()
    // An older probe may finish after the default model changes.
    const attempt = generation
    const fail = (failure: ProbeFailure, detail: string): never => {
      const at = now()
      if (attempt === generation) {
        const delay = failure.kind === 'transient' ? nextTransientDelay : retryAfter
        nextTransientDelay = failure.kind === 'transient'
          ? Math.min(nextTransientDelay * 2, RETRY_AFTER_MS)
          : FIRST_TRANSIENT_RETRY_MS
        status = { state: 'failed', ...failure, detail, at, retryAt: at + delay }
      }
      opts.onResult?.({ ok: false, ...failure, detail, ms: at - started })
      throw new FirstUseProbeError(opts.failureMessage(detail, failure))
    }

    status = { state: 'probing' }
    inflight = Promise.resolve().then(async () => {
      let text: string
      try {
        const model = current?.model
        text = (await opts.probe(model === UNKNOWN_PROBE_FIELD ? undefined : model)).trim()
      } catch (err) {
        if (isNetworkUnprotectedError(err)) {
          if (attempt === generation) status = { state: 'untested' }
          throw err
        }
        const detail = err instanceof Error ? err.message : String(err)
        return fail(classifyProbeError(err, detail), detail)
      }
      if (text === '') fail(INCOMPATIBLE, EMPTY_REPLY)
      const at = now()
      const detail = text.slice(0, 40)
      if (attempt === generation) {
        nextTransientDelay = FIRST_TRANSIENT_RETRY_MS
        status = { state: 'ok', source: 'probe', detail, at }
        remember(at)
      }
      opts.onResult?.({ ok: true, detail, ms: at - started })
    }).finally(() => { if (attempt === generation) inflight = null })
    return inflight
  }

  const invalidate = (attempt: number) => {
    if (attempt !== generation) return
    cache?.history.clear()
    reset(combination)
  }
  const incompatibleError = (error: unknown, detail: string) => classifyProbeError(error, detail).kind === 'incompatible'

  const observeSession = (session: AgentSession, spawnedWith: ProbeCombination, requestedModel?: string | null): AgentSession => {
    let cancellations = 0
    return {
      ...session,
      ...(session.cancel ? { async cancel() { cancellations++; await session.cancel!() } } : {}),
      async close() { cancellations++; await session.close() },
      async *dispatch(...args) {
        if (args[2]?.source === 'background') {
          yield* session.dispatch(...args)
          return
        }
        const startedCancellation = cancellations
        // SessionManager can reuse a session after an incompatible turn.
        await ensure()
        if (startedCancellation !== cancellations) return
        const attempt = generation
        let failure: Extract<AgentEvent, { kind: 'error' }> | undefined
        let completed = false
        let hasReply = false
        try {
          for await (const event of session.dispatch(...args)) {
            if (event.kind === 'error') failure ??= event
            else if (event.kind === 'result') {
              completed = true
              hasReply ||= !!event.finalText?.trim()
            } else if (event.kind === 'tool_call' || (event.kind === 'text' && event.text.trim())) hasReply = true
            yield event
          }
        } catch (err) {
          if (startedCancellation === cancellations) {
            const detail = failure?.message ?? (err instanceof Error ? err.message : String(err))
            if (incompatibleError(failure ?? err, detail)) invalidate(attempt)
          }
          throw err
        }
        if (attempt !== generation || startedCancellation !== cancellations) return
        if (failure ? incompatibleError(failure, failure.message) : completed && !hasReply) {
          invalidate(attempt)
        } else if (!failure && completed && sameProbeCombination(spawnedWith, cache?.combination()) &&
            (!requestedModel || requestedModel === spawnedWith.model)) {
          remember(now())
        }
      },
    }
  }

  const wrapped: AgentProvider & { probeStatus(): ProbeStatus } = {
    ...inner,
    async spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      const spawnedWith = cache?.combination()
      await ensure(spawnedWith)
      const attempt = generation
      if (!spawnedWith || ctx.evaluation) return inner.spawn(project, ctx)
      try {
        const session = await inner.spawn(project, ctx)
        const model = ctx.execution?.model ?? ctx.model ??
          (spawnedWith.model === UNKNOWN_PROBE_FIELD ? undefined : session.callTarget?.()?.model)
        return observeSession(session, spawnedWith, model)
      } catch (err) {
        if (incompatibleError(err, err instanceof Error ? err.message : String(err))) invalidate(attempt)
        throw err
      }
    },
    ...(inner.cheapEval && (opts.gate ?? 'all') === 'all' ? { cheapEval: async (prompt, options) => { if (!options?.singleAttempt) await ensure(); return inner.cheapEval!(prompt, options) } } : {}),
    ...(inner.strongEval && (opts.gate ?? 'all') === 'all' ? { strongEval: async (prompt: string) => { await ensure(); return inner.strongEval!(prompt) } } : {}),
    probeStatus: () => sameProbeCombination(cache?.combination(), combination) ? status : { state: 'untested' },
  }
  return wrapped
}
