/**
 * 链接令牌能走的路由 = 链接页面真正会调的路由(架构复查 10-21 理念 2「权限跟着入口走」)。
 *
 * 这里是扫描器本身(纯函数,只吃文本);守卫在 `link-routes-from-source.guard.test.ts`。
 * 扫的是「拿着 /set 链接令牌(`t…`)会跑起来的代码」:
 *   - 手机网页 /m(apps/mobile/src 组装出来的整份页面)
 *   - 设置页 /set(settings-panel-html.ts 的 pageHtml,内联了同一份传输层)
 *   - 中继壳页 relay/pset.src.html(document.write 上面两页之一)
 *   - 手机 App 配对那一步(apps/app/src/net/pairing.ts 的 linkClient —— App 只有这一处拿链接令牌)
 *   - `wechat-cc selftest phone` 的配对那一步(src/cli/selftest-phone.ts,同一个形状)
 *
 * 认得的调用形状(别的形状一律报错,不静默跳过):
 *   - `api(lit, opts?)` / `mApi(lit, opts?)` / `mPostOnce(lit, opts)` / `fetch(lit, opts?)`:
 *     方法看 opts 里的 `method: '…'`,没有 opts 或 opts 里没 method ⇒ GET;opts 里 method 不是字面量 ⇒ 报错。
 *   - `sapi(lit)` ⇒ GET,`sapi(lit, body)` ⇒ POST(设置页的封装)。
 *   - `ccNav(lit)` / `q(lit)` ⇒ GET(带令牌跳页)。
 *   - `linkClient.request({ method: '…', path: '…' })`(App / selftest 配对)。
 *   - 第一个参数不是字面量(`api(path, opts)` 这种转手的封装)⇒ 算「转手」,不出路由;兜底见下一条。
 * 兜底:文本里每一个长得像面板路由的字符串字面量(`/m…`、`/set…`)都必须被上面某个调用的第一个参数吃掉,
 * 或者落在 NON_CALL_SITES 认得的上下文里;否则报「认不出的调用形状」。所以 `var p = "/m/api/x"; api(p)` 会红。
 *
 * 字面量拼接:`'/m/api/matter?id=' + id` 取 `?` 之前;`'/m/api/sticker/' + name` 或模板串 `${…}` 前面是路径的,
 * 算前缀调用,只能对上以 `/` 结尾的前缀路由(`GET /m/api/sticker/`)。
 *
 * 只在设备令牌下才走的调用:在调用前紧挨着写 `/* link-scan: device-only *\/`,扫描器把它记成「只给设备」、
 * 不计入链接集合。现在一处都没有(收敛 5b 之后网页只剩配对、此刻、一起做的看和停),
 * 页面区分两种令牌靠 boot.js 的 `isDevice = T.charAt(0) === "d"`;要在 `if (isDevice)` 分支里加调用,就加这条注释。
 */

export type ScannedCall = { key: string; source: string; snippet: string; deviceOnly: boolean }
export type ScanResult = { calls: ScannedCall[]; forwarders: string[] }

export const DEVICE_ONLY_MARK = '/* link-scan: device-only */'
const DEVICE_SENTINEL = '\u0000DEVICE_ONLY\u0000'

/** 不带令牌的静态资源(与 phone-routes.guard.test.ts 的 TOKENLESS 同一组),不是面板路由。 */
export const TOKENLESS = new Set(['/m/icon.png', '/m/manifest.json', '/m/sw.js'])

/**
 * 不是「带令牌调路由」、但确实会出现面板路径字面量的地方。每条:紧挨字面量之前的文本(正则,锚在结尾)。
 * `emit` 给了的,这个字面量本身就是一次调用(壳页的默认路径)。
 */
