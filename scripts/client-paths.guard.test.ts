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
 * 桌面也换完了(架构终态 F5):`apps/desktop/src` 里(测试与生成物 `src/generated/` 除外)一条手写的 `/v1` 字符串都不许有 ——
 * 路径从 `src/daemon-client.js` 的 `V1` 表拿(gen:routes 从 `packages/protocol/src/desktop-calls.ts` 生成)。
 * 桌面那份拼请求的小实现(webview 引不到协议包)和协议包的 `callRequest` 逐个样例比,两边拼出来的路径必须一样。
 * 注释里不带引号的路径不算(扫的是引号起头的字面量)。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTES } from '@wechat-cc/protocol/routes'
import { DESKTOP_CALLS } from '../packages/protocol/src/desktop-calls'
import { callRequest } from '../packages/protocol/src/calls'
import { V1, v1, v1Request } from '../apps/desktop/src/daemon-client.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATHS = Object.keys(ROUTES).map(k => k.slice(k.indexOf(' ') + 1))
const known = (p: string) => PATHS.includes(p) || PATHS.some(q => q.startsWith(p))

function walk(dir: string, exts: string[], out: string[] = [], skipDirs: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || skipDirs.includes(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, exts, out, skipDirs)
    else if (exts.some(e => name.endsWith(e)) && !/\.test\.[jt]sx?$/.test(name)) out.push(p)
  }
  return out
}

const PANEL_PATH = /['"`](\/(?:m|set)\/api\/[A-Za-z0-9_/-]*)/g
const V1_PATH = /['"`](\/v1(?:\/[A-Za-z0-9_/-]*)?)/g
const CLIENTS: Array<[string, string[], RegExp]> = [
  ['apps/mobile/src', ['.js', '.ts'], PANEL_PATH],
]
/** 已经换成类型化客户端、不许再有手写路径的客户端:[目录, 扩展名, 扫描式子, 跳过的子目录, 该用什么]。 */
const TYPED_CLIENTS: Array<[string, string[], RegExp, string[], string]> = [
  ['apps/app/src', ['.ts', '.tsx'], PANEL_PATH, [], '@wechat-cc/protocol 的 PHONE_CALLS / makePhoneApi'],
  ['apps/desktop/src', ['.js', '.ts'], V1_PATH, ['generated'], 'src/daemon-client.js 的 v1(transport, V1.ns.m, …)'],
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

describe('换成类型化客户端的,一条手写路径都没有(F3 / F5)', () => {
  for (const [dir, exts, re, skip, use] of TYPED_CLIENTS) {
    it(dir, () => {
      const files = walk(join(ROOT, dir), exts, [], skip)
      expect(files.length, `${dir} 一个文件都没扫到 —— 守卫瞎了`).toBeGreaterThan(10)
      const bad: string[] = []
      for (const f of files) {
        for (const m of readFileSync(f, 'utf8').matchAll(re)) bad.push(`${relative(ROOT, f)}: ${m[1]}(改用 ${use})`)
      }
      expect(bad).toEqual([])
    })
  }
  it('桌面源码里点到的 V1.ns.m 都在表里(没开 @ts-check 的文件写错了也要红,不等运行时才炸)', () => {
    const table = V1 as unknown as Record<string, Record<string, string> | undefined>
    const bad: string[] = []
    let seen = 0
    for (const f of walk(join(ROOT, 'apps/desktop/src'), ['.js', '.ts'], [], ['generated'])) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bV1\.(\w+)\.(\w+)/g)) {
        seen++
        if (typeof table[m[1]!]?.[m[2]!] !== 'string') bad.push(`${relative(ROOT, f)}: V1.${m[1]}.${m[2]}`)
      }
    }
    expect(seen, '一处 V1.ns.m 都没扫到 —— 守卫瞎了').toBeGreaterThan(100)
    expect(bad).toEqual([])
  })
  it('扫描式子认得手写路径(喂人造源码,免得正则哪天静默变空)', () => {
    const hits = (src: string) => [...src.matchAll(PANEL_PATH)].map(m => m[1])
    expect(hits(`call('GET /m/api/x', '/m/api/x'); c.request({ path: "/set/api/state" }); \`/m/api/matter?\${q}\``)).toEqual(['/m/api/x', '/set/api/state', '/m/api/matter'])
    expect(hits(`/** GET /m/api/home 的注释 */ api.home.get()`)).toEqual([])
    const v1Hits = (src: string) => [...src.matchAll(V1_PATH)].map(m => m[1])
    expect(v1Hits(`invokeApi('GET', '/v1/a2a/list'); x("/v1"); \`/v1/workbench?\${q}\`; // GET /v1/health`)).toEqual(['/v1/a2a/list', '/v1', '/v1/workbench'])
  })
})

describe('桌面拼请求的小实现(daemon-client.js)和协议包的 callRequest 逐字一样(F5)', () => {
  const specs = Object.entries(DESKTOP_CALLS).flatMap(([ns, ms]) => Object.entries(ms).map(([m, s]) => ({ ns, m, key: (s as { key: string }).key })))
  const SAMPLES: Array<{ query?: Record<string, string | number | undefined> | URLSearchParams; body?: unknown; suffix?: string } | undefined> = [
    undefined,
    {},
    { body: { id: 'a', n: 1 } },
    { query: { id: 'a b/c?&=', since: 0, wait_ms: 20000, skip: undefined } },
    { query: { q: '中文 + 空格', limit: 30 }, body: {} },
    { query: { empty: undefined } },
    { query: new URLSearchParams({ providerId: 'claude', path: '/Users/x y', q: 'a+b' }) },
    { query: new URLSearchParams() },
    { suffix: 'a b.png', query: { b64: 1 } },
  ]
  it('表里每一条 × 每组样例:方法、路径、正文都一样;生成的 V1 表和协议包的表同一份', () => {
    expect(specs.length).toBeGreaterThan(50)
    for (const { ns, m, key } of specs) {
      expect((V1 as unknown as Record<string, Record<string, string>>)[ns]![m], `${ns}.${m}`).toBe(key)
      for (const a of SAMPLES) {
        const want = callRequest({ key }, a)
        const got = v1Request(key as never, a as never)
        expect(got, `${ns}.${m} ${JSON.stringify(a)}`).toEqual({ key: want.key, method: want.method, path: want.path, ...('body' in want ? { body: want.body } : {}) })
      }
    }
  })
  it('v1() 交给传输的实参个数和搬家前一样:没正文没选项两个、有正文三个、有选项四个', () => {
    const seen: unknown[][] = []
    const t = (...a: unknown[]) => { seen.push(a); return a.length }
    v1(t, V1.journal.seen)
    v1(t, V1.a2a.test, { body: { x: 1 } })
    v1(t, V1.memory.synthesize, undefined, { timeoutMs: 60_000 })
    v1(t, V1.workbench.task, { query: { id: 'A1' } })
    expect(seen).toEqual([
      ['POST', '/v1/journal/seen'],
      ['POST', '/v1/a2a/test', { x: 1 }],
      ['POST', '/v1/memory/synthesize', undefined, { timeoutMs: 60_000 }],
      ['GET', '/v1/workbench/task?id=A1'],
    ])
    expect(() => v1Request(undefined as never)).toThrow(/V1 表里没有/)
  })
})
