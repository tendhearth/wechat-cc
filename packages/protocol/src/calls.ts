/**
 * calls.ts —— 类型化客户端的共用底子(架构终态 F3 / F5):一条调用 = 路由键 + 查询 / 正文的类型;
 * `callRequest` 把「调哪条、带什么」拼成交给传输的 `CallRequest`,怎么送、怎么校验、错误怎么映射全在传输里。
 *
 * 手机面板(`phone-calls.ts`,经中继 v2)和桌面(`desktop-calls.ts`,经本机 HTTP / Tauri 宿主代理)都从这里拼请求,
 * 查询串的拼法只有这一份:
 * - 普通对象:按给的顺序、`undefined` 的不带;字符串 `encodeURIComponent`,数字原样。
 * - `URLSearchParams`(桌面有几处搬家前就这么拼):原样 `String()`,空的不带 `?`。注意它把空格编成 `+`,
 *   和 `encodeURIComponent` 不一样 —— 搬家时照原来的写法挑,别混着改。
 * - 前缀路由(键以 `/` 结尾,贴纸一族)多一个 `suffix`,编码后接在路径后面。
 *
 * 桌面的 webview 引不到这个包(只加载 apps/desktop/src 里的文件),所以那边有一份照抄的小实现
 * (`apps/desktop/src/daemon-client.js`);`scripts/client-paths.guard.test.ts` 拿同一组样例逐个比两边的输出。
 *
 * 运行时不 import zod(只引类型)。
 */

export type QueryValue = string | number | undefined
export type Query = Record<string, QueryValue>
export type CallMethod = 'GET' | 'POST'

/** 一条调用的声明。`_q` / `_b` 只是类型标记,运行时恒为 undefined。 */
export interface CallSpec<K extends string = string, Q = unknown, B = unknown> {
  readonly key: K
  readonly _q?: Q
  readonly _b?: B
}

/** 只给类型用的标记:`query: t<{ id: string }>()`。 */
export const t = <X>(): X => undefined as X

/** 声明一条调用;各端包一层把 `K` 收窄到自己那半张路由表。 */
export function callSpec<K extends string, Q = void, B = void>(key: K, _types?: { query?: Q; body?: B }): CallSpec<K, Q, B> {
  return { key }
}

/** 交给传输的一次调用:键(给校验 / 日志)、方法、拼好的路径、正文(对象,未序列化)。 */
export interface CallRequest<K extends string = string> {
  readonly key: K
  readonly method: CallMethod
  readonly path: string
  readonly body?: unknown
  /** 超时后协议层可不可以原样重发;不给 ⇒ 传输的默认。 */
  readonly retry?: boolean
}

type IsVoid<X> = [X] extends [void] ? true : false
type IsPrefix<K extends string> = K extends `${string}/` ? true : false
/** 调用参数:有查询就要 query,有正文就要 body,前缀路由要 suffix;retry 随时可给。 */
export type CallArgs<S> = S extends CallSpec<infer K, infer Q, infer B>
  ? (IsVoid<Q> extends true ? unknown : { query: Q })
    & (IsVoid<B> extends true ? unknown : { body: B })
    & (IsPrefix<K> extends true ? { suffix: string } : unknown)
    & { retry?: boolean }
  : never

export function queryString(q: Query | URLSearchParams | undefined): string {
  if (!q) return ''
  if (typeof URLSearchParams !== 'undefined' && q instanceof URLSearchParams) {
    const s = String(q)
    return s ? `?${s}` : ''
  }
  const parts: string[] = []
  for (const [k, v] of Object.entries(q as Query)) {
    if (v === undefined) continue
    parts.push(`${k}=${typeof v === 'number' ? String(v) : encodeURIComponent(v)}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

export type LooseCallArgs = { query?: Query | URLSearchParams; body?: unknown; suffix?: string; retry?: boolean } | undefined

/** 一条声明 + 参数 ⇒ 交给传输的请求(不送)。 */
export function callRequest<K extends string>(spec: CallSpec<K>, args?: LooseCallArgs): CallRequest<K> {
  const sp = spec.key.indexOf(' ')
  const method = spec.key.slice(0, sp) as CallMethod
  const base = spec.key.slice(sp + 1)
  const path = base + (args?.suffix !== undefined ? encodeURIComponent(args.suffix) : '') + queryString(args?.query)
  return {
    key: spec.key, method, path,
    ...(args?.body !== undefined ? { body: args.body } : {}),
    ...(args?.retry !== undefined ? { retry: args.retry } : {}),
  }
}

/** 一张 `命名空间.方法 → 声明` 的表 + 一个传输 ⇒ `api.ns.m(args)`。类型由各端自己给(返回形状各端不同)。 */
export function makeApi(table: Readonly<Record<string, Readonly<Record<string, CallSpec>>>>, send: (req: CallRequest) => Promise<unknown>): unknown {
  const out: Record<string, Record<string, (a?: LooseCallArgs) => Promise<unknown>>> = {}
  for (const [ns, methods] of Object.entries(table)) {
    const o: Record<string, (a?: LooseCallArgs) => Promise<unknown>> = {}
    for (const [m, spec] of Object.entries(methods)) o[m] = (a?: LooseCallArgs) => send(callRequest(spec, a))
    out[ns] = o
  }
  return out
}
