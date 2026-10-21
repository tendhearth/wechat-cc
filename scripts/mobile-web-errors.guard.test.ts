/**
 * 手机网页(apps/mobile/src)「错误码 → 一句话」的守卫(架构复查 10-21:收敛 5b 之后网页只剩一张小表,没人核对)。
 *
 * 网页现在只调六条路由(link-routes-from-source 扫出来的那一组):一起做的列表 / 详情 / 停下这一轮、此刻、形象画、配对。
 * 规矩和 App 那半(apps/app/src/net/errors.test.ts 的 GENERIC)一样:
 *   1. 这几条路由会回的每个码,要么在网页的表里有一句话,要么明列在下面的 GENERIC(按通用那句走);
 *   2. 网页表里的每个码都得是对应路由真会回的 —— 没有死条目(以前 mError 认的 not_found 详情路由从来不回,它回 matter_not_found);
 *   3. GENERIC 里也不留路由不会回的码;
 *   4. 网页里别再有表外的 `x.error === '码'` 这类零散比较(要比就进表)。
 *
 * 「路由会回的码」怎么来:下面 ROUTE_CODES 按处理器逐条写,并且对着处理器源码核对 ——
 *   - direct:处理器直接回的 `error: '码'`;源码切片里每个 `error: '…'` 都得列出来,列出来的每个码都得在切片里出现;
 *   - thrown:抛给 mobileMatterError 的 `Error('码')`,经错误表手机一栏(workbenchErrorHttp(code, 'phone'))换成对外的码;
 *     切片里每个 `Error('…')` 都得列出来。切片覆盖处理器、MattersService.stop / taskDetail / require、工作台 cancel;
 *     更深处(deps.workbench.detail 之类)抛的码同样过手机一栏,表里没声明的落到兜底 unavailable / invalid_*。
 *   - 所有面板路由在分派之前还可能回 unauthorized(401)、route_not_allowed(403)。
 * 网页自己造的(超时 timeout、正文里没有 error 时的 unavailable)不是路由回的码,不在这里管。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { workbenchErrorHttp } from '../packages/protocol/src/workbench-errors'
import { assembleMobilePage } from '../apps/mobile/assemble'
import { readMobileSource } from '../apps/mobile/sources'
import { scanSource } from './link-routes-scan'
import { PHONE_ROUTES } from '../src/daemon/phone-routes'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Windows 检出是 CRLF(autocrlf):统一成 \n 再切片,不然 '\n}\n' 这类边界找不到(#526 Windows CI)
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n')

type Slice = { file: string; from: string; to: string }
/** 从 from 起(含)到 to 之前截一段;找不到就红(写法变了,别让守卫静默变空)。 */
function slice({ file, from, to }: Slice): string {
  const src = read(...file.split('/'))
  const start = src.indexOf(from)
  if (start < 0) throw new Error(`${file}: 找不到 ${from}`)
  const end = src.indexOf(to, start + from.length)
  if (end < 0) throw new Error(`${file}: ${from} 之后找不到 ${to}`)
  return src.slice(start, end)
}

const SP = 'src/daemon/settings-panel.ts'
const NEXT_ROUTE = 'if (url.pathname ==='
/** 分派之前(settings-panel routeRequest):没令牌 / 令牌够不着这条路由。 */
const COMMON: { codes: string[]; slices: Slice[] } = {
  codes: ['unauthorized', 'route_not_allowed'],
  slices: [{ file: SP, from: 'const caller = panelToken(t)', to: '// ── token-gated' }],
}

interface RouteCodes { direct: string[]; thrown?: string[]; slices: Slice[] }
const ROUTE_CODES: Record<string, RouteCodes> = {
  'GET /m/api/matters': {
    direct: ['matters_not_wired', 'invalid'],
    slices: [{ file: SP, from: "if (url.pathname === '/m/api/matters' && req.method === 'GET') {", to: NEXT_ROUTE }],
  },
  'GET /m/api/matter': {
    // catch 里是 `error: msg === 'matter_not_found' ? msg : 'unavailable'`(只有 matter_not_found 原样出去,其余一律 unavailable)
    direct: ['matters_not_wired', 'invalid', 'matter_not_found', 'unavailable', 'detail_too_large'],
    slices: [
      { file: SP, from: "if (url.pathname === '/m/api/matter' && req.method === 'GET') {", to: NEXT_ROUTE },
      { file: 'src/daemon/mobile-matter-response.ts', from: 'export function mobileMatterDetailResponse', to: '\n}\n' },
    ],
  },
  'POST /m/api/matter/stop': {
    direct: ['method_not_allowed'],
    thrown: ['invalid_request', 'workbench_not_wired', 'invalid_matter_id', 'matter_not_found', 'matter_task_required', 'input_stale', 'control_stale'],
    slices: [
      { file: 'src/daemon/mobile-workbench.ts', from: "if(url.pathname==='/m/api/matter/stop'){", to: 'const operation=' },
      { file: 'src/core/matters/service.ts', from: 'const require=', to: 'const current=' },
      { file: 'src/core/matters/service.ts', from: 'async stop(id,runId){', to: 'answer(' },
      { file: 'src/core/workbench/service/lifecycle.ts', from: 'async function cancel(', to: 'function shutdown' },
    ],
  },
  // home() 一律 ok:true(读不到的那一块写成 presence_error 字段,网页不当错误码用)
  'GET /m/api/home': { direct: [], slices: [{ file: SP, from: "if (url.pathname === '/m/api/home' && req.method === 'GET') {", to: NEXT_ROUTE }] },
  'GET /m/api/art/presence': { direct: [], slices: [{ file: SP, from: "if (url.pathname === '/m/api/art/presence' && req.method === 'GET') {", to: NEXT_ROUTE }] },
  'POST /set/api/pair': {
    direct: ['link_only', 'device_limit'],
    slices: [{ file: SP, from: "if (url.pathname === '/set/api/pair' && req.method === 'POST') {", to: NEXT_ROUTE }],
  },
}

