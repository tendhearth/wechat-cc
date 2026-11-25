import type { AgentEvent, AgentProvider, AgentSession } from '../ports/agent-provider'
import { classifyProviderError, parseResetAt } from '../domain/provider-quota'
import { outdatedClientSignal } from '../domain/cli-upgrade/outdated-signal'
import { CLI_SPECS } from '../domain/cli-upgrade/specs'
import { looksLikeAuthFailure } from '../lib/auth-failure'
import { isConnectFailure, isTimeoutFailure } from '../lib/net-errors'
import { codeForHttpStatus, contextOverflowInputTokens, contextOverflowLimitTokens, errorWithProviderCode, isAuthErrorCode, isProviderErrorCode, providerErrorCodeOf, type ProviderErrorCode } from '../lib/provider-error-code'
import { isNetworkUnprotectedError, sessionCallTarget, type CallTarget } from '../lib/network-gate'
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
  read(target: ProbeCombination): ProbeRecord | undefined
  save(record: ProbeRecord): void
  clear(target: ProbeCombination): void
}

export function probeEndpointKey(target: Pick<CallTarget, 'baseUrl' | 'unresolved'>): string {
  if (target.unresolved) return 'unresolved'
  if (!target.baseUrl) return 'native'
  try {
    const url = new URL(target.baseUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'unresolved'
    return sha256Hex(url.origin + url.pathname.replace(/\/+$/, ''))
  } catch { return 'unresolved' }
}

export const probeCombinationKey = (target: ProbeCombination) => JSON.stringify([
  target.model, target.endpoint, target.cliVersion, target.sdkVersion,
])

export type ProbeFailure = { kind: 'transient' | 'auth' | 'incompatible' | 'quota'; reason: string; cause?: 'server_error'; code: ProviderErrorCode }
export type ProbeStatus =
  | { state: 'awaiting_turn' }
  | { state: 'ok'; source: 'history' | 'turn'; at: number }
  | ({ state: 'failed'; at: number; startup?: true; resetAt?: number } & ProbeFailure)

const INCOMPATIBLE: ProbeFailure = { kind: 'incompatible', reason: '模型或客户端协议不兼容', code: 'incompatible' }

function classifyProbeError(provider: ConfirmationOptions['provider'], error: unknown, detail: string): ProbeFailure {
  // HTTP 状态可能留在抛出物上，也可能只剩 CLI 转述。只从状态字段或错误前缀取数字。
  const envelope = error !== null && typeof error === 'object'
    ? error as { status?: unknown; statusCode?: unknown; httpStatusCode?: unknown; code?: unknown }
    : undefined
  const status = Number(envelope?.status ?? envelope?.statusCode ?? envelope?.httpStatusCode ??
    /(?:^\s*|\b(?:API Error:|unexpected status|HTTP(?: error:| status:?|\/\d(?:\.\d)?)?|status code:?)\s+|"status"\s*:\s*)([45]\d\d)\b/i.exec(detail)?.[1])
  let code = providerErrorCodeOf(error) ?? (isProviderErrorCode(envelope?.code) ? envelope.code : undefined)
  const timedOut = () => status === 408 || isTimeoutFailure(envelope?.code) || isTimeoutFailure(detail)
  const transient = (reason: string, code: ProviderErrorCode): ProbeFailure => ({ kind: 'transient', reason, code })

  if (!code || code === 'provider_error') {
    if (detail === '' || /^codex_(?:missing_(?:thread|turn)_id|turn_start_mismatch|rpc_method_not_found)$/.test(detail)) return INCOMPATIBLE
    const quota = classifyProviderError(detail)
    code = quota === 'quota' ? 'quota' : codeForHttpStatus(status, detail)
    if (!code) {
      if (timedOut() || isConnectFailure(detail) || isConnectFailure(envelope?.code)) code = 'network'
      else if (quota === 'rate_limit') return transient('暂时忙不过来（rate_limit）', 'rate_limited')
      else if (looksLikeAuthFailure(detail)) code = 'auth_rejected'
    }
  }
  if (isAuthErrorCode(code)) return { kind: 'auth', code, reason: `拒绝了凭证（${status === 401 || status === 403 ? status : '认证'}）` }
  if (code === 'quota') return { kind: 'quota', code, reason: '额度用完了' }
  if (code === 'server_error') return { ...transient(`暂时忙不过来（${status >= 500 && status <= 599 ? status : '5xx'}）`, code), cause: code }
  if (code === 'rate_limited') return transient(`暂时限流（${status === 429 ? status : 'rate_limit'}）`, code)
  if (code === 'context_overflow') return transient('上下文过长', code)
  if (code === 'network') return transient(timedOut() ? `请求超时（${status === 408 ? status : 'timeout'}）` : '暂时连不上（网络）', code)
  // invalid_request 包含模型不可用等多种拒绝，明确的兼容性错误可进一步细分。
  if (code === 'incompatible') return INCOMPATIBLE
  if ((!code || code === 'invalid_request') && (outdatedClientSignal(provider, detail) ||
      /\b(?:model(?:[_ ]not[_ ]found|[_ ]not[_ ]supported|[^\n.]{0,120} (?:does not exist|is not supported|is unavailable))|unsupported model|(?:version|protocol) mismatch|incompatible (?:version|protocol))\b/i.test(detail))) return INCOMPATIBLE
  return transient('暂时没有回应（原因未明）', code ?? 'provider_error')
}

export function probeStatusNote(status: ProbeStatus): string {
  if (status.state === 'awaiting_turn') return '还没用过，第一次对话时确认'
  if (status.state === 'ok') {
    return status.source === 'history'
      ? `沿用上次的结果（${new Date(status.at).toLocaleString('zh-CN', { hour12: false })}）`
      : '已通过对话确认连接'
  }
  const prefix = status.startup ? '启动失败，' : ''
  if (status.kind === 'auth') return `${prefix}${status.reason}，请检查账号或密钥`
  if (status.kind === 'quota') {
    const reset = status.resetAt === undefined ? '' : `（预计 ${new Date(status.resetAt).toLocaleString('zh-CN', { hour12: false })} 恢复）`
    return `${prefix}${status.reason}${reset}，等额度恢复或换一个脑子`
  }
  if (status.kind === 'transient') return `${prefix}${status.reason}，再发一句就会重试`
  return `${prefix}${status.reason}，请检查 CLI 版本或换一个模型`
}

interface ConfirmationOptions {
  provider: 'claude' | 'codex'
  combination: () => ProbeCombination
  history: ProbeHistory
  inferredModel?: (target: ProbeCombination) => string | undefined
  now?: () => number
}

/** Observe chat outcomes. Startup, dispatch and evaluation retain their normal admission rules. */
export function withTurnConfirmation(inner: AgentProvider, opts: ConfirmationOptions): AgentProvider & { probeStatus(): ProbeStatus } {
  const now = opts.now ?? Date.now
  const latest = new Map<string, { order: number; status: ProbeStatus }>()
  let order = 0
  const persisted = new Map<string, { order: number; confirmed: boolean }>()
  const configuredTarget = (defaults: ProbeCombination) => {
    const inferred = defaults.model === UNKNOWN_PROBE_FIELD ? opts.inferredModel?.(defaults) : undefined
    return inferred ? { ...defaults, model: inferred } : defaults
  }
  const known = (target: CallTarget | null | undefined, defaults: ProbeCombination): ProbeCombination | undefined => {
    if (!target?.model || target.model === UNKNOWN_PROBE_FIELD) return
    const endpoint = probeEndpointKey(target)
    if (endpoint !== 'unresolved') return { ...defaults, model: target.model, endpoint }
  }
  // The turn owns delivery, while the version lookup and record update run independently.
  const afterVersion = (version: string | Promise<string | undefined>, apply: (cliVersion: string) => void) => {
    void Promise.resolve(version).then(cliVersion => {
      if (cliVersion) apply(cliVersion)
    }).catch(() => { /* Connection accounting is best effort. */ })
  }
  const update = (target: ProbeCombination, observed: number, status: ProbeStatus) => {
    const key = probeCombinationKey(target)
    if ((latest.get(key)?.order ?? 0) < observed) latest.set(key, { order: observed, status })
    return key
  }
  // Transient failures can supersede the display while a successful confirmation is still pending.
  const persist = (target: ProbeCombination, key: string, observed: number, at?: number) => {
    const previous = persisted.get(key)
    if (previous && previous.order > observed) return
    if (at === undefined) opts.history.clear(target)
    else if (!previous?.confirmed) opts.history.save({ ...target, at, confirmedByTurn: true })
    persisted.set(key, { order: observed, confirmed: at !== undefined })
  }
  const failure = (error: unknown, detail: string, note: (status: Extract<ProbeStatus, { state: 'failed' }>, observed: number) => void) => {
    const classified = classifyProbeError(opts.provider, error, detail)
    const at = now()
    const resetAt = classified.kind === 'quota' ? parseResetAt(detail) : null
    note({
      state: 'failed', ...classified, at,
      ...(resetAt !== null && resetAt > at ? { resetAt } : {}),
    }, ++order)
    let message = classified.reason
    // Preserve fixed upgrade and overflow signals used by the coordinator.
    if (classified.kind === 'incompatible' && outdatedClientSignal(opts.provider, detail)) {
      message = `This request requires a newer version of ${CLI_SPECS[opts.provider].label}.`
    }
    if (classified.code === 'context_overflow') {
      const input = contextOverflowInputTokens(detail)
      const limit = contextOverflowLimitTokens(detail)
      message = `context window exceeded${input ? `, requested ${input}` : ''}${limit ? `, model token limit: ${limit}` : ''}`
    }
    return { kind: 'error' as const, message, code: classified.code }
  }

  const noteFailure = (target: ProbeCombination, status: Extract<ProbeStatus, { state: 'failed' }>, observed: number, startup = false) => {
    if (!startup && status.code === 'context_overflow') return
    const key = update(target, observed, status)
    if (startup || status.kind === 'incompatible') persist(target, key, observed)
  }
  const observeSession = (session: AgentSession, defaults: ProbeCombination): AgentSession => {
    let cancellations = 0
    const target = () => {
      try {
        const route = known(session.confirmationTarget
          ? session.confirmationTarget()
          : sessionCallTarget(session, opts.provider), defaults)
        if (!route) return
        const version = session.confirmationVersion?.().catch(() => undefined) ?? defaults.cliVersion
        return (apply: (target: ProbeCombination) => void) => {
          afterVersion(version, cliVersion => apply({ ...route, cliVersion }))
        }
      } catch { /* Missing confirmation metadata leaves the turn unchanged. */ }
    }
    const turnFailure = (error: unknown, detail: string, captured: ReturnType<typeof target>) =>
      failure(error, detail, (status, observed) => captured?.(sentTo => noteFailure(sentTo, status, observed)))
    return {
      ...session,
      ...(session.cancel ? { async cancel() { cancellations++; await session.cancel!() } } : {}),
      async close() { cancellations++; await session.close() },
      async *dispatch(...args) {
        if (args[2]?.source === 'background') {
          yield* session.dispatch(...args)
          return
        }
        const before = cancellations
        let failed = false
        let completion: { target: ReturnType<typeof target> } | undefined
        let hasReply = false
        try {
          for await (const event of session.dispatch(...args)) {
            if (before !== cancellations) continue
            if (event.kind === 'error') {
              if (!failed) yield turnFailure(event, event.message || 'provider_error', target())
              failed = true
              continue
            }
            if (event.kind === 'tool_call' || (event.kind === 'text' && event.text.trim())) hasReply = true
            if (event.kind === 'result') {
              completion = { target: target() }
              hasReply ||= !!event.finalText?.trim()
            }
            yield event
          }
        } catch (err) {
          if (isNetworkUnprotectedError(err)) throw err
          if (!failed && before === cancellations) {
            yield turnFailure(err, err instanceof Error ? err.message : String(err), target())
          }
          return
        }
        if (before !== cancellations || failed || !completion) return
        if (!hasReply) {
          yield turnFailure(undefined, '', completion.target)
          return
        }
        const at = now()
        const observed = ++order
        completion.target?.(sentTo => {
          const key = update(sentTo, observed, { state: 'ok', source: 'turn', at })
          persist(sentTo, key, observed, at)
        })
      },
    }
  }

  return {
    ...inner,
    async spawn(project, ctx) {
      if (ctx.evaluation) return inner.spawn(project, ctx)
      const defaults = opts.combination()
      let startupTarget: CallTarget | undefined
      let startupVersion: Promise<string | undefined> | undefined
      try {
        const session = await inner.spawn(project, { ...ctx, reportStartupTarget: (target, version) => { startupTarget = target; startupVersion = version } })
        return observeSession(session, defaults)
      } catch (err) {
        if (isNetworkUnprotectedError(err) || ctx.preparationSignal?.aborted) throw err
        const requested = ctx.execution?.model ?? ctx.model
        const defaultStartup = !ctx.resumeSessionId && (!requested || requested === defaults.model)
        const partialDefaultRoute = startupTarget && !startupTarget.model &&
          defaults.model === UNKNOWN_PROBE_FIELD && !requested && defaults.endpoint !== 'unresolved' &&
          probeEndpointKey(startupTarget) === defaults.endpoint
        const { message, code } = failure(err, err instanceof Error ? err.message : String(err), (status, observed) => {
          afterVersion(startupVersion ?? defaults.cliVersion, cliVersion => {
            const started = { ...defaults, cliVersion }
            const target = known(startupTarget, started)
            if (target) noteFailure(target, status, observed, true)
            else if (defaultStartup && (!startupTarget || partialDefaultRoute)) {
              update(started, observed, { ...status, startup: true })
            }
          })
        })
        throw errorWithProviderCode(message, code)
      }
    },
    probeStatus() {
      const defaults = opts.combination()
      const target = configuredTarget(defaults)
      const current = latest.get(probeCombinationKey(target))
      const route = latest.get(probeCombinationKey(defaults))
      if (route?.status.state === 'failed' && route.status.startup && route.order > (current?.order ?? 0)) return route.status
      if (current) return current.status
      const previous = target.cliVersion !== UNKNOWN_PROBE_FIELD ? opts.history.read(target) : undefined
      // Older records include standalone probes and cannot establish a real turn.
      return previous?.confirmedByTurn
        ? { state: 'ok', source: 'history', at: previous.at }
        : { state: 'awaiting_turn' }
    },
  }
}
