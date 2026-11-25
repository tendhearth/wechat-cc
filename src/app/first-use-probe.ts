/**
 * Claude probes on demand in an isolated one-shot call. Codex learns from
 * real chat turns. Both keep confirmation records by model and endpoint.
 */
import type { AgentEvent, AgentProvider, AgentProject, AgentSession, SpawnContext } from '../ports/agent-provider'
import { classifyProviderError, parseResetAt, QUOTA_TTL_MS } from '../domain/provider-quota'
import { outdatedClientSignal } from '../domain/cli-upgrade/outdated-signal'
import { looksLikeAuthFailure } from '../lib/auth-failure'
import { isConnectFailure, isTimeoutFailure } from '../lib/net-errors'
import { codeForHttpStatus, contextOverflowInputTokens, contextOverflowLimitTokens, errorWithProviderCode, isAuthErrorCode, isProviderErrorCode, providerErrorCodeOf, withProviderCode, type ProviderErrorCode } from '../lib/provider-error-code'
import { assertCallAllowed, isNetworkUnprotectedError, sessionCallTarget, type CallTarget, type NetworkGate } from '../lib/network-gate'
import { sha256Hex } from '../lib/content-hash'

export const UNKNOWN_PROBE_FIELD = '未知'

export interface ProbeCombination {
  cliVersion: string
  sdkVersion: string
  model: string
  endpoint?: string
}

export interface ProbeRecord extends ProbeCombination {
  at: number
  confirmedByTurn?: true
}

export interface ProbeHistory {
  read(target: Pick<ProbeCombination, 'model' | 'endpoint'>): ProbeRecord | undefined
  save(record: ProbeRecord): void
  clear(target: Pick<ProbeCombination, 'model' | 'endpoint'>): void
}

export function probeEndpointKey(target: Pick<CallTarget, 'baseUrl' | 'unresolved'>): string {
  if (target.unresolved) return 'unresolved'
  if (!target.baseUrl) return 'native'
  try {
    const url = new URL(target.baseUrl)
    return sha256Hex(url.origin + url.pathname.replace(/\/+$/, ''))
  } catch { return 'unresolved' }
}

export const probeTargetKey = (target: Pick<ProbeCombination, 'model' | 'endpoint'>) => JSON.stringify([target.model, target.endpoint])

function sameProbeCombination(a: ProbeCombination | undefined, b: ProbeCombination | undefined): boolean {
  return a?.cliVersion === b?.cliVersion && a?.sdkVersion === b?.sdkVersion &&
    a?.model === b?.model && a?.endpoint === b?.endpoint
}

export type ProbeFailure = { kind: 'transient' | 'auth' | 'incompatible' | 'quota'; reason: string; cause?: 'server_error'; code: ProviderErrorCode }
export type ProbeResult = ({ ok: true } | ({ ok: false } & ProbeFailure)) & { detail: string; ms: number }
export type ProbeStatus =
  | { state: 'untested' | 'probing' | 'awaiting_turn' }
  | { state: 'ok'; source: 'probe' | 'history' | 'turn'; detail: string; at: number }
  | ({ state: 'failed'; detail: string; at: number; retryAt?: number } & ProbeFailure)

