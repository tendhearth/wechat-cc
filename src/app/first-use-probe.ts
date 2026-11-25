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
 *    失败等十分钟,额度耗尽等到重置时间。退避结束后由下一次使用触发,没有后台计时器。
 *
 * 并发:多个调用同时撞上首次使用,同一模型共用一个 in-flight promise,只探一次。
 */
import type { AgentEvent, AgentProvider, AgentProject, AgentSession, SpawnContext } from '../ports/agent-provider'
import { classifyProviderError, parseResetAt, QUOTA_TTL_MS } from '../domain/provider-quota'
import { outdatedClientSignal } from '../domain/cli-upgrade/outdated-signal'
import { looksLikeAuthFailure } from '../lib/auth-failure'
import { isConnectFailure, isTimeoutFailure } from '../lib/net-errors'
import { codeForHttpStatus, isAuthErrorCode, isProviderErrorCode, providerErrorCodeOf, withProviderCode } from '../lib/provider-error-code'
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
  read(model: string): ProbeRecord | undefined
  save(record: ProbeRecord): void
  clear(model: string): void
}

function sameProbeCombination(a: ProbeCombination | undefined, b: ProbeCombination | undefined): boolean {
  return a?.cliVersion === b?.cliVersion && a?.sdkVersion === b?.sdkVersion && a?.model === b?.model
}

export type ProbeFailure = { kind: 'transient' | 'auth' | 'incompatible' | 'quota'; reason: string; cause?: 'server_error' }
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

  if (code === 'quota' || httpCode === 'quota') return { kind: 'quota', reason: '额度用完了' }
  if (httpCode === 'server_error' || code === 'server_error') return { ...transient(`暂时忙不过来（${httpCode === 'server_error' ? status : '5xx'}）`), cause: 'server_error' }
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
  if (failure.kind === 'quota') return `${failure.reason}，等额度恢复或换一个脑子`
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
  probe: (model: string | undefined, signal: AbortSignal, project?: AgentProject) => Promise<string>
  /** The native thread reports its effective model before it sends a turn. */
  probeAfterSpawn?: boolean
  timeoutMs?: number
  /** Omit for callers without a daemon-owned cache. */
  cache?: { combination: () => ProbeCombination; history: ProbeHistory }
  /** 探测结果的人话摘要,给 /mode 和日志。 */
  onResult?: (r: ProbeResult) => void
  /** 失败时抛给调用方的信息(会原样进用户提示)。 */
  failureMessage: (detail: string, failure: ProbeFailure, model?: string) => string
  /** 认证或不兼容失败后多久允许重探(默认 10 分钟)。 */
  retryAfterMs?: number
  /** 'all'(默认):spawn 和 cheapEval/strongEval 都先过探测;'spawn':只拦聊天
   *  回合 —— 给默认 provider 用,后台评估(开机就可能跑)不因探测多一次外呼。 */
  gate?: 'spawn' | 'all'
  now?: () => number
}

const PROBE_TIMEOUT_MS = 20_000

/** Leave time for the enclosing turn to receive the probe's own error. */
export function firstUseProbeTimeout(turnTimeoutMs: number): number {
  return turnTimeoutMs > 0 ? Math.min(PROBE_TIMEOUT_MS, turnTimeoutMs / 2) : PROBE_TIMEOUT_MS
}

async function runProbe(opts: FirstUseProbeOpts, model: string | undefined, project?: AgentProject): Promise<string> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('first-use probe timed out')
      reject(error)
      controller.abort(error)
    }, opts.timeoutMs ?? PROBE_TIMEOUT_MS)
  })
  try {
    // Bound the shared wait even when a provider takes longer to stop.
    return await Promise.race([deadline, Promise.resolve().then(() => opts.probe(model, controller.signal, project))])
  } finally {
    clearTimeout(timer)
  }
}

export class FirstUseProbeError extends Error {}

function probeError(message: string, failure: ProbeFailure): Error {
  return withProviderCode(new FirstUseProbeError(message), failure.kind === 'quota' ? 'quota' : undefined)
}