export const NON_CALL_SITES: ReadonlyArray<{ before: RegExp; why: string; emit?: 'GET' }> = [
  { before: /scope:\s*$/, why: 'service worker 的作用域,不是请求' },
  { before: /location\.replace\(\s*$/, why: '401 后不带令牌回到 /m(那里走 bootstrap 找设备令牌)' },
  { before: /P\.p\s*\|\|\s*$/, why: '壳页隧道取页:PATH 缺省 /m,其余值来自 ccNav 的 &p=(那些调用各自已经扫到)', emit: 'GET' },
]

const CALLERS = ['api', 'mApi', 'mPostOnce', 'sapi', 'fetch', 'ccNav', 'q', 'linkClient.request'] as const
const CALLER_RE = new RegExp(String.raw`(?<![\w$.])(${CALLERS.map(c => c.replace('.', String.raw`\.`)).join('|')})\s*\(`, 'g')
const ROUTE_LITERAL_RE = /(["'`])(\/(?:m|set)(?:[/?][^"'`\s]*)?)\1/g

export class ScanError extends Error {}

/** 去掉 HTML 注释、JS 块注释(保留 device-only 标记)与行注释。行注释只认行首 / 空白 / 标点之后的 `//`,不碰 `wss://`、正则里的 `\/\/`。 */
export function stripComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split(DEVICE_ONLY_MARK).join(DEVICE_SENTINEL)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1')
}

/** 从 `open`(指向 `(`)起配对到匹配的 `)`,跳过字符串。返回顶层逗号切开的参数文本。 */
function readArgs(text: string, open: number): { args: string[]; end: number } {
  let depth = 0, i = open, start = open + 1
  const args: string[] = []
  for (; i < text.length; i++) {
    const c = text[i]!
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      for (i++; i < text.length && text[i] !== q; i++) if (text[i] === '\\') i++
      continue
    }
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') {
      depth--
      if (depth === 0) { args.push(text.slice(start, i).trim()); return { args: args.filter((a, k) => a !== '' || k > 0), end: i } }
    } else if (c === ',' && depth === 1) { args.push(text.slice(start, i).trim()); start = i + 1 }
  }
  throw new ScanError(`括号没配上:${text.slice(open, open + 80)}`)
}

