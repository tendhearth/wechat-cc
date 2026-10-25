/**
 * phone-calls.ts —— 手机面板(`/m/api/*`、`/set/api/*`)的类型化客户端(架构终态 F3)。
 *
 * 一张表 `PHONE_CALLS`:`命名空间.方法 → 路由键`,外加查询参数 / 正文的类型。路由键只能是路由表
 * (`routes.ts` 的 `ROUTES`)里登记过、且在 `api.ts` 的 `PHONE_API_SCHEMAS` 里有返回形状的那些 ——
 * 写错一个字编译就不过;路径从键里取,不再在调用方手写。返回类型从同一份 schema 推(`PhoneApiOk`)。
 *
 * 传输可换:`makePhoneApi(send)` 只管把「调哪条、带什么」拼成 `PhoneCallRequest`,怎么送、怎么校验、
 * 错误怎么映射全在 `send` 里。App 今天经中继 v2(`apps/app/src/backend/live.ts`);网页、桌面以后各接各的。
 *
 * 运行时不 import zod(只引类型):网页那份 IIFE 以后要用也不长个子。
 *
 * 查询串的拼法与搬家前逐字一致:按给的顺序、`undefined` 的不带;字符串 `encodeURIComponent`,数字原样。
 * 前缀路由(贴纸一族,键以 `/` 结尾)多一个 `suffix`,编码后接在路径后面。拼法和桌面(`desktop-calls.ts`)共用 `calls.ts`。
 */
import type { PhoneApiKey, PhoneApiOk } from './api'
import { callRequest, callSpec, makeApi, t, type CallArgs, type CallRequest, type CallSpec, type LooseCallArgs } from './calls'

/** 一条调用的声明。`_q` / `_b` 只是类型标记,运行时恒为 undefined。 */
export type PhoneCallSpec<K extends PhoneApiKey = PhoneApiKey, Q = unknown, B = unknown> = CallSpec<K, Q, B>

function call<K extends PhoneApiKey, Q = void, B = void>(key: K, types?: { query?: Q; body?: B }): PhoneCallSpec<K, Q, B> {
  return callSpec(key, types)
}

type JobsActionT = 'pause' | 'resume' | 'remove'

export const PHONE_CALLS = {
  set: {
    state: call('GET /set/api/state'),
    apply: call('POST /set/api/apply', { body: t<{ op: string } & Record<string, unknown>>() }),
    pair: call('POST /set/api/pair', { body: t<Record<string, never>>() }),
  },
  home: {
    get: call('GET /m/api/home', { query: t<{ limit: number }>() }),
    seen: call('POST /m/api/seen', { body: t<{ until: string }>() }),
  },
  state: { get: call('GET /m/api/state') },
  todos: { set: call('POST /m/api/todo', { body: t<{ id: number; status: string }>() }) },
  memory: {
    get: call('GET /m/api/memory'),
    correct: call('POST /m/api/memory/correct', { body: t<{ id: string; verdict: string }>() }),
  },
  matters: {
    list: call('GET /m/api/matters'),
    get: call('GET /m/api/matter', { query: t<{ id: string }>() }),
    inputReceipt: call('GET /m/api/matter/input-receipt', { query: t<{ id: string; requestId: string }>() }),
    insight: call('GET /m/api/matter/insight', { query: t<{ id: string; lang: string }>() }),
    changes: call('GET /m/api/matter/changes', { query: t<{ id: string }>() }),
    reviewMark: call('POST /m/api/matter/review-mark', { body: t<{ id: string; artifactId: string; path: string; mark: 'accepted' }>() }),
    reviewReturn: call('POST /m/api/matter/review-return', { body: t<{ id: string; artifactId: string; paths: string[]; comment: string }>() }),
    reviewComment: call('POST /m/api/matter/review-comment', { body: t<{ id: string; commentId: string } & Record<string, unknown>>() }),
    reviewCommentsSend: call('POST /m/api/matter/review-comments-send', { body: t<{ id: string; inputRequestId: string; summary?: string }>() }),
    rewindPreview: call('GET /m/api/matter/rewind', { query: t<{ id: string; artifactId: string }>() }),
    rewind: call('POST /m/api/matter/rewind', { body: t<{ id: string; artifactId: string; token: string }>() }),
    say: call('POST /m/api/matter/say', { body: t<{ id: string; text: string; requestId: string } & Record<string, unknown>>() }),
    create: call('POST /m/api/matter/create', { body: t<{ requestId: string; text: string } & Record<string, unknown>>() }),
    createReceipt: call('GET /m/api/matter/create-receipt', { query: t<{ requestId: string }>() }),
    permission: call('POST /m/api/matter/permission', { body: t<{ id: string; runId: string; requestId: string; decision: string }>() }),
    stop: call('POST /m/api/matter/stop', { body: t<{ id: string; runId: string }>() }),
    worktree: call('POST /m/api/matter/worktree', { body: t<{ id: string; action: string }>() }),
    answer: call('POST /m/api/matter/answer', { body: t<{ id: string; runId: string; requestId: string; answers: unknown }>() }),
    artifact: call('GET /m/api/matter/artifact', { query: t<{ id: string; artifactId: string; sha256: string; offset: number }>() }),
    handoff: call('POST /m/api/matter/handoff', { body: t<{ id: string; requestId: string; providerId: string }>() }),
  },
  chat: {
    page: call('GET /m/api/chat', { query: t<{ before?: string; limit?: number }>() }),
    say: call('POST /m/api/chat/say', { body: t<{ requestId: string; text: string; draftId?: string; attachmentIds?: string[] }>() }),
    search: call('GET /m/api/chat/search', { query: t<{ q: string }>() }),
    model: call('GET /m/api/chat/model'),
    setModel: call('POST /m/api/chat/model', { body: t<{ provider: string; model: string | null }>() }),
    file: call('GET /m/api/chat/file', { query: t<{ id: string; i: number; offset: number }>() }),
    voice: call('GET /m/api/chat/voice', { query: t<{ id: string; i: number }>() }),
    transcribeStatus: call('GET /m/api/chat/transcribe'),
    transcribe: call('POST /m/api/chat/transcribe', { body: t<{ mime: string; audioBase64: string }>() }),
  },
  attachments: {
    chunk: call('POST /m/api/attachment/chunk', { body: t<Record<string, unknown>>() }),
    upload: call('GET /m/api/attachment/upload', { query: t<{ id: string; draftId: string }>() }),
    discard: call('POST /m/api/attachment/discard', { body: t<{ id: string; draftId: string }>() }),
  },
  entry: {
    models: call('GET /m/api/entry/models', { query: t<{ providerId: string; projectId?: string }>() }),
    options: call('GET /m/api/entry/options'),
  },
  jobs: {
    list: call('GET /m/api/jobs'),
    action: call('POST /m/api/jobs/action', { body: t<{ id: string; action: JobsActionT }>() }),
  },
  activity: { list: call('GET /m/api/activity', { query: t<{ cursor?: string }>() }) },
  letters: {
    list: call('GET /m/api/letters'),
    page: call('GET /m/api/letters/page', { query: t<{ id: string; p: number; offset: number }>() }),
  },
  stickers: { get: call('GET /m/api/sticker/', { query: t<{ b64: 1 }>() }) },
  connections: { get: call('GET /m/api/connections') },
  sessions: {
    list: call('GET /m/api/sessions', { query: t<{ provider: string; cursor?: string; q?: string }>() }),
    get: call('GET /m/api/session', { query: t<{ key: string; cursor?: string; window?: string }>() }),
    continuePreview: call('GET /m/api/session/continue', { query: t<{ key: string }>() }),
    continue: call('POST /m/api/session/continue', { body: t<{ key: string }>() }),
  },
  cli: {
    sessions: call('GET /m/api/cli/sessions'),
    permission: call('POST /m/api/cli/permission', { body: t<{ session_id: string; hash?: string; decision: string }>() }),
    say: call('POST /m/api/cli/say', { body: t<{ session_id: string; text: string }>() }),
    activity: call('GET /m/api/cli/activity', { query: t<{ session_id: string }>() }),
  },
  today: { get: call('GET /m/api/today') },
  push: {
    register: call('POST /m/api/push/register', { body: t<{ platform: string; token: string }>() }),
    test: call('POST /m/api/push/test', { body: t<Record<string, never>>() }),
  },
} as const

