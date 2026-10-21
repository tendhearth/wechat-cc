/**
 * 路由白名单的**接缝守卫**(2026-09-27 梳理第 3 步;2026-10-20 重构第二批 5a 改写)。
 *
 * 以前桌面能调的一条路由要手抄在四五处(route-tiers / operator routeAllow / workbench-proxy.ts /
 * lib.rs),这条测试解析源码比对四份名单的包含关系。5a 起它们都从路由表
 * `packages/protocol/src/routes.ts` 推出来,于是这里改成钉三件事:
 *
 * 1. 生成物 `apps/desktop/src-tauri/generated/workbench-routes.json` 和表一致(重新生成一遍比字节)。
 * 2. lib.rs 与 workbench-proxy.ts 真的读那份生成物,没有再手写一份名单。
 * 3. 表内的约束 —— 就是原来四份名单之间的包含关系:devProxy ⇒ tauri(matter 那几条只走 tauri)、
 *    tauri ⇒ operator(宿主代理拿的是 operator 凭据)、每条桌面路由都有已知档位。
 *
 * 逐条行为没变由 `routes-snapshot.guard.test.ts` 对着改造前的快照证明。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTES } from '../packages/protocol/src/routes'
import { renderWorkbenchRoutes, WORKBENCH_ROUTES_JSON } from './gen-routes'
import { makeTokenRegistry } from '../src/daemon/internal-api/token-registry'
import { ROUTE_MIN_TIER, TIER_RANK } from '../src/daemon/internal-api/route-tiers'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

const LIB_RS = read('apps', 'desktop', 'src-tauri', 'src', 'lib.rs')
const GENERATED = readFileSync(WORKBENCH_ROUTES_JSON, 'utf8')
const generated = JSON.parse(GENERATED) as { version: number; tauri: string[]; devProxy: string[] }

/** 从 `name` 之后的第一个 `{` 起按花括号配对截函数体(不靠行尾,CRLF 安全)。 */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(name)
  if (start < 0) throw new Error(`lib.rs 里找不到 ${name}`)
  const open = src.indexOf('{', start)
  let depth = 0, end = open
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++
    else if (src[end] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(open, end + 1)
}

const desktopRows = Object.entries(ROUTES).flatMap(([key, r]) => (r.desktop ? [{ key, d: r.desktop }] : []))
const diff = (a: Iterable<string>, b: ReadonlySet<string>) => [...a].filter(k => !b.has(k)).sort()

describe('桌面白名单生成物与路由表一致', () => {
  it('workbench-routes.json 是最新的(否则跑 bun run gen:routes)', () => {
    expect(renderWorkbenchRoutes(GENERATED), '跑 bun run gen:routes 再提交').toBe(GENERATED)
  })
  it('CRLF 检出下也算一致(Windows 的 git autocrlf 会把生成物改成 CRLF)', () => {
    const crlf = GENERATED.replace(/\r?\n/g, '\r\n')
    expect(JSON.parse(crlf)).toEqual(generated)
  })
  it('带 version,且两份名单都抓到了东西(抓空 = 守卫沉默)', () => {
    expect(Number.isInteger(generated.version) && generated.version >= 1).toBe(true)
    expect(generated.tauri.length).toBeGreaterThanOrEqual(30)
    expect(generated.devProxy.length).toBeGreaterThanOrEqual(25)
  })
  it('名单内容变了 ⇒ version 加一;没变 ⇒ version 不动', () => {
    const bumped = JSON.parse(renderWorkbenchRoutes(JSON.stringify({ ...generated, tauri: generated.tauri.slice(1) })))
    expect(bumped.version).toBe(generated.version + 1)
    expect(JSON.parse(renderWorkbenchRoutes(GENERATED)).version).toBe(generated.version)
  })
})