/** 参数开头是字符串字面量 ⇒ { path, prefix };不是 ⇒ null。 */
function literalPath(arg: string): { raw: string; path: string; dynamic: boolean } | null {
  const m = /^(["'`])((?:\\.|(?!\1).)*)\1/s.exec(arg)
  if (!m) return null
  let lit = m[2]!
  let dynamic = arg.slice(m[0].length).trim().startsWith('+')
  if (m[1] === '`' && lit.includes('${')) { lit = lit.slice(0, lit.indexOf('${')); dynamic = true }
  const qi = lit.indexOf('?')
  if (qi >= 0) return { raw: m[2]!, path: lit.slice(0, qi), dynamic: false }
  return { raw: m[2]!, path: lit, dynamic }
}

function methodFrom(opts: string | undefined, where: string): string {
  if (opts === undefined || opts === '' || opts === 'undefined') return 'GET'
  const lit = /\bmethod\s*:\s*(["'])([A-Z]+)\1/.exec(opts)
  if (lit) return lit[2]!
  if (/\bmethod\b/.test(opts)) throw new ScanError(`认不出请求方法(method 不是字面量):${where}`)
  return 'GET'
}

/** 把一次调用落到路由表的键上:精确键,或(动态后缀)以 `/` 结尾的前缀键。 */
export function routeKey(method: string, path: string, dynamic: boolean, table: ReadonlySet<string>, where: string): string {
  const exact = `${method} ${path}`
  if (!dynamic && table.has(exact)) return exact
  if (dynamic) {
    const prefix = [...table].find(k => k.startsWith(`${method} `) && k.endsWith('/') && path.startsWith(k.slice(method.length + 1)))
    if (prefix) return prefix
  }
  throw new ScanError(`调用对不上路由表里的任何一行:${exact}${dynamic ? '…(拼接)' : ''} @ ${where}`)
}

/**
 * 扫一份源码。`table` 是路由表里所有带 phone / set 的键(PHONE_ROUTES)。
 * 认不出的形状、对不上表的路径、悬空的 device-only 标记都抛 ScanError。
 */
export function scanSource(source: string, rawText: string, table: ReadonlySet<string>): ScanResult {
  const text = stripComments(rawText)
  const calls: ScannedCall[] = []
  const forwarders: string[] = []
  const consumed = new Set<number>()
  for (const m of text.matchAll(CALLER_RE)) {
    const name = m[1]!
    const at = m.index!
    const before = text.slice(Math.max(0, at - 40), at)
    if (/\bfunction\s+$/.test(before)) continue // 定义,不是调用
    const open = at + m[0].length - 1
    const { args } = readArgs(text, open)
    const snippet = text.slice(at, Math.min(text.length, open + 1 + (args[0]?.length ?? 0) + 1)).replace(/\s+/g, ' ')
    const where = `${source}: ${snippet}`
    const deviceOnly = before.trimEnd().endsWith(DEVICE_SENTINEL)
    let method: string, lit: ReturnType<typeof literalPath>, litOffset: number
    if (name === 'linkClient.request') {
      const obj = args[0] ?? ''
      const pathM = /\bpath\s*:\s*(["'`])/.exec(obj)
      if (!obj.startsWith('{') || !pathM) throw new ScanError(`认不出 linkClient.request 的形状:${where}`)
      lit = literalPath(obj.slice(pathM.index + pathM[0].length - 1))
      if (!lit) throw new ScanError(`linkClient.request 的 path 不是字面量:${where}`)
      method = methodFrom(obj, where)
      litOffset = text.indexOf(obj, open) + pathM.index + pathM[0].length - 1
    } else {
      const first = args[0] ?? ''
      lit = literalPath(first)
      if (!lit) { forwarders.push(where); continue }
      method = name === 'sapi' ? (args.length > 1 && args[1] !== 'undefined' ? 'POST' : 'GET')
        : name === 'ccNav' || name === 'q' ? 'GET'
        : methodFrom(args[1], where)
      litOffset = text.indexOf(first, open)
    }
    if (!/^\/(?:m|set)(?:\/|$)/.test(lit.path)) throw new ScanError(`调用的不是面板路由(${lit.raw}):${where}`)
    consumed.add(litOffset)
    calls.push({ key: routeKey(method, lit.path, lit.dynamic, table, where), source, snippet, deviceOnly })
  }
  for (const m of text.matchAll(ROUTE_LITERAL_RE)) {
    if (consumed.has(m.index!)) continue
    const path = m[2]!
    if (TOKENLESS.has(path)) continue
    const before = text.slice(Math.max(0, m.index! - 40), m.index!)
    const site = NON_CALL_SITES.find(s => s.before.test(before))
    const where = `${source}: …${before.slice(-24)}${m[0]}`.replace(/\s+/g, ' ')
    if (!site) throw new ScanError(`认不出的调用形状(面板路径字面量没被任何已知调用吃掉):${where}`)
    if (site.emit) {
      const lit = literalPath(m[0])!
      calls.push({ key: routeKey(site.emit, lit.path, lit.dynamic, table, where), source, snippet: where, deviceOnly: false })
    }
  }
  if (text.includes(DEVICE_SENTINEL)) {
    const n = text.split(DEVICE_SENTINEL).length - 1
    const used = calls.filter(c => c.deviceOnly).length
    if (n !== used) throw new ScanError(`${source}: ${DEVICE_ONLY_MARK} 有 ${n} 处,紧跟着认得的调用的只有 ${used} 处`)
  }
  return { calls, forwarders }
}

/** scanSource,但扫出来少于 `min` 次调用就报错:扫描器认不出新写法时会「什么都没扫到」,那不能算过。 */
export function scanAtLeast(source: string, rawText: string, table: ReadonlySet<string>, min: number): ScanResult {
  const r = scanSource(source, rawText, table)
  if (r.calls.length < min) throw new ScanError(`${source}: 只扫出 ${r.calls.length} 次调用(至少 ${min}),扫描器多半认不出新写法`)
  return r
}

/** 规则:链接令牌的范围(LINK_ROUTES)= 扫出来的链接调用。返回违规说明,空数组 = 通过。 */
export function compareLinkScope(calls: readonly ScannedCall[], linkRoutes: ReadonlySet<string>): string[] {
  const scanned = new Set(calls.filter(c => !c.deviceOnly).map(c => c.key))
  const problems: string[] = []
  for (const k of [...scanned].sort()) {
    if (!linkRoutes.has(k)) {
      const by = calls.filter(c => c.key === k && !c.deviceOnly).map(c => c.source).join(', ')
      problems.push(`${k}:链接页面会调(${by}),但路由表里 link:'none' ⇒ 链接会话会 403。页面不该在链接令牌下调它,就挪进设备分支并标 ${DEVICE_ONLY_MARK};确实要给链接,就在 routes.ts 把它开成 read / write 并写理由`)
    }
  }
  for (const k of [...linkRoutes].sort()) {
    if (!scanned.has(k)) problems.push(`${k}:链接令牌能走,但没有任何链接页面调它 ⇒ 在 routes.ts 把它收成 link:'none'`)
  }
  return problems
}
