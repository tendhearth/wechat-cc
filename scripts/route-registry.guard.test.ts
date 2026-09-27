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

function rustAllowed(): Set<string> {
  const src = read('apps', 'desktop', 'src-tauri', 'src', 'lib.rs')
  const start = src.indexOf('fn workbench_request_allowed')
  const end = src.indexOf('\n}\n', start)
  const body = src.slice(start, end)
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

  it('三份都真的抓到了东西(正则没抓空 = 守卫沉默,比误报危险)', () => {
    expect(rust.size).toBeGreaterThanOrEqual(30)
    expect(proxy.size).toBeGreaterThanOrEqual(25)
    expect(op.size).toBeGreaterThanOrEqual(40)
  })

  it('lib.rs 放行的每一条,dev 代理也放行(打包版能调的,浏览器预览也得能调)', () => {
    // matter 四条与 workbench 走的是同一个 Rust 命令,但 dev 代理只管 /v1/workbench*:
    // 它们经 test-shim 另一条路,不在 workbench-proxy.ROUTES 里。这是已知形状,不是漏登记。
    const onlyRust = diff(rust, proxy).filter(k => !k.includes('/v1/matter'))
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
