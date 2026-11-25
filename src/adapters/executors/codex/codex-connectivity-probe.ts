import { classifyProviderError, parseResetAt } from '../../../domain/provider-quota'
import type { CallTarget } from '../../../lib/network-gate'
import { codexErrorCode } from './codex-errors'
import { errorWithProviderCode } from '../../../lib/provider-error-code'
import type { CodexTargetResolution } from '../../../lib/codex-target'

export type CodexConnectivityProbe = (target: CallTarget, signal: AbortSignal) => Promise<string>

/** The native thread resolves project layers. Only reproduce a plain Responses gateway.
 * Native login and custom authentication transports are confirmed by the owner's turn.
 */
export function codexConnectivityProbe(
  config: Record<string, unknown> | undefined,
  route: CodexTargetResolution,
  env: NodeJS.ProcessEnv,
  globalRoute: () => CodexTargetResolution,
): CodexConnectivityProbe | undefined {
  if ('unresolved' in route || !route.baseUrl || route.wireApi !== 'responses') return
  const providers = config?.model_providers as Record<string, Record<string, unknown>> | undefined
  const provider = providers?.[route.providerId]
  if (!provider) return
  // Unknown provider options can alter auth, headers or the transport. Leave them to Codex.
  const supportedFields = new Set(['name', 'base_url', 'wire_api', 'env_key', 'env_key_instructions', 'requires_openai_auth',
    'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms', 'supports_websockets'])
  if (Object.entries(provider).some(([key, value]) => value != null && !supportedFields.has(key)) ||
      provider.requires_openai_auth === true) return
  let url: URL
  try { url = new URL(route.baseUrl) } catch { return }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return
  url.pathname = url.pathname.replace(/\/+$/, '') + '/responses'
  let key: string | undefined
  if (provider.env_key != null) {
    // A project must not select an environment credential or change its destination.
    const global = globalRoute()
    if (!route.envKey || 'unresolved' in global || global.providerId !== route.providerId ||
        global.baseUrl !== route.baseUrl || global.envKey !== route.envKey) return
    key = env[route.envKey]
    if (!key) return
  }

  return async (target, signal) => {
    // No agent process, cwd, instruction layers, history, tool registry or approval handlers.
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: target.model, input: '只回复两个字母:ok', tools: [], tool_choice: 'none', store: false,
      }),
    }).catch(() => { throw errorWithProviderCode('Codex probe connection failed', 'network') })
    const body = await response.json().catch(() => null)
    const error = body?.error
    if (!response.ok || error) {
      const detail = [error?.code, error?.message].filter(value => typeof value === 'string').join(' ')
      const quota = classifyProviderError(detail) === 'quota'
      const reset = quota ? parseResetAt(detail) : null
      // Keep only fixed phrases and numeric metadata. Gateway errors can echo credentials.
      const message = quota ? `usage limit reached${reset === null ? '' : `|${reset}`}`
        : /\bmodel[_ ]not[_ ]found\b/i.test(detail) ? 'model not found'
        : `HTTP status ${response.status}`
      throw errorWithProviderCode(message, codexErrorCode(message))
    }
    if (body?.status !== 'completed' || !Array.isArray(body.output) ||
        body.output.some((item: { type?: string } | null) => item?.type !== 'message' && item?.type !== 'reasoning')) return ''
    const output: Array<{ type: string; content?: Array<{ type?: string; text?: string } | null> }> = body.output
    return output.flatMap(item => item.type === 'message' && Array.isArray(item.content) ? item.content : [])
      .map(part => part?.type === 'output_text' && typeof part.text === 'string' ? part.text : '').join('')
  }
}
