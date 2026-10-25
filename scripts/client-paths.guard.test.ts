/**
 * 三端客户端里手写的路径都在路由表里(架构终态 F5 之前的一道闸)。
 *
 * 桌面(apps/desktop/src,纯 JS)、App(apps/app/src)、网页(apps/mobile/src)今天还是手写 '/v1/…'、'/m/api/…'、'/set/api/…'
 * 字符串去调 daemon。路由表(packages/protocol/src/routes.ts)改了名、删了一条,客户端那边不会有任何编译错 ——
 * 这里逐个文件扫:每一条手写路径都要是表里某条路由的路径,或者是它的前缀(模板字符串 `/v1/x/${id}` 只扫得到前缀)。
 * 等三端换成从契约生成的客户端,这道闸就没东西可扫了。
 *
 * App 已经换完(架构终态 F3):`apps/app/src` 里(测试除外)**一条**手写的 `/m/api`、`/set/api` 字符串都不许有 ——
 * 路径从协议包的类型化客户端(`packages/protocol/src/phone-calls.ts` 的 `PHONE_CALLS`)拿。
 * 注释里不带引号的路径不算(扫的是引号起头的字面量)。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTES } from '@wechat-cc/protocol/routes'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATHS = Object.keys(ROUTES).map(k => k.slice(k.indexOf(' ') + 1))
const known = (p: string) => PATHS.includes(p) || PATHS.some(q => q.startsWith(p))

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, exts, out)
    else if (exts.some(e => name.endsWith(e)) && !/\.test\.[jt]sx?$/.test(name)) out.push(p)
  }
  return out
}

const PANEL_PATH = /['"`](\/(?:m|set)\/api\/[A-Za-z0-9_/-]*)/g
const CLIENTS: Array<[string, string[], RegExp]> = [
  ['apps/desktop/src', ['.js', '.ts'], /['"`](\/v1\/[A-Za-z0-9_/-]+)/g],
  ['apps/mobile/src', ['.js', '.ts'], PANEL_PATH],
]
/** 已经换成类型化客户端、不许再有手写路径的客户端。 */
const TYPED_CLIENTS: Array<[string, string[], RegExp]> = [
  ['apps/app/src', ['.ts', '.tsx'], PANEL_PATH],
]

describe('客户端手写的路径都在路由表里', () => {
  for (const [dir, exts, re] of CLIENTS) {
    it(dir, () => {
      const bad: string[] = []
      let seen = 0
      for (const f of walk(join(ROOT, dir), exts)) {
        for (const m of readFileSync(f, 'utf8').matchAll(re)) {
          seen++
          if (!known(m[1]!)) bad.push(`${relative(ROOT, f)}: ${m[1]}`)
        }
      }
      expect(seen, `${dir} 一条路径都没扫到 —— 守卫瞎了`).toBeGreaterThan(0)
      expect(bad).toEqual([])
    })
  }
})

describe('换成类型化客户端的,一条手写路径都没有(F3)', () => {
  for (const [dir, exts, re] of TYPED_CLIENTS) {
    it(dir, () => {
      const files = walk(join(ROOT, dir), exts)
      expect(files.length, `${dir} 一个文件都没扫到 —— 守卫瞎了`).toBeGreaterThan(10)
      const bad: string[] = []
      for (const f of files) {
        for (const m of readFileSync(f, 'utf8').matchAll(re)) bad.push(`${relative(ROOT, f)}: ${m[1]}(改用 @wechat-cc/protocol 的 PHONE_CALLS / makePhoneApi)`)
      }
      expect(bad).toEqual([])
    })
  }
  it('扫描式子认得手写路径(喂人造源码,免得正则哪天静默变空)', () => {
    const hits = (src: string) => [...src.matchAll(PANEL_PATH)].map(m => m[1])
    expect(hits(`call('GET /m/api/x', '/m/api/x'); c.request({ path: "/set/api/state" }); \`/m/api/matter?\${q}\``)).toEqual(['/m/api/x', '/set/api/state', '/m/api/matter'])
    expect(hits(`/** GET /m/api/home 的注释 */ api.home.get()`)).toEqual([])
  })
})
