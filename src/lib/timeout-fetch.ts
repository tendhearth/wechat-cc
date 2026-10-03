/**
 * timeout-fetch — 给一个 fetch 套两道**边界超时**,超时抛带 `network` 码的错误
 * (arch backlog #4 第 2 步;provider-error-shapes §4.4)。
 *
 * WHY:openai 兼容那条路(AI SDK + 自建网关,主人的主聊天走它)**没有任何请求超时**。
 * 沙箱实测:base URL 指向黑洞地址,40 秒内无任何输出;会话只能等 600 秒回合看门狗,
 * 而看门狗给的是 `turn_timeout`,不是「连不上」。
 *
 *   · connect:发出请求 → 拿到**响应头**。连不上 / 黑洞 / 网关卡住都在这里收尾。
 *   · idle:拿到响应头之后,流式正文**相邻两块之间**的最长间隔。流不断就不会被掐,
 *     只掐真正停住的流。
 *
 * 调用方自己的 AbortSignal 照常生效(用户 /stop);那种中止不是超时,不挂码。
 * 结构化的码在抛出物的 `providerErrorCode` 上(lib/provider-error-code),
 * 不是 `code` —— 别和 Node 的系统错误码混。
 */
import { errorWithProviderCode } from './provider-error-code'

export interface FetchTimeouts {
  /** 请求发出到拿到响应头的上限(ms)。 */
  connectTimeoutMs: number
  /** 流式正文相邻两块之间的上限(ms)。 */
  idleTimeoutMs: number
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** 带码的超时错误。name 刻意**不是** AbortError / TimeoutError:AI SDK 会把那两个当用户中止。 */
export function fetchTimeoutError(kind: 'connect' | 'idle', ms: number, url: string): Error {
  const seconds = Math.round(ms / 1000)
  const message = kind === 'connect'
    ? `请求 ${seconds}s 内没有拿到响应(连不上或对端没回):${url}`
    : `流式响应停了 ${seconds}s 没有新内容:${url}`
  const err = errorWithProviderCode(message, 'network')
  err.name = 'ProviderTimeoutError'
  return err
}

const urlOf = (input: RequestInfo | URL): string => {
  try { return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url } catch { return '<request>' }
}

export function makeTimeoutFetch(timeouts: FetchTimeouts, base: FetchLike = (input, init) => fetch(input, init)): FetchLike {
  return async (input, init) => {
    const url = urlOf(input).replace(/[?#].*$/, '')
    const controller = new AbortController()
    const outer = init?.signal
    const onOuterAbort = () => controller.abort(outer?.reason)
    if (outer) { if (outer.aborted) controller.abort(outer.reason); else outer.addEventListener('abort', onOuterAbort, { once: true }) }
    const detach = () => outer?.removeEventListener('abort', onOuterAbort)

    let timedOut: Error | undefined
    const connectTimer = setTimeout(() => {
      timedOut = fetchTimeoutError('connect', timeouts.connectTimeoutMs, url)
      controller.abort(timedOut)
    }, timeouts.connectTimeoutMs)
    let response: Response
    try {
      response = await base(input, { ...init, signal: controller.signal })
    } catch (err) {
      detach()
      throw timedOut ?? err
    } finally {
      clearTimeout(connectTimer)
    }
    if (!response.body) { detach(); return response }

    // 正文:每来一块就重置 idle 计时;停住就中止底层请求并让流报带码的错。
    const reader = response.body.getReader()
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const disarm = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined }
    const arm = () => {
      disarm()
      idleTimer = setTimeout(() => {
        const err = fetchTimeoutError('idle', timeouts.idleTimeoutMs, url)
        controller.abort(err)
        void reader.cancel(err).catch(() => {})
        try { streamController?.error(err) } catch { /* already closed */ }
      }, timeouts.idleTimeoutMs)
    }
    const body = new ReadableStream<Uint8Array>({
      start(c) { streamController = c; arm() },
      async pull(c) {
        try {
          const { done, value } = await reader.read()
          if (done) { disarm(); detach(); c.close(); return }
          arm()
          c.enqueue(value)
        } catch (err) {
          disarm(); detach()
          // 已经因为 idle 超时 error 过了就别再报一次。
          try { c.error(err) } catch { /* already errored */ }
        }
      },
      cancel(reason) { disarm(); detach(); return reader.cancel(reason).catch(() => {}) },
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * openai 兼容端点的缺省:connect 110s(比 Cloudflare 的 100s 524 稍长 —— 网关在
 * Cloudflare 后面时让真正的 524 先到,码是 server_error 而不是我们自己的超时),
 * idle 120s(思考型模型两段输出之间可以停很久)。
 * `WECHAT_OPENAI_CONNECT_TIMEOUT_MS` / `WECHAT_OPENAI_IDLE_TIMEOUT_MS` 可改。
 */
export function openaiFetchTimeoutsFromEnv(): FetchTimeouts {
  return {
    connectTimeoutMs: envMs('WECHAT_OPENAI_CONNECT_TIMEOUT_MS', 110_000),
    idleTimeoutMs: envMs('WECHAT_OPENAI_IDLE_TIMEOUT_MS', 120_000),
  }
}