const RETRY_AFTER_MS = 10 * 60_000
const FIRST_TRANSIENT_RETRY_MS = 30_000
const INCOMPATIBLE: ProbeFailure = { kind: 'incompatible', reason: '探测失败', code: 'incompatible' }
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
  const transient = (reason: string, code: ProviderErrorCode): ProbeFailure => ({ kind: 'transient', reason, code })
  const auth = (): ProbeFailure => ({ kind: 'auth', code: code === 'auth_failed' ? code : 'auth_rejected', reason: `拒绝了凭证（${status === 401 || status === 403 ? status : '认证'}）` })
  const quota = classifyProviderError(detail)

  if (code === 'quota' || httpCode === 'quota' || quota === 'quota') return { kind: 'quota', code: 'quota', reason: '额度用完了' }
  if (httpCode === 'server_error' || code === 'server_error') return { ...transient(`暂时忙不过来（${httpCode === 'server_error' ? status : '5xx'}）`, 'server_error'), cause: 'server_error' }
  if (httpCode === 'rate_limited' || code === 'rate_limited') return transient(`暂时限流（${httpCode === 'rate_limited' ? status : 'rate_limit'}）`, 'rate_limited')
  if (isAuthErrorCode(httpCode)) return auth()
  if (timeout) return transient(`请求超时（${status === 408 ? status : 'timeout'}）`, 'network')
  if (code === 'network' || isConnectFailure(detail) || isConnectFailure(envelope?.code)) return transient('暂时连不上（网络）', 'network')
  if (quota === 'rate_limit') return transient('暂时忙不过来（rate_limit）', 'rate_limited')
  if (isAuthErrorCode(code) || looksLikeAuthFailure(detail)) return auth()
  if (code === 'incompatible' || outdatedClientSignal('claude', detail) || outdatedClientSignal('codex', detail) ||
      /\b(?:model(?:[_ ]not[_ ]found|[_ ]not[_ ]supported|[^\n.]{0,120} (?:does not exist|is not supported|is unavailable))|unsupported model|(?:version|protocol) mismatch|incompatible (?:version|protocol))\b/i.test(detail)) return INCOMPATIBLE
  return transient('暂时没有回应（原因未明）', code ?? 'provider_error')
}

/** 暂停期结束后,下一次使用才触发重探。 */
function firstUseProbeNote(failure: ProbeFailure): string {
  if (failure.kind === 'quota') return `${failure.reason}，等额度恢复或换一个脑子`
  return failure.kind === 'transient' ? `${failure.reason}，稍后使用时自动重试`
    : failure.kind === 'auth' ? `探测失败，${failure.reason}`
      : failure.reason
}

export function probeStatusNote(status: ProbeStatus): string {
  if (status.state === 'failed') {
    if (status.retryAt === undefined) {
      if (status.kind === 'auth') return `${status.reason}，请检查账号或密钥`
      if (status.kind === 'transient') return `${status.reason}，再发一句就会重试`
    }
    return firstUseProbeNote(status)
  }
  if (status.state === 'awaiting_turn') return '还没用过，第一次对话时确认'
  if (status.state === 'ok') {
    if (status.source === 'history') return `沿用上次的结果（${new Date(status.at).toLocaleString('zh-CN', { hour12: false })}）`
    if (status.source === 'turn') return '已通过对话确认连接'
    return '刚探测过 ✓'
  }
  return status.state === 'probing' ? '正在探测' : '待探测'
}