/** 交给传输的一次调用:键(给校验 / 日志)、方法、拼好的路径、正文(对象,未序列化)。 */
export type PhoneCallRequest = CallRequest<PhoneApiKey>
/** 可换的传输:送出去、按状态码 / 错误码挡掉失败、校验返回形状,回成功那一半。 */
export type PhoneTransport = (req: PhoneCallRequest) => Promise<unknown>

/** 调用参数:有查询就要 query,有正文就要 body,前缀路由要 suffix;retry 随时可给。 */
export type PhoneCallArgs<S> = CallArgs<S>
export type PhoneCallFn<S> = S extends PhoneCallSpec<infer K, unknown, unknown>
  ? Record<string, never> extends PhoneCallArgs<S>
    ? (args?: PhoneCallArgs<S>) => Promise<PhoneApiOk<K>>
    : (args: PhoneCallArgs<S>) => Promise<PhoneApiOk<K>>
  : never

type Calls = typeof PHONE_CALLS
export type PhoneApi = { readonly [NS in keyof Calls]: { readonly [M in keyof Calls[NS]]: PhoneCallFn<Calls[NS][M]> } }

/** 一条声明 + 参数 ⇒ 交给传输的请求(不送)。拼法见 `calls.ts`。 */
export function phoneCallRequest<S extends PhoneCallSpec>(spec: S, args?: PhoneCallArgs<S>): PhoneCallRequest {
  return callRequest(spec, args as LooseCallArgs)
}

/** 给协议客户端(`ProtocolClient.request`)的形状:有正文 ⇒ JSON 序列化 + content-type。 */
export function toProtocolRequest(r: PhoneCallRequest): { method: 'GET' | 'POST'; path: string; body?: string; headers?: Record<string, string>; retry?: boolean } {
  return {
    method: r.method, path: r.path,
    ...(r.body !== undefined ? { body: JSON.stringify(r.body), headers: { 'content-type': 'application/json' } } : {}),
    ...(r.retry !== undefined ? { retry: r.retry } : {}),
  }
}

/** 类型化客户端:`api.matters.list()`、`api.matters.get({ query: { id } })` …,底下是可换的传输。 */
export function makePhoneApi(send: PhoneTransport): PhoneApi {
  return makeApi(PHONE_CALLS, send as (req: CallRequest) => Promise<unknown>) as PhoneApi
}