describe('lib.rs 与 workbench-proxy.ts 读的是生成物,不再手写名单', () => {
  it('lib.rs include_str! 那份 JSON,workbench_request_allowed 里没有手写的 ("GET", "/v1/…") 元组', () => {
    expect(LIB_RS).toContain('include_str!("../generated/workbench-routes.json")')
    const body = fnBody(LIB_RS, 'fn workbench_request_allowed')
    expect(body.match(/\(\s*"(GET|POST)"\s*,\s*"\/v1\//g) ?? []).toEqual([])
    expect(body).toContain('workbench_routes()')
  })
  it('lib.rs 测试里「应放行」的每一条都在生成的 tauri 名单里(不跑 cargo 也能对上)', () => {
    const tests = LIB_RS.slice(LIB_RS.indexOf('fn allows_only_the_exact_workbench_method_route_pairs'))
    const allowedBlock = tests.slice(0, tests.indexOf('to be allowed'))
    const tuples = [...allowedBlock.matchAll(/\(\s*"(GET|POST)"\s*,\s*"(\/v1\/[^"?]+)(?:\?[^"]*)?"\s*\)/g)].map(m => `${m[1]} ${m[2]}`)
    expect(tuples.length).toBeGreaterThanOrEqual(30)
    expect(diff(tuples, new Set(generated.tauri))).toEqual([])
  })
  it('workbench-proxy.ts import 生成物、ROUTES 取 devProxy', () => {
    const src = read('apps', 'desktop', 'workbench-proxy.ts')
    expect(src).toContain("from './src-tauri/generated/workbench-routes.json'")
    expect(src).toContain('new Set(WORKBENCH_ROUTES.devProxy)')
    expect(src.match(/'(GET|POST) \/v1\//g) ?? []).toEqual([])
  })
})

describe('路由表内的约束(原来四份名单之间的包含关系)', () => {
  const tauri = new Set(desktopRows.filter(r => r.d.tauri).map(r => r.key))
  const dev = new Set(desktopRows.filter(r => r.d.devProxy).map(r => r.key))
  const reg = makeTokenRegistry(() => 'deadbeef'.repeat(8))
  reg.registerOperatorToken('op')
  const op = new Set(reg.resolve('op')!.routeAllow!)

  it('dev 代理放行的每一条,打包版也放行(别让功能只在浏览器预览里能用)', () => {
    expect(diff(dev, tauri)).toEqual([])
  })
  it('打包版放行而 dev 代理不放行的,只有 matter 那几条(它们经 test-shim 另一条路)', () => {
    expect(diff(tauri, dev).filter(k => !k.includes('/v1/matter'))).toEqual([])
  })
  it('打包版放行的每一条,operator token 的 routeAllow 都有(否则 daemon 侧 403 route_not_allowed)', () => {
    expect(diff(tauri, op)).toEqual([])
  })
  it('routeAllow 里的每一条都在 ROUTE_MIN_TIER 登记过', () => {
    expect(diff(op, new Set(Object.keys(ROUTE_MIN_TIER)))).toEqual([])
  })
  it('每条桌面路由的档位都认识;键都是 "METHOD /v1/…"', () => {
    for (const { key, d } of desktopRows) {
      expect(d.tier in TIER_RANK, `${key}: ${d.tier}`).toBe(true)
      expect(key, key).toMatch(/^(GET|POST) \/v1\//)
    }
  })
  it('手机 / 设置页的行:路径归对端,link 为 read 必是 GET、write 必是 POST,且都带理由', () => {
    for (const [key, r] of Object.entries(ROUTES)) {
      if (r.phone) expect(key, key).toMatch(/^(GET|POST) \/m(\/|$)/)
      if (r.set) expect(key, key).toMatch(/^(GET|POST) \/set(\/|$)/)
      const panel = r.phone ?? r.set
      if (!panel) continue
      expect([r.desktop, r.phone, r.set].filter(Boolean).length, key).toBe(1)
      if (panel.link === 'read') expect(key.startsWith('GET '), key).toBe(true)
      if (panel.link === 'write') expect(key.startsWith('POST '), key).toBe(true)
      if (panel.link !== 'none') expect((panel.reason ?? '').length, key).toBeGreaterThan(4)
      else expect(panel.reason, key).toBeUndefined()
    }
  })
})