/** 带令牌跳页(ccNav):回的是整页 HTML,网页不读错误码。 */
const NAVIGATIONS = ['GET /set']

/** 网页的码表,以及哪几条路由的回包交给它。表外的路由没有码表:回什么都按通用那句(GENERIC 里明列)。 */
const WEB_MAPS: Record<string, string[]> = {
  M_ERRORS: ['GET /m/api/matters', 'GET /m/api/matter'],
  M_STOP_ERRORS: ['POST /m/api/matter/stop'],
}

/** 有意按通用说法走的码(按路由)。路由多回了一个码 ⇒ 要么进网页的表,要么加进这里。 */
const GENERIC: Record<string, string[]> = {
  // 「暂时没读到，请检查连接后再看。」
  'GET /m/api/matters': ['route_not_allowed', 'matters_not_wired', 'invalid'],
  'GET /m/api/matter': ['route_not_allowed', 'matters_not_wired', 'invalid', 'unavailable'],
  // 「没停成，稍后再试。」
  'POST /m/api/matter/stop': ['unauthorized', 'route_not_allowed', 'method_not_allowed', 'invalid_request', 'invalid_matter_id', 'matter_not_found', 'matter_task_required', 'unavailable'],
  // 此刻:401 按状态走 onUnauthorized,其余是「家里的电脑暂时连不上」那条横幅;不看码
  'GET /m/api/home': ['unauthorized', 'route_not_allowed'],
  // 形象画拉不到就留空,不看码
  'GET /m/api/art/presence': ['unauthorized', 'route_not_allowed'],
  // 配对:toast「没配上:」后面直接跟码,没有逐码的话
  'POST /set/api/pair': ['unauthorized', 'route_not_allowed', 'link_only', 'device_limit'],
}

const DIRECT_RE = /error\s*:\s*'([a-z_]+)'/g
const THROWN_RE = /Error\(\s*'([a-z_]+)'\s*\)/g
const uniq = (a: Iterable<string>) => [...new Set(a)].sort()

/** 一条路由真会回的码(对外的那个)。 */
function returnable(key: string): string[] {
  const r = ROUTE_CODES[key]!
  return uniq([...COMMON.codes, ...r.direct, ...(r.thrown ?? []).map(code => workbenchErrorHttp(code, 'phone').error)])
}