export interface FirstUseProbeOpts {
  /** Omit to confirm using the native thread's real chat turns. */
  probe?: (model: string | undefined, signal: AbortSignal, project?: AgentProject) => Promise<string>
  networkGate?: NetworkGate
  timeoutMs?: number
  /** Omit for callers without a daemon-owned cache. */
  cache?: { combination: () => ProbeCombination; history: ProbeHistory }
  /** 探测结果的人话摘要,给 /mode 和日志。 */
  onResult?: (r: ProbeResult) => void
  /** 失败时抛给调用方的信息(会原样进用户提示)。 */
  failureMessage?: (detail: string, failure: ProbeFailure, model?: string) => string
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

async function runProbe(probe: NonNullable<FirstUseProbeOpts['probe']>, timeoutMs: number, model: string | undefined, project?: AgentProject): Promise<string> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('first-use probe timed out')
      reject(error)
      controller.abort(error)
    }, timeoutMs)
  })
  try {
    // Bound the shared wait even when a provider takes longer to stop.
    return await Promise.race([deadline, Promise.resolve().then(() => probe(model, controller.signal, project))])
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
  const probe = opts.probe
  const failureMessage = opts.failureMessage ?? ((_detail, failure) => firstUseProbeNote(failure))
  const states = new Map<string | undefined, {
    combination: ProbeCombination | undefined
    status: ProbeStatus
    inflight?: Promise<void>
    nextTransientDelay: number
    savedThisRun: boolean
  }>()
  const stateFor = (combination: ProbeCombination | undefined) => {
    const key = combination && probeTargetKey(combination)
    const existing = states.get(key)
    if (existing && sameProbeCombination(combination, existing.combination)) return existing
    const state: NonNullable<typeof existing> = {
      combination, status: { state: 'untested' }, nextTransientDelay: FIRST_TRANSIENT_RETRY_MS, savedThisRun: false,
    }
    states.set(key, state)
    return state
  }
  const remember = (state: ReturnType<typeof stateFor>, at: number) => {
    if (!cache || !state.combination || state.combination.endpoint === 'unresolved' || (!probe && state.combination.model === UNKNOWN_PROBE_FIELD) ||
        state.savedThisRun || states.get(probeTargetKey(state.combination)) !== state) return
    cache.history.save({ ...state.combination, at, ...(!probe ? { confirmedByTurn: true } : {}) })
    state.savedThisRun = true
  }
  const ensure = (current = cache?.combination(), project?: AgentProject): Promise<void> => {
    if (!probe) return Promise.resolve()
    const state = stateFor(current)
    const model = current?.model === UNKNOWN_PROBE_FIELD ? undefined : current?.model
    const { status } = state
    if (status.state === 'ok') return Promise.resolve()
    if (status.state === 'failed' && status.retryAt !== undefined && now() < status.retryAt) {
      return Promise.reject(probeError(failureMessage(status.detail, status, model), status))
    }
    if (state.inflight) return state.inflight
    const previous = current && cache?.history.read(current)
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
      throw probeError(failureMessage(detail, failure, model), failure)
    }

    state.status = { state: 'probing' }
    state.inflight = Promise.resolve().then(async () => {
      let text: string
      try {
        text = (await runProbe(probe, opts.timeoutMs ?? PROBE_TIMEOUT_MS, model, project)).trim()
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

  const invalidate = (state: ReturnType<typeof stateFor>, target: ProbeCombination) => {
    const key = probeTargetKey(target)
    if (states.get(key) !== state) return
    cache?.history.clear(target)
    states.delete(key)
  }
  const incompatibleError = (error: unknown, detail: string) => classifyProbeError(error, detail).kind === 'incompatible'

  const recordTurnFailure = (target: ProbeCombination | undefined, error: unknown, detail: string) => {
    const invalidProtocol = /^codex_(?:missing_(?:thread|turn)_id|turn_start_mismatch|rpc_method_not_found)$/.test(detail)
    const failure = detail === EMPTY_REPLY || invalidProtocol ? INCOMPATIBLE : classifyProbeError(error, detail)
    const incompatible = failure.kind === 'incompatible'
    const reason = incompatible ? '模型或 Codex 客户端协议不兼容' : failure.reason
    if (target && target.model !== UNKNOWN_PROBE_FIELD && target.endpoint !== 'unresolved' && failure.code !== 'context_overflow') {
      const state = stateFor(target)
      if (incompatible) {
        cache?.history.clear(target)
        state.savedThisRun = false
      }
      state.status = { state: 'failed', ...failure, reason, detail: reason, at: now() }
    }
    // Preserve the fixed upgrade signal in the error channel without forwarding vendor text.
    let message = reason
    if (incompatible && outdatedClientSignal('codex', detail)) message = 'This model requires a newer version of Codex.'
    if (failure.code === 'context_overflow') {
      // The conversation's existing overflow recovery uses the input and limit counts.
      const input = contextOverflowInputTokens(detail)
      const limit = contextOverflowLimitTokens(detail)
      message = `context window exceeded${input ? `, requested ${input}` : ''}${limit ? `, model token limit: ${limit}` : ''}`
    }
    return { kind: 'error' as const, message, code: failure.code }
  }

  const nativeCombination = (session: AgentSession, defaults: ProbeCombination): ProbeCombination => {
    const target = sessionCallTarget(session, 'codex')
    return { ...defaults, model: target.model ?? UNKNOWN_PROBE_FIELD, endpoint: probeEndpointKey(target) }
  }

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
        const current = probe ? spawnedWith : nativeCombination(session, spawnedWith)
        const state = stateFor(current)
        try {
          if (probe) await ensure(current, project)
          if (startedCancellation !== cancellations) return
          if (opts.networkGate) await assertCallAllowed(opts.networkGate, sessionCallTarget(session, 'unknown'))
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
            if (event.kind === 'error') {
              failure ??= event
              if (!probe && startedCancellation === cancellations) {
                if (event === failure) yield recordTurnFailure(nativeCombination(session, current), event, event.message)
                continue
              }
            } else if (event.kind === 'result') {
              completed = true
              hasReply ||= !!event.finalText?.trim()
            } else if (event.kind === 'tool_call' || (event.kind === 'text' && event.text.trim())) hasReply = true
            yield event
          }
        } catch (err) {
          if (startedCancellation === cancellations) {
            const detail = failure?.message ?? (err instanceof Error ? err.message : String(err))
            if (!probe && !isNetworkUnprotectedError(err)) {
              if (!failure) yield recordTurnFailure(nativeCombination(session, current), err, detail)
              return
            }
            if (probe && incompatibleError(failure ?? err, detail)) invalidate(state, current)
          }
          throw err
        }
        if (startedCancellation !== cancellations) return
        const sentTo = probe ? current : nativeCombination(session, current)
        const sentState = sameProbeCombination(sentTo, current) ? state : stateFor(sentTo)
        if (!probe && !failure && completed && !hasReply) {
          yield recordTurnFailure(sentTo, undefined, EMPTY_REPLY)
        } else if (probe && (failure ? incompatibleError(failure, failure.message) : completed && !hasReply)) {
          invalidate(sentState, sentTo)
        } else if (!failure && completed) {
          const at = now()
          if (sentState.status.state === 'untested' || (!probe && sentState.status.state === 'failed')) sentState.status = { state: 'ok', source: 'turn', detail: '已通过对话确认连接', at }
          remember(sentState, at)
        }
      },
    }
  }

  const wrapped: AgentProvider & { probeStatus(): ProbeStatus } = {
    ...inner,
    async spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      if (ctx.evaluation) return inner.spawn(project, ctx)
      const defaults = cache?.combination()
      if (!probe) {
        try {
          const session = await inner.spawn(project, ctx)
          return defaults ? observeSession(session, defaults, project) : session
        } catch (err) {
          if (isNetworkUnprotectedError(err)) throw err
          const { message, code } = recordTurnFailure(undefined, err, err instanceof Error ? err.message : String(err))
          throw errorWithProviderCode(message, code)
        }
      }
      const model = ctx.execution?.model ?? ctx.model ?? defaults?.model
      const spawnedWith = defaults && { ...defaults, model: model ?? defaults.model }
      const state = stateFor(spawnedWith)
      await ensure(spawnedWith, project)
      if (!spawnedWith) return inner.spawn(project, ctx)
      try {
        const session = await inner.spawn(project, ctx)
        return observeSession(session, spawnedWith, project)
      } catch (err) {
        if (incompatibleError(err, err instanceof Error ? err.message : String(err))) invalidate(state, spawnedWith)
        throw err
      }
    },
    ...(probe && inner.cheapEval && (opts.gate ?? 'all') === 'all' ? { cheapEval: async (prompt, options) => { if (!options?.singleAttempt) await ensure(); return inner.cheapEval!(prompt, options) } } : {}),
    ...(probe && inner.strongEval && (opts.gate ?? 'all') === 'all' ? { strongEval: async (prompt: string) => { await ensure(); return inner.strongEval!(prompt) } } : {}),
    probeStatus: () => {
      const current = cache?.combination()
      const state = states.get(current && probeTargetKey(current))
      if (state && state.status.state !== 'untested' && sameProbeCombination(current, state.combination)) return state.status
      if (probe) return { state: 'untested' }
      const previous = current && cache?.history.read(current)
      // Earlier Codex records could come from a gateway request that never used the CLI.
      if (previous?.confirmedByTurn && sameProbeCombination(current, previous)) {
        return { state: 'ok', source: 'history', at: previous.at, detail: '沿用上次的结果' }
      }
      return { state: 'awaiting_turn' }
    },
  }
  return wrapped
}
