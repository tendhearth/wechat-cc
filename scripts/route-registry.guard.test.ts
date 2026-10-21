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
 * 4. 主人工作区(待办、记下的想法)那份名单(2026-10-21 架构复查 1-②):以前 lib.rs、api.js、test-shim.ts
 *    各手写一份、没人核对;现在表里 `desktop.ownerWorkspace` 是唯一声明,lib.rs / test-shim.ts 读生成物,
 *    api.js(webview 引不到生成物)照抄一份路径、这里核对相等。
 *
 * 逐条行为没变由 `routes-snapshot.guard.test.ts` 对着改造前的快照证明;ownerWorkspace 那份对着下面
 * FORMER_OWNER_WORKSPACE(改造前三处手写名单的原样)证明。
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
const generated = JSON.parse(GENERATED) as { version: number; tauri: string[]; devProxy: string[]; ownerWorkspace: string[] }

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
    expect(JSON.parse(renderWorkbenchRoutes(JSON.stringify({ ...generated, ownerWorkspace: generated.ownerWorkspace.slice(1) }))).version).toBe(generated.version + 1)
    expect(JSON.parse(renderWorkbenchRoutes(GENERATED)).version).toBe(generated.version)
  })
  it('上一份还没有 ownerWorkspace(10-21 之前生成的)⇒ 补上这份名单不加版本(放行范围没变,只是挪了地方)', () => {
    const { ownerWorkspace: _, ...before } = generated
    const next = JSON.parse(renderWorkbenchRoutes(JSON.stringify(before)))
    expect(next.version).toBe(generated.version)
    expect(next.ownerWorkspace).toEqual(generated.ownerWorkspace)
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

/** 改造前(origin/dev a2227987)三处手写的名单,原样照抄:lib.rs 的 OWNER_WORKSPACE_ROUTES、api.js 的 OWNER_WORKSPACE_PATHS
 *  (这两份是同一组路径,方法不限 GET / POST)、test-shim.ts 的 TODOS_PROXY_ROUTES(只收 POST)+ 本进程答的 GET /v1/companion/thoughts。 */
const FORMER_OWNER_WORKSPACE = {
  paths: ['/v1/knowledge/facts/find_facts', '/v1/llm/keys', '/v1/companion/thoughts', '/v1/knowledge/facts/set_fact_status', '/v1/knowledge/graph/top_contacts', '/v1/reminders/schedule'],
  shimPost: ['/v1/knowledge/facts/find_facts', '/v1/llm/keys', '/v1/knowledge/facts/set_fact_status', '/v1/knowledge/graph/top_contacts', '/v1/reminders/schedule'],
  shimGet: ['/v1/companion/thoughts'],
}
const pathOf = (key: string) => key.slice(key.indexOf(' ') + 1)

/** api.js 里那份照抄:`export const OWNER_WORKSPACE_PATHS = new Set([ '…', … ])`。写法变了找不到 ⇒ 红。 */
function apiJsOwnerWorkspacePaths(src: string): string[] {
  const m = src.match(/export const OWNER_WORKSPACE_PATHS = new Set\(\[([^\]]*)\]\)/)
  if (!m) throw new Error('api.js 里找不到 export const OWNER_WORKSPACE_PATHS = new Set([...])')
  const body = m[1]!.replace(/\/\/[^\n]*/g, '')
  const items = [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map(x => x[1] ?? x[2]!)
  if (body.replace(/'[^']*'|"[^"]*"|[\s,]/g, '') !== '') throw new Error('api.js 的 OWNER_WORKSPACE_PATHS 里除了字符串字面量还有别的东西,守卫读不懂')
  return items
}

describe('主人工作区名单(desktop.ownerWorkspace)只在路由表里声明一次', () => {
  const owner = desktopRows.filter(r => r.d.ownerWorkspace)
  const API_JS = read('apps', 'desktop', 'src', 'api.js')
  const SHIM = read('apps', 'desktop', 'test-shim.ts')

  it('生成物里的 ownerWorkspace = 表里打了 ownerWorkspace 的行', () => {
    expect(generated.ownerWorkspace).toEqual(owner.map(r => r.key).sort())
  })
  it('和改造前三处手写的名单逐条相同(lib.rs / api.js 的路径;test-shim 的 POST 与 GET)', () => {
    const paths = generated.ownerWorkspace.map(pathOf)
    expect(new Set(paths).size).toBe(paths.length)
    expect([...paths].sort()).toEqual([...FORMER_OWNER_WORKSPACE.paths].sort())
    expect(generated.ownerWorkspace.filter(k => k.startsWith('POST ')).map(pathOf).sort()).toEqual([...FORMER_OWNER_WORKSPACE.shimPost].sort())
    expect(generated.ownerWorkspace.filter(k => k.startsWith('GET ')).map(pathOf).sort()).toEqual([...FORMER_OWNER_WORKSPACE.shimGet].sort())
  })
  it('表内约束:有 operator(宿主拿的是 operator 凭据)、不同时 tauri(一条路由只走一个宿主命令)、方法只有 GET / POST', () => {
    expect(owner.length).toBeGreaterThanOrEqual(1)
    for (const { key, d } of owner) {
      expect(d.tokens ?? [], key).toContain('operator')
      expect(d.tauri, key).toBeUndefined()
      expect(key, key).toMatch(/^(GET|POST) \//)
    }
  })
  it('lib.rs 从生成物读 ownerWorkspace,customer_review_api 里没有手写的 "/v1/…"', () => {
    expect(fnBody(LIB_RS, 'fn owner_workspace_routes')).toContain('"ownerWorkspace"')
    const body = fnBody(LIB_RS, 'async fn customer_review_api')
    expect(body).toContain('owner_workspace_request_check(')
    expect(body.match(/"\/v1\//g) ?? []).toEqual([])
    expect(LIB_RS).not.toMatch(/const OWNER_WORKSPACE_ROUTES/)
  })
  it('api.js 的 OWNER_WORKSPACE_PATHS(webview 引不到生成物,照抄)= 生成物的路径', () => {
    expect(apiJsOwnerWorkspacePaths(API_JS).sort()).toEqual(generated.ownerWorkspace.map(pathOf).sort())
  })
  it('test-shim.ts 读生成物:POST 那几条从 ownerWorkspace 推出来,GET 的每一条本进程都有处理器,没有手写名单', () => {
    expect(SHIM).toContain("import WORKBENCH_ROUTES from './src-tauri/generated/workbench-routes.json'")
    expect(SHIM).toContain('WORKBENCH_ROUTES.ownerWorkspace.filter(')
    expect(SHIM).toContain('OWNER_WORKSPACE_POST_PATHS.has(url.pathname)')
    for (const key of generated.ownerWorkspace.filter(k => k.startsWith('GET '))) {
      expect(SHIM, key).toContain(`url.pathname === '${pathOf(key)}' && req.method === 'GET'`)
    }
    // POST 的路径不再以字面量出现在 shim 里(只剩 playwright 那边的拦截,不在这个文件)
    for (const key of generated.ownerWorkspace.filter(k => k.startsWith('POST '))) expect(SHIM, key).not.toContain(`'${pathOf(key)}'`)
  })
  it('api.js 读法自己的失败方式:找不到 / 混进非字面量 ⇒ 报错,不静默当空', () => {
    expect(() => apiJsOwnerWorkspacePaths('const X = 1')).toThrow(/找不到/)
    expect(() => apiJsOwnerWorkspacePaths("export const OWNER_WORKSPACE_PATHS = new Set(['/v1/a', SOME_VAR])")).toThrow(/读不懂/)
    expect(apiJsOwnerWorkspacePaths("export const OWNER_WORKSPACE_PATHS = new Set([\n  '/v1/a', // x\n  \"/v1/b\",\n])")).toEqual(['/v1/a', '/v1/b'])
  })
})