export function withFirstUseProbe(inner: AgentProvider, opts: FirstUseProbeOpts): AgentProvider & { probeStatus(): ProbeStatus } {
  const now = opts.now ?? Date.now
  const retryAfter = opts.retryAfterMs ?? RETRY_AFTER_MS
  const cache = opts.cache
  const states = new Map<string | undefined, {
    combination: ProbeCombination | undefined
    status: ProbeStatus
    inflight?: Promise<void>
    nextTransientDelay: number
    savedThisRun: boolean
  }>()
  const stateFor = (combination: ProbeCombination | undefined) => {
    const key = combination?.model
    const existing = states.get(key)
    if (existing && sameProbeCombination(combination, existing.combination)) return existing
    const state: NonNullable<typeof existing> = {
      combination, status: { state: 'untested' }, nextTransientDelay: FIRST_TRANSIENT_RETRY_MS, savedThisRun: false,
    }
    states.set(key, state)
    return state
  }
  const remember = (state: ReturnType<typeof stateFor>, at: number) => {
    if (!cache || !state.combination || state.savedThisRun || states.get(state.combination.model) !== state) return
    cache.history.save({ ...state.combination, at })
    state.savedThisRun = true
  }
  const ensure = (current = cache?.combination(), project?: AgentProject): Promise<void> => {
    const state = stateFor(current)
    const model = current?.model === UNKNOWN_PROBE_FIELD ? undefined : current?.model
    const { status } = state
    if (status.state === 'ok') return Promise.resolve()
    if (status.state === 'failed' && now() < status.retryAt) {
      return Promise.reject(probeError(opts.failureMessage(status.detail, status, model), status))
    }
    if (state.inflight) return state.inflight
    const previous = current && cache?.history.read(current.model)
    if (previous && sameProbeCombination(current, previous)) {
      state.status = { state: 'ok', source: 'history', at: previous.at, detail: '沿用上次的结果' }
      return Promise.resolve()
    }
    const started = now()
    const fail = (failure: ProbeFailure, detail: string): never => {
      const at = now()
      const resetAt = failure.kind === 'quota' ? parseResetAt(detail) : null
      const delay = failure.kind === 'quota' ? (resetAt !== null && resetAt > at ? resetAt - at : QUOTA_TTL_MS)
        : failure.kind === 'transient' ? state.nextTransientDelay : retryAfter
      state.nextTransientDelay = failure.kind === 'transient'
        ? Math.min(state.nextTransientDelay * 2, RETRY_AFTER_MS)
        : FIRST_TRANSIENT_RETRY_MS
      state.status = { state: 'failed', ...failure, detail, at, retryAt: at + delay }
      opts.onResult?.({ ok: false, ...failure, detail, ms: at - started })
      throw probeError(opts.failureMessage(detail, failure, model), failure)
    }

    state.status = { state: 'probing' }
    state.inflight = Promise.resolve().then(async () => {
      let text: string
      try {
        text = (await runProbe(opts, model, project)).trim()
      } catch (err) {
        if (isNetworkUnprotectedError(err)) {
          state.status = { state: 'untested' }
          throw err
        }
        const detail = err instanceof Error ? err.message : String(err)
        return fail(classifyProbeError(err, detail), detail)
      }
      if (text === '') fail(INCOMPATIBLE, EMPTY_REPLY)
      const at = now()
      const detail = text.slice(0, 40)
      state.nextTransientDelay = FIRST_TRANSIENT_RETRY_MS
      state.status = { state: 'ok', source: 'probe', detail, at }
      remember(state, at)
      opts.onResult?.({ ok: true, detail, ms: at - started })
    }).finally(() => { delete state.inflight })
    return state.inflight
  }

  const invalidate = (state: ReturnType<typeof stateFor>, model: string) => {
    if (states.get(model) !== state) return
    cache?.history.clear(model)
    states.delete(model)
  }
  const incompatibleError = (error: unknown, detail: string) => classifyProbeError(error, detail).kind === 'incompatible'

  const observeSession = (session: AgentSession, spawnedWith: ProbeCombination, project: AgentProject): AgentSession => {
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
        const state = stateFor(spawnedWith)
        try {
          await ensure(spawnedWith, project)
        } catch (err) {
          if (startedCancellation !== cancellations) return
          throw err
        }
        if (startedCancellation !== cancellations) return
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
            if (incompatibleError(failure ?? err, detail)) invalidate(state, spawnedWith.model)
          }
          throw err
        }
        if (startedCancellation !== cancellations) return
        if (failure ? incompatibleError(failure, failure.message) : completed && !hasReply) {
          invalidate(state, spawnedWith.model)
        } else if (!failure && completed) {
          remember(state, now())
        }
      },
    }
  }

  const wrapped: AgentProvider & { probeStatus(): ProbeStatus } = {
    ...inner,
    async spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      const defaults = cache?.combination()
      if (opts.probeAfterSpawn && defaults) {
        const session = await inner.spawn(project, ctx)
        try {
          const model = session.callTarget?.()?.model ?? ctx.execution?.model ?? ctx.model ?? UNKNOWN_PROBE_FIELD
          const combination = { ...defaults, model }
          await ensure(combination, project)
          return ctx.evaluation ? session : observeSession(session, combination, project)
        } catch (err) {
          await session.close().catch(() => {})
          throw err
        }
      }
      const model = ctx.execution?.model ?? ctx.model ?? defaults?.model
      const spawnedWith = defaults && { ...defaults, model: model ?? defaults.model }
      const state = stateFor(spawnedWith)
      await ensure(spawnedWith, project)
      if (!spawnedWith || ctx.evaluation) return inner.spawn(project, ctx)
      try {
        const session = await inner.spawn(project, ctx)
        return observeSession(session, spawnedWith, project)
      } catch (err) {
        if (incompatibleError(err, err instanceof Error ? err.message : String(err))) invalidate(state, spawnedWith.model)
        throw err
      }
    },
    ...(inner.cheapEval && (opts.gate ?? 'all') === 'all' ? { cheapEval: async (prompt, options) => { if (!options?.singleAttempt) await ensure(); return inner.cheapEval!(prompt, options) } } : {}),
    ...(inner.strongEval && (opts.gate ?? 'all') === 'all' ? { strongEval: async (prompt: string) => { await ensure(); return inner.strongEval!(prompt) } } : {}),
    probeStatus: () => {
      const current = cache?.combination()
      const state = states.get(current?.model)
      return state && sameProbeCombination(current, state.combination) ? state.status : { state: 'untested' }
    },
  }
  return wrapped
}
