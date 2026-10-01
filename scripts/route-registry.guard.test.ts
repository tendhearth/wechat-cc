/**
 * 路由白名单的**接缝守卫**(2026-09-27,梳理第 3 步)。
 *
 * 桌面能调的一条内部 API 路由要登记在四处:route-tiers(tier)→ token-registry 的
 * operator routeAllow → apps/desktop/workbench-proxy.ts(dev 代理)→ src-tauri lib.rs
 * 的 workbench_request_allowed(打包版代理)。此前四份各自手抄、各自有测试,但没有
 * 一条测试比对它们 —— 漏一处的症状是「只在打包版出现的 403 route_not_allowed」。
 * 这里钉住包含关系:lib.rs ⊆ proxy ⊆ routeAllow ⊆ ROUTE_MIN_TIER。
 *
 * 这些断言不测逻辑,测的是「四份名单还对得上」。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTE_MIN_TIER } from '../src/daemon/internal-api/route-tiers'
import { makeTokenRegistry } from '../src/daemon/internal-api/token-registry'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

const LIB_RS = read('apps', 'desktop', 'src-tauri', 'src', 'lib.rs')

/**
 * 只取 `fn workbench_request_allowed` 的函数体:从签名后的第一个 `{` 起按花括号配对
 * 截到对应的 `}`。不用行尾当边界(CRLF 下 `\n}\n` 找不到,会一路切到文件末尾把
 * `mod tests` 里的用例元组也抓进来 —— 2026-09-27 CI windows 就是这么红的),也不依赖
 * 函数定义在 `mod tests` 之前。
 */
function rustAllowed(src: string = LIB_RS): Set<string> {
  const start = src.indexOf('fn workbench_request_allowed')
  if (start < 0) throw new Error('lib.rs 里找不到 fn workbench_request_allowed')
  const open = src.indexOf('{', start)
  let depth = 0, end = open
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++
    else if (src[end] === '}') { depth--; if (depth === 0) break }
  }
  const body = src.slice(open, end + 1)
  const out = new Set<string>()
  for (const m of body.matchAll(/\(\s*"(GET|POST)"\s*,\s*"(\/v1\/[^"]+)"\s*\)/g)) out.add(`${m[1]} ${m[2]}`)
  return out
}

function proxyAllowed(): Set<string> {
  const src = read('apps', 'desktop', 'workbench-proxy.ts')
  const start = src.indexOf('const ROUTES = new Set([')
  const end = src.indexOf('])', start)
  const out = new Set<string>()
  for (const m of src.slice(start, end).matchAll(/'((?:GET|POST) \/v1\/[^']+)'/g)) out.add(m[1]!)
  return out
}

function operatorAllowed(): Set<string> {
  const reg = makeTokenRegistry(() => 'deadbeef'.repeat(8))
  reg.registerOperatorToken('op')
  return new Set(reg.resolve('op')!.routeAllow!)
}

const diff = (a: Set<string>, b: Set<string>) => [...a].filter(k => !b.has(k)).sort()

describe('桌面可达路由四份白名单对得上', () => {
  const rust = rustAllowed(), proxy = proxyAllowed(), op = operatorAllowed()

  it('lib.rs 的解析只取 workbench_request_allowed 的 matches! 块,不受行尾影响(2026-09-27 CI windows:CRLF 让 \\n}\\n 找不到,整段 mod tests 的用例元组被当成白名单)', () => {
    const crlf = rustAllowed(LIB_RS.replace(/\r?\n/g, '\r\n'))
    expect([...crlf].sort()).toEqual([...rust].sort())
    // 测试模块里的用例长这样:/v1/workbench/../companion/presence、?id=、/extra —— 白名单里绝不该有
    for (const k of rust) expect(k, k).not.toMatch(/\.\.|\?|\/extra$|\/$/)
  })

  it('三份都真的抓到了东西(正则没抓空 = 守卫沉默,比误报危险)', () => {
    expect(rust.size).toBeGreaterThanOrEqual(30)
    expect(proxy.size).toBeGreaterThanOrEqual(25)
    expect(op.size).toBeGreaterThanOrEqual(40)
  })

  it('lib.rs 放行的每一条,dev 代理也放行(打包版能调的,浏览器预览也得能调)', () => {
    // matter 四条与 workbench 走的是同一个 Rust 命令,但 dev 代理只管 /v1/workbench*:
    // 它们经 test-shim 另一条路,不在 workbench-proxy.ROUTES 里。这是已知形状,不是漏登记。
    // GET /v1/connections(此刻的连接浮层,2026-10-01)同理:test-shim 有自己的演示路由。
    const onlyRust = diff(rust, proxy).filter(k => !k.includes('/v1/matter') && k !== 'GET /v1/connections')
    expect(onlyRust, '在 lib.rs 里但不在 apps/desktop/workbench-proxy.ts:ROUTES').toEqual([])
  })

  it('dev 代理放行的每一条,lib.rs 也放行(别让功能只在浏览器预览里能用)', () => {
    expect(diff(proxy, rust), '在 workbench-proxy.ts 里但不在 lib.rs workbench_request_allowed').toEqual([])
  })

  it('lib.rs 放行的每一条,operator token 的 routeAllow 都有(否则 daemon 侧 403 route_not_allowed)', () => {
    expect(diff(rust, op), '在 lib.rs 里但不在 token-registry.ts routeAllow').toEqual([])
  })

  it('routeAllow 里的每一条都在 ROUTE_MIN_TIER 登记过(没登记 = admin,operator 恰好是 admin,所以此前静默)', () => {
    expect(diff(op, new Set(Object.keys(ROUTE_MIN_TIER))), '在 routeAllow 里但 route-tiers.ts 没登记').toEqual([])
  })
})
