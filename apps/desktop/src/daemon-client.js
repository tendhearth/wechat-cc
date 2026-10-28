// @ts-check
/**
 * 桌面的类型化客户端(架构终态 F5):路径不再在调用方手写,从生成的表 `V1`(`./generated/daemon-calls.js`,
 * 源头是 packages/protocol/src/desktop-calls.ts)里取。
 *
 *   await v1(invokeApi, V1.a2a.test, { body: { agent_id, text } })
 *   await v1(deps.invokeWorkbenchApi, V1.workbench.task, { query: { id } })
 *   await v1(invokeApi, V1.memory.synthesize, undefined, { timeoutMs: 60_000 })
 *
 * 传输照旧是各模块拿到的那个函数(`invokeApi` / `invokeWorkbenchApi` / 测试注入的假传输),签名
 * `(method, path, body?, opts?)` 不变;这里只把「调哪条、带什么」拼成方法和路径交给它,实参个数也和搬家前一样
 * (没正文、没选项就只传两个)。
 *
 * 拼法照抄 packages/protocol/src/calls.ts 的 callRequest(webview 引不到协议包):
 * 普通对象 ⇒ 按给的顺序、undefined 不带、字符串 encodeURIComponent、数字原样;URLSearchParams ⇒ 原样,空的不带 `?`。
 * scripts/client-paths.guard.test.ts 拿同一组样例比两边的输出。
 */
import { V1 } from './generated/daemon-calls.js'

export { V1 }

/** @typedef {import('./generated/daemon-calls.js').V1Key} V1Key */
/** @typedef {Record<string, string | number | undefined> | URLSearchParams} V1Query */
/** @typedef {{ query?: V1Query, body?: unknown, suffix?: string }} V1Args */

/** @param {V1Query | undefined} q */
function queryString(q) {
  if (!q) return ''
  if (q instanceof URLSearchParams) {
    const s = String(q)
    return s ? `?${s}` : ''
  }
  /** @type {string[]} */
  const parts = []
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue
    parts.push(`${k}=${typeof v === 'number' ? String(v) : encodeURIComponent(v)}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

/**
 * 一条调用 ⇒ `{ key, method, path, body? }`(不送)。
 * @param {V1Key} key
 * @param {V1Args} [args]
 * @returns {{ key: V1Key, method: 'GET' | 'POST', path: string, body?: unknown }}
 */
export function v1Request(key, args) {
  if (typeof key !== 'string') throw new Error('v1Request: 未知的调用(V1 表里没有这一项)')
  const sp = key.indexOf(' ')
  const method = /** @type {'GET' | 'POST'} */ (key.slice(0, sp))
  const path = key.slice(sp + 1) + (args?.suffix !== undefined ? encodeURIComponent(args.suffix) : '') + queryString(args?.query)
  return { key, method, path, ...(args?.body !== undefined ? { body: args.body } : {}) }
}

/**
 * 只要路径(给 `fetch` 的开发兜底、要把路径当常量导出的地方)。
 * @param {V1Key} key
 * @param {V1Args} [args]
 */
export function v1Path(key, args) {
  return v1Request(key, args).path
}

/**
 * 拼好交给传输。返回的就是传输的返回(类型跟着传输走)。
 * @template R
 * @param {(method: any, path: string, body?: any, opts?: any) => R} transport  方法收窄成只读的 `'GET'` 的传输也接(调用方保证只拿它调 GET)
 * @param {V1Key} key
 * @param {V1Args} [args]
 * @param {unknown} [opts]  传输自己的选项(`invokeApi` 的 `{ timeoutMs }`),原样带过去
 * @returns {R}
 */
export function v1(transport, key, args, opts) {
  const r = v1Request(key, args)
  if (opts !== undefined) return transport(r.method, r.path, r.body, opts)
  if ('body' in r) return transport(r.method, r.path, r.body)
  return transport(r.method, r.path)
}
