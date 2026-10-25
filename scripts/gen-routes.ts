/**
 * `bun run gen:routes` —— 从路由表(`packages/protocol/src/routes.ts`)生成桌面宿主的白名单
 * `apps/desktop/src-tauri/generated/workbench-routes.json`(重构第二批 5a)。
 *
 * - `tauri`:lib.rs 的 workbench_request_allowed 放行的 `"METHOD /path"`(include_str! 编进 .app)。
 * - `devProxy`:apps/desktop/workbench-proxy.ts(浏览器预览的 dev 代理)放行的。
 * - `ownerWorkspace`:主人工作区(待办、记下的想法)走 lib.rs 的 daemon_request 宿主命令(主人工作区那一半);同一份名单
 *   test-shim.ts 直接 import,api.js(webview 里引不到这份文件)由守卫对着它核对。
 * - `version`:名单内容的版本。三份名单和上一次生成的一样 ⇒ 不动;变了 ⇒ 加一。
 *   上一份还没有 `ownerWorkspace`(2026-10-21 之前生成的)时这份名单不参与比较:它的内容就是当时 lib.rs
 *   手写的那六条,编进 .app 的放行范围没变,不该因为挪了个地方就加版本。sidecar 能单独换
 *   (`self deploy`),lib.rs 编在 .app 里,第 5c 步拿它判断「桌面白名单比 sidecar 老」。
 *
 * 另外写 `apps/desktop/src/generated/daemon-calls.js`(架构终态 F5):桌面类型化客户端的表
 * (`packages/protocol/src/desktop-calls.ts` 的 `DESKTOP_CALLS`,`命名空间.方法 → 路由键`)和主人工作区的路径名单。
 * webview 只加载 apps/desktop/src 里的文件、引不到协议包,所以写成纯数据的 ES 模块;拼请求的是 `src/daemon-client.js`。
 *
 * 生成物进仓库;`scripts/route-registry.guard.test.ts` 重新生成一遍和仓库里的比,不一致就红。
 * `--check`:只比不写,不一致退出 1。`apps/desktop/scripts/build-sidecar.ts`(tauri build 的
 * beforeBuildCommand)也会调一次,保证打出来的包和表一致。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTES } from '../packages/protocol/src/routes'
import { DESKTOP_CALLS } from '../packages/protocol/src/desktop-calls'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const WORKBENCH_ROUTES_JSON = join(ROOT, 'apps', 'desktop', 'src-tauri', 'generated', 'workbench-routes.json')
export const DAEMON_CALLS_JS = join(ROOT, 'apps', 'desktop', 'src', 'generated', 'daemon-calls.js')

export interface WorkbenchRoutesFile {
  _comment: string
  version: number
  tauri: string[]
  devProxy: string[]
  ownerWorkspace: string[]
}

const COMMENT = '生成物,别手改:改 packages/protocol/src/routes.ts 后跑 bun run gen:routes'

const sameList = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i])

/** 按表算出生成物的文本;`previous` 是仓库里现有的那份(没有就当第一次生成)。纯函数,守卫测试也用它。 */
export function renderWorkbenchRoutes(previous?: string): string {
  const rows = Object.entries(ROUTES).flatMap(([key, r]) => (r.desktop ? [{ key, d: r.desktop }] : []))
  const tauri = rows.filter(r => r.d.tauri).map(r => r.key).sort()
  const devProxy = rows.filter(r => r.d.devProxy).map(r => r.key).sort()
  const ownerWorkspace = rows.filter(r => r.d.ownerWorkspace).map(r => r.key).sort()
  let prev: Partial<WorkbenchRoutesFile> = {}
  try { if (previous) prev = JSON.parse(previous) } catch { prev = {} }
  const prevVersion = typeof prev.version === 'number' ? prev.version : 0
  const unchanged = prevVersion > 0 && sameList(prev.tauri, tauri) && sameList(prev.devProxy, devProxy)
    && (prev.ownerWorkspace === undefined || sameList(prev.ownerWorkspace, ownerWorkspace))
  const out: WorkbenchRoutesFile = { _comment: COMMENT, version: unchanged ? prevVersion : prevVersion + 1, tauri, devProxy, ownerWorkspace }
  return JSON.stringify(out, null, 2) + '\n'
}

/** 桌面类型化客户端的表(纯数据 ES 模块)。纯函数,守卫测试也用它。 */
export function renderDaemonCalls(): string {
  const table: Record<string, Record<string, string>> = {}
  for (const [ns, methods] of Object.entries(DESKTOP_CALLS)) {
    table[ns] = {}
    for (const [m, spec] of Object.entries(methods as Record<string, { key: string }>)) table[ns]![m] = spec.key
  }
  const keys = [...new Set(Object.values(table).flatMap(o => Object.values(o)))].sort()
  const ownerPaths = Object.entries(ROUTES).filter(([, r]) => r.desktop?.ownerWorkspace).map(([k]) => k.slice(k.indexOf(' ') + 1)).sort()
  return [
    '// @ts-check',
    `// ${COMMENT}(表在 packages/protocol/src/desktop-calls.ts)`,
    '// 桌面类型化客户端的表(架构终态 F5):命名空间.方法 → 路由键。拼请求、送出去见 ../daemon-client.js。',
    '',
    `/** @typedef {${keys.map(k => JSON.stringify(k)).join(' | ')}} V1Key */`,
    '',
    `export const V1 = /** @type {const} */ (${JSON.stringify(table, null, 2)})`,
    '',
    '/** 主人工作区(路由表里 `desktop.ownerWorkspace` 的行)的路径:打包版交给宿主代理,webview 不拿那份凭据。 */',
    `export const OWNER_WORKSPACE_PATHS = /** @type {const} */ (${JSON.stringify(ownerPaths, null, 2)})`,
    '',
  ].join('\n')
}

/** 写盘(内容没变就不碰文件);返回是否改了。两份生成物一起写。 */
export function writeWorkbenchRoutes(path = WORKBENCH_ROUTES_JSON): boolean {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  const next = renderWorkbenchRoutes(previous)
  let changed = false
  if (next !== previous) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, next)
    changed = true
  }
  if (path === WORKBENCH_ROUTES_JSON) {
    const prevCalls = existsSync(DAEMON_CALLS_JS) ? readFileSync(DAEMON_CALLS_JS, 'utf8') : undefined
    const calls = renderDaemonCalls()
    if (calls !== prevCalls) {
      mkdirSync(dirname(DAEMON_CALLS_JS), { recursive: true })
      writeFileSync(DAEMON_CALLS_JS, calls)
      changed = true
    }
  }
  return changed
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const previous = existsSync(WORKBENCH_ROUTES_JSON) ? readFileSync(WORKBENCH_ROUTES_JSON, 'utf8') : undefined
    const calls = existsSync(DAEMON_CALLS_JS) ? readFileSync(DAEMON_CALLS_JS, 'utf8') : undefined
    if (renderWorkbenchRoutes(previous) !== previous || renderDaemonCalls() !== calls) {
      console.error(`${WORKBENCH_ROUTES_JSON} / ${DAEMON_CALLS_JS} 和路由表不一致:跑 bun run gen:routes`)
      process.exit(1)
    }
    console.log('workbench-routes.json、daemon-calls.js 与路由表一致')
  } else {
    console.log(writeWorkbenchRoutes() ? '已按路由表更新生成物' : 'workbench-routes.json、daemon-calls.js 已是最新')
  }
}
