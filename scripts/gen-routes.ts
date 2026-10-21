/**
 * `bun run gen:routes` —— 从路由表(`packages/protocol/src/routes.ts`)生成桌面宿主的白名单
 * `apps/desktop/src-tauri/generated/workbench-routes.json`(重构第二批 5a)。
 *
 * - `tauri`:lib.rs 的 workbench_request_allowed 放行的 `"METHOD /path"`(include_str! 编进 .app)。
 * - `devProxy`:apps/desktop/workbench-proxy.ts(浏览器预览的 dev 代理)放行的。
 * - `version`:名单内容的版本。两份名单和上一次生成的一样 ⇒ 不动;变了 ⇒ 加一。sidecar 能单独换
 *   (`self deploy`),lib.rs 编在 .app 里,第 5c 步拿它判断「桌面白名单比 sidecar 老」。
 *
 * 生成物进仓库;`scripts/route-registry.guard.test.ts` 重新生成一遍和仓库里的比,不一致就红。
 * `--check`:只比不写,不一致退出 1。`apps/desktop/scripts/build-sidecar.ts`(tauri build 的
 * beforeBuildCommand)也会调一次,保证打出来的包和表一致。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTES } from '../packages/protocol/src/routes'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const WORKBENCH_ROUTES_JSON = join(ROOT, 'apps', 'desktop', 'src-tauri', 'generated', 'workbench-routes.json')

export interface WorkbenchRoutesFile {
  _comment: string
  version: number
  tauri: string[]
  devProxy: string[]
}

const COMMENT = '生成物,别手改:改 packages/protocol/src/routes.ts 后跑 bun run gen:routes'

const sameList = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i])

/** 按表算出生成物的文本;`previous` 是仓库里现有的那份(没有就当第一次生成)。纯函数,守卫测试也用它。 */
export function renderWorkbenchRoutes(previous?: string): string {
  const rows = Object.entries(ROUTES).flatMap(([key, r]) => (r.desktop ? [{ key, d: r.desktop }] : []))
  const tauri = rows.filter(r => r.d.tauri).map(r => r.key).sort()
  const devProxy = rows.filter(r => r.d.devProxy).map(r => r.key).sort()
  let prev: Partial<WorkbenchRoutesFile> = {}
  try { if (previous) prev = JSON.parse(previous) } catch { prev = {} }
  const prevVersion = typeof prev.version === 'number' ? prev.version : 0
  const unchanged = prevVersion > 0 && sameList(prev.tauri, tauri) && sameList(prev.devProxy, devProxy)
  const out: WorkbenchRoutesFile = { _comment: COMMENT, version: unchanged ? prevVersion : prevVersion + 1, tauri, devProxy }
  return JSON.stringify(out, null, 2) + '\n'
}

/** 写盘(内容没变就不碰文件);返回是否改了。 */
export function writeWorkbenchRoutes(path = WORKBENCH_ROUTES_JSON): boolean {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  const next = renderWorkbenchRoutes(previous)
  if (next === previous) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, next)
  return true
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const previous = existsSync(WORKBENCH_ROUTES_JSON) ? readFileSync(WORKBENCH_ROUTES_JSON, 'utf8') : undefined
    if (renderWorkbenchRoutes(previous) !== previous) {
      console.error(`${WORKBENCH_ROUTES_JSON} 和路由表不一致:跑 bun run gen:routes`)
      process.exit(1)
    }
    console.log('workbench-routes.json 与路由表一致')
  } else {
    console.log(writeWorkbenchRoutes() ? `已更新 ${WORKBENCH_ROUTES_JSON}` : 'workbench-routes.json 已是最新')
  }
}