/** workbench.js 里 `var NAME = { 码: "一句话", … }` 的键;不是全字符串值的对象字面量 ⇒ 报错。 */
function webMapKeys(src: string, name: string): string[] {
  const sf = ts.createSourceFile('workbench.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let keys: string[] | null = null
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.name.getText() === name) {
      if (!n.initializer || !ts.isObjectLiteralExpression(n.initializer)) throw new Error(`${name} 不是对象字面量`)
      keys = n.initializer.properties.map(p => {
        if (!ts.isPropertyAssignment(p) || !ts.isStringLiteralLike(p.initializer)) throw new Error(`${name} 里有不是「码: 字符串」的条目:${p.getText()}`)
        return p.name.getText().replace(/^["']|["']$/g, '')
      })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  if (!keys) throw new Error(`workbench.js 里找不到 var ${name}`)
  return keys
}

/** 网页里表外的零散比较:`x.error === '码'` / `x.message === '码'` / `code === '码'`。任务记录里的失败码(d.task.error)不走 HTTP,不算。 */
function strayComparisons(src: string): string[] {
  return [...src.matchAll(/([\w$.]+)\s*===?\s*["']([a-z_]+)["']/g)]
    .filter(m => /(^|\.)(error|message)$/.test(m[1]!) || m[1] === 'code')
    .filter(m => !/\.task\.error$/.test(m[1]!))
    .map(m => m[0])
}

const WORKBENCH_JS = read('apps', 'mobile', 'src', 'workbench.js')
const MOBILE_JS = ['boot.js', 'home.js', 'nav.js', 'presence.js', 'workbench.js'].map(f => ({ f, src: read('apps', 'mobile', 'src', f) }))

describe('手机网页调的路由 = 这里登记了码的路由', () => {
  it('link-routes 扫描器从组装好的 /m 页里扫出来的,正好是 ROUTE_CODES 那六条 + 跳页', () => {
    // 内联的协议包(压缩过的 noble)不是页面逻辑,同 link-routes-from-source 的做法先拿掉
    const page = assembleMobilePage(readMobileSource).phone.split(read('apps', 'mobile', 'src', 'protocol-generated.js')).join('')
    const called = uniq(scanSource('phone /m', page, PHONE_ROUTES).calls.map(c => c.key))
    expect(called).toEqual(uniq([...Object.keys(ROUTE_CODES), ...NAVIGATIONS]))
  })
})

describe('ROUTE_CODES 对得上处理器源码', () => {
  it.each(Object.keys(ROUTE_CODES))('%s', key => {
    const r = ROUTE_CODES[key]!
    const text = r.slices.map(slice).join('\n')
    expect(uniq([...text.matchAll(DIRECT_RE)].map(m => m[1]!)).filter(c => !r.direct.includes(c)), '处理器新回的码:加进 direct').toEqual([])
    expect(uniq([...text.matchAll(THROWN_RE)].map(m => m[1]!)).filter(c => !(r.thrown ?? []).includes(c)), '新抛的码:加进 thrown').toEqual([])
    for (const code of [...r.direct, ...(r.thrown ?? [])]) expect(text, `${code} 在处理器里已经不出现了:从 ROUTE_CODES 删掉`).toContain(`'${code}'`)
  })
  it('分派之前的那两个码', () => {
    const text = COMMON.slices.map(slice).join('\n')
    for (const code of COMMON.codes) expect(text, code).toContain(`'${code}'`)
  })
})

describe('网页的码表 × 路由会回的码', () => {
  const maps = Object.fromEntries(Object.keys(WEB_MAPS).map(name => [name, webMapKeys(WORKBENCH_JS, name)]))
  const mapOf = (key: string) => Object.entries(WEB_MAPS).find(([, routes]) => routes.includes(key))?.[0]

  it.each(Object.keys(WEB_MAPS))('%s 里每个码都是它那几条路由真会回的(没有死条目)', name => {
    const can = new Set(WEB_MAPS[name]!.flatMap(returnable))
    expect(maps[name]!.length).toBeGreaterThan(0)
    expect(maps[name]!.filter(code => !can.has(code))).toEqual([])
  })
  it.each(Object.keys(ROUTE_CODES))('%s 会回的码:要么在网页的表里、要么在 GENERIC;GENERIC 不留多余的', key => {
    const mapped = new Set(mapOf(key) ? maps[mapOf(key)!]! : [])
    const generic = GENERIC[key] ?? []
    const out = returnable(key)
    expect(out.filter(code => !mapped.has(code) && !generic.includes(code)), '在网页的表里给一句,或加进 GENERIC').toEqual([])
    expect(generic.filter(code => !out.includes(code)), '路由已经不回了:从 GENERIC 删掉').toEqual([])
    expect(generic.filter(code => mapped.has(code)), '既在表里又在 GENERIC').toEqual([])
  })
  it('码表真的被用上了(mError 读 M_ERRORS,停下读 M_STOP_ERRORS)', () => {
    expect(WORKBENCH_JS).toMatch(/function mError\(code\)\s*\{\s*return mText\(M_ERRORS,/)
    expect(WORKBENCH_JS).toContain('mText(M_STOP_ERRORS,')
  })
  it('网页里没有表外的零散比较', () => {
    expect(MOBILE_JS.flatMap(({ f, src }) => strayComparisons(src).map(s => `${f}: ${s}`))).toEqual([])
  })
})

describe('守卫自己的读法', () => {
  it('码表:找不到 / 值不是字符串 ⇒ 报错;正常读出键', () => {
    expect(() => webMapKeys('var X = {}', 'M_ERRORS')).toThrow(/找不到/)
    expect(() => webMapKeys('var M_ERRORS = { a_b: f() }', 'M_ERRORS')).toThrow(/不是「码: 字符串」/)
    expect(webMapKeys('var M_ERRORS = { a_b: "x", "c_d": \'y\' }', 'M_ERRORS')).toEqual(['a_b', 'c_d'])
  })
  it('零散比较:认得 b.error / e.message / code,放过 d.task.error 与 r.status', () => {
    expect(strayComparisons("if(b.error==='input_stale')x;if(e.message === \"timeout\")y;if (code === 'not_found') z")).toHaveLength(3)
    expect(strayComparisons("if(d.task.error==='execution_model_unsupported')x;if(r.status===401)y")).toEqual([])
  })
  it('切片:标记找不到 ⇒ 报错', () => {
    expect(() => slice({ file: SP, from: 'no such marker', to: NEXT_ROUTE })).toThrow(/找不到/)
  })
})
